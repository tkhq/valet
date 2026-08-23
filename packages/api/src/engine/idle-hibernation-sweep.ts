/**
 * Stranded-session sweep: hibernates idle ACTIVE sessions the in-memory
 * idle sweep cannot see. `EngineHost.runIdleSweep` iterates the host cache
 * only, and an api restart evicts every idle session while leaving its
 * pod running (deliberately — kill-mid-turn recovery needs the workspace).
 * Boot-restore only re-caches sessions with unsettled work, so an idle
 * session from before a restart stays `status='active'` with a running
 * pod FOREVER: the cache sweep never sees it, and the HibernationReaper
 * only reaps `hibernated` rows. Observed on agents-dev (2026-08-22): 32
 * assistant sessions active-but-idle for days, each holding a dedicated
 * pod, saturating a node.
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
 * Only runs on hibernation-capable backends with deterministic sandbox
 * ids (kubernetes). Race rules mirror the cache sweep: unsettled
 * submissions win, re-checked immediately before the suspend, and a
 * session that gets cached mid-pass is left to the cache sweep.
 */
import { and, eq, lte } from "drizzle-orm";
import type { SandboxStatus } from "@valet/engine";
import type { AppDb } from "../lib/drizzle.js";
import { agentSessions } from "../schema/index.js";
import { writeHibernated } from "./hibernation-hooks.js";

const DEFAULT_SWEEP_INTERVAL_MS = 5 * 60_000;

export interface IdleHibernationSweepDeps {
  db: AppDb;
  engineHost: {
    /** Only the null-check is used — a cached session belongs to the
     * in-memory idle sweep, never to this one. */
    liveSession(sessionId: string): object | null;
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
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly deps: IdleHibernationSweepDeps) {}

  async sweep(now = Date.now()): Promise<void> {
    const idleMs = this.deps.idleMs;
    if (idleMs <= 0) return;
    if (!this.deps.engineHost.sandboxHibernationCapable()) return;
    const cutoff = now - idleMs;
    // `updated_at` is a coarse pre-filter (it moves on status flips, not
    // per message); the engine's activity clock below is the real judge.
    const rows = await this.deps.db
      .select()
      .from(agentSessions)
      .where(and(eq(agentSessions.status, "active"), lte(agentSessions.updatedAt, cutoff)));
    for (const row of rows) {
      try {
        await this.maybeHibernate(row.id, row.workspace, cutoff);
      } catch (err) {
        console.error(`IdleHibernationSweep: hibernate failed for session ${row.id}:`, err);
      }
    }
  }

  private async maybeHibernate(sessionId: string, workspace: string, cutoff: number): Promise<void> {
    // Cached sessions are the in-memory idle sweep's jurisdiction — its
    // activity clock includes the gateway-touch signal this sweep cannot
    // read for uncached sessions.
    if (this.deps.engineHost.liveSession(sessionId) != null) return;

    const unsettled = await this.deps.engineStore.listUnsettledSubmissions(sessionId);
    if (unsettled.length > 0) return;
    const activityAt = await this.deps.engineStore.latestActivityAt(sessionId);
    if (activityAt != null && activityAt > cutoff) return;

    const sandboxId = this.deps.engineHost.deriveSandboxId(workspace);
    if (!sandboxId) {
      // Backend-assigned ids (docker/local) are unreachable without a live
      // attachment — and those backends are not hibernation-capable, so
      // the capability gate in sweep() normally prevents reaching here.
      console.warn(
        `IdleHibernationSweep: session ${sessionId} is idle but its sandbox id is not derivable; skipping`,
      );
      return;
    }

    // Re-check both race signals immediately before acting (the idle
    // sweep's rule): a wake restores the session into the cache, and a
    // prompt admits a submission — either one wins.
    if (this.deps.engineHost.liveSession(sessionId) != null) return;
    const recheck = await this.deps.engineStore.listUnsettledSubmissions(sessionId);
    if (recheck.length > 0) return;

    const status = await this.deps.engineHost.sandboxStatus(sandboxId);
    if (status.state === "released") {
      // No backing sandbox (the session never provisioned one, or it was
      // already reclaimed). Nothing to scale down — but the row must still
      // leave `active`, or it re-sweeps forever. The reaper's destroy
      // tolerates the 404 and stamps the reclaim.
      await writeHibernated(this.deps.db, sessionId, sandboxId);
      console.log(`IdleHibernationSweep: stamped sandbox-less idle session ${sessionId} hibernated`);
      return;
    }
    if (status.state === "idle") {
      // Already suspended (an earlier pass crashed between suspend and
      // stamp) — just finish the stamp.
      await writeHibernated(this.deps.db, sessionId, sandboxId);
      console.log(`IdleHibernationSweep: re-stamped already-suspended session ${sessionId} hibernated`);
      return;
    }

    await this.deps.engineHost.suspendSandbox(sandboxId);
    // Same guarded flip the cache sweep's onHibernate hook writes
    // (conditioned on status='active', records the reaper's destroy
    // handle, clears the reclaim stamp).
    await writeHibernated(this.deps.db, sessionId, sandboxId);
    console.log(
      `IdleHibernationSweep: hibernated stranded idle session ${sessionId} (sandbox ${sandboxId})`,
    );
  }

  /** Start the sweep interval (no-op when the idle window is off).
   * Unref'd — never holds the process open. */
  start(): void {
    if (this.timer || this.deps.idleMs <= 0) return;
    const intervalMs = this.deps.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
    const timer = setInterval(() => {
      void this.sweep().catch((err) => console.error("IdleHibernationSweep: sweep failed:", err));
    }, intervalMs);
    timer.unref();
    this.timer = timer;
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }
}
