/**
 * `LocalRunHost` (Phase 5 plan decision 16, Task 8) — the leased worker-loop
 * implementation of the run-host design spec's `RunHost` port
 * (`docs/specs/2026-07-11-workflow-run-host-design.md` §"RunHost Port")
 * over a `WorkflowStore`. Portable: only `setInterval`/`setTimeout` (the
 * platform-timer relaxation CLAUDE.md and the plan's Global Constraints
 * grant to the host layer specifically), no other Node-only API.
 *
 * ## Port deviation: `start` takes a `definition`
 *
 * The spec's `RunHost.start(runId, params)` doesn't carry the workflow
 * definition snapshot, but `WorkflowStore.createRun` requires one (the run
 * row snapshots the definition it was started against — plan decision 17).
 * `params.definitionVersionId` names *which* version but not its content.
 * `LocalRunHost.start` therefore takes a third `definition` argument; this
 * is a concrete-class widening of the abstract port, not a narrowing — any
 * caller satisfying the wider signature also satisfies the spec's minimal
 * one conceptually (the extra argument is exactly the piece a real host
 * needs to resolve from a workflow-definitions table before calling
 * `start`, e.g. `packages/api`'s route handler in Task 10).
 *
 * ## Sweep enumeration: store-driven, not host-local
 *
 * The sweep is the durable backstop for every wake — including a run that
 * parked on a submission wait, then the process crashed and restarted
 * before it ever saw that run. A host-local record of "runs I've seen"
 * (e.g. an in-memory set populated on `start`/`wake`/`scheduleWake`/
 * `terminate`) is empty after a restart, so it can never be the sweep's
 * enumeration source — that would leave exactly the run a lost-wake sweep
 * exists to protect permanently un-swept. Instead the sweep enumerates via
 * `store.listParked(...)`, the store's durable "every parked run" query
 * (`listRunnable` is unsuitable: it's filtered to its own narrow
 * wake-requested/due-timer/expired-lease criteria, which is exactly what
 * the sweep exists to go *beyond* — unconsumed signals and settled
 * submissions are invisible to `listRunnable` by design). This makes the
 * sweep correct for a freshly-restarted process with zero in-memory state,
 * which is the whole point of a durable backstop.
 *
 * ## Worker loop
 *
 * `startHost()` begins two independent real-timer loops:
 *   - **poll** (`pollMs`, default 1s): `listRunnable` up to remaining
 *     concurrency, `claimRun` each, drive with a `heartbeatMs` heartbeat,
 *     handle the park result. `wake`/`scheduleWake`/`terminate` all nudge
 *     the poll loop immediately in-process (`requestWake`/`scheduleWake`
 *     write through the store, then a direct `pollOnce()` call), so the 1s
 *     interval is a floor on staleness, not the primary delivery path.
 *   - **sweep** (`sweepMs`, default 15s, spec bound ≤60s): the lost-wake
 *     backstop, enumerated via `store.listParked` — see "Sweep enumeration"
 *     above.
 *
 * `stopHost()` clears both interval timers and awaits every in-flight
 * drive so a caller can shut down cleanly without a drive being cut off
 * mid-write.
 */

import { driveUntilPark } from './interpreter.js';
import type { WorkflowEngineDeps } from './engine-deps.js';
import type { NodeExecutorRegistry, OnApprovalPending } from './nodes/index.js';
import type { RunParams, RunParkState, RunWaitCondition, WorkflowStore } from './store.js';

/** The spec's `RunHost` port, widened per the "Port deviation" note above, plus lifecycle. */
export interface RunHost {
  /** Begin executing a run. Idempotent by runId: re-starting an existing run is a no-op. */
  start(runId: string, params: RunParams, definition: unknown): Promise<void>;
  /** Resume a parked run now. Spurious wakes are safe. */
  wake(runId: string): Promise<void>;
  /** Durable timer. Move-forward: keeps the earlier of an existing scheduled wake and `at`. */
  scheduleWake(runId: string, at: number): Promise<void>;
  /** Hard stop: writes a `cancel` signal and wakes the run for cancellation reconciliation. */
  terminate(runId: string): Promise<void>;
  /** Start the background poll + sweep loops. */
  startHost(): void;
  /** Stop the loops and await every in-flight drive. */
  stopHost(): Promise<void>;
}

