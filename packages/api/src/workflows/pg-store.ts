/**
 * `WorkflowStore` port (`@valet/workflow`'s `packages/workflow/src/store.ts`)
 * implemented over the app Postgres DB (Task 8 of the postgres-backend
 * plan, docs/specs/2026-07-15-postgres-backend-design.md — replaces
 * `sqlite-store.ts`).
 *
 * Backed by the shared `PgDb` query interface (decision 4) the app's other
 * raw-SQL stores use. Fencing/CAS translation follows decision 6:
 *   - `claimRun`/`heartbeat`: true single-statement CAS — direct `UPDATE
 *     ... WHERE <fence predicate>`, success read from normalized
 *     `rowCount`.
 *   - `parkRun`/`scheduleWake`/`beginTerminalize`/`putIntent`/
 *     `completeCheckpoint`/`consumeSignalAndCheckpoint`: fenced
 *     read-then-write sequences — run inside `db.transaction(fn)` with
 *     `SELECT ... FOR UPDATE` on the run row (and, where the write also
 *     depends on the current checkpoint row, that row too) BEFORE the
 *     fence/state check, so a concurrent claim/checkpoint write serializes
 *     against them instead of racing.
 *   - `createRun`/`insertSignal`: insert-if-absent CAS via `ON CONFLICT ...
 *     DO NOTHING`, then a plain read for the canonical row — no lock
 *     needed, the constraint arbitrates the race.
 *
 * `workflow_runs.wake_requested` is a real `boolean` column (not the sqlite
 * store's 0/1 integer) — read/write JS booleans directly, no `!== 0`
 * translation. `workflow_signals.id` is `generated always as identity` — no
 * explicit `id` ever appears in an insert.
 *
 * JSON columns (`definition`, `params`, `waiting_on`, `result`, `effects`,
 * `payload`, `consumed_by`) are `jsonb` (schema/index.ts): written as
 * `JSON.stringify`'d text (Postgres coerces a text literal targeting a
 * jsonb column), but read back ALREADY PARSED by the pg/PGlite driver — no
 * `JSON.parse` on read. `fromJsonColumn`/`requiredJsonColumn` below also
 * tolerate a raw string defensively (in case a driver ever returns jsonb as
 * text), so the mapping is correct either way. `undefined` is stored as SQL
 * `NULL` and read back as `undefined` (not `null`) so the shape matches
 * `InMemoryWorkflowStore`'s observable behavior exactly — the conformance
 * suites assert this (e.g. a `skipped` checkpoint's `result` stays
 * `undefined`, not `null`).
 */
import type { PgDb, PgQueryable } from '@valet/store-postgres';
import {
  WorkflowFenceError,
  type NodeCheckpoint,
  type RunParams,
  type RunSignal,
  type RunWaitCondition,
  type WorkflowRun,
  type WorkflowStore,
} from '@valet/workflow';

type RunStatus = 'pending' | 'running' | 'parked' | 'terminalizing' | 'settled';
type RunOutcome = 'completed' | 'failed' | 'cancelled';
type CheckpointStatus = 'intent' | 'completed' | 'failed' | 'skipped';

interface WorkflowRunRow {
  id: string;
  workflowId: string;
  definitionVersionId: string;
  definition: unknown;
  params: unknown;
  status: RunStatus;
  outcome: RunOutcome | null;
  waitingOn: unknown;
  wakeAt: number | null;
  wakeRequested: boolean;
  leaseOwnerId: string | null;
  leaseExpiresAt: number | null;
  attempt: number;
  ownerType: string;
  ownerId: string;
  createdAt: number;
  updatedAt: number;
}

interface WorkflowCheckpointRow {
  runId: string;
  nodeId: string;
  iteration: number;
  attempt: number;
  status: CheckpointStatus;
  result: unknown;
  effects: unknown;
  error: string | null;
  createdAt: number;
}

