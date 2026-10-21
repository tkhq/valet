import { eq } from "drizzle-orm";
import {
  recordLeaseNodeSeconds,
  recordLeaseOrphanReleased,
  recordLeasesActive,
  recordLeasesOverDeadline,
  recordLeasesUnannotated,
  recordWakeupBadRow,
  recordWakeupEnded,
  recordWakeupSignalLost,
  recordWakeupKillFailed,
  recordWakeupsActive,
  recordWakeupSweepFailed,
  recordWakeupSweepOk,
} from "@valet/engine";
import type {
  ChannelOrigin,
  EventMatchDigest,
  JobPollOpts,
  Lease,
  LeaseOwnerKind,
  PromptContent,
  PromptOptions,
  Sandbox,
  SandboxProvider,
  SessionStore,
  Wakeup,
  WakeupCause,
  WakeupCursor,
  WakeupKind,
  WakeupLimits,
  WakeupStatus,
} from "@valet/engine";
import type { EventWaiterDerive } from "../events/derive.js";
import { derivedClausesAccept } from "../events/waiter-match.js";
import type { AppDb } from "../lib/drizzle.js";
import { startSweepTimer, type SweepTimer } from "../lib/sweep-timer.js";
import { agentSessions } from "../schema/index.js";
import type { SessionMeta } from "./host.js";
import { loadSessionMeta } from "./session-meta.js";
import {
  decideDeliveredWaiter,
  decideEventWaiter,
  decideWakeup,
  LOG_TAIL_BYTES,
  PENDING_START_GRACE_MS,
  WATCH_READ_BYTES,
  type DecideOptions,
  type SignalDraft,
  type WakeupDecision,
  type WakeupProbe,
} from "./wake-watcher-decide.js";
import { isSandboxGone } from "./wakeups-admin.js";

/** Default tick interval (spec B5). */
export const WAKE_WATCHER_INTERVAL_MS = 30_000;
/** Max due rows one page reads (spec B5). A tick reads every page. */
export const WAKE_WATCHER_BATCH = 200;
/**
 * Most event waiters whose derive step runs at once (event wakeups spec,
 * Part F step 1). A derive can take its whole 20 s deadline, so one at a
 * time would let a few slow waiters hold the pass for minutes.
 */
export const EVENT_DERIVE_CONCURRENCY = 4;

const TERMINAL: readonly WakeupStatus[] = ["done", "cancelled", "expired", "lost"];
const WAKEUP_KINDS: readonly WakeupKind[] = ["process", "watch", "timer", "event"];
const LEASE_OWNER_KINDS: readonly LeaseOwnerKind[] = ["process", "watch", "hold"];

/** The slice of an engine `Session` the watcher uses. */
export interface WakeWatcherSession {
  prompt(content: PromptContent, opts: PromptOptions): Promise<unknown>;
  /** The loaded thread with this id, or null when the session has none. */
  threadById(id: string): object | null;
  attachment: { current(): Sandbox | null };
}

/** The slice of `EngineHost` the watcher uses. */
export interface WakeWatcherHost {
  sessionFor(sessionId: string, meta: SessionMeta): Promise<WakeWatcherSession>;
  liveSession(sessionId: string): WakeWatcherSession | null;
}

/** Why the watcher released a process or watch lease outside the row's own transition. */
type OrphanReleaseReason = Parameters<typeof recordLeaseOrphanReleased>[1];

/** The counters the watcher records. Tests inject spies. */
export interface WakeWatcherMetrics {
  wakeupEnded(kind: WakeupKind, cause: WakeupCause): void;
  signalLost(kind: WakeupKind | "hold"): void;
  /** A best-effort kill after a terminal transition threw; the process may run untracked. */
  killFailed(kind: WakeupKind): void;
  leasesUnannotated(count: number): void;
  orphanReleased(ownerKind: LeaseOwnerKind, reason: OrphanReleaseReason): void;
  nodeSeconds(ownerKind: LeaseOwnerKind, seconds: number): void;
  wakeupsActive(kind: WakeupKind, count: number): void;
  sweepOk(unixSeconds: number): void;
  sweepFailed(): void;
  leasesOverDeadline(count: number): void;
  badRow(table: "engine_wakeups" | "engine_leases"): void;
}

const DEFAULT_METRICS: WakeWatcherMetrics = {
  wakeupEnded: recordWakeupEnded,
  signalLost: recordWakeupSignalLost,
  killFailed: recordWakeupKillFailed,
  leasesUnannotated: recordLeasesUnannotated,
  orphanReleased: recordLeaseOrphanReleased,
  nodeSeconds: recordLeaseNodeSeconds,
  wakeupsActive: recordWakeupsActive,
  sweepOk: recordWakeupSweepOk,
  sweepFailed: recordWakeupSweepFailed,
  leasesOverDeadline: recordLeasesOverDeadline,
  badRow: recordWakeupBadRow,
};

interface WakeWatcherBaseDeps {
  engineStore: SessionStore;
  engineHost: WakeWatcherHost;
  provider: Pick<SandboxProvider, "restore" | "setEvictionProtection" | "listEvictionProtected">;
  limits: WakeupLimits;
  /**
   * The in-sandbox job log directory, for the `logPath` signal attribute.
   * Set it only for a provider that writes job logs to files (kubernetes:
   * `/tmp/valet-jobs`). Absent, signals carry no `logPath`.
   */
  jobLogDir?: string;
  sweepIntervalMs?: number;
  /**
   * Resolves an event waiter digest marked `derive` (spec 2026-10-15, Part
   * F step 1). Production passes `productionEventWaiterDeriver`. Absent, a
   * marked digest stays buffered until the waiter ends, and each tick logs it.
   */
  deriveEvent?: EventWaiterDerive;
  /** Rows per `listDueWakeups` page. Defaults to `WAKE_WATCHER_BATCH`. */
  batchSize?: number;
  metrics?: Partial<WakeWatcherMetrics>;
  now?: () => number;
}

