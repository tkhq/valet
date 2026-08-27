/**
 * Stranded-session sweep: hibernates idle ACTIVE sessions the in-memory
 * idle sweep cannot see. `EngineHost.runIdleSweep` iterates the host cache
 * only, and an api restart evicts every idle session while leaving its
 * pod running (deliberately — kill-mid-turn recovery needs the sandbox's
 * working directory). Boot-restore only re-caches sessions with unsettled
 * work, so an idle session from before a restart stays `status='active'`
 * with a running pod FOREVER: the cache sweep never sees it, and the
 * HibernationReaper only reaps `hibernated` rows. Observed on agents-dev
 * (2026-08-22): 32 assistant sessions active-but-idle for days, each
 * holding a dedicated pod, saturating a node.
 *
 * This sweep is DB-driven, like the reaper: `agent_sessions` rows that are
 * `active`, uncached, past the idle window on the engine's activity clock,
 * and free of unsettled work get their sandbox suspended at the provider
 * level (no live attachment exists to `suspend()`) and their row flipped
 * to `hibernated` via the same guarded `writeHibernated` the cache sweep's
 * hook uses. The already-deployed HibernationReaper then owns the destroy
 * after the retention window, and reopening wakes through the normal
 * hibernated-session path.
 *
 * Auto-repair justification (CLAUDE.md "Invariants: alert, don't
 * auto-repair", rule 3): the violation is EXPECTED in normal operation —
 * every api restart strands whatever was idle-and-cached at that moment.
 * This sweep is that crash-window's owner, not a mask over a bug.
 *
 * Jurisdiction rule between the two idle authorities: a session that is
 * cached OR mid-build belongs to the in-memory sweep (whose activity
 * clock includes the gateway-touch signal this sweep cannot read);
 * everything else is this sweep's. Race rules: unsettled submissions and
 * liveness are re-checked immediately before the suspend (after the
 * provider status read — nothing awaits between the re-check and the
 * suspend call). The residual window is milliseconds; a wake that loses
 * it recovers through the attachment's failure path (one failed tool op,
 * then re-provision resumes the CR and the ready transition heals the
 * row status). Only runs on hibernation-capable backends with
 * deterministic sandbox ids (kubernetes).
 */
import { and, eq, lte } from "drizzle-orm";
import type { SandboxStatus } from "@valet/engine";
import type { AppDb } from "../lib/drizzle.js";
import { agentSessions } from "../schema/index.js";
import { startSweepTimer, type SweepTimer } from "../lib/sweep-timer.js";
import { writeHibernated } from "./hibernation-hooks.js";

const DEFAULT_SWEEP_INTERVAL_MS = 5 * 60_000;
/** Rows per pass — bounds a post-restart backlog; hibernated rows leave
 * the predicate, so the backlog drains across passes. */
const SWEEP_BATCH_LIMIT = 200;

export interface IdleHibernationSweepDeps {
  db: AppDb;
  engineHost: {
    /** Cached OR mid-build — either way the session belongs to the
     * in-memory idle sweep, never to this one. */
    sessionLiveOrBuilding(sessionId: string): boolean;
    suspendSandbox(sandboxId: string): Promise<void>;
    sandboxStatus(sandboxId: string): Promise<SandboxStatus>;
    deriveSandboxId(sessionKey: string): string | null;
    sandboxHibernationCapable(): boolean;
  };
  engineStore: {
    listUnsettledSubmissions(sessionId: string): Promise<unknown[]>;
    latestActivityAt(sessionId: string): Promise<number | null>;
  };
  /** Same window the in-memory idle sweep uses (`resolveIdleMinutes`);
   * `<= 0` disables. */
  idleMs: number;
  /** Override for tests. */
  sweepIntervalMs?: number;
}

export class IdleHibernationSweep {
  private timer: SweepTimer | null = null;

  constructor(private readonly deps: IdleHibernationSweepDeps) {}

  async sweep(now = Date.now()): Promise<void> {
    const idleMs = this.deps.idleMs;
    if (idleMs <= 0) return;
    if (!this.deps.engineHost.sandboxHibernationCapable()) return;
    const cutoff = now - idleMs;
    // `updated_at` is a coarse pre-filter (it moves on status flips, not
    // per message); the engine's activity clock below is the real judge.
    const rows = await this.deps.db
      .select({
        id: agentSessions.id,
        workspace: agentSessions.workspace,
        createdAt: agentSessions.createdAt,
      })
      .from(agentSessions)
      .where(and(eq(agentSessions.status, "active"), lte(agentSessions.updatedAt, cutoff)))
      .orderBy(agentSessions.updatedAt)
      .limit(SWEEP_BATCH_LIMIT);
    for (const row of rows) {
      try {
        await this.maybeHibernate(row.id, row.workspace, row.createdAt, cutoff);
      } catch (err) {
        console.error(`IdleHibernationSweep: hibernate failed for session ${row.id}:`, err);
      }
    }
  }