interface WorkflowSignalRow {
  runId: string;
  signalId: string;
  signalType: string;
  payload: unknown;
  createdAt: number;
  consumedAt: number | null;
  consumedBy: unknown;
}

// ─── Row parsing helpers ────────────────────────────────────────────────────

function toNum(value: unknown, field: string): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const n = Number(value);
    if (Number.isNaN(n)) throw new Error(`expected numeric value for ${field}, got non-numeric string ${JSON.stringify(value)}`);
    return n;
  }
  throw new Error(`expected numeric value for ${field}, got ${typeof value}`);
}

function toNumOrNull(value: unknown, field: string): number | null {
  return value === null || value === undefined ? null : toNum(value, field);
}

function asString(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new Error(`expected string for ${field}, got ${typeof value}`);
  return value;
}

function asStringOrNull(value: unknown, field: string): string | null {
  return value === null || value === undefined ? null : asString(value, field);
}

function asBoolean(value: unknown, field: string): boolean {
  if (typeof value === 'boolean') return value;
  // Defensive: some drivers surface boolean columns as 0/1 or 't'/'f'
  // strings under certain configurations — normalize rather than assume.
  if (value === 1 || value === '1' || value === 't' || value === 'true') return true;
  if (value === 0 || value === '0' || value === 'f' || value === 'false') return false;
  throw new Error(`expected boolean for ${field}, got ${typeof value}`);
}

/** `undefined` in → SQL `NULL` param out; every other value → `JSON.stringify`'d text (Postgres coerces it into the target jsonb column). */
function jsonToParam(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

/** Reads a nullable jsonb column: `null`/`undefined` → `undefined`; an already-parsed JS value passes through; a raw string (defensive) is `JSON.parse`'d. */
function fromJsonColumn<T>(value: unknown): T | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'string') return JSON.parse(value) as T;
  return value as T;
}

/** Like `fromJsonColumn`, but for NOT NULL jsonb columns where the value is guaranteed present. */
function requiredJsonColumn<T>(value: unknown, field: string): T {
  if (value === null || value === undefined) throw new Error(`expected jsonb value for ${field}, got ${value}`);
  if (typeof value === 'string') return JSON.parse(value) as T;
  return value as T;
}

function rawToRunRow(raw: Record<string, unknown>): WorkflowRunRow {
  return {
    id: asString(raw.id, 'id'),
    workflowId: asString(raw.workflow_id, 'workflow_id'),
    definitionVersionId: asString(raw.definition_version_id, 'definition_version_id'),
    definition: raw.definition,
    params: raw.params,
    status: asString(raw.status, 'status') as RunStatus,
    outcome: asStringOrNull(raw.outcome, 'outcome') as RunOutcome | null,
    waitingOn: raw.waiting_on,
    wakeAt: toNumOrNull(raw.wake_at, 'wake_at'),
    wakeRequested: asBoolean(raw.wake_requested, 'wake_requested'),
    leaseOwnerId: asStringOrNull(raw.lease_owner_id, 'lease_owner_id'),
    leaseExpiresAt: toNumOrNull(raw.lease_expires_at, 'lease_expires_at'),
    attempt: toNum(raw.attempt, 'attempt'),
    ownerType: asString(raw.owner_type, 'owner_type'),
    ownerId: asString(raw.owner_id, 'owner_id'),
    createdAt: toNum(raw.created_at, 'created_at'),
    updatedAt: toNum(raw.updated_at, 'updated_at'),
  };
}

function rawToCheckpointRow(raw: Record<string, unknown>): WorkflowCheckpointRow {
  return {
    runId: asString(raw.run_id, 'run_id'),
    nodeId: asString(raw.node_id, 'node_id'),
    iteration: toNum(raw.iteration, 'iteration'),
    attempt: toNum(raw.attempt, 'attempt'),
    status: asString(raw.status, 'status') as CheckpointStatus,
    result: raw.result,
    effects: raw.effects,
    error: asStringOrNull(raw.error, 'error'),
    createdAt: toNum(raw.created_at, 'created_at'),
  };
}