/**
 * `db` builds a cold session the way `ChildWatcher.attempt` does. Tests pass
 * `loadSession` instead, so they need no app database.
 */
export type WakeWatcherDeps = WakeWatcherBaseDeps &
  ({ db: AppDb; loadSession?: undefined } | { db?: undefined; loadSession: (sessionId: string) => Promise<WakeWatcherSession> });

/** Where a due process or watch row can be probed, or why it cannot. */
type ProbeTarget =
  | { kind: "sandbox"; sandbox: Sandbox }
  | { kind: "unavailable"; why: string }
  | { kind: "error"; why: string };

/** A lease's sandbox id, or why it has none. */
type LeaseSandbox = { kind: "id"; sandboxId: string } | { kind: "unavailable"; why: string } | { kind: "error"; why: string };

/**
 * Read bounds per kind (spec B4). A `process` needs only its log tail. A
 * `watch` reads forward, one bounded slice per tick.
 */
function readBounds(kind: "process" | "watch"): JobPollOpts {
  return kind === "process" ? { maxBytes: LOG_TAIL_BYTES, tail: true } : { maxBytes: WATCH_READ_BYTES };
}

/**
 * Api-side owner of every wakeup and lease (spec 2026-10-08, B5, B6, C5,
 * C6). Each tick probes due wakeups, applies `decideWakeup`, releases
 * leases with the row's CAS, delivers signals, expires leases, and
 * reconciles eviction protection. It reads all state from the store, so a
 * restart loses nothing.
 */
export class WakeWatcher {
  private timer: SweepTimer | null = null;
  private readonly intervalMs: number;
  private readonly batchSize: number;
  private readonly metrics: WakeWatcherMetrics;
  private readonly clock: () => number;
  private readonly loadSession: (sessionId: string) => Promise<WakeWatcherSession>;
  private readonly decideOptions: DecideOptions;
  /** When the previous pass's lease accounting ran, for `node_seconds`. */
  private lastPassAt: number | undefined;
  /** Set by `stop()`. A pass checks it before each row and stops there. */
  private stopping = false;
  /** Event waiters that ingest appended to since the last light pass read them. */
  private readonly nudged = new Set<string>();

  constructor(private readonly deps: WakeWatcherDeps) {
    this.intervalMs = deps.sweepIntervalMs ?? WAKE_WATCHER_INTERVAL_MS;
    this.batchSize = deps.batchSize ?? WAKE_WATCHER_BATCH;
    this.metrics = { ...DEFAULT_METRICS, ...deps.metrics };
    this.clock = deps.now ?? Date.now;
    this.decideOptions = {
      watchMaxEventsPerHour: deps.limits.watchMaxEventsPerHour,
      tickMs: this.intervalMs,
      leaseMaxHours: deps.limits.leaseMaxHours,
      ...(deps.limits.watchMinIntervalMs !== undefined ? { watchMinIntervalMs: deps.limits.watchMinIntervalMs } : {}),
      ...(deps.jobLogDir !== undefined ? { logDir: deps.jobLogDir } : {}),
    };
    if (deps.loadSession) {
      this.loadSession = deps.loadSession;
    } else {
      const db = deps.db;
      this.loadSession = (sessionId) => loadColdSession(db, deps.engineStore, deps.engineHost, sessionId);
    }
  }

  start(): void {
    if (this.timer || this.intervalMs <= 0) return;
    this.stopping = false;
    // The liveness series exists from the start, so a watcher that never
    // finishes a pass still trips the staleness alert (fix wave 3, data L3).
    this.metrics.sweepOk(Math.floor(this.clock() / 1000));
    this.timer = startSweepTimer("WakeWatcher", this.intervalMs, () => this.sweep(), { light: () => this.eventPass() });
  }

  /**
   * Stops the timer and resolves when the pass in flight ends. The pass
   * stops before its next row, so a shutdown waits for one row at most and
   * never cuts a row between its CAS and its delivery (fix wave 2, M3; fix
   * wave 3, concurrency M6).
   */
  async stop(): Promise<void> {
    this.stopping = true;
    const timer = this.timer;
    this.timer = null;
    await timer?.stop();
  }

  /**
   * Ends a once-mode event waiter after a claim redirect delivered its
   * matching event to the waiter's thread (spec 2026-10-16: delivery
   * threads and claims, Part C step 5). The dispatcher calls it after the
   * delivery lands, so the terminal signal queues behind the inbound
   * message. The row's CAS makes it safe to call again on a retry: a waiter
   * that already ended sends no second terminal signal (INV-E5). Returns
   * true when this call ended the waiter.
   */
  async endDeliveredWaiter(args: { waiterId: string; sessionId: string; threadId: string }): Promise<boolean> {
    const row = await this.deps.engineStore.getWakeup(args.waiterId);
    // A stamp names a waiter in the thread it delivered to. Any other row stays.
    if (!row || row.sessionId !== args.sessionId || row.threadId !== args.threadId) return false;
    const decision = decideDeliveredWaiter(this.clock(), row);
    if (!decision) return false;
    return (await this.applyDecision(row, decision, null, { pastCas: false })) !== null;
  }

