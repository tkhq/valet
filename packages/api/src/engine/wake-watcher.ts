import { eq } from "drizzle-orm";
import {
  recordLeaseNodeSeconds,
  recordLeasesActive,
  recordLeasesOverDeadline,
  recordLeasesUnannotated,
  recordWakeupEnded,
  recordWakeupSignalLost,
  recordWakeupsActive,
  SandboxSupersededError,
  SandboxUnavailableError,
} from "@valet/engine";
import type {
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
import type { AppDb } from "../lib/drizzle.js";
import { startSweepTimer, type SweepTimer } from "../lib/sweep-timer.js";
import { agentSessions } from "../schema/index.js";
import type { SessionMeta } from "./host.js";
import { loadSessionMeta } from "./session-meta.js";
import {
  decideWakeup,
  LOG_TAIL_BYTES,
  WATCH_READ_BYTES,
  type SignalDraft,
  type WakeupProbe,
} from "./wake-watcher-decide.js";

/** Default tick interval (spec B5). */
export const WAKE_WATCHER_INTERVAL_MS = 30_000;
/** Max due rows one page reads (spec B5). A tick reads every page. */
export const WAKE_WATCHER_BATCH = 200;

const TERMINAL: readonly WakeupStatus[] = ["done", "cancelled", "expired", "lost"];
const WAKEUP_KINDS: readonly WakeupKind[] = ["process", "watch", "timer"];
const LEASE_OWNER_KINDS: readonly LeaseOwnerKind[] = ["process", "watch", "hold"];

/**
 * Errors that mean the sandbox is gone: the kubernetes provider's pod-gone
 * error (`podUnavailableError`) and its `restore()` miss for a deleted CR.
 */
const SANDBOX_GONE = /No such container|backing pod was recreated or removed|Sandbox CR "[^"]*" not found/;

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

/** The counters the watcher records. Tests inject spies. */
export interface WakeWatcherMetrics {
  wakeupEnded(kind: WakeupKind, cause: WakeupCause): void;
  signalLost(kind: WakeupKind | "hold"): void;
  leasesUnannotated(count: number): void;
}

const DEFAULT_METRICS: WakeWatcherMetrics = {
  wakeupEnded: recordWakeupEnded,
  signalLost: recordWakeupSignalLost,
  leasesUnannotated: recordLeasesUnannotated,
};

interface WakeWatcherBaseDeps {
  engineStore: SessionStore;
  engineHost: WakeWatcherHost;
  provider: Pick<SandboxProvider, "restore" | "setEvictionProtection" | "listEvictionProtected">;
  limits: WakeupLimits;
  sweepIntervalMs?: number;
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
 * leases, delivers signals, expires hold leases, and reconciles eviction
 * protection. It reads all state from the store, so a restart loses nothing.
 */
export class WakeWatcher {
  private timer: SweepTimer | null = null;
  private readonly intervalMs: number;
  private readonly batchSize: number;
  private readonly metrics: WakeWatcherMetrics;
  private readonly clock: () => number;
  private readonly loadSession: (sessionId: string) => Promise<WakeWatcherSession>;

  constructor(private readonly deps: WakeWatcherDeps) {
    this.intervalMs = deps.sweepIntervalMs ?? WAKE_WATCHER_INTERVAL_MS;
    this.batchSize = deps.batchSize ?? WAKE_WATCHER_BATCH;
    this.metrics = { ...DEFAULT_METRICS, ...deps.metrics };
    this.clock = deps.now ?? Date.now;
    if (deps.loadSession) {
      this.loadSession = deps.loadSession;
    } else {
      const db = deps.db;
      this.loadSession = (sessionId) => loadColdSession(db, deps.engineStore, deps.engineHost, sessionId);
    }
  }

  start(): void {
    if (this.timer || this.intervalMs <= 0) return;
    this.timer = startSweepTimer("WakeWatcher", this.intervalMs, () => this.sweep());
  }

  stop(): void {
    this.timer?.stop();
    this.timer = null;
  }

  async sweep(now: number = this.clock()): Promise<void> {
    const active = new Map<WakeupKind, number>(WAKEUP_KINDS.map((kind) => [kind, 0]));
    // Page through every due row. A single fixed batch let old always-due
    // process rows starve newer timers once more than one batch was due.
    let after: WakeupCursor | undefined;
    for (;;) {
      const rows = await this.deps.engineStore.listDueWakeups(now, this.batchSize, after);
      for (const row of rows) {
        active.set(row.kind, (active.get(row.kind) ?? 0) + 1);
        const progress = { pastCas: false };
        try {
          await this.processRow(now, row, progress);
        } catch (err) {
          if (progress.pastCas) {
            console.error(`WakeWatcher: wakeup ${row.id} failed after its transition was stored:`, err);
          } else {
            console.error(`WakeWatcher: wakeup ${row.id} failed this tick; it stays due for the next tick:`, err);
          }
        }
      }
      const last = rows[rows.length - 1];
      if (rows.length < this.batchSize || !last) break;
      after = { createdAt: last.createdAt, id: last.id };
    }
    for (const [kind, count] of active) recordWakeupsActive(kind, count);
    await this.expireHolds(now);
    await this.reconcileLeases(now);
  }

