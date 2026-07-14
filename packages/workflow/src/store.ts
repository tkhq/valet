/**
 * The `WorkflowStore` port — checkpoints, signals, run ownership.
 *
 * Types and method contracts are normative per
 * `docs/specs/2026-07-11-workflow-run-host-design.md` ("Execution Model",
 * "RunHost Port") and Phase 5 plan decisions 6–7. Later tasks (interpreter,
 * LocalRunHost, sqlite store) consume this port unchanged.
 *
 * All methods are async even though the reference in-memory implementation
 * (`memory-store.ts`) is synchronous under the hood — a sqlite-backed
 * implementation (Task 9) runs the exact same conformance suites against
 * this interface.
 */

/** One node execution's checkpoint row. Keyed by (runId, nodeId, iteration). */
export interface NodeCheckpoint {
  runId: string;
  nodeId: string;
  iteration: number; // 0 for non-foreach nodes
  status: 'intent' | 'completed' | 'failed' | 'skipped';
  result?: unknown; // JSON-serializable node output
  error?: string;
  /** Values the node read from the environment (clock, generated ids). */
  effects?: Record<string, unknown>;
  attempt: number; // the attempt that wrote the current status
  createdAt: number;
}

/** What a parked run is waiting for. */
export type RunWaitCondition =
  | { kind: 'timer'; nodeId: string; wakeAt: number }
  | { kind: 'signal'; nodeId: string; signalType: string; timeoutAt?: number }
  | { kind: 'submission'; nodeId: string; sessionId: string; threadId: string; queueItemId: string };

/** Run status + park/ownership state, independent of the row's params/definition fields. */
export interface RunParkState {
  runId: string;
  status: 'pending' | 'running' | 'parked' | 'terminalizing' | 'settled'; // pending = created, not yet driven
  outcome?: 'completed' | 'failed' | 'cancelled';
  waitingOn: RunWaitCondition[];
  ownerId?: string;
  leaseExpiresAt?: number;
  updatedAt: number;
}

/** Parameters to start a run. JSON-serializable. */
export interface RunParams {
  workflowId: string;
  definitionVersionId: string;
  triggerId?: string;
  input?: unknown; // JSON-serializable trigger/manual input
}

/**
 * The full run row: `RunParkState` plus the immutable-at-start fields
 * (params, the definition snapshot the run was started against, attempt
 * counter, wake scheduling, creation time).
 */
export interface WorkflowRun extends RunParkState {
  params: RunParams;
  /** Snapshot of the workflow definition at run-start time. Never mutated. */
  definition: unknown;
  definitionVersionId: string;
  attempt: number;
  wakeAt?: number;
  wakeRequested: boolean;
  createdAt: number;
}

/** A durable signal row (approval resolution, cancellation, etc.). */
export interface RunSignal {
  runId: string;
  signalId: string; // unique; idempotent insert
  signalType: string; // e.g. 'approval:{nodeId}' | 'cancel'
  payload?: unknown;
  createdAt: number;
  consumedAt?: number; // set when a wait absorbs it
  consumedBy?: { nodeId: string; iteration: number; attempt: number };
}

/**
 * Thrown when a checkpoint or signal-consume write carries an `attempt`
 * that is no longer current for the run — i.e. a superseded/zombie attempt
 * (its lease expired and was reclaimed) is trying to land a write after it
 * lost ownership. Also thrown for a late terminal write that arrives after
 * a terminal checkpoint has already been written (terminal rows are
 * immutable; first terminal write wins).
 */
export class WorkflowFenceError extends Error {
  constructor(
    public readonly runId: string,
    public readonly staleAttempt: number,
    public readonly currentAttempt: number,
  ) {
    super(
      `stale attempt for workflow run ${runId}: attempt ${staleAttempt} is no longer current (current: ${currentAttempt})`,
    );
    this.name = 'WorkflowFenceError';
  }
}