function rawToSignalRow(raw: Record<string, unknown>): WorkflowSignalRow {
  return {
    runId: asString(raw.run_id, 'run_id'),
    signalId: asString(raw.signal_id, 'signal_id'),
    signalType: asString(raw.signal_type, 'signal_type'),
    payload: raw.payload,
    createdAt: toNum(raw.created_at, 'created_at'),
    consumedAt: toNumOrNull(raw.consumed_at, 'consumed_at'),
    consumedBy: raw.consumed_by,
  };
}

function rowToRun(row: WorkflowRunRow): WorkflowRun {
  return {
    runId: row.id,
    status: row.status,
    outcome: row.outcome ?? undefined,
    waitingOn: requiredJsonColumn<RunWaitCondition[]>(row.waitingOn, 'waiting_on'),
    ownerId: row.leaseOwnerId ?? undefined,
    leaseExpiresAt: row.leaseExpiresAt ?? undefined,
    updatedAt: row.updatedAt,
    params: requiredJsonColumn<RunParams>(row.params, 'params'),
    definition: requiredJsonColumn<unknown>(row.definition, 'definition'),
    definitionVersionId: row.definitionVersionId,
    attempt: row.attempt,
    wakeAt: row.wakeAt ?? undefined,
    wakeRequested: row.wakeRequested,
    createdAt: row.createdAt,
    // `owner_type`/`owner_id` carry not-null defaults ('user'/'') so a run
    // created without an owner has a distinguishable sentinel row rather
    // than NULL columns — map that sentinel back to `undefined` so this
    // matches `InMemoryWorkflowStore`'s owner-omitted-means-undefined shape.
    owner: row.ownerId === '' ? undefined : { ownerType: row.ownerType, ownerId: row.ownerId },
  };
}

function rowToCheckpoint(row: WorkflowCheckpointRow): NodeCheckpoint {
  return {
    runId: row.runId,
    nodeId: row.nodeId,
    iteration: row.iteration,
    status: row.status,
    result: fromJsonColumn(row.result),
    error: row.error ?? undefined,
    effects: fromJsonColumn<Record<string, unknown>>(row.effects),
    attempt: row.attempt,
    createdAt: row.createdAt,
  };
}

function rowToSignal(row: WorkflowSignalRow): RunSignal {
  return {
    runId: row.runId,
    signalId: row.signalId,
    signalType: row.signalType,
    payload: fromJsonColumn(row.payload),
    createdAt: row.createdAt,
    consumedAt: row.consumedAt ?? undefined,
    consumedBy: fromJsonColumn<RunSignal['consumedBy']>(row.consumedBy),
  };
}

export class PgWorkflowStore implements WorkflowStore {
  constructor(
    private readonly db: PgDb,
    private readonly clock: () => number = () => Date.now(),
  ) {}

  private async getRunRow(q: PgQueryable, runId: string): Promise<WorkflowRunRow | undefined> {
    const result = await q.query('SELECT * FROM workflow_runs WHERE id = $1', [runId]);
    const raw = result.rows[0];
    return raw ? rawToRunRow(raw) : undefined;
  }

  private async mustGetRunRow(q: PgQueryable, runId: string): Promise<WorkflowRunRow> {
    const row = await this.getRunRow(q, runId);
    if (!row) throw new Error(`workflow run not found: ${runId}`);
    return row;
  }

  private async lockRunRow(tx: PgQueryable, runId: string): Promise<WorkflowRunRow> {
    const result = await tx.query('SELECT * FROM workflow_runs WHERE id = $1 FOR UPDATE', [runId]);
    const raw = result.rows[0];
    if (!raw) throw new Error(`workflow run not found: ${runId}`);
    return rawToRunRow(raw);
  }

