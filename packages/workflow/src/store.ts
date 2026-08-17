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
  | { kind: 'submission'; nodeId: string; sessionId: string; threadId: string; queueItemId: string }
  | { kind: 'run'; nodeId: string; runId: string };

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
  /**
   * Set when this run was started by a `workflow` node in another run
   * (batch-fanout design decision 1). `parentRunId` wires settle-time
   * wake-up of the parent; `parentNodeId`/`parentIteration` name the exact
   * checkpoint waiting on this run. Absent on every top-level run.
   */
  parentRunId?: string;
  parentNodeId?: string;
  parentIteration?: number;
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
  /**
   * Principal ownership (who this run belongs to for access-control
   * purposes) — distinct from `RunParkState.ownerId`, which is the
   * claim-lease owner (a worker instance id). Optional: a caller that
   * doesn't pass `owner` to `createRun` gets an unset owner.
   */
  owner?: { ownerType: string; ownerId: string };
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

/**
 * The run fields a list view needs. Deliberately excludes `definition` and
 * `params` — both are jsonb snapshots, and dragging them back for every row
 * is the cost `listRuns` exists to remove.
 */
export interface WorkflowRunListItem {
  runId: string;
  workflowId: string;
  status: RunParkState['status'];
  outcome?: RunParkState['outcome'];
  createdAt: number;
  updatedAt: number;
  owner?: { ownerType: string; ownerId: string };
  /** What a parked run is blocked on. Carried on the list item so a run
   * list can name the gate without a per-run fetch. Empty unless parked. */
  waitingOn: RunWaitCondition[];
  /** Lifted out of `RunParams` so a batch parent's children are one query. */
  parentRunId?: string;
  parentNodeId?: string;
  parentIteration?: number;
}

/** Filter for `listRuns`. Every field is optional except `limit`. */
export interface ListRunsFilter {
  /** Any-of. Omit to read every workflow's runs. */
  workflowIds?: string[];
  /** Any-of. */
  status?: RunParkState['status'][];
  /** Any-of. Runs with no outcome yet never match. */
  outcome?: NonNullable<RunParkState['outcome']>[];
  /** Children of one parent run (batch tracking). */
  parentRunId?: string;
  /** `createdAt >= since`. */
  since?: number;
  limit: number;
  /** A previous page's `nextCursor`, passed back unchanged. */
  cursor?: string;
}

export interface ListRunsPage {
  runs: WorkflowRunListItem[];
  /** Absent on the last page. */
  nextCursor?: string;
}

/**
 * Keyset cursor for `listRuns`. The run id is part of the key because a
 * 250-item fan-out creates many runs in the same millisecond — `createdAt`
 * alone would skip or repeat rows across pages.
 */
export function encodeRunCursor(item: { createdAt: number; runId: string }): string {
  return `${item.createdAt}:${item.runId}`;
}

/** Thrown by `decodeRunCursor` for a cursor a store cannot read. */
export class WorkflowCursorError extends Error {
  constructor(cursor: string) {
    super(
      `invalid workflow run cursor ${JSON.stringify(cursor)} — pass back the ` +
        `nextCursor value from the previous page unchanged, or omit it to start at the newest run`,
    );
    this.name = 'WorkflowCursorError';
  }
}

export function decodeRunCursor(cursor: string): { createdAt: number; runId: string } {
  const split = cursor.indexOf(':');
  if (split <= 0) throw new WorkflowCursorError(cursor);
  const createdAt = Number(cursor.slice(0, split));
  const runId = cursor.slice(split + 1);
  // `createdAt` must be a safe integer, not merely finite: a store that keeps
  // it in an integer column rejects `1.5` or `1e+30` with a driver error the
  // caller cannot act on, and this codec is the only place both stores agree.
  if (!Number.isSafeInteger(createdAt) || runId === '') throw new WorkflowCursorError(cursor);
  return { createdAt, runId };
}

export interface WorkflowStore {
  /**
   * Insert a new run row if absent; if a row with this id already exists,
   * return it unchanged. `owner` records principal ownership (see
   * `WorkflowRun.owner`); when omitted the run has no recorded owner.
   */
  createRun(
    runId: string,
    params: RunParams,
    definition: unknown,
    definitionVersionId: string,
    owner?: { ownerType: string; ownerId: string },
  ): Promise<WorkflowRun>;

  getRun(runId: string): Promise<WorkflowRun | null>;

  /**
   * CAS `pending|parked → running`, recording `ownerId` and a lease expiring
   * in `leaseMs`, and incrementing the run's `attempt`. Also succeeds for a
   * `running` or `terminalizing` run whose lease has expired (crashed
   * owner) — this is the reclaim path for a dead worker. A reclaimed
   * `terminalizing` run stays `terminalizing` (the new owner resumes
   * terminal cleanup; its status is not reset to `running`); a reclaimed
   * `running` run is re-claimed as `running`. Both cases still bump
   * `attempt` and replace `ownerId`/`leaseExpiresAt`. Returns the new
   * attempt on success, `null` if the run does not exist or is not in a
   * claimable status (a `running`/`terminalizing` run with a live lease is
   * not claimable).
   */
  claimRun(runId: string, ownerId: string, leaseMs: number): Promise<{ attempt: number } | null>;

  /** Renew the lease for the current owner/attempt. No-op (returns false) if the run isn't held by `ownerId`. */
  heartbeat(runId: string, ownerId: string, leaseMs: number): Promise<boolean>;