export interface LocalRunHostDeps {
  store: WorkflowStore;
  engine: WorkflowEngineDeps;
  executors?: NodeExecutorRegistry;
  clock?: () => number;
  onApprovalPending?: OnApprovalPending;
  /** Max concurrently-driven runs. Default 4 (decision 16). */
  concurrency?: number;
  /** Poll interval in ms. Default 1000 (decision 16). */
  pollMs?: number;
  /** Claim lease duration in ms. Default 30_000 (decision 16). */
  leaseMs?: number;
  /** Heartbeat interval while driving, in ms. Default 10_000 (decision 16). */
  heartbeatMs?: number;
  /** Lost-wake sweep interval in ms. Default 15_000; spec bound is ≤60_000. */
  sweepMs?: number;
  /** Test-only crash-point hook (decision 20). */
  crashAt?: 'terminalizing';
  /** Test-only injectable process exit; defaults to real `process.exit`. */
  exit?: (code: number) => never;
}

function defaultExit(code: number): never {
  process.exit(code);
}

export class LocalRunHost implements RunHost {
  private readonly store: WorkflowStore;
  private readonly engine: WorkflowEngineDeps;
  private readonly executors?: NodeExecutorRegistry;
  private readonly clock: () => number;
  private readonly onApprovalPending?: OnApprovalPending;
  private readonly concurrency: number;
  private readonly pollMs: number;
  private readonly leaseMs: number;
  private readonly heartbeatMs: number;
  private readonly sweepMs: number;
  private readonly crashAt?: 'terminalizing';
  private readonly exit: (code: number) => never;

  private readonly ownerId = `local-${Math.random().toString(36).slice(2)}-${Date.now()}`;
  /** Dedupe key `${runId}:${queueItemId}` — one background waiter per submission wait, even across re-parks. */
  private readonly submissionWaiters = new Set<string>();
  /** In-flight background submission-waiter promises. Tracked so `stopHost` can drop them without awaiting an unbounded wait. */
  private readonly waiterPromises = new Set<Promise<void>>();
  /** RunIds currently claimed and being driven by this host — concurrency accounting + double-claim guard. */
  private readonly inFlight = new Set<string>();
  /** In-flight drive promises, awaited by `stopHost` for clean shutdown. */
  private readonly activeDrives = new Set<Promise<void>>();
  /** How many parked runs a single sweep pass enumerates via `store.listParked`. */
  private readonly sweepBatchLimit = 1_000;

  private pollTimer?: ReturnType<typeof setInterval>;
  private sweepTimer?: ReturnType<typeof setInterval>;
  private running = false;
  private polling = false;
  private pollAgain = false;

  constructor(deps: LocalRunHostDeps) {
    this.store = deps.store;
    this.engine = deps.engine;
    this.executors = deps.executors;
    this.clock = deps.clock ?? (() => Date.now());
    this.onApprovalPending = deps.onApprovalPending;
    this.concurrency = deps.concurrency ?? 4;
    this.pollMs = deps.pollMs ?? 1_000;
    this.leaseMs = deps.leaseMs ?? 30_000;
    this.heartbeatMs = deps.heartbeatMs ?? 10_000;
    this.sweepMs = deps.sweepMs ?? 15_000;
    this.crashAt = deps.crashAt;
    this.exit = deps.exit ?? defaultExit;
  }

  // ─── RunHost port ────────────────────────────────────────────────────────

  async start(runId: string, params: RunParams, definition: unknown): Promise<void> {
    if (!this.running) return;
    await this.store.createRun(runId, params, definition, params.definitionVersionId);
    await this.wake(runId);
  }

  async wake(runId: string): Promise<void> {
    if (!this.running) return;
    await this.store.requestWake(runId);
    this.nudge();
  }

  async scheduleWake(runId: string, at: number): Promise<void> {
    if (!this.running) return;
    await this.store.scheduleWake(runId, at);
    this.nudge();
  }

  async terminate(runId: string): Promise<void> {
    if (!this.running) return;
    await this.store.insertSignal({
      runId,
      signalId: 'cancel',
      signalType: 'cancel',
      createdAt: this.clock(),
    });
    await this.wake(runId);
  }

  // ─── Lifecycle ───────────────────────────────────────────────────────────

  startHost(): void {
    if (this.running) return;
    this.running = true;
    this.pollTimer = setInterval(() => this.nudge(), this.pollMs);
    this.sweepTimer = setInterval(() => {
      void this.sweepOnce();
    }, this.sweepMs);
    this.nudge();
  }

