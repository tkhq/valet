/**
 * Reference `WorkflowStore` implementation over in-process Maps. Used by
 * interpreter/host unit tests and as the baseline the conformance suites
 * are developed against; a sqlite-backed store (Task 9) must pass the same
 * suites unchanged.
 */

import {
  WorkflowFenceError,
  type NodeCheckpoint,
  type RunParams,
  type RunSignal,
  type RunWaitCondition,
  type WorkflowRun,
  type WorkflowStore,
} from './store.js';

function checkpointKey(runId: string, nodeId: string, iteration: number): string {
  return `${runId}::${nodeId}::${iteration}`;
}

export class InMemoryWorkflowStore implements WorkflowStore {
  private runs = new Map<string, WorkflowRun>();
  private checkpoints = new Map<string, NodeCheckpoint>();
  private signals = new Map<string, RunSignal>();

  constructor(private readonly clock: () => number = () => Date.now()) {}

  private mustRun(runId: string): WorkflowRun {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`workflow run not found: ${runId}`);
    return run;
  }

  /** Fences run-level operations (park/terminalize) against the run's current attempt. */
  private checkRunAttempt(run: WorkflowRun, attempt: number): void {
    if (attempt < run.attempt) {
      throw new WorkflowFenceError(run.runId, attempt, run.attempt);
    }
  }

  async createRun(
    runId: string,
    params: RunParams,
    definition: unknown,
    definitionVersionId: string,
  ): Promise<WorkflowRun> {
    const existing = this.runs.get(runId);
    if (existing) return structuredClone(existing);
    const now = this.clock();
    const run: WorkflowRun = {
      runId,
      status: 'pending',
      waitingOn: [],
      updatedAt: now,
      params: structuredClone(params),
      definition: structuredClone(definition),
      definitionVersionId,
      attempt: 0,
      wakeRequested: false,
      createdAt: now,
    };
    this.runs.set(runId, run);
    return structuredClone(run);
  }

  async getRun(runId: string): Promise<WorkflowRun | null> {
    const run = this.runs.get(runId);
    return run ? structuredClone(run) : null;
  }

  async claimRun(runId: string, ownerId: string, leaseMs: number): Promise<{ attempt: number } | null> {
    const run = this.runs.get(runId);
    if (!run) return null;
    const now = this.clock();
    const leaseExpired = run.leaseExpiresAt !== undefined && run.leaseExpiresAt <= now;
    const claimable =
      run.status === 'pending' ||
      run.status === 'parked' ||
      ((run.status === 'running' || run.status === 'terminalizing') && leaseExpired);
    if (!claimable) return null;
    run.attempt += 1;
    // `terminalizing` runs stay `terminalizing` on reclaim — the new owner
    // resumes terminal cleanup rather than re-entering the run body.
    if (run.status !== 'terminalizing') run.status = 'running';
    run.ownerId = ownerId;
    run.leaseExpiresAt = now + leaseMs;
    run.wakeRequested = false;
    run.updatedAt = now;
    return { attempt: run.attempt };
  }

  async heartbeat(runId: string, ownerId: string, leaseMs: number): Promise<boolean> {
    const run = this.runs.get(runId);
    if (!run || run.ownerId !== ownerId) return false;
    run.leaseExpiresAt = this.clock() + leaseMs;
    run.updatedAt = this.clock();
    return true;
  }

  async parkRun(runId: string, attempt: number, waitingOn: RunWaitCondition[], wakeAt?: number): Promise<void> {
    const run = this.mustRun(runId);
    this.checkRunAttempt(run, attempt);
    run.status = 'parked';
    run.waitingOn = waitingOn;
    run.wakeAt = wakeAt;
    run.wakeRequested = false;
    // A parked run is unowned — clear the lease so it doesn't look like an
    // expired-lease-reclaimable running/terminalizing run.
    run.ownerId = undefined;
    run.leaseExpiresAt = undefined;
    run.updatedAt = this.clock();
  }

  async requestWake(runId: string): Promise<void> {
    const run = this.mustRun(runId);
    run.wakeRequested = true;
    run.updatedAt = this.clock();
  }

  async scheduleWake(runId: string, at: number): Promise<void> {
    const run = this.mustRun(runId);
    run.wakeAt = run.wakeAt === undefined ? at : Math.min(run.wakeAt, at);
    run.updatedAt = this.clock();
  }

  async beginTerminalize(
    runId: string,
    attempt: number,
    outcome: 'completed' | 'failed' | 'cancelled',
  ): Promise<void> {
    const run = this.mustRun(runId);
    this.checkRunAttempt(run, attempt);
    run.status = 'terminalizing';
    run.outcome = outcome;
    run.updatedAt = this.clock();
  }

  async settleRun(runId: string, outcome: 'completed' | 'failed' | 'cancelled'): Promise<void> {
    const run = this.mustRun(runId);
    if (run.status === 'settled') return; // idempotent finalize
    run.status = 'settled';
    run.outcome = outcome;
    run.waitingOn = [];
    run.updatedAt = this.clock();
  }

  async listRunnable(now: number, limit: number): Promise<WorkflowRun[]> {
    const out: WorkflowRun[] = [];
    for (const run of this.runs.values()) {
      const expiredLease = run.leaseExpiresAt !== undefined && run.leaseExpiresAt <= now;
      if (run.status === 'running' || run.status === 'terminalizing') {
        // Only a crashed owner's expired lease makes an in-flight run
        // runnable again; a live lease means someone still owns it.
        if (!expiredLease) continue;
        out.push(structuredClone(run));
        if (out.length >= limit) break;
        continue;
      }
      if (run.status !== 'pending' && run.status !== 'parked') continue;
      const wakeRequested = run.wakeRequested;
      const dueTimer = run.wakeAt !== undefined && run.wakeAt <= now;
      if (wakeRequested || dueTimer || expiredLease) {
        out.push(structuredClone(run));
        if (out.length >= limit) break;
      }
    }
    return out;
  }

  /**
   * Fences a checkpoint/signal-consume write against the run's current
   * `attempt` — catches a zombie writer (its lease was reclaimed) creating
   * a brand-new row for a nodeId with no prior row to CAS against.
   */
  private checkRunAttemptForWrite(runId: string, attempt: number): void {
    const run = this.mustRun(runId);
    if (attempt < run.attempt) {
      throw new WorkflowFenceError(runId, attempt, run.attempt);
    }
  }

  async putIntent(cp: NodeCheckpoint): Promise<void> {
    this.checkRunAttemptForWrite(cp.runId, cp.attempt);
    const key = checkpointKey(cp.runId, cp.nodeId, cp.iteration);
    const existing = this.checkpoints.get(key);
    if (existing) {
      if (existing.status !== 'intent') {
        // Terminal rows are immutable — putIntent must never touch one.
        throw new WorkflowFenceError(cp.runId, cp.attempt, existing.attempt);
      }
      if (cp.attempt < existing.attempt) {
        throw new WorkflowFenceError(cp.runId, cp.attempt, existing.attempt);
      }
    }
    this.checkpoints.set(key, structuredClone({ ...cp, status: 'intent' }));
  }

  async completeCheckpoint(
    runId: string,
    nodeId: string,
    iteration: number,
    attempt: number,
    terminal: NodeCheckpoint,
  ): Promise<void> {
    this.checkRunAttemptForWrite(runId, attempt);
    const key = checkpointKey(runId, nodeId, iteration);
    const existing = this.checkpoints.get(key);
    if (existing && existing.status !== 'intent') {
      // Terminal row already present: first terminal write wins.
      if (existing.attempt === attempt) return; // idempotent replay of the same write
      throw new WorkflowFenceError(runId, attempt, existing.attempt);
    }
    if (existing && existing.attempt > attempt) {
      throw new WorkflowFenceError(runId, attempt, existing.attempt);
    }
    this.checkpoints.set(key, structuredClone(terminal));
  }

  async getCheckpoints(runId: string): Promise<NodeCheckpoint[]> {
    const out: NodeCheckpoint[] = [];
    for (const cp of this.checkpoints.values()) {
      if (cp.runId === runId) out.push(structuredClone(cp));
    }
    return out;
  }

  async insertSignal(signal: RunSignal): Promise<RunSignal> {
    const existing = this.signals.get(signal.signalId);
    if (existing) return structuredClone(existing);
    const stored = structuredClone(signal);
    this.signals.set(signal.signalId, stored);
    return structuredClone(stored);
  }

  async consumeSignalAndCheckpoint(
    signalId: string,
    consumedBy: { nodeId: string; iteration: number; attempt: number },
    checkpoint: NodeCheckpoint,
  ): Promise<void> {
    const signal = this.signals.get(signalId);
    if (!signal) throw new Error(`signal not found: ${signalId}`);
    if (signal.consumedAt !== undefined) {
      const same =
        signal.consumedBy?.nodeId === consumedBy.nodeId &&
        signal.consumedBy?.iteration === consumedBy.iteration &&
        signal.consumedBy?.attempt === consumedBy.attempt;
      if (same) return; // idempotent replay of the same consume+checkpoint write
      throw new WorkflowFenceError(checkpoint.runId, consumedBy.attempt, signal.consumedBy?.attempt ?? -1);
    }
    this.checkRunAttemptForWrite(checkpoint.runId, checkpoint.attempt);
    // Atomic in-process: both writes land together, or (on the checkpoint
    // write throwing) neither does — the signal write below only commits
    // after the checkpoint write succeeds.
    const key = checkpointKey(checkpoint.runId, checkpoint.nodeId, checkpoint.iteration);
    const existingCp = this.checkpoints.get(key);
    if (existingCp && existingCp.status !== 'intent' && existingCp.attempt !== checkpoint.attempt) {
      // Terminal row already present: first terminal write wins.
      throw new WorkflowFenceError(checkpoint.runId, checkpoint.attempt, existingCp.attempt);
    }
    if (existingCp && existingCp.status === 'intent' && existingCp.attempt > checkpoint.attempt) {
      // A live higher-attempt intent must not be overwritten by a
      // lower-attempt (zombie) terminal write.
      throw new WorkflowFenceError(checkpoint.runId, checkpoint.attempt, existingCp.attempt);
    }
    this.checkpoints.set(key, structuredClone(checkpoint));
    signal.consumedAt = this.clock();
    signal.consumedBy = consumedBy;
  }

  async listSignals(runId: string, opts?: { unconsumed?: boolean }): Promise<RunSignal[]> {
    const out: RunSignal[] = [];
    for (const signal of this.signals.values()) {
      if (signal.runId !== runId) continue;
      if (opts?.unconsumed && signal.consumedAt !== undefined) continue;
      out.push(structuredClone(signal));
    }
    return out;
  }

  async voidConsumption(signalId: string): Promise<void> {
    const signal = this.signals.get(signalId);
    if (!signal) return;
    signal.consumedAt = undefined;
    signal.consumedBy = undefined;
  }
}