  private async processRow(now: number, row: Wakeup, progress: { pastCas: boolean }): Promise<void> {
    let sandbox: Sandbox | null = null;
    let probe: WakeupProbe;
    if (row.kind === "timer") {
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
          };
        }
      } catch (err) {
        if (isUnavailable(err)) {
          probe = { kind: "unavailable" };
        } else {
          console.error(`WakeWatcher: probe of wakeup ${row.id} failed; retrying next tick until its deadline:`, err);
          probe = { kind: "error" };
        }
      }
    }

    const decision = decideWakeup(now, row, probe, this.deps.limits);
    if (!decision) return;

    if (decision.kill && sandbox?.cancelJob && row.execId !== undefined) {
      try {
        await sandbox.cancelJob(row.execId);
      } catch (err) {
        console.error(`WakeWatcher: kill of wakeup ${row.id} (exec ${row.execId}) failed; expiring the row anyway:`, err);
      }
    }

    const updated = await this.deps.engineStore.transitionWakeup(row.id, [row.status], decision.to, decision.patch, now);
    // Null means another sweep or wakeup_cancel won the CAS (INV-5).
    if (!updated) return;
    progress.pastCas = true;

    if (decision.releaseLease && updated.leaseId) {
      try {
        await this.deps.engineStore.releaseLease(updated.leaseId, decision.releaseLease, now);
      } catch (err) {
        // The row already moved, so delivery and the metric still run.
        console.error(
          `WakeWatcher: lease ${updated.leaseId} release failed after wakeup ${row.id} moved to ${decision.to}; valet_leases_over_deadline will page:`,
          err,
        );
      }
    }

    for (const signal of decision.signals) {
      try {
        await this.deliver(updated.sessionId, updated.threadId, signal);
      } catch (err) {
        // The row is already terminal or advanced, so this signal is lost.
        // The counter and the log line are the only record (spec Deviations).
        this.metrics.signalLost(updated.kind);
        console.error(`WakeWatcher: delivery of ${signal.signalType} for wakeup ${row.id} failed; the signal is lost:`, err);
      }
    }

    if (TERMINAL.includes(decision.to) && decision.cause) {
      this.metrics.wakeupEnded(updated.kind, decision.cause);
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
   * otherwise targets the session's main thread (spec B5).
   */
  private async deliver(sessionId: string, threadId: string | undefined, draft: SignalDraft): Promise<void> {
    const session = this.deps.engineHost.liveSession(sessionId) ?? (await this.loadSession(sessionId));
    const content: PromptContent = {
      kind: "signal",
      signalType: draft.signalType,
      body: draft.body,
      attributes: draft.attributes,
      tagName: "wakeup",
    };
    const base: PromptOptions = { dispatchId: draft.dispatchId, queueMode: "followup" };
    if (threadId === undefined || !session.threadById(threadId)) {
      await session.prompt(content, base);
      return;
    }
    await session.prompt(content, { threadId, ...base });
  }

  /** Releases hold leases at their deadline and emits `lease.expired` (spec C2, C6). */
  private async expireHolds(now: number): Promise<void> {
    const leases = await this.deps.engineStore.listAllActiveLeases();
    for (const lease of leases) {
      if (lease.ownerKind !== "hold" || lease.deadlineAt > now) continue;
      let released: Lease | null;
      try {
        released = await this.deps.engineStore.releaseLease(lease.id, "deadline", now);
      } catch (err) {
        console.error(`WakeWatcher: release of hold lease ${lease.id} failed; it stays due for the next tick:`, err);
        continue;
      }
      if (!released) continue;
      try {
        await this.deliver(lease.sessionId, undefined, holdExpiredSignal(lease));
      } catch (err) {
        // The lease is already released, so this signal is lost (spec Deviations).
        this.metrics.signalLost("hold");
        console.error(`WakeWatcher: delivery of lease.expired for lease ${lease.id} failed; the signal is lost:`, err);
      }
    }
  }

  /** Sets lease gauges and reconciles pod eviction protection (spec C5, INV-3). */
  private async reconcileLeases(now: number): Promise<void> {
    const leases = await this.deps.engineStore.listAllActiveLeases();
    const stale = now - 2 * this.intervalMs;

    for (const kind of LEASE_OWNER_KINDS) {
      recordLeasesActive(kind, leases.filter((l) => l.ownerKind === kind).length);
    }
    for (const lease of leases) {
      recordLeaseNodeSeconds(lease.ownerKind, this.intervalMs / 1000);
    }
    recordLeasesOverDeadline(leases.filter((l) => l.deadlineAt < stale).length);

    const { setEvictionProtection, listEvictionProtected } = this.deps.provider;
    if (!setEvictionProtection) {
      this.metrics.leasesUnannotated(0);
      return;
    }
    const provider = this.deps.provider;
    // INV-3 counts every leased sandbox this reconcile could not protect:
    // a pod that lacked the annotation past two ticks, a failed patch, and
    // a lease whose sandbox id stayed unknown past two ticks.
    let unannotated = 0;
    const oldestBySandbox = new Map<string, number>();
    for (const lease of leases) {
      let sandboxId = lease.sandboxId;
      if (sandboxId === undefined) {
        let resolved: LeaseSandbox;
        try {
          resolved = await this.leaseSandbox(lease);
        } catch (err) {
          resolved = { kind: "error", why: err instanceof Error ? err.message : String(err) };
        }
        if (resolved.kind !== "id") {
          if (lease.createdAt < stale) {
            unannotated++;
            console.error(`WakeWatcher: leased sandbox of lease ${lease.id} is unprotected: ${resolved.why}.`);
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

function holdExpiredSignal(lease: Lease): SignalDraft {
  return {
    signalType: "lease.expired",
    body: `Hold "${lease.reason}" expired at ${new Date(lease.deadlineAt).toISOString()}.`,
    attributes: { leaseId: lease.id, reason: lease.reason, ownerKind: lease.ownerKind },
    dispatchId: `lease:${lease.id}:expired`,
  };
}

function isUnavailable(err: unknown): boolean {
  if (err instanceof SandboxUnavailableError || err instanceof SandboxSupersededError) return true;
  return err instanceof Error && SANDBOX_GONE.test(err.message);
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