  async stopHost(): Promise<void> {
    this.running = false;
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.pollTimer = undefined;
    this.sweepTimer = undefined;
    await Promise.all([...this.activeDrives]);
    // Background submission waiters aren't cancellable (they're awaiting a
    // third-party promise), but they're now gated on `running` and can no
    // longer trigger a drive — drop them from tracking rather than await an
    // unbounded external wait during shutdown.
    this.waiterPromises.clear();
    this.submissionWaiters.clear();
  }

  // ─── Poll loop ───────────────────────────────────────────────────────────

  private nudge(): void {
    if (!this.running) return;
    void this.pollOnce();
  }

  private async pollOnce(): Promise<void> {
    if (!this.running) return;
    if (this.polling) {
      this.pollAgain = true;
      return;
    }
    this.polling = true;
    try {
      do {
        this.pollAgain = false;
        if (!this.running) break;
        const capacity = this.concurrency - this.inFlight.size;
        if (capacity <= 0) break;
        const runnable = await this.store.listRunnable(this.clock(), capacity);
        // Re-check after the await: stopHost may have run while suspended,
        // and a drive started past this point would escape its Promise.all.
        if (!this.running) break;
        for (const run of runnable) {
          if (this.inFlight.has(run.runId)) continue;
          this.claimAndDrive(run.runId);
        }
      } while (this.pollAgain);
    } finally {
      this.polling = false;
    }
  }

  private claimAndDrive(runId: string): void {
    if (this.inFlight.has(runId)) return;
    this.inFlight.add(runId);
    const p = this.driveRun(runId).finally(() => {
      this.inFlight.delete(runId);
    });
    this.activeDrives.add(p);
    void p.finally(() => this.activeDrives.delete(p));
  }

  private async driveRun(runId: string): Promise<void> {
    const claim = await this.store.claimRun(runId, this.ownerId, this.leaseMs);
    if (!claim) return; // lost the claim race to another owner

    const heartbeat = setInterval(() => {
      void this.store.heartbeat(runId, this.ownerId, this.leaseMs);
    }, this.heartbeatMs);

    try {
      const park = await driveUntilPark(runId, claim.attempt, {
        store: this.store,
        engine: this.engine,
        clock: this.clock,
        executors: this.executors,
        onApprovalPending: this.onApprovalPending,
        onBeginTerminalize:
          this.crashAt === 'terminalizing'
            ? () => {
                this.exit(137);
              }
            : undefined,
      });
      await this.afterPark(runId, park);
    } catch {
      // Any failure here — a `WorkflowFenceError` from a superseded attempt,
      // a genuine executor error, or (decision 20) the crash hook's thrown
      // `exit` — is swallowed. The lease is abandoned as-is; either the
      // sweep, a future poll's expired-lease reclaim, or an external wake
      // will pick the run back up. There is nothing safe to do with the
      // error here that the next claim attempt doesn't already handle.
    } finally {
      clearInterval(heartbeat);
    }
  }

  /** After a park: schedule signal-timeout wakes (pinned requirement) and spawn submission background waiters. */
  private async afterPark(runId: string, park: RunParkState): Promise<void> {
    if (park.status !== 'parked') return;
    for (const wait of park.waitingOn) {
      if (wait.kind === 'signal' && wait.timeoutAt !== undefined) {
        // Pinned requirement: `parkRun`'s own `wakeAt` derivation only
        // considers `timer` waits (interpreter.ts `earliestTimerWake`), so a
        // signal wait's `timeoutAt` never reaches `run.wakeAt` on its own —
        // an approval timeout would otherwise never be promoted to a due
        // timer. `scheduleWake`'s move-forward semantics make this call
        // idempotent/safe to repeat on every re-park.
        await this.store.scheduleWake(runId, wait.timeoutAt);
      }
      if (wait.kind === 'submission') {
        this.spawnSubmissionWaiter(runId, wait);
      }
    }
  }