  /**
   * Persist park state: `running → parked` with the accumulated
   * `waitingOn`, fenced by `attempt`. A parked run is unowned — this clears
   * `ownerId`/`leaseExpiresAt` so a stale lease can't make the parked run
   * look expired-lease-reclaimable.
   */
  parkRun(runId: string, attempt: number, waitingOn: RunWaitCondition[], wakeAt?: number): Promise<void>;

  /** Mark the run as needing a wake pass regardless of its current waitingOn conditions. */
  requestWake(runId: string): Promise<void>;

  /** Move-forward semantics: keeps the earlier of the existing `wakeAt` and `at`. */
  scheduleWake(runId: string, at: number): Promise<void>;

  /** `running → terminalizing`, fenced by `attempt`, recording the pending outcome. */
  beginTerminalize(runId: string, attempt: number, outcome: 'completed' | 'failed' | 'cancelled'): Promise<void>;

  /** `terminalizing → settled`. Idempotent: calling again with the same outcome is a no-op. */
  settleRun(runId: string, outcome: 'completed' | 'failed' | 'cancelled'): Promise<void>;

  /**
   * Runs that are wake-requested, have a due timer, or have an expired
   * lease. The expired-lease case includes `pending`/`parked` runs as well
   * as `running`/`terminalizing` runs whose lease has expired (crashed
   * owner) — those are listed so a new worker can reclaim them via
   * `claimRun`. A `running`/`terminalizing` run with a live lease is never
   * included.
   */
  listRunnable(now: number, limit: number): Promise<WorkflowRun[]>;

  /**
   * Runs with status `parked`, oldest-`updatedAt` first, up to `limit`. This
   * is the durable enumeration source for a host's lost-wake sweep: unlike
   * `listRunnable` (which is filtered to wake-requested/due-timer/expired
   * -lease), `listParked` surfaces every parked run so the sweep can
   * independently evaluate its own wake sources — unconsumed signals,
   * settled submissions, uncheckpointed consumption — against each one.
   * Critically, this includes a run parked before the current process
   * started: the sweep must not depend on any host-local, in-memory record
   * of which runs exist, since a freshly-restarted host has none.
   */
  listParked(limit: number): Promise<WorkflowRun[]>;

  /**
   * Newest-first page of run summaries, keyset-paginated. This is the read
   * path for run lists (batch-fanout design decision 5): a batch parent's
   * children are one query through `parentRunId`, instead of one `getRun`
   * per row.
   *
   * The filter carries no owner field on purpose — the port stays free of
   * team-membership semantics. A caller that must scope by principal
   * resolves the workflow ids it may read and passes them in `workflowIds`.
   */
  listRuns(filter: ListRunsFilter): Promise<ListRunsPage>;

  /**
   * Insert a checkpoint in `intent` status, or CAS-replace an existing
   * `intent` row whose `attempt` is lower than `cp.attempt` (higher attempt
   * wins); an existing `intent` row with `attempt` equal to `cp.attempt` is
   * also overwritten (an executor re-writing its own intent, e.g. to add
   * receipt effects, is not a conflict). Rejects with `WorkflowFenceError`
   * if a terminal row already exists for this key, if an existing `intent`
   * row's attempt is greater than `cp.attempt`, or — the run-level fence —
   * if `cp.attempt` is lower than the run's current `attempt` (catches a
   * zombie writer creating a brand-new row with no prior row to CAS
   * against).
   */
  putIntent(cp: NodeCheckpoint): Promise<void>;

  /**
   * CAS-transition the `(runId, nodeId, iteration)` row's own `intent`
   * checkpoint (matching `attempt`) to `terminal` (`completed`/`failed`/
   * `skipped`, carrying `result`/`error`/`effects`). Terminal rows are
   * immutable: if a terminal row already exists, this is a no-op if it was
   * written by the same attempt (idempotent replay) and throws
   * `WorkflowFenceError` for a stale attempt's late write. Also throws
   * `WorkflowFenceError` — the run-level fence — if `attempt` is lower
   * than the run's current `attempt`.
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
   * neither does. Subject to the same checkpoint-row and run-level
   * `attempt` fences as `completeCheckpoint` (rejects a lower-attempt
   * write against an existing higher-attempt intent row, and rejects if
   * the write's `attempt` is lower than the run's current `attempt`).
   *
   * Consumption itself is also fenced: if the signal is already consumed,
   * this call is idempotent (resolves without error) when `consumedBy`
   * matches the recorded consumption exactly (same attempt replaying its
   * own write), and otherwise throws `WorkflowFenceError` — an
   * already-consumed signal can never be consumed a second time by a
   * different node/iteration/attempt, even one with a currently-valid
   * (non-stale) attempt.
   */
  consumeSignalAndCheckpoint(
    signalId: string,
    consumedBy: { nodeId: string; iteration: number; attempt: number },
    checkpoint: NodeCheckpoint,
  ): Promise<void>;

  listSignals(runId: string, opts?: { unconsumed?: boolean }): Promise<RunSignal[]>;

  /**
   * Re-delivery: clear `consumedAt`/`consumedBy` on a signal whose
   * consumption produced no checkpoint. Scoped by `runId` (in addition to
   * `signalId`) so voiding a signal on one run can never touch a
   * same-`signalId` row belonging to a different run.
   */
  voidConsumption(runId: string, signalId: string): Promise<void>;
}
