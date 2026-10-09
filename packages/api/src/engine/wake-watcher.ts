import { eq } from "drizzle-orm";
import {
  recordLeaseNodeSeconds,
  recordLeasesActive,
  recordLeasesOverDeadline,
  recordLeasesUnannotated,
  recordWakeupEnded,
  recordWakeupsActive,
  SandboxSupersededError,
  SandboxUnavailableError,
} from "@valet/engine";
import type {
  Lease,
  LeaseOwnerKind,
  PromptContent,
  PromptOptions,
  Sandbox,
  SandboxProvider,
  SessionStore,
  Wakeup,
  WakeupKind,
  WakeupLimits,
  WakeupStatus,
} from "@valet/engine";
import type { AppDb } from "../lib/drizzle.js";
import { startSweepTimer, type SweepTimer } from "../lib/sweep-timer.js";
import { agentSessions } from "../schema/index.js";
import type { SessionMeta } from "./host.js";
import { loadSessionMeta } from "./session-meta.js";
import { decideWakeup, type SignalDraft, type WakeupProbe } from "./wake-watcher-decide.js";

/** Default tick interval (spec B5). */
export const WAKE_WATCHER_INTERVAL_MS = 30_000;
/** Max due rows one tick reads (spec B5). */
export const WAKE_WATCHER_BATCH = 200;

const TERMINAL: readonly WakeupStatus[] = ["done", "cancelled", "expired", "lost"];
const WAKEUP_KINDS: readonly WakeupKind[] = ["process", "watch", "timer"];
const LEASE_OWNER_KINDS: readonly LeaseOwnerKind[] = ["process", "watch", "hold"];

/** The kubernetes provider's pod-gone error (`podUnavailableError`). */
const POD_GONE = /No such container|backing pod was recreated or removed/;

/** The slice of an engine `Session` the watcher uses. */
export interface WakeWatcherSession {
  prompt(content: PromptContent, opts: PromptOptions): Promise<unknown>;
  attachment: { current(): Sandbox | null };
}

/** The slice of `EngineHost` the watcher uses. */
export interface WakeWatcherHost {
  sessionFor(sessionId: string, meta: SessionMeta): Promise<WakeWatcherSession>;
  liveSession(sessionId: string): WakeWatcherSession | null;
}

interface WakeWatcherBaseDeps {
  engineStore: SessionStore;
  engineHost: WakeWatcherHost;
  provider: Pick<SandboxProvider, "restore" | "setEvictionProtection" | "listEvictionProtected">;
  limits: WakeupLimits;
  sweepIntervalMs?: number;
  now?: () => number;
}

/**
 * `db` builds a cold session the way `ChildWatcher.attempt` does. Tests pass
 * `loadSession` instead, so they need no app database.
 */
export type WakeWatcherDeps = WakeWatcherBaseDeps &
  ({ db: AppDb; loadSession?: undefined } | { db?: undefined; loadSession: (sessionId: string) => Promise<WakeWatcherSession> });

/**
 * Api-side owner of every wakeup and lease (spec 2026-10-08, B5, B6, C5,
 * C6). Each tick probes due wakeups, applies `decideWakeup`, releases
 * leases, delivers signals, expires hold leases, and reconciles eviction
 * protection. It reads all state from the store, so a restart loses nothing.
 */
export class WakeWatcher {
  private timer: SweepTimer | null = null;
  private readonly intervalMs: number;
  private readonly clock: () => number;
  private readonly loadSession: (sessionId: string) => Promise<WakeWatcherSession>;

  constructor(private readonly deps: WakeWatcherDeps) {
    this.intervalMs = deps.sweepIntervalMs ?? WAKE_WATCHER_INTERVAL_MS;
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
    const rows = await this.deps.engineStore.listDueWakeups(now, WAKE_WATCHER_BATCH);
    for (const kind of WAKEUP_KINDS) {
      recordWakeupsActive(kind, rows.filter((r) => r.kind === kind).length);
    }
    for (const row of rows) {
      try {
        await this.processRow(now, row);
      } catch (err) {
        console.error(`WakeWatcher: wakeup ${row.id} failed this tick; it stays due for the next tick:`, err);
      }
    }
    await this.expireHolds(now);
    await this.reconcileLeases(now);
  }