  async createRun(
    runId: string,
    params: RunParams,
    definition: unknown,
    definitionVersionId: string,
    owner?: { ownerType: string; ownerId: string },
  ): Promise<WorkflowRun> {
    const now = this.clock();
    if (owner) {
      await this.db.query(
        `INSERT INTO workflow_runs
           (id, workflow_id, definition_version_id, definition, params, status, waiting_on, wake_requested, attempt, owner_type, owner_id, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,'pending','[]',false,0,$6,$7,$8,$9)
         ON CONFLICT (id) DO NOTHING`,
        [runId, params.workflowId, definitionVersionId, JSON.stringify(definition), JSON.stringify(params), owner.ownerType, owner.ownerId, now, now],
      );
    } else {
      await this.db.query(
        `INSERT INTO workflow_runs
           (id, workflow_id, definition_version_id, definition, params, status, waiting_on, wake_requested, attempt, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,'pending','[]',false,0,$6,$7)
         ON CONFLICT (id) DO NOTHING`,
        [runId, params.workflowId, definitionVersionId, JSON.stringify(definition), JSON.stringify(params), now, now],
      );
    }
    return rowToRun(await this.mustGetRunRow(this.db, runId));
  }

  async getRun(runId: string): Promise<WorkflowRun | null> {
    const row = await this.getRunRow(this.db, runId);
    return row ? rowToRun(row) : null;
  }

  async claimRun(runId: string, ownerId: string, leaseMs: number): Promise<{ attempt: number } | null> {
    const now = this.clock();
    const result = await this.db.query(
      `UPDATE workflow_runs
       SET attempt = attempt + 1,
           status = CASE WHEN status = 'terminalizing' THEN 'terminalizing' ELSE 'running' END,
           lease_owner_id = $1,
           lease_expires_at = $2,
           wake_requested = false,
           updated_at = $3
       WHERE id = $4
         AND (
           status IN ('pending', 'parked')
           OR (status IN ('running', 'terminalizing') AND lease_expires_at IS NOT NULL AND lease_expires_at <= $5)
         )`,
      [ownerId, now + leaseMs, now, runId, now],
    );
    if (result.rowCount === 0) return null;
    const row = await this.mustGetRunRow(this.db, runId);
    return { attempt: row.attempt };
  }

  async heartbeat(runId: string, ownerId: string, leaseMs: number): Promise<boolean> {
    const now = this.clock();
    const result = await this.db.query(
      `UPDATE workflow_runs SET lease_expires_at = $1, updated_at = $2 WHERE id = $3 AND lease_owner_id = $4`,
      [now + leaseMs, now, runId, ownerId],
    );
    return result.rowCount > 0;
  }

  async parkRun(runId: string, attempt: number, waitingOn: RunWaitCondition[], wakeAt?: number): Promise<void> {
    await this.db.transaction(async (tx) => {
      const row = await this.lockRunRow(tx, runId);
      if (attempt < row.attempt) throw new WorkflowFenceError(runId, attempt, row.attempt);
      const now = this.clock();
      await tx.query(
        `UPDATE workflow_runs
         SET status = 'parked', waiting_on = $1, wake_at = $2, wake_requested = false,
             lease_owner_id = NULL, lease_expires_at = NULL, updated_at = $3
         WHERE id = $4`,
        [JSON.stringify(waitingOn), wakeAt ?? null, now, runId],
      );
    });
  }

  async requestWake(runId: string): Promise<void> {
    await this.mustGetRunRow(this.db, runId); // matches memory-store's mustRun-on-missing behavior
    const now = this.clock();
    await this.db.query(`UPDATE workflow_runs SET wake_requested = true, updated_at = $1 WHERE id = $2`, [now, runId]);
  }