  private spawnSubmissionWaiter(runId: string, wait: Extract<RunWaitCondition, { kind: 'submission' }>): void {
    const key = `${runId}:${wait.queueItemId}`;
    if (this.submissionWaiters.has(key)) return;
    this.submissionWaiters.add(key);
    const p = this.engine
      .awaitResult(wait.sessionId, wait.threadId, wait.queueItemId)
      .then(() => {
        // Gate on `running`: after `stopHost()`, a waiter that resolves
        // must not trigger a new drive. `wake()` already no-ops when
        // `!running`, but checking here too avoids even the wasted
        // store round-trip a no-op `wake()` call would still make.
        if (!this.running) return;
        return this.wake(runId);
      })
      .catch(() => {
        // Best-effort: a waiter failure (e.g. the engine handle went away)
        // is not fatal — the lost-wake sweep's `isSettled` check is the
        // backstop for exactly this case.
      })
      .finally(() => {
        this.submissionWaiters.delete(key);
        this.waiterPromises.delete(p);
      });
    this.waiterPromises.add(p);
  }

  // ─── Lost-wake sweep ─────────────────────────────────────────────────────

  private async sweepOnce(): Promise<void> {
    const now = this.clock();
    const parked = await this.store.listParked(this.sweepBatchLimit);
    for (const run of parked) {
      let shouldWake = false;

      if (this.hasDueTimerWait(run.waitingOn, now)) shouldWake = true;
      if (!shouldWake && (await this.hasUnconsumedCancelOrMatchingSignal(run.runId, run.waitingOn))) shouldWake = true;
      if (!shouldWake && (await this.hasSettledSubmissionWait(run.waitingOn))) shouldWake = true;
      if (!shouldWake && (await this.reconcileUncheckpointedConsumption(run.runId))) shouldWake = true;

      if (shouldWake) await this.wake(run.runId);
    }
  }

  private hasDueTimerWait(waitingOn: RunWaitCondition[], now: number): boolean {
    for (const wait of waitingOn) {
      if (wait.kind === 'timer' && wait.wakeAt <= now) return true;
      if (wait.kind === 'signal' && wait.timeoutAt !== undefined && wait.timeoutAt <= now) return true;
    }
    return false;
  }

  /**
   * An unconsumed `cancel` signal must wake the run regardless of what it's
   * currently `waitingOn` — a `terminate()` call can land while a run is
   * parked purely on a `submission` wait (no `signal` wait present at all),
   * and that cancel still needs to reach cancellation reconciliation via the
   * sweep if the direct `wake()` from `terminate()` was lost. A non-cancel
   * signal only matters if it matches one of the run's own signal waits.
   */
  private async hasUnconsumedCancelOrMatchingSignal(runId: string, waitingOn: RunWaitCondition[]): Promise<boolean> {
    const unconsumed = await this.store.listSignals(runId, { unconsumed: true });
    if (unconsumed.length === 0) return false;
    const signalWaits = waitingOn.filter((w): w is Extract<RunWaitCondition, { kind: 'signal' }> => w.kind === 'signal');
    return unconsumed.some((s) => s.signalType === 'cancel' || signalWaits.some((w) => w.signalType === s.signalType));
  }

  private async hasSettledSubmissionWait(waitingOn: RunWaitCondition[]): Promise<boolean> {
    for (const wait of waitingOn) {
      if (wait.kind !== 'submission') continue;
      if (await this.engine.isSettled(wait.sessionId, wait.queueItemId)) return true;
    }
    return false;
  }

  /**
   * Re-delivery rule: a signal whose `consumedBy` references an attempt
   * that produced no matching terminal checkpoint (crash between the
   * atomic consume+checkpoint's two effects on a backend that can't share
   * a transaction, or a superseded attempt's consume that never landed its
   * checkpoint) is voided back to unconsumed and the run is woken so the
   * next drive re-delivers it.
   */
  private async reconcileUncheckpointedConsumption(runId: string): Promise<boolean> {
    const signals = await this.store.listSignals(runId);
    if (signals.every((s) => s.consumedAt === undefined || !s.consumedBy)) return false;
    const checkpoints = await this.store.getCheckpoints(runId);
    let voided = false;
    for (const signal of signals) {
      if (signal.consumedAt === undefined || !signal.consumedBy) continue;
      const cp = checkpoints.find(
        (c) => c.nodeId === signal.consumedBy?.nodeId && c.iteration === signal.consumedBy?.iteration,
      );
      const hasMatchingTerminal = cp !== undefined && cp.status !== 'intent' && cp.attempt === signal.consumedBy.attempt;
      if (!hasMatchingTerminal) {
        await this.store.voidConsumption(signal.signalId);
        voided = true;
      }
    }
    return voided;
  }
}