  /**
   * Runs a light pass soon for event waiters that ingest just appended to
   * (spec 2026-10-15, Part E step 6). The light pass reads only those rows
   * by id: no due-row scan, no probe, no lease work. It never overlaps a
   * full pass: a nudge during a pass runs one light pass after it. Before
   * `start()` and after `stop()`, it does nothing.
   */
  nudge(wakeupIds: readonly string[]): void {
    if (!this.timer) return;
    for (const id of wakeupIds) this.nudged.add(id);
    this.timer.runLight();
  }

  /**
   * The nudge's light pass: the nudged event waiters that are still
   * running with a non-empty buffer, through the same event-row step as
   * the full pass. A nudged id that this pass misses (a crash, a stop)
   * stays due, and the next full pass reads it.
   */
  async eventPass(now: number = this.clock()): Promise<void> {
    const ids = [...this.nudged];
    this.nudged.clear();
    const rows: Wakeup[] = [];
    for (const id of ids) {
      if (this.stopping) return;
      try {
        const row = await this.deps.engineStore.getWakeup(id);
        if (row && row.kind === "event" && row.status === "running" && (row.eventBuffer ?? []).length > 0) rows.push(row);
      } catch (err) {
        console.error(`WakeWatcher: reading nudged event wakeup ${id} failed; the next full pass handles it:`, err);
      }
    }
    await this.processEventRows(now, rows);
  }

  /** One pass. Records its liveness: `sweep_ok_at` on success, `sweep_failed` on a throw (fix wave 2, M5). */
  async sweep(now: number = this.clock()): Promise<void> {
    try {
      await this.pass(now);
    } catch (err) {
      this.metrics.sweepFailed();
      throw err;
    }
    this.metrics.sweepOk(Math.floor(this.clock() / 1000));
  }

  private async pass(now: number): Promise<void> {
    // INV-6 is measured before this pass ends or repairs anything, so the
    // repair cannot hide the violation it repairs (fix wave 3, M2).
    const stale = now - 2 * this.intervalMs;
    const atStart = await this.deps.engineStore.listAllActiveLeases();
    this.metrics.leasesOverDeadline(atStart.filter((l) => l.deadlineAt < stale).length);

    // Page through every due row. A single fixed batch let old always-due
    // process rows starve newer timers once more than one batch was due.
    // The store's cursor counts unreadable rows too, so one bad row never
    // ends the scan early (fix wave 4, data N1).
    // Event waiters run after the other rows, so a slow derive never holds
    // up a process, watch, or timer row (spec 2026-10-15, Part F step 1).
    const eventRows: Wakeup[] = [];
    let after: WakeupCursor | undefined;
    for (;;) {
      const { rows, next } = await this.deps.engineStore.listDueWakeups(now, this.batchSize, after);
      for (const row of rows) {
        if (this.stopping) return;
        if (row.kind === "event") {
          eventRows.push(row);
          continue;
        }
        await this.guardedRow(row, (progress) => this.processRow(now, row, progress));
      }
      if (next === null) break;
      after = next;
    }
    await this.processEventRows(now, eventRows);
    if (this.stopping) return;
    // Every pending or running row, not just the due ones: a pending timer
    // is not due until it fires (fix wave 2, M11).
    const counts = await this.deps.engineStore.countWakeupsByKindAndStatus(["pending", "running"]);
    for (const kind of WAKEUP_KINDS) {
      this.metrics.wakeupsActive(kind, counts.filter((c) => c.kind === kind).reduce((n, c) => n + c.count, 0));
    }
    await this.expireLeases(now);
    // A shutdown that began during the lease pass skips the reconcile: its
    // patches add work to the shutdown budget (fix wave 4, concurrency M6).
    if (this.stopping) return;
    await this.reconcileLeases(now);
  }

  /** Runs one row's step and logs a throw, so one bad row never ends the pass. */
  private async guardedRow(row: Wakeup, step: (progress: { pastCas: boolean }) => Promise<void>): Promise<void> {
    const progress = { pastCas: false };
    try {
      await step(progress);
    } catch (err) {
      if (progress.pastCas) {
        console.error(`WakeWatcher: wakeup ${row.id} failed after its transition was stored:`, err);
      } else {
        console.error(`WakeWatcher: wakeup ${row.id} failed this tick; it stays due for the next tick:`, err);
      }
    }
  }

  /**
   * Due event waiters (spec 2026-10-15, Part F): the derive steps first,
   * at most `EVENT_DERIVE_CONCURRENCY` at once, then each row's decision
   * and delivery one at a time. Each row is one waiter, so two derive
   * steps never write the same row.
   */
  private async processEventRows(now: number, rows: readonly Wakeup[]): Promise<void> {
    const steps: Array<{ row: Wakeup | null; derived: boolean } | null> = rows.map(() => null);
    // One limit for every derive call of the pass, across rows and source commits.
    const limit = concurrencyLimit(EVENT_DERIVE_CONCURRENCY);
    await Promise.all(rows.map(async (row, index) => {
      try {
        steps[index] = await this.deriveStep(row, limit);
      } catch (err) {
        console.error(`WakeWatcher: derive step of event wakeup ${row.id} failed; it stays due for the next tick:`, err);
      }
    }));
    for (const [index, row] of rows.entries()) {
      if (this.stopping) return;
      const step = steps[index];
      if (!step?.row) continue;
      const current = step.row;
      // A derive can take up to its 20 s deadline, so the decision after one
      // reads the clock again instead of the pass start.
      const at = step.derived ? this.clock() : now;
      await this.guardedRow(row, (progress) => this.decideEventRow(at, current, progress));
    }
  }