  async scheduleWake(runId: string, at: number): Promise<void> {
    await this.db.transaction(async (tx) => {
      const row = await this.lockRunRow(tx, runId);
      const nextWakeAt = row.wakeAt === null ? at : Math.min(row.wakeAt, at);
      const now = this.clock();
      await tx.query(`UPDATE workflow_runs SET wake_at = $1, updated_at = $2 WHERE id = $3`, [nextWakeAt, now, runId]);
    });
  }

  async beginTerminalize(runId: string, attempt: number, outcome: RunOutcome): Promise<void> {
    await this.db.transaction(async (tx) => {
      const row = await this.lockRunRow(tx, runId);
      if (attempt < row.attempt) throw new WorkflowFenceError(runId, attempt, row.attempt);
      const now = this.clock();
      await tx.query(`UPDATE workflow_runs SET status = 'terminalizing', outcome = $1, updated_at = $2 WHERE id = $3`, [
        outcome,
        now,
        runId,
      ]);
    });
  }

  async settleRun(runId: string, outcome: RunOutcome): Promise<void> {
    const row = await this.mustGetRunRow(this.db, runId);
    if (row.status === 'settled') return; // idempotent finalize
    const now = this.clock();
    await this.db.query(`UPDATE workflow_runs SET status = 'settled', outcome = $1, waiting_on = '[]', updated_at = $2 WHERE id = $3`, [
      outcome,
      now,
      runId,
    ]);
    // Grant expiry (action-policies plan, Task 3): a settled run's
    // exec-scoped runtime grants must not survive to quiet a future action.
    // Soft-revoke (matches `revokeExecutionGrants`) and idempotent — the
    // `status === 'settled'` short-circuit above already makes a re-settle a
    // no-op, and the `revoked_at IS NULL` guard makes the UPDATE itself
    // idempotent regardless.
    await this.db.query(
      `UPDATE runtime_grants SET revoked_at = $1 WHERE workflow_execution_id = $2 AND revoked_at IS NULL`,
      [now, runId],
    );
  }

  async listRunnable(now: number, limit: number): Promise<WorkflowRun[]> {
    const result = await this.db.query(
      `SELECT * FROM workflow_runs
       WHERE
         (status IN ('running', 'terminalizing') AND lease_expires_at IS NOT NULL AND lease_expires_at <= $1)
         OR (status IN ('pending', 'parked') AND (
           wake_requested = true
           OR (wake_at IS NOT NULL AND wake_at <= $2)
           OR (lease_expires_at IS NOT NULL AND lease_expires_at <= $3)
         ))
       ORDER BY updated_at ASC
       LIMIT $4`,
      [now, now, now, limit],
    );
    return result.rows.map((r) => rowToRun(rawToRunRow(r)));
  }

  async listParked(limit: number): Promise<WorkflowRun[]> {
    const result = await this.db.query(`SELECT * FROM workflow_runs WHERE status = 'parked' ORDER BY updated_at ASC LIMIT $1`, [
      limit,
    ]);
    return result.rows.map((r) => rowToRun(rawToRunRow(r)));
  }

  private async getCheckpointRow(
    q: PgQueryable,
    runId: string,
    nodeId: string,
    iteration: number,
    forUpdate = false,
  ): Promise<WorkflowCheckpointRow | undefined> {
    const result = await q.query(
      `SELECT * FROM workflow_checkpoints WHERE run_id = $1 AND node_id = $2 AND iteration = $3${forUpdate ? ' FOR UPDATE' : ''}`,
      [runId, nodeId, iteration],
    );
    const raw = result.rows[0];
    return raw ? rawToCheckpointRow(raw) : undefined;
  }

  /** Fences a checkpoint/signal-consume write against the run's current `attempt` — the run row must already be locked (`FOR UPDATE`) by the caller's transaction. */
  private checkRunAttemptForWrite(row: WorkflowRunRow, runId: string, attempt: number): void {
    if (attempt < row.attempt) throw new WorkflowFenceError(runId, attempt, row.attempt);
  }