  /** `sessionKey` is `agent_sessions.workspace` — the session-identity
   * input the provider derives the sandbox id from (the reaper's
   * `deriveSandboxId(row.workspace)` precedent), not a display label or
   * an in-sandbox path. */
  private async maybeHibernate(
    sessionId: string,
    sessionKey: string,
    createdAt: number,
    cutoff: number,
  ): Promise<void> {
    if (this.deps.engineHost.sessionLiveOrBuilding(sessionId)) return;

    const unsettled = await this.deps.engineStore.listUnsettledSubmissions(sessionId);
    if (unsettled.length > 0) return;
    // Missing activity data fails SAFE, like the cache sweep: a session
    // with no recorded activity is judged by its creation time, so a row
    // created moments before a restart is never hibernated as "idle".
    const activityAt = (await this.deps.engineStore.latestActivityAt(sessionId)) ?? createdAt;
    if (activityAt > cutoff) return;

    const sandboxId = this.deps.engineHost.deriveSandboxId(sessionKey);
    if (!sandboxId) {
      // Backend-assigned ids (docker/local) are unreachable without a live
      // attachment — and those backends are not hibernation-capable, so
      // the capability gate in sweep() normally prevents reaching here.
      console.warn(
        `IdleHibernationSweep: session ${sessionId} is idle but its sandbox id is not derivable; skipping`,
      );
      return;
    }

    const status = await this.deps.engineHost.sandboxStatus(sandboxId);
    if (status.state === "released" || status.state === "idle") {
      // Nothing to scale down: no backing sandbox exists ("released" —
      // never provisioned or already reclaimed), or it is already
      // suspended ("idle" — an earlier pass crashed between suspend and
      // stamp). Either way the row must leave `active`, or it re-sweeps
      // forever. The stamp still needs the liveness re-check below: a
      // wake that landed during the awaits above keeps the row `active`
      // (its status guard would pass!), and a mid-stamp flip would show a
      // chatting session as paused with no heal until its next prompt.
      if (this.deps.engineHost.sessionLiveOrBuilding(sessionId)) return;
      await writeHibernated(this.deps.db, sessionId, sandboxId);
      console.log(
        `IdleHibernationSweep: stamped idle session ${sessionId} hibernated (sandbox state ${status.state})`,
      );
      return;
    }
    if (status.state !== "ready") {
      // provisioning / error / anything mid-flight: suspending would
      // scale down a sandbox the controller is still converging (or wedge
      // a failed one into a fake hibernation the wake path cannot serve).
      // Skip; the next pass re-judges, and the reconcile sweep's over-age
      // report owns anything permanently stuck here.
      console.warn(
        `IdleHibernationSweep: session ${sessionId} sandbox ${sandboxId} is '${status.state}'; not suspendable, skipping`,
      );
      return;
    }

    // Re-check both race signals — the unsettled read first, then the
    // (synchronous) liveness check immediately before the suspend, so
    // nothing awaits between the last check and the suspend call. A wake
    // building the session into the cache, or a submission admitted since
    // the checks above, wins.
    const recheck = await this.deps.engineStore.listUnsettledSubmissions(sessionId);
    if (recheck.length > 0) return;
    if (this.deps.engineHost.sessionLiveOrBuilding(sessionId)) return;

    await this.deps.engineHost.suspendSandbox(sandboxId);
    // Liveness one last time BEFORE the stamp: a wake that slipped in
    // during the suspend await re-resumes the sandbox through its own
    // provisioning (create-adopt resumes a Suspended CR), but its row is
    // still `active` — the guard on `writeHibernated` cannot catch it, so
    // this check is what keeps a live session from being shown as paused.
    if (this.deps.engineHost.sessionLiveOrBuilding(sessionId)) return;
    // Same guarded flip the cache sweep's onHibernate hook writes
    // (conditioned on status='active', records the reaper's destroy
    // handle, clears the reclaim stamp).
    await writeHibernated(this.deps.db, sessionId, sandboxId);
    console.log(
      `IdleHibernationSweep: hibernated stranded idle session ${sessionId} (sandbox ${sandboxId})`,
    );
  }

  /** Start the sweep interval (no-op when the idle window is off). */
  start(): void {
    if (this.timer || this.deps.idleMs <= 0) return;
    const intervalMs = this.deps.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
    this.timer = startSweepTimer("IdleHibernationSweep", intervalMs, () => this.sweep());
  }

  stop(): void {
    this.timer?.stop();
    this.timer = null;
  }
}