  /** One due process, watch, or timer row. Event waiters go through `processEventRows`. */
  private async processRow(now: number, row: Wakeup, progress: { pastCas: boolean }): Promise<void> {
    if (row.kind === "event") return;
    let sandbox: Sandbox | null = null;
    let probe: WakeupProbe;
    if (row.kind === "timer" || (row.status === "pending" && now - row.createdAt < PENDING_START_GRACE_MS)) {
      // A timer runs no job, so nothing is probed. A pending process or
      // watch inside its start grace is not probed: the seam may still be
      // starting it.
      probe = { kind: "none" };
    } else if (row.execId === undefined) {
      console.error(`WakeWatcher: ${row.kind} wakeup ${row.id} has no execId; it expires at its deadline.`);
      probe = { kind: "error" };
    } else {
      try {
        const target = await this.probeTarget(row);
        if (target.kind === "unavailable") {
          console.warn(`WakeWatcher: wakeup ${row.id} cannot reach its sandbox: ${target.why}.`);
          probe = { kind: "unavailable" };
        } else if (target.kind === "error") {
          console.error(`WakeWatcher: wakeup ${row.id} was not probed: ${target.why}. It expires at its deadline.`);
          probe = { kind: "error" };
        } else if (!target.sandbox.pollJob) {
          console.error(`WakeWatcher: sandbox ${target.sandbox.id} has no job mode; cannot probe wakeup ${row.id}.`);
          probe = { kind: "error" };
        } else {
          sandbox = target.sandbox;
          const poll = await target.sandbox.pollJob(row.execId, row.logOffset, readBounds(row.kind));
          probe = {
            kind: "poll",
            status: poll.status,
            output: poll.output,
            nextOffset: poll.nextOffset,
            ...(poll.exitCode !== undefined ? { exitCode: poll.exitCode } : {}),
            ...(poll.truncated ? { truncated: true } : {}),
          };
        }
      } catch (err) {
        if (isSandboxGone(err)) {
          probe = { kind: "unavailable" };
        } else {
          console.error(`WakeWatcher: probe of wakeup ${row.id} failed; retrying next tick until its deadline:`, err);
          probe = { kind: "error" };
        }
      }
    }

    const decision = decideWakeup(now, row, probe, this.decideOptions);
    if (!decision) return;
    if (decision.badRow) {
      this.metrics.badRow("engine_wakeups");
      console.error(`WakeWatcher: ${row.kind} wakeup ${row.id} cannot be acted on as stored; it ends as ${decision.to}.`);
    }
    await this.applyDecision(row, decision, sandbox, progress);
  }

  /**
   * One event waiter after its derive step: `decideEventWaiter` through
   * the shared `applyDecision`. An event waiter runs no job, so it has no
   * probe, lease, or kill.
   */
  private async decideEventRow(now: number, row: Wakeup, progress: { pastCas: boolean }): Promise<void> {
    const decision = decideEventWaiter(now, row, this.decideOptions);
    if (!decision) return;
    if (decision.badRow) {
      this.metrics.badRow("engine_wakeups");
      console.error(`WakeWatcher: event wakeup ${row.id} has no match spec; it ends as ${decision.to}.`);
    }
    await this.applyDecision(row, decision, null, progress);
  }

  /**
   * Spec Part F step 1: at most one derive call per waiter, derive key, and
   * source commit per tick, for the latest digest of that group. A derive
   * reads the state of the source's own commit, so the latest source of a
   * commit answers for that commit's older sources, and never for another
   * commit's. A waiter indexed by its repository subject can hold sources
   * of other pull requests' commits; their `null` must not remove the
   * head commit's sources. The buffer changes only by key, never by a
   * whole-buffer write, so a digest that ingest appends meanwhile stays.
   *
   * Per group:
   * - `event`: remove the group's source digests, then append the derived
   *   digest when the `status` and `from_status` of a clause on the derived
   *   key accept it. Otherwise no signal. `appendEventMatch` refuses a
   *   derived key that the waiter already holds or delivered (INV-E4).
   * - `null`: remove the group's source digests. No signal.
   * - `error`: keep them for the next tick.
   *
   * `limit` bounds the derive calls of the whole pass. Returns the row to
   * decide on, or null when it is gone, and whether a derive call ran.
   */
  private async deriveStep(row: Wakeup, limit: ConcurrencyLimit): Promise<{ row: Wakeup | null; derived: boolean }> {
    const groups = deriveGroups(row.eventBuffer ?? []);
    if (groups.length === 0) return { row, derived: false };
    const deriveEvent = this.deps.deriveEvent;
    if (!deriveEvent) {
      console.error(`WakeWatcher: event wakeup ${row.id} holds ${groups[0]?.latest.derive} digests, but this watcher has no derive step; they stay buffered.`);
      return { row, derived: false };
    }
    let ran = false;
    await Promise.all(groups.map((group) => limit(async () => {
      if (this.stopping) return;
      ran = true;
      const { latest, sources } = group;
      let outcome: Awaited<ReturnType<EventWaiterDerive>>;
      try {
        outcome = await deriveEvent(row, latest);
      } catch (error) {
        outcome = { result: "error", error };
      }
      console.info("WakeWatcher: event waiter derivation", {
        waiterId: row.id, sourceDedupeKey: latest.dedupeKey, key: latest.derive, result: outcome.result,
      });
      if (outcome.result === "error") {
        console.warn(`WakeWatcher: derive of ${latest.derive} for event wakeup ${row.id} failed; ${outcome.consumeSource ? "consuming denied source" : "it retries next tick"}:`, outcome.error);
        if (outcome.consumeSource) await this.deps.engineStore.removeEventMatches(row.id, sources, this.clock(), "source");
        return;
      }
      const at = this.clock();
      await this.deps.engineStore.removeEventMatches(row.id, sources, at, "source");
      const key = latest.derive;
      if (outcome.result === "event" && key !== undefined && row.eventMatch && derivedClausesAccept(row.eventMatch, key, outcome.digest)) {
        await this.deps.engineStore.appendEventMatch(row.id, outcome.digest, at);
      }
    })));
    if (!ran) return { row, derived: false };
    return { row: await this.deps.engineStore.getWakeup(row.id), derived: true };
  }