  async putIntent(cp: NodeCheckpoint): Promise<void> {
    await this.db.transaction(async (tx) => {
      const runRow = await this.lockRunRow(tx, cp.runId);
      this.checkRunAttemptForWrite(runRow, cp.runId, cp.attempt);
      const existing = await this.getCheckpointRow(tx, cp.runId, cp.nodeId, cp.iteration, true);
      if (existing) {
        if (existing.status !== 'intent') {
          // Terminal rows are immutable — putIntent must never touch one.
          throw new WorkflowFenceError(cp.runId, cp.attempt, existing.attempt);
        }
        if (cp.attempt < existing.attempt) {
          throw new WorkflowFenceError(cp.runId, cp.attempt, existing.attempt);
        }
      }
      await tx.query(
        `INSERT INTO workflow_checkpoints (run_id, node_id, iteration, attempt, status, result, effects, error, created_at)
         VALUES ($1,$2,$3,$4,'intent',$5,$6,$7,$8)
         ON CONFLICT (run_id, node_id, iteration) DO UPDATE SET
           attempt = EXCLUDED.attempt,
           status = 'intent',
           result = EXCLUDED.result,
           effects = EXCLUDED.effects,
           error = EXCLUDED.error,
           created_at = EXCLUDED.created_at`,
        [cp.runId, cp.nodeId, cp.iteration, cp.attempt, jsonToParam(cp.result), jsonToParam(cp.effects), cp.error ?? null, cp.createdAt],
      );
    });
  }