  private async processRow(now: number, row: Wakeup): Promise<void> {
    let sandbox: Sandbox | null = null;
    let probe: WakeupProbe;
    if (row.kind === "timer") {
      probe = { kind: "none" };
    } else {
      if (row.execId === undefined) {
        console.error(`WakeWatcher: ${row.kind} wakeup ${row.id} has no execId; skipping it.`);
        return;
      }
      try {
        sandbox = await this.sandboxFor(row);
        if (!sandbox) {
          console.error(`WakeWatcher: wakeup ${row.id} has no active lease with a sandbox id; skipping it.`);
          return;
        }
        if (!sandbox.pollJob) {
          console.error(`WakeWatcher: sandbox ${sandbox.id} has no job mode; cannot probe wakeup ${row.id}.`);
          return;
        }
        const poll = await sandbox.pollJob(row.execId, row.logOffset);
        probe = {
          kind: "poll",
          status: poll.status,
          output: poll.output,
          nextOffset: poll.nextOffset,
          ...(poll.exitCode !== undefined ? { exitCode: poll.exitCode } : {}),
        };
      } catch (err) {
        if (!isUnavailable(err)) {
          console.error(`WakeWatcher: probe of wakeup ${row.id} failed; retrying next tick:`, err);
          return;
        }
        probe = { kind: "unavailable" };
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

    if (decision.releaseLease && updated.leaseId) {
      await this.deps.engineStore.releaseLease(updated.leaseId, decision.releaseLease, now);
    }

    for (const signal of decision.signals) {
      try {
        await this.deliver(updated.sessionId, updated.threadId, signal);
      } catch (err) {
        // The row is already terminal or advanced, so this signal is lost.
        // The log line is the only record; see the spec Deviations.
        console.error(`WakeWatcher: delivery of ${signal.signalType} for wakeup ${row.id} failed; the signal is lost:`, err);
      }
    }

    if (TERMINAL.includes(decision.to) && decision.cause) {
      recordWakeupEnded(updated.kind, decision.cause);
    }
  }

  /**
   * The live session's ready sandbox, else a restored handle for the lease's
   * sandbox id. Neither path wakes or provisions a sandbox.
   */
  private async sandboxFor(row: Wakeup): Promise<Sandbox | null> {
    const live = this.deps.engineHost.liveSession(row.sessionId)?.attachment.current();
    if (live) return live;
    if (row.leaseId === undefined) return null;
    const leases = await this.deps.engineStore.listActiveLeases(row.sessionId);
    const sandboxId = leases.find((l) => l.id === row.leaseId)?.sandboxId;
    if (sandboxId === undefined) return null;
    return this.deps.provider.restore(sandboxId);
  }

  /**
   * Submits one signal. Targets `threadId` when given; when that thread is
   * gone, retries on the session's main thread (spec B5).
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
    if (threadId === undefined) {
      await session.prompt(content, base);
      return;
    }
    try {
      await session.prompt(content, { threadId, ...base });
    } catch (err) {
      if (!isThreadNotFound(err, threadId)) throw err;
      await session.prompt(content, base);
    }
  }

  /** Releases hold leases at their deadline and emits `lease.expired` (spec C2, C6). */
  private async expireHolds(now: number): Promise<void> {
    const leases = await this.deps.engineStore.listAllActiveLeases();
    for (const lease of leases) {
      if (lease.ownerKind !== "hold" || lease.deadlineAt > now) continue;
      try {
        const released = await this.deps.engineStore.releaseLease(lease.id, "deadline", now);
        if (!released) continue;
        await this.deliver(lease.sessionId, undefined, holdExpiredSignal(lease));
      } catch (err) {
        console.error(`WakeWatcher: expiry of hold lease ${lease.id} failed:`, err);
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

    const oldestBySandbox = new Map<string, number>();
    for (const lease of leases) {
      if (lease.sandboxId === undefined) continue;
      const prev = oldestBySandbox.get(lease.sandboxId);
      if (prev === undefined || lease.createdAt < prev) oldestBySandbox.set(lease.sandboxId, lease.createdAt);
    }

    const { setEvictionProtection, listEvictionProtected } = this.deps.provider;
    if (!setEvictionProtection) {
      recordLeasesUnannotated(0);
      return;
    }
    const provider = this.deps.provider;
    let unannotated = 0;
    for (const [sandboxId, oldest] of oldestBySandbox) {
      try {
        const r = await setEvictionProtection.call(provider, sandboxId, true);
        // A lease older than two ticks should already be protected.
        if (r.changed && oldest < stale) unannotated++;
      } catch (err) {
        console.error(`WakeWatcher: eviction protection for leased sandbox ${sandboxId} failed:`, err);
      }
    }
    recordLeasesUnannotated(unannotated);

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
  return err instanceof Error && POD_GONE.test(err.message);
}

/** Matches `Session.resolveTargetThread`'s missing-thread error. */
function isThreadNotFound(err: unknown, threadId: string): boolean {
  return err instanceof Error && err.message.includes(`thread ${threadId} not found`);
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
