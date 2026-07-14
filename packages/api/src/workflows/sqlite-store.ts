/**
 * `WorkflowStore` port (`@valet/workflow`'s `packages/workflow/src/store.ts`)
 * implemented over the app sqlite DB (Phase 5 plan Task 9, decision 17).
 *
 * Backed by the raw better-sqlite3 handle underneath the app's Drizzle
 * instance (`AppDb["$client"]`) — mirrors `packages/store-sqlite/src/
 * store.ts`'s house idiom: single conditional `UPDATE`s for simple CAS
 * transitions (`claimRun`, `heartbeat`), and `db.transaction(fn).immediate()`
 * for multi-statement sequences that must read-then-conditionally-write
 * atomically (`parkRun`, `beginTerminalize`, `putIntent`, `completeCheckpoint`,
 * `consumeSignalAndCheckpoint`).
 *
 * JSON columns (`definition`, `params`, `waiting_on`, `result`, `effects`,
 * `payload`, `consumed_by`) are `JSON.stringify`'d text; `undefined` is
 * stored as SQL `NULL` and read back as `undefined` (not `null`) so the
 * shape matches `InMemoryWorkflowStore`'s observable behavior exactly (the
 * conformance suites assert this — e.g. a `skipped` checkpoint's `result`
 * stays `undefined`, not `null`).
 */

import type Database from 'better-sqlite3';
import {
  WorkflowFenceError,
  type NodeCheckpoint,
  type RunParams,
  type RunSignal,
  type RunWaitCondition,
  type WorkflowRun,
  type WorkflowStore,
} from '@valet/workflow';
import type { AppDb } from '../lib/drizzle.js';

type RunStatus = 'pending' | 'running' | 'parked' | 'terminalizing' | 'settled';
type RunOutcome = 'completed' | 'failed' | 'cancelled';
type CheckpointStatus = 'intent' | 'completed' | 'failed' | 'skipped';

interface WorkflowRunRow {
  id: string;
  workflow_id: string;
  definition_version_id: string;
  definition: string;
  params: string;
  status: RunStatus;
  outcome: RunOutcome | null;
  waiting_on: string;
  wake_at: number | null;
  wake_requested: number;
  lease_owner_id: string | null;
  lease_expires_at: number | null;
  attempt: number;
  created_at: number;
  updated_at: number;
}

interface WorkflowCheckpointRow {
  run_id: string;
  node_id: string;
  iteration: number;
  attempt: number;
  status: CheckpointStatus;
  result: string | null;
  effects: string | null;
  error: string | null;
  created_at: number;
}

interface WorkflowSignalRow {
  run_id: string;
  signal_id: string;
  signal_type: string;
  payload: string | null;
  created_at: number;
  consumed_at: number | null;
  consumed_by: string | null;
}

