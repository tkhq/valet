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
    if (existing) return existing;
    const now = this.clock();
    const run: WorkflowRun = {
      runId,
      status: 'pending',
      waitingOn: [],
      updatedAt: now,
      params,
      definition,
      definitionVersionId,
      attempt: 0,
      wakeRequested: false,
      createdAt: now,
    };
    this.runs.set(runId, run);
    return run;
  }

  async getRun(runId: string): Promise<WorkflowRun | null> {
    return this.runs.get(runId) ?? null;
  }

  async claimRun(runId: string, ownerId: string, leaseMs: number): Promise<{ attempt: number } | null> {
    const run = this.runs.get(runId);
    if (!run) return null;
    if (run.status !== 'pending' && run.status !== 'parked') return null;
    run.attempt += 1;
    run.status = 'running';
    run.ownerId = ownerId;
    run.leaseExpiresAt = this.clock() + leaseMs;
    run.wakeRequested = false;
    run.updatedAt = this.clock();
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
      if (run.status !== 'pending' && run.status !== 'parked') continue;
      const wakeRequested = run.wakeRequested;
      const dueTimer = run.wakeAt !== undefined && run.wakeAt <= now;
      const expiredLease = run.leaseExpiresAt !== undefined && run.leaseExpiresAt <= now;
      if (wakeRequested || dueTimer || expiredLease) {
        out.push(run);
        if (out.length >= limit) break;
      }
    }
    return out;
  }

  async putIntent(cp: NodeCheckpoint): Promise<void> {
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
    this.checkpoints.set(key, { ...cp, status: 'intent' });
  }

  async completeCheckpoint(
    runId: string,
    nodeId: string,
    iteration: number,
    attempt: number,
    terminal: NodeCheckpoint,
  ): Promise<void> {
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
    this.checkpoints.set(key, terminal);
  }

  async getCheckpoints(runId: string): Promise<NodeCheckpoint[]> {
    const out: NodeCheckpoint[] = [];
    for (const cp of this.checkpoints.values()) {
      if (cp.runId === runId) out.push(cp);
    }
    return out;
  }

  async insertSignal(signal: RunSignal): Promise<RunSignal> {
    const existing = this.signals.get(signal.signalId);
    if (existing) return existing;
    this.signals.set(signal.signalId, signal);
    return signal;
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
    // Atomic in-process: both writes land together, or (on the checkpoint
    // write throwing) neither does — the signal write below only commits
    // after the checkpoint write succeeds.
    const key = checkpointKey(checkpoint.runId, checkpoint.nodeId, checkpoint.iteration);
    const existingCp = this.checkpoints.get(key);
    if (existingCp && existingCp.status !== 'intent' && existingCp.attempt !== checkpoint.attempt) {
      throw new WorkflowFenceError(checkpoint.runId, checkpoint.attempt, existingCp.attempt);
    }
    this.checkpoints.set(key, checkpoint);
    signal.consumedAt = this.clock();
    signal.consumedBy = consumedBy;
  }

  async listSignals(runId: string, opts?: { unconsumed?: boolean }): Promise<RunSignal[]> {
    const out: RunSignal[] = [];
    for (const signal of this.signals.values()) {
      if (signal.runId !== runId) continue;
      if (opts?.unconsumed && signal.consumedAt !== undefined) continue;
      out.push(signal);
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