  async completeCheckpoint(
    runId: string,
    nodeId: string,
    iteration: number,
    attempt: number,
    terminal: NodeCheckpoint,
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      const runRow = await this.lockRunRow(tx, runId);
      this.checkRunAttemptForWrite(runRow, runId, attempt);
      const existing = await this.getCheckpointRow(tx, runId, nodeId, iteration, true);
      if (existing && existing.status !== 'intent') {
        // Terminal row already present: first terminal write wins.
        if (existing.attempt === attempt) return; // idempotent replay of the same write
        throw new WorkflowFenceError(runId, attempt, existing.attempt);
      }
      if (existing && existing.attempt > attempt) {
        throw new WorkflowFenceError(runId, attempt, existing.attempt);
      }
      await this.writeTerminalCheckpoint(tx, terminal);
    });
  }

  /** Raw upsert of a terminal checkpoint row — caller has already validated the fence (and locked the row, where applicable). */
  private async writeTerminalCheckpoint(q: PgQueryable, terminal: NodeCheckpoint): Promise<void> {
    await q.query(
      `INSERT INTO workflow_checkpoints (run_id, node_id, iteration, attempt, status, result, effects, error, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (run_id, node_id, iteration) DO UPDATE SET
         attempt = EXCLUDED.attempt,
         status = EXCLUDED.status,
         result = EXCLUDED.result,
         effects = EXCLUDED.effects,
         error = EXCLUDED.error,
         created_at = EXCLUDED.created_at`,
      [
        terminal.runId,
        terminal.nodeId,
        terminal.iteration,
        terminal.attempt,
        terminal.status,
        jsonToParam(terminal.result),
        jsonToParam(terminal.effects),
        terminal.error ?? null,
        terminal.createdAt,
      ],
    );
  }

  async getCheckpoints(runId: string): Promise<NodeCheckpoint[]> {
    const result = await this.db.query('SELECT * FROM workflow_checkpoints WHERE run_id = $1', [runId]);
    return result.rows.map((r) => rowToCheckpoint(rawToCheckpointRow(r)));
  }

  private async getSignalRow(q: PgQueryable, runId: string, signalId: string, forUpdate = false): Promise<WorkflowSignalRow | undefined> {
    const result = await q.query(
      `SELECT * FROM workflow_signals WHERE run_id = $1 AND signal_id = $2${forUpdate ? ' FOR UPDATE' : ''}`,
      [runId, signalId],
    );
    const raw = result.rows[0];
    return raw ? rawToSignalRow(raw) : undefined;
  }

  async insertSignal(signal: RunSignal): Promise<RunSignal> {
    await this.db.query(
      `INSERT INTO workflow_signals (run_id, signal_id, signal_type, payload, created_at, consumed_at, consumed_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (run_id, signal_id) DO NOTHING`,
      [
        signal.runId,
        signal.signalId,
        signal.signalType,
        jsonToParam(signal.payload),
        signal.createdAt,
        signal.consumedAt ?? null,
        jsonToParam(signal.consumedBy),
      ],
    );
    const row = await this.getSignalRow(this.db, signal.runId, signal.signalId);
    if (!row) throw new Error(`signal not found after insert: ${signal.signalId}`);
    return rowToSignal(row);
  }

  async consumeSignalAndCheckpoint(
    signalId: string,
    consumedBy: { nodeId: string; iteration: number; attempt: number },
    checkpoint: NodeCheckpoint,
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      const signalRow = await this.getSignalRow(tx, checkpoint.runId, signalId, true);
      if (!signalRow) throw new Error(`signal not found: ${signalId}`);

      if (signalRow.consumedAt !== null) {
        const consumedByExisting = fromJsonColumn<typeof consumedBy>(signalRow.consumedBy);
        const same =
          consumedByExisting?.nodeId === consumedBy.nodeId &&
          consumedByExisting?.iteration === consumedBy.iteration &&
          consumedByExisting?.attempt === consumedBy.attempt;
        if (same) return; // idempotent replay of the same consume+checkpoint write
        throw new WorkflowFenceError(checkpoint.runId, consumedBy.attempt, consumedByExisting?.attempt ?? -1);
      }

      const runRow = await this.lockRunRow(tx, checkpoint.runId);
      this.checkRunAttemptForWrite(runRow, checkpoint.runId, checkpoint.attempt);

      const existingCp = await this.getCheckpointRow(tx, checkpoint.runId, checkpoint.nodeId, checkpoint.iteration, true);
      if (existingCp && existingCp.status !== 'intent' && existingCp.attempt !== checkpoint.attempt) {
        // Terminal row already present: first terminal write wins.
        throw new WorkflowFenceError(checkpoint.runId, checkpoint.attempt, existingCp.attempt);
      }
      if (existingCp && existingCp.status === 'intent' && existingCp.attempt > checkpoint.attempt) {
        // A live higher-attempt intent must not be overwritten by a
        // lower-attempt (zombie) terminal write.
        throw new WorkflowFenceError(checkpoint.runId, checkpoint.attempt, existingCp.attempt);
      }

      await this.writeTerminalCheckpoint(tx, checkpoint);
      await tx.query(`UPDATE workflow_signals SET consumed_at = $1, consumed_by = $2 WHERE run_id = $3 AND signal_id = $4`, [
        this.clock(),
        JSON.stringify(consumedBy),
        checkpoint.runId,
        signalId,
      ]);
    });
  }

  async listSignals(runId: string, opts?: { unconsumed?: boolean }): Promise<RunSignal[]> {
    const result = opts?.unconsumed
      ? await this.db.query('SELECT * FROM workflow_signals WHERE run_id = $1 AND consumed_at IS NULL ORDER BY created_at ASC, id ASC', [
          runId,
        ])
      : await this.db.query('SELECT * FROM workflow_signals WHERE run_id = $1 ORDER BY created_at ASC, id ASC', [runId]);
    return result.rows.map((r) => rowToSignal(rawToSignalRow(r)));
  }

  async voidConsumption(runId: string, signalId: string): Promise<void> {
    await this.db.query(`UPDATE workflow_signals SET consumed_at = NULL, consumed_by = NULL WHERE run_id = $1 AND signal_id = $2`, [
      runId,
      signalId,
    ]);
  }
}