function jsonOrNull(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

function parseJson(value: string | null): unknown {
  return value === null ? undefined : JSON.parse(value);
}

function rowToRun(row: WorkflowRunRow): WorkflowRun {
  return {
    runId: row.id,
    status: row.status,
    outcome: row.outcome ?? undefined,
    waitingOn: JSON.parse(row.waiting_on) as RunWaitCondition[],
    ownerId: row.lease_owner_id ?? undefined,
    leaseExpiresAt: row.lease_expires_at ?? undefined,
    updatedAt: row.updated_at,
    params: JSON.parse(row.params) as RunParams,
    definition: JSON.parse(row.definition),
    definitionVersionId: row.definition_version_id,
    attempt: row.attempt,
    wakeAt: row.wake_at ?? undefined,
    wakeRequested: row.wake_requested !== 0,
    createdAt: row.created_at,
  };
}

function rowToCheckpoint(row: WorkflowCheckpointRow): NodeCheckpoint {
  return {
    runId: row.run_id,
    nodeId: row.node_id,
    iteration: row.iteration,
    status: row.status,
    result: parseJson(row.result),
    error: row.error ?? undefined,
    effects: row.effects === null ? undefined : (JSON.parse(row.effects) as Record<string, unknown>),
    attempt: row.attempt,
    createdAt: row.created_at,
  };
}

function rowToSignal(row: WorkflowSignalRow): RunSignal {
  return {
    runId: row.run_id,
    signalId: row.signal_id,
    signalType: row.signal_type,
    payload: parseJson(row.payload),
    createdAt: row.created_at,
    consumedAt: row.consumed_at ?? undefined,
    consumedBy: row.consumed_by === null ? undefined : (JSON.parse(row.consumed_by) as RunSignal['consumedBy']),
  };
}

export class SqliteWorkflowStore implements WorkflowStore {
  private readonly sqlite: Database.Database;

  constructor(
    db: AppDb & { $client: Database.Database },
    private readonly clock: () => number = () => Date.now(),
  ) {
    this.sqlite = db.$client;
  }

  private getRunRow(runId: string): WorkflowRunRow | undefined {
    return this.sqlite.prepare('SELECT * FROM workflow_runs WHERE id = ?').get(runId) as
      | WorkflowRunRow
      | undefined;
  }

  private mustGetRunRow(runId: string): WorkflowRunRow {
    const row = this.getRunRow(runId);
    if (!row) throw new Error(`workflow run not found: ${runId}`);
    return row;
  }

  async createRun(
    runId: string,
    params: RunParams,
    definition: unknown,
    definitionVersionId: string,
  ): Promise<WorkflowRun> {
    const now = this.clock();
    this.sqlite
      .prepare(
        `INSERT OR IGNORE INTO workflow_runs
          (id, workflow_id, definition_version_id, definition, params, status, waiting_on, wake_requested, attempt, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'pending', '[]', 0, 0, ?, ?)`,
      )
      .run(runId, params.workflowId, definitionVersionId, JSON.stringify(definition), JSON.stringify(params), now, now);
    return rowToRun(this.mustGetRunRow(runId));
  }

  async getRun(runId: string): Promise<WorkflowRun | null> {
    const row = this.getRunRow(runId);
    return row ? rowToRun(row) : null;
  }

  async claimRun(runId: string, ownerId: string, leaseMs: number): Promise<{ attempt: number } | null> {
    const now = this.clock();
    const result = this.sqlite
      .prepare(
        `UPDATE workflow_runs
         SET attempt = attempt + 1,
             status = CASE WHEN status = 'terminalizing' THEN 'terminalizing' ELSE 'running' END,
             lease_owner_id = ?,
             lease_expires_at = ?,
             wake_requested = 0,
             updated_at = ?
         WHERE id = ?
           AND (
             status IN ('pending', 'parked')
             OR (status IN ('running', 'terminalizing') AND (lease_expires_at IS NULL OR lease_expires_at <= ?))
           )`,
      )
      .run(ownerId, now + leaseMs, now, runId, now);
    if (result.changes === 0) return null;
    const row = this.mustGetRunRow(runId);
    return { attempt: row.attempt };
  }

  async heartbeat(runId: string, ownerId: string, leaseMs: number): Promise<boolean> {
    const now = this.clock();
    const result = this.sqlite
      .prepare(`UPDATE workflow_runs SET lease_expires_at = ?, updated_at = ? WHERE id = ? AND lease_owner_id = ?`)
      .run(now + leaseMs, now, runId, ownerId);
    return result.changes > 0;
  }

  async parkRun(runId: string, attempt: number, waitingOn: RunWaitCondition[], wakeAt?: number): Promise<void> {
    const run = this.sqlite.transaction(() => {
      const row = this.mustGetRunRow(runId);
      if (attempt < row.attempt) throw new WorkflowFenceError(runId, attempt, row.attempt);
      const now = this.clock();
      this.sqlite
        .prepare(
          `UPDATE workflow_runs
           SET status = 'parked', waiting_on = ?, wake_at = ?, wake_requested = 0,
               lease_owner_id = NULL, lease_expires_at = NULL, updated_at = ?
           WHERE id = ?`,
        )
        .run(JSON.stringify(waitingOn), wakeAt ?? null, now, runId);
    });
    run.immediate();
  }

  async requestWake(runId: string): Promise<void> {
    this.mustGetRunRow(runId); // matches memory-store's mustRun-on-missing behavior
    const now = this.clock();
    this.sqlite.prepare(`UPDATE workflow_runs SET wake_requested = 1, updated_at = ? WHERE id = ?`).run(now, runId);
  }

  async scheduleWake(runId: string, at: number): Promise<void> {
    const run = this.sqlite.transaction(() => {
      const row = this.mustGetRunRow(runId);
      const nextWakeAt = row.wake_at === null ? at : Math.min(row.wake_at, at);
      const now = this.clock();
      this.sqlite
        .prepare(`UPDATE workflow_runs SET wake_at = ?, updated_at = ? WHERE id = ?`)
        .run(nextWakeAt, now, runId);
    });
    run.immediate();
  }

  async beginTerminalize(runId: string, attempt: number, outcome: RunOutcome): Promise<void> {
    const run = this.sqlite.transaction(() => {
      const row = this.mustGetRunRow(runId);
      if (attempt < row.attempt) throw new WorkflowFenceError(runId, attempt, row.attempt);
      const now = this.clock();
      this.sqlite
        .prepare(`UPDATE workflow_runs SET status = 'terminalizing', outcome = ?, updated_at = ? WHERE id = ?`)
        .run(outcome, now, runId);
    });
    run.immediate();
  }

  async settleRun(runId: string, outcome: RunOutcome): Promise<void> {
    const row = this.mustGetRunRow(runId);
    if (row.status === 'settled') return; // idempotent finalize
    const now = this.clock();
    this.sqlite
      .prepare(
        `UPDATE workflow_runs SET status = 'settled', outcome = ?, waiting_on = '[]', updated_at = ? WHERE id = ?`,
      )
      .run(outcome, now, runId);
  }

  async listRunnable(now: number, limit: number): Promise<WorkflowRun[]> {
    const rows = this.sqlite
      .prepare(
        `SELECT * FROM workflow_runs
         WHERE
           (status IN ('running', 'terminalizing') AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?)
           OR (status IN ('pending', 'parked') AND (
             wake_requested = 1
             OR (wake_at IS NOT NULL AND wake_at <= ?)
             OR (lease_expires_at IS NOT NULL AND lease_expires_at <= ?)
           ))
         ORDER BY updated_at ASC
         LIMIT ?`,
      )
      .all(now, now, now, limit) as WorkflowRunRow[];
    return rows.map(rowToRun);
  }

  async listParked(limit: number): Promise<WorkflowRun[]> {
    const rows = this.sqlite
      .prepare(`SELECT * FROM workflow_runs WHERE status = 'parked' ORDER BY updated_at ASC LIMIT ?`)
      .all(limit) as WorkflowRunRow[];
    return rows.map(rowToRun);
  }

  private getCheckpointRow(runId: string, nodeId: string, iteration: number): WorkflowCheckpointRow | undefined {
    return this.sqlite
      .prepare(`SELECT * FROM workflow_checkpoints WHERE run_id = ? AND node_id = ? AND iteration = ?`)
      .get(runId, nodeId, iteration) as WorkflowCheckpointRow | undefined;
  }

  /** Fences a checkpoint/signal-consume write against the run's current `attempt`. */
  private checkRunAttemptForWrite(runId: string, attempt: number): void {
    const row = this.mustGetRunRow(runId);
    if (attempt < row.attempt) throw new WorkflowFenceError(runId, attempt, row.attempt);
  }

  async putIntent(cp: NodeCheckpoint): Promise<void> {
    const run = this.sqlite.transaction(() => {
      this.checkRunAttemptForWrite(cp.runId, cp.attempt);
      const existing = this.getCheckpointRow(cp.runId, cp.nodeId, cp.iteration);
      if (existing) {
        if (existing.status !== 'intent') {
          // Terminal rows are immutable — putIntent must never touch one.
          throw new WorkflowFenceError(cp.runId, cp.attempt, existing.attempt);
        }
        if (cp.attempt < existing.attempt) {
          throw new WorkflowFenceError(cp.runId, cp.attempt, existing.attempt);
        }
      }
      this.sqlite
        .prepare(
          `INSERT INTO workflow_checkpoints (run_id, node_id, iteration, attempt, status, result, effects, error, created_at)
           VALUES (?, ?, ?, ?, 'intent', ?, ?, ?, ?)
           ON CONFLICT(run_id, node_id, iteration) DO UPDATE SET
             attempt = excluded.attempt,
             status = 'intent',
             result = excluded.result,
             effects = excluded.effects,
             error = excluded.error,
             created_at = excluded.created_at`,
        )
        .run(
          cp.runId,
          cp.nodeId,
          cp.iteration,
          cp.attempt,
          jsonOrNull(cp.result),
          jsonOrNull(cp.effects),
          cp.error ?? null,
          cp.createdAt,
        );
    });
    run.immediate();
  }

  async completeCheckpoint(
    runId: string,
    nodeId: string,
    iteration: number,
    attempt: number,
    terminal: NodeCheckpoint,
  ): Promise<void> {
    const run = this.sqlite.transaction(() => {
      this.checkRunAttemptForWrite(runId, attempt);
      const existing = this.getCheckpointRow(runId, nodeId, iteration);
      if (existing && existing.status !== 'intent') {
        // Terminal row already present: first terminal write wins.
        if (existing.attempt === attempt) return; // idempotent replay of the same write
        throw new WorkflowFenceError(runId, attempt, existing.attempt);
      }
      if (existing && existing.attempt > attempt) {
        throw new WorkflowFenceError(runId, attempt, existing.attempt);
      }
      this.writeTerminalCheckpoint(terminal);
    });
    run.immediate();
  }

  /** Raw upsert of a terminal checkpoint row — caller has already validated the fence. */
  private writeTerminalCheckpoint(terminal: NodeCheckpoint): void {
    this.sqlite
      .prepare(
        `INSERT INTO workflow_checkpoints (run_id, node_id, iteration, attempt, status, result, effects, error, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(run_id, node_id, iteration) DO UPDATE SET
           attempt = excluded.attempt,
           status = excluded.status,
           result = excluded.result,
           effects = excluded.effects,
           error = excluded.error,
           created_at = excluded.created_at`,
      )
      .run(
        terminal.runId,
        terminal.nodeId,
        terminal.iteration,
        terminal.attempt,
        terminal.status,
        jsonOrNull(terminal.result),
        jsonOrNull(terminal.effects),
        terminal.error ?? null,
        terminal.createdAt,
      );
  }

  async getCheckpoints(runId: string): Promise<NodeCheckpoint[]> {
    const rows = this.sqlite
      .prepare(`SELECT * FROM workflow_checkpoints WHERE run_id = ?`)
      .all(runId) as WorkflowCheckpointRow[];
    return rows.map(rowToCheckpoint);
  }

  async insertSignal(signal: RunSignal): Promise<RunSignal> {
    const run = this.sqlite.transaction((): RunSignal => {
      const existing = this.sqlite
        .prepare(`SELECT * FROM workflow_signals WHERE run_id = ? AND signal_id = ?`)
        .get(signal.runId, signal.signalId) as WorkflowSignalRow | undefined;
      if (existing) return rowToSignal(existing);
      this.sqlite
        .prepare(
          `INSERT INTO workflow_signals (run_id, signal_id, signal_type, payload, created_at, consumed_at, consumed_by)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          signal.runId,
          signal.signalId,
          signal.signalType,
          jsonOrNull(signal.payload),
          signal.createdAt,
          signal.consumedAt ?? null,
          jsonOrNull(signal.consumedBy),
        );
      return { ...signal };
    });
    return run.immediate();
  }

  async consumeSignalAndCheckpoint(
    signalId: string,
    consumedBy: { nodeId: string; iteration: number; attempt: number },
    checkpoint: NodeCheckpoint,
  ): Promise<void> {
    const run = this.sqlite.transaction(() => {
      const signalRow = this.sqlite
        .prepare(`SELECT * FROM workflow_signals WHERE run_id = ? AND signal_id = ?`)
        .get(checkpoint.runId, signalId) as WorkflowSignalRow | undefined;
      if (!signalRow) throw new Error(`signal not found: ${signalId}`);

      if (signalRow.consumed_at !== null) {
        const consumedByExisting = signalRow.consumed_by === null ? undefined : (JSON.parse(signalRow.consumed_by) as typeof consumedBy);
        const same =
          consumedByExisting?.nodeId === consumedBy.nodeId &&
          consumedByExisting?.iteration === consumedBy.iteration &&
          consumedByExisting?.attempt === consumedBy.attempt;
        if (same) return; // idempotent replay of the same consume+checkpoint write
        throw new WorkflowFenceError(checkpoint.runId, consumedBy.attempt, consumedByExisting?.attempt ?? -1);
      }

      this.checkRunAttemptForWrite(checkpoint.runId, checkpoint.attempt);

      const existingCp = this.getCheckpointRow(checkpoint.runId, checkpoint.nodeId, checkpoint.iteration);
      if (existingCp && existingCp.status !== 'intent' && existingCp.attempt !== checkpoint.attempt) {
        // Terminal row already present: first terminal write wins.
        throw new WorkflowFenceError(checkpoint.runId, checkpoint.attempt, existingCp.attempt);
      }
      if (existingCp && existingCp.status === 'intent' && existingCp.attempt > checkpoint.attempt) {
        // A live higher-attempt intent must not be overwritten by a
        // lower-attempt (zombie) terminal write.
        throw new WorkflowFenceError(checkpoint.runId, checkpoint.attempt, existingCp.attempt);
      }

      this.writeTerminalCheckpoint(checkpoint);
      this.sqlite
        .prepare(`UPDATE workflow_signals SET consumed_at = ?, consumed_by = ? WHERE run_id = ? AND signal_id = ?`)
        .run(this.clock(), JSON.stringify(consumedBy), checkpoint.runId, signalId);
    });
    run.immediate();
  }

  async listSignals(runId: string, opts?: { unconsumed?: boolean }): Promise<RunSignal[]> {
    const sql = opts?.unconsumed
      ? `SELECT * FROM workflow_signals WHERE run_id = ? AND consumed_at IS NULL ORDER BY created_at ASC, id ASC`
      : `SELECT * FROM workflow_signals WHERE run_id = ? ORDER BY created_at ASC, id ASC`;
    const rows = this.sqlite.prepare(sql).all(runId) as WorkflowSignalRow[];
    return rows.map(rowToSignal);
  }

  async voidConsumption(signalId: string): Promise<void> {
    this.sqlite
      .prepare(`UPDATE workflow_signals SET consumed_at = NULL, consumed_by = NULL WHERE signal_id = ?`)
      .run(signalId);
  }
}