  /**
   * Applies one decision: the CAS with its lease release, the kill, the
   * signals, and the end metric. Returns the updated row, or null when
   * another writer won the CAS.
   */
  private async applyDecision(
    row: Wakeup,
    decision: WakeupDecision,
    probed: Sandbox | null,
    progress: { pastCas: boolean },
  ): Promise<Wakeup | null> {
    let sandbox = probed;
    // The kill runs after the CAS (spec B5). Find its target first, while
    // the lease that names the sandbox is still active.
    if (decision.kill && !sandbox && row.execId !== undefined) {
      sandbox = await this.killTarget(row);
    }

    // Stamp the transition with the clock now, not the pass start: a pass
    // can run for minutes, and the ChildWatcher compares endedAt with
    // admission times (fix wave 3, concurrency M1).
    const at = this.clock();
    const patch = decision.patch.endedAt !== undefined ? { ...decision.patch, endedAt: at } : decision.patch;
    // The CAS and the lease release are one store write (fix wave 2, B2).
    // Null means another sweep or wakeup_cancel won the CAS (INV-5).
    const updated =
      decision.releaseLease && row.leaseId !== undefined
        ? await this.deps.engineStore.transitionWakeupAndReleaseLease(
            row.id,
            [row.status],
            decision.to,
            patch,
            at,
            decision.releaseLease,
          )
        : await this.deps.engineStore.transitionWakeup(row.id, [row.status], decision.to, patch, at);
    if (!updated) return null;
    progress.pastCas = true;

    // An event waiter in stream mode removes what it delivers, by key and
    // before the delivery: a digest that ingest appended after the read
    // stays, and a crash here loses a signal rather than sending it twice
    // (INV-E4, INV-E7). A failed removal rolls the emit back and throws
    // before any delivery, so the next tick sends the same digests once.
    if (decision.deliveredKeys && decision.deliveredKeys.length > 0) {
      try {
        await this.deps.engineStore.removeEventMatches(row.id, decision.deliveredKeys, at);
      } catch (err) {
        await this.rollBackEventEmit(row, at);
        throw err;
      }
    }

    for (const signal of decision.signals) {
      try {
        await this.deliver(updated.sessionId, updated.threadId, signal, updated.origin);
      } catch (err) {
        // The row is already terminal or advanced, so this signal is lost.
        // The counter and the log line are the only record (spec Deviations).
        this.metrics.signalLost(updated.kind);
        console.error(`WakeWatcher: delivery of ${signal.signalType} for wakeup ${row.id} failed; the signal is lost:`, err);
      }
    }

    // A lost CAS never reaches this kill, so a process that a cancel or
    // another sweep already ended is never killed twice. The kill runs
    // after the delivery: a kill exec can take a minute, and a shutdown
    // that cuts this row then loses the kill, not the signal (fix wave 4,
    // concurrency M6). The row is terminal by now, so nothing retries a
    // lost kill: the process runs untracked until its container stops.
    // The counter is the record, and an alert on it pages (spec Part G).
    if (decision.kill && sandbox?.cancelJob && row.execId !== undefined) {
      try {
        await sandbox.cancelJob(row.execId);
      } catch (err) {
        this.metrics.killFailed(updated.kind);
        console.error(`WakeWatcher: kill of wakeup ${row.id} (exec ${row.execId}) failed after the row moved to ${decision.to}:`, err);
      }
    }

    if (TERMINAL.includes(decision.to) && decision.cause) {
      this.metrics.wakeupEnded(updated.kind, decision.cause);
    }
    return updated;
  }

  /**
   * Undoes a stream emit's CAS after its removal failed, so the next tick
   * sends the same digests as the same event number and counts them once
   * in the rate window. A store patch cannot unset a field, so a first
   * emit's `lastEmitAt` goes back to 0, which the min-interval check reads
   * as long past. If the rollback also fails, the next tick can count one
   * extra signal; the log line is the record.
   */
  private async rollBackEventEmit(row: Wakeup, at: number): Promise<void> {
    try {
      await this.deps.engineStore.transitionWakeup(
        row.id,
        ["running"],
        "running",
        {
          eventCount: row.eventCount,
          lastEmitAt: row.lastEmitAt ?? 0,
          windowCount: row.windowCount ?? 0,
          ...(row.windowStartAt !== undefined ? { windowStartAt: row.windowStartAt } : {}),
        },
        at,
      );
    } catch (err) {
      console.error(`WakeWatcher: rollback of event wakeup ${row.id}'s emit failed; its next signal can count twice in the rate window:`, err);
    }
  }