export interface WorkflowStore {
  /** Insert a new run row if absent; if a row with this id already exists, return it unchanged. */
  createRun(
    runId: string,
    params: RunParams,
    definition: unknown,
    definitionVersionId: string,
  ): Promise<WorkflowRun>;

  getRun(runId: string): Promise<WorkflowRun | null>;

  /**
   * CAS `pending|parked → running`, recording `ownerId` and a lease expiring
   * in `leaseMs`, and incrementing the run's `attempt`. Returns the new
   * attempt on success, `null` if the run does not exist or is not in a
   * claimable status.
   */
  claimRun(runId: string, ownerId: string, leaseMs: number): Promise<{ attempt: number } | null>;

  /** Renew the lease for the current owner/attempt. No-op (returns false) if the run isn't held by `ownerId`. */
  heartbeat(runId: string, ownerId: string, leaseMs: number): Promise<boolean>;

  /** Persist park state: `running → parked` with the accumulated `waitingOn`, fenced by `attempt`. */
  parkRun(runId: string, attempt: number, waitingOn: RunWaitCondition[], wakeAt?: number): Promise<void>;

  /** Mark the run as needing a wake pass regardless of its current waitingOn conditions. */
  requestWake(runId: string): Promise<void>;

  /** Move-forward semantics: keeps the earlier of the existing `wakeAt` and `at`. */
  scheduleWake(runId: string, at: number): Promise<void>;

  /** `running → terminalizing`, fenced by `attempt`, recording the pending outcome. */
  beginTerminalize(runId: string, attempt: number, outcome: 'completed' | 'failed' | 'cancelled'): Promise<void>;

  /** `terminalizing → settled`. Idempotent: calling again with the same outcome is a no-op. */
  settleRun(runId: string, outcome: 'completed' | 'failed' | 'cancelled'): Promise<void>;

  /** Runs that are wake-requested, have a due timer, or have an expired lease. */
  listRunnable(now: number, limit: number): Promise<WorkflowRun[]>;

  /**
   * Insert a checkpoint in `intent` status, or CAS-replace an existing
   * `intent` row whose `attempt` is lower than `cp.attempt` (higher attempt
   * wins). Rejects with `WorkflowFenceError` if a terminal row already
   * exists for this key, or if an existing `intent` row's attempt is >=
   * `cp.attempt`.
   */
  putIntent(cp: NodeCheckpoint): Promise<void>;

  /**
   * CAS-transition the `(runId, nodeId, iteration)` row's own `intent`
   * checkpoint (matching `attempt`) to `terminal` (`completed`/`failed`/
   * `skipped`, carrying `result`/`error`/`effects`). Terminal rows are
   * immutable: if a terminal row already exists, this is a no-op if it was
   * written by the same attempt (idempotent replay) and throws
   * `WorkflowFenceError` for a stale attempt's late write.
   */
  completeCheckpoint(
    runId: string,
    nodeId: string,
    iteration: number,
    attempt: number,
    terminal: NodeCheckpoint,
  ): Promise<void>;

  getCheckpoints(runId: string): Promise<NodeCheckpoint[]>;

  /** Idempotent by `signalId`: inserting a duplicate returns the existing row rather than erroring. */
  insertSignal(signal: RunSignal): Promise<RunSignal>;

  /**
   * Atomically CAS `consumedAt` on the signal (only if currently
   * unconsumed) and write the terminal checkpoint — both succeed or
   * neither does.
   */
  consumeSignalAndCheckpoint(
    signalId: string,
    consumedBy: { nodeId: string; iteration: number; attempt: number },
    checkpoint: NodeCheckpoint,
  ): Promise<void>;

  listSignals(runId: string, opts?: { unconsumed?: boolean }): Promise<RunSignal[]>;

  /** Re-delivery: clear `consumedAt`/`consumedBy` on a signal whose consumption produced no checkpoint. */
  voidConsumption(signalId: string): Promise<void>;
}