  /** The sandbox to kill a row's job in, or null when none can be reached. */
  private async killTarget(row: Wakeup): Promise<Sandbox | null> {
    try {
      const target = await this.probeTarget(row);
      return target.kind === "sandbox" ? target.sandbox : null;
    } catch (err) {
      console.warn(`WakeWatcher: no sandbox to kill wakeup ${row.id} in:`, err);
      return null;
    }
  }

  /**
   * The sandbox the wakeup's lease names: the live session's ready handle
   * when it is that sandbox, else a restored handle. Neither path wakes or
   * provisions a sandbox. A row whose lease is gone is unavailable.
   */
  private async probeTarget(row: Wakeup): Promise<ProbeTarget> {
    if (row.leaseId === undefined) return { kind: "unavailable", why: "it has no lease" };
    const leases = await this.deps.engineStore.listActiveLeases(row.sessionId);
    const lease = leases.find((l) => l.id === row.leaseId);
    if (!lease) return { kind: "unavailable", why: `its lease ${row.leaseId} is no longer active` };
    const resolved = await this.leaseSandbox(lease);
    if (resolved.kind !== "id") return resolved;
    const live = this.deps.engineHost.liveSession(row.sessionId)?.attachment.current();
    if (live && live.id === resolved.sandboxId) return { kind: "sandbox", sandbox: live };
    return { kind: "sandbox", sandbox: await this.deps.provider.restore(resolved.sandboxId) };
  }

  /**
   * The lease's sandbox id. A lease created before its attachment knew the
   * id has none. That is expected in normal operation, so the id comes from
   * the live attachment or the session row and is written back to the lease.
   */
  private async leaseSandbox(lease: Lease): Promise<LeaseSandbox> {
    if (lease.sandboxId !== undefined) return { kind: "id", sandboxId: lease.sandboxId };
    let sandboxId = this.deps.engineHost.liveSession(lease.sessionId)?.attachment.current()?.id;
    if (sandboxId === undefined) {
      const session = await this.deps.engineStore.getSession(lease.sessionId);
      if (!session) return { kind: "unavailable", why: `session ${lease.sessionId} no longer exists` };
      sandboxId = session.sandboxId;
    }
    if (sandboxId === undefined) return { kind: "error", why: `lease ${lease.id} has no sandbox id yet` };
    try {
      await this.deps.engineStore.setLeaseSandboxId(lease.id, sandboxId);
    } catch (err) {
      console.error(`WakeWatcher: recording sandbox ${sandboxId} on lease ${lease.id} failed; resolving it again next tick:`, err);
    }
    return { kind: "id", sandboxId };
  }

  /**
   * Submits one signal. Targets `threadId` when the session has that thread;
   * otherwise targets the session's main thread (spec B5). A channel origin
   * rides along with manual replies, as `child.settled` does (fix wave 2,
   * H3): the agent can answer in the channel, and nothing auto-posts.
   */
  private async deliver(
    sessionId: string,
    threadId: string | undefined,
    draft: SignalDraft,
    origin: ChannelOrigin | undefined,
  ): Promise<void> {
    const session = this.deps.engineHost.liveSession(sessionId) ?? (await this.loadSession(sessionId));
    const content: PromptContent = {
      kind: "signal",
      signalType: draft.signalType,
      body: draft.body,
      attributes: draft.attributes,
      tagName: "wakeup",
      ...(origin !== undefined ? { origin: { ...origin, reply: "manual" } } : {}),
    };
    // A wake-up joins the running turn at its next step when it can, the
    // way a coding agent takes a finished background task mid-turn
    // (`QueueMode` `inject`); otherwise it runs after the turn.
    const base: PromptOptions = { dispatchId: draft.dispatchId, queueMode: "inject" };
    if (threadId === undefined) {
      await session.prompt(content, base);
      return;
    }
    if (!session.threadById(threadId)) {
      // The work's thread is gone, so the signal lands on the main thread.
      // On a team session that thread can have readers the work's thread
      // did not have: keep the output and the channel origin out of it,
      // as a human cancel does (fix wave 4, security N3).
      // The digests attribute carries summaries and links, so it stays out too.
      const { origin: _origin, ...plain } = content;
      const { digests: _digests, ...attributes } = draft.attributes;
      await session.prompt({ ...plain, attributes, body: removedThreadBody(draft) }, base);
      return;
    }
    await session.prompt(content, { threadId, ...base });
  }

  /**
   * Releases leases that reached their end (spec C2, C6):
   *
   * - A hold at its deadline, with a `lease.expired` signal to the thread
   *   that asked for it (fix wave 2, M17).
   * - A process or watch lease whose owner row is missing, unreadable, or
   *   terminal. This repair exists on purpose (CLAUDE.md, "Invariants:
   *   alert, don't auto-repair"): crash windows happen in normal operation.
   *   Rows written before the single-statement writes, a deploy mid-pass,
   *   or a failed store write can each leave such a lease, and nothing else
   *   would ever release it. Counted as `missing_owner` or `terminal_owner`.
   * - A process or watch lease two ticks past its deadline whose owner is
   *   still open. That is not a crash window: the row's own transition
   *   failed. The owner ends as `expired/deadline` with a kill and its
   *   signal, so the agent hears the true cause. Counted as `deadline`,
   *   which pages, and `valet.leases.over_deadline` already showed it at
   *   the start of the pass (fix wave 3, M2 and concurrency L5).
   */
  private async expireLeases(now: number): Promise<void> {
    const leases = await this.deps.engineStore.listAllActiveLeases();
    for (const lease of leases) {
      if (this.stopping) return;
      if (lease.ownerKind === "hold") {
        if (lease.deadlineAt > now) continue;
        await this.expireHold(now, lease);
        continue;
      }
      try {
        // An unreadable owner row reads as null (the store counts it), so it
        // never blocks this repair (fix wave 3, data L4).
        const owner = lease.ownerId === undefined ? null : await this.deps.engineStore.getWakeup(lease.ownerId);
        const ownerOpen = owner !== null && !TERMINAL.includes(owner.status);
        const pastDeadline = lease.deadlineAt + 2 * this.intervalMs <= now;
        if (ownerOpen && !pastDeadline) continue;
        if (ownerOpen && owner && (await this.endOverdueOwner(now, owner))) {
          this.metrics.orphanReleased(lease.ownerKind, "deadline");
          console.error(
            `WakeWatcher: ${lease.ownerKind} wakeup ${owner.id} of session ${lease.sessionId} was still ${owner.status} two ticks past its deadline; ended it as expired.`,
          );
          continue;
        }
        const reason: OrphanReleaseReason = owner === null ? "missing_owner" : ownerOpen ? "deadline" : "terminal_owner";
        const released = await this.deps.engineStore.releaseLease(lease.id, "deadline", now);
        if (!released) continue;
        this.metrics.orphanReleased(lease.ownerKind, reason);
        console.warn(
          `WakeWatcher: released orphan ${lease.ownerKind} lease ${lease.id} of session ${lease.sessionId}: ` +
            `its wakeup ${lease.ownerId ?? "(none)"} is ${owner ? owner.status : "missing or unreadable"} (${reason}).`,
        );
      } catch (err) {
        console.error(`WakeWatcher: orphan check of lease ${lease.id} failed; it stays due for the next tick:`, err);
      }
    }
  }

  /**
   * Ends an open owner whose lease is past its deadline, the way a failed
   * probe past the deadline does: `expired/deadline`, kill, and signal.
   * True when this call's CAS ended it.
   */
  private async endOverdueOwner(now: number, owner: Wakeup): Promise<boolean> {
    const decision = decideWakeup(now, owner, { kind: "error" }, this.decideOptions);
    if (!decision || !TERMINAL.includes(decision.to)) return false;
    const updated = await this.applyDecision(owner, decision, null, { pastCas: false });
    return updated !== null;
  }

  private async expireHold(now: number, lease: Lease): Promise<void> {
    let released: Lease | null;
    try {
      released = await this.deps.engineStore.releaseLease(lease.id, "deadline", now);
    } catch (err) {
      console.error(`WakeWatcher: release of hold lease ${lease.id} failed; it stays due for the next tick:`, err);
      return;
    }
    if (!released) return;
    try {
      await this.deliver(lease.sessionId, lease.threadId, holdExpiredSignal(lease, now), lease.origin);
    } catch (err) {
      // The lease is already released, so this signal is lost (spec Deviations).
      this.metrics.signalLost("hold");
      console.error(`WakeWatcher: delivery of lease.expired for lease ${lease.id} failed; the signal is lost:`, err);
    }
  }

  /** Sets lease gauges and reconciles pod eviction protection (spec C5, INV-3). */
  private async reconcileLeases(now: number): Promise<void> {
    const leases = await this.deps.engineStore.listAllActiveLeases();
    const stale = now - 2 * this.intervalMs;

    for (const kind of LEASE_OWNER_KINDS) {
      recordLeasesActive(kind, leases.filter((l) => l.ownerKind === kind).length);
    }
    // Real time held since the previous pass, not the nominal interval: a
    // slow pass skips ticks (fix wave 2, M11). The first pass after a start
    // counts one interval at most: the previous process counted the rest
    // (fix wave 3, data L1).
    // One sandbox counts once, from its oldest lease, under that lease's
    // owner kind: a process and a hold on one pod hold one node (fix wave
    // 4, k8s L-4b). A lease with no sandbox id yet counts alone.
    const since = this.lastPassAt ?? now - this.intervalMs;
    const oldestPerSandbox = new Map<string, Lease>();
    for (const lease of leases) {
      const key = lease.sandboxId ?? `lease:${lease.id}`;
      const prev = oldestPerSandbox.get(key);
      if (!prev || lease.createdAt < prev.createdAt) oldestPerSandbox.set(key, lease);
    }
    for (const lease of oldestPerSandbox.values()) {
      const from = Math.max(lease.createdAt, since);
      const seconds = Math.max(0, now - from) / 1000;
      if (seconds > 0) this.metrics.nodeSeconds(lease.ownerKind, seconds);
    }
    this.lastPassAt = now;

    const { setEvictionProtection, listEvictionProtected } = this.deps.provider;
    if (!setEvictionProtection) {
      this.metrics.leasesUnannotated(0);
      return;
    }
    const provider = this.deps.provider;
    // INV-3 counts every leased sandbox this reconcile could not protect: a
    // pod that lacked the annotation past two ticks, and a failed patch. A
    // lease whose session has no sandbox yet has no pod to protect, so it
    // is not counted (fix wave 2, M10).
    let unannotated = 0;
    const oldestBySandbox = new Map<string, number>();
    // A failed lookup hides which sandbox its lease holds, so this tick
    // removes no protection: it could be that lease's (fix wave 4, k8s N-7).
    let lookupFailed = false;
    for (const lease of leases) {
      let sandboxId = lease.sandboxId;
      if (sandboxId === undefined) {
        let resolved: LeaseSandbox;
        try {
          resolved = await this.leaseSandbox(lease);
        } catch (err) {
          lookupFailed = true;
          resolved = { kind: "error", why: err instanceof Error ? err.message : String(err) };
        }
        if (resolved.kind !== "id") {
          if (lease.createdAt < stale) {
            console.warn(`WakeWatcher: lease ${lease.id} has no sandbox to protect: ${resolved.why}.`);
          }
          continue;
        }
        sandboxId = resolved.sandboxId;
      }
      const prev = oldestBySandbox.get(sandboxId);
      if (prev === undefined || lease.createdAt < prev) oldestBySandbox.set(sandboxId, lease.createdAt);
    }

    for (const [sandboxId, oldest] of oldestBySandbox) {
      try {
        const r = await setEvictionProtection.call(provider, sandboxId, true);
        // A lease older than two ticks should already be protected.
        if (r.changed && oldest < stale) unannotated++;
      } catch (err) {
        unannotated++;
        console.error(`WakeWatcher: eviction protection for leased sandbox ${sandboxId} failed:`, err);
      }
    }
    this.metrics.leasesUnannotated(unannotated);

    if (lookupFailed) {
      console.error("WakeWatcher: a lease lookup failed, so no eviction protection is removed this tick.");
      return;
    }
    let protectedIds: string[] = [];
    try {
      protectedIds = (await listEvictionProtected?.call(provider)) ?? [];
    } catch (err) {
      console.error("WakeWatcher: listing eviction-protected sandboxes failed:", err);
    }
    for (const sandboxId of protectedIds) {
      if (oldestBySandbox.has(sandboxId)) continue;
      try {
        await setEvictionProtection.call(provider, sandboxId, false);
      } catch (err) {
        console.error(`WakeWatcher: removing eviction protection from sandbox ${sandboxId} failed:`, err);
      }
    }
  }
}

/**
 * The main-thread body for a signal whose thread is gone. It names the work
 * and the next step, and it never carries the work's output.
 */
function removedThreadBody(draft: SignalDraft): string {
  const id = draft.attributes.wakeupId ?? "";
  if (draft.attributes.kind === "event") {
    return draft.signalType === "event.matched"
      ? `A background wait (${id}) in a removed thread matched an event. Its details stay out of this thread. Arm a new wait in an open thread if you still need one.`
      : `A background wait (${id}) in a removed thread ended. Arm a new wait in an open thread if you still need one.`;
  }
  return (
    `This ${draft.attributes.kind ?? "work"} ("${draft.attributes.reason ?? id}") ` +
    `ended with ${draft.signalType}, but the thread it ran in is gone. Its output stays out of this thread. ` +
    `Use process_read with its id if the log still exists.`
  );
}

/** The `lease.expired` signal (spec B6: `leaseId`, `reason`, `ownerKind`, `expiredAt`). */
function holdExpiredSignal(lease: Lease, now: number): SignalDraft {
  return {
    signalType: "lease.expired",
    body: `Hold "${lease.reason}" expired at ${new Date(lease.deadlineAt).toISOString()}.`,
    attributes: {
      leaseId: lease.id,
      reason: lease.reason,
      ownerKind: lease.ownerKind,
      expiredAt: new Date(now).toISOString(),
    },
    dispatchId: `lease:${lease.id}:expired`,
  };
}

/** Builds or restores a session the way `ChildWatcher.attempt` and signal delivery do. */
async function loadColdSession(
  db: AppDb,
  engineStore: SessionStore,
  engineHost: WakeWatcherHost,
  sessionId: string,
): Promise<WakeWatcherSession> {
  const rows = await db.select().from(agentSessions).where(eq(agentSessions.id, sessionId)).limit(1);
  const row = rows[0];
  if (row) return engineHost.sessionFor(sessionId, await loadSessionMeta(db, row));
  const data = await engineStore.getSession(sessionId);
  if (!data) throw new Error(`session ${sessionId} not found`);
  return engineHost.sessionFor(
    sessionId,
    await loadSessionMeta(db, {
      id: sessionId,
      userId: data.userId,
      orgId: data.orgId,
      workspace: data.workspace,
      ownerType: data.owner.type,
      ownerId: data.owner.id,
    }),
  );
}

/** Runs at most `max` of the functions it wraps at once, in call order. */
type ConcurrencyLimit = <T>(fn: () => Promise<T>) => Promise<T>;

function concurrencyLimit(max: number): ConcurrencyLimit {
  let active = 0;
  const waiting: Array<() => void> = [];
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active >= max) await new Promise<void>((resolve) => waiting.push(resolve));
    active++;
    try {
      return await fn();
    } finally {
      active--;
      waiting.shift()?.();
    }
  };
}

/** The commit subject (`<service>:<owner>/<repo>@<sha>`) of a digest, or "" when it has none. */
function commitSubject(digest: EventMatchDigest): string {
  return digest.subjects.find((subject) => /@[0-9a-f]+$/i.test(subject)) ?? "";
}

/**
 * The buffered derive digests grouped by derive key and source commit,
 * each with its latest digest and every source key of the group (spec
 * Part F step 1).
 */
function deriveGroups(buffer: readonly EventMatchDigest[]): Array<{ latest: EventMatchDigest; sources: string[] }> {
  const groups = new Map<string, { latest: EventMatchDigest; sources: string[] }>();
  for (const digest of buffer) {
    if (digest.derive === undefined) continue;
    const key = `${digest.derive}\u0000${commitSubject(digest)}`;
    const group = groups.get(key);
    if (group) {
      group.latest = digest;
      group.sources.push(digest.dedupeKey);
    } else {
      groups.set(key, { latest: digest, sources: [digest.dedupeKey] });
    }
  }
  return [...groups.values()];
}
