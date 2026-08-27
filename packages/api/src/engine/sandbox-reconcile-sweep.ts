/**
 * Provider-side sandbox reconciler: the backstop under every DB-driven
 * sweep. The hibernation reaper, child retention sweep, and workflow
 * reclaim each cover one session class, and each keys off a DB row — a
 * sandbox whose row was never written (crash between create and persist)
 * or whose session was deleted out from under it is invisible to all of
 * them. This sweep starts from the other side: `SandboxProvider.list()`
 * enumerates what actually exists, and anything whose owner is gone is
 * destroyed.
 *
 * One destroy rule — **orphan**: the owning session (create-time
 * annotation) no longer exists in the engine store and is not cached. Its
 * sandbox has no owner left to delete it through any other path.
 *
 * Everything else is REPORTED, never destroyed (CLAUDE.md: "Invariants:
 * alert, don't auto-repair"). A sandbox older than
 * `VALET_SANDBOX_AGE_REPORT_HOURS`, or one with no session annotation,
 * means some owner failed — an age-based kill here would mask that bug
 * and wipe legitimately long-lived active workspaces (an orchestrator's)
 * on a timer. The sweep logs both classes and returns their counts so the
 * lifecycle metrics can alert on them.
 *
 * Unsettled submissions always win (never destroy mid-turn), re-checked
 * immediately before the destroy. Providers without `list()` (docker/local
 * — process-local handles) make this sweep a no-op.
 */
import { recordSandboxDestroyed, recordSandboxFlagged, type SandboxProvider } from "@valet/engine";
import type { AppDb } from "../lib/drizzle.js";
import { revokeSandboxTokens } from "../auth/sandbox-tokens.js";
import { startSweepTimer, type SweepTimer } from "../lib/sweep-timer.js";

const DEFAULT_SWEEP_INTERVAL_MS = 30 * 60_000;

/** One sweep pass's outcome — the raw material for lifecycle metrics. */
export interface SweepReport {
  /** Sandboxes destroyed because their owning session is gone. */
  orphansDestroyed: number;
  /** Sandboxes older than the report threshold — an invariant violation
   * some owner failed to clean; reported, never destroyed here. */
  overAge: number;
  /** Sandboxes with no session annotation (created before stamping).
   * Unverifiable ownership; reported, never destroyed here. */
  unowned: number;
}

export interface SandboxReconcileSweepDeps {
  db: AppDb;
  /** Only `list` is read; `backend` keeps assignment from providers that
   * lack the optional method from tripping the weak-type check (a `Pick`
   * of one optional member has no required overlap). */
  provider: Pick<SandboxProvider, "list" | "backend">;
  engineHost: {
    /** Only the null-check is used — a cached session means "not orphaned". */
    liveSession(sessionId: string): object | null;
    destroySandbox(sandboxId: string): Promise<void>;
  };
  engineStore: {
    getSession(sessionId: string): Promise<unknown>;
    listUnsettledSubmissions(sessionId: string): Promise<unknown[]>;
  };
  /** Resolved via `resolveSandboxAgeReportMs` at boot; `<= 0` disables the
   * over-age report (never affects the orphan rule). */
  ageReportMs: number;
  /** Override for tests. */
  sweepIntervalMs?: number;
}

export class SandboxReconcileSweep {
  private timer: SweepTimer | null = null;

  constructor(private readonly deps: SandboxReconcileSweepDeps) {}

  async sweep(now = Date.now()): Promise<SweepReport> {
    const report: SweepReport = { orphansDestroyed: 0, overAge: 0, unowned: 0 };
    const list = this.deps.provider.list;
    if (!list) return report;
    const listed = await list.call(this.deps.provider);
    const overAgeIds: string[] = [];
    const orphanCandidates: Array<{ id: string; sessionId: string }> = [];
    for (const sb of listed) {
      try {
        const ageMs = this.deps.ageReportMs;
        if (ageMs > 0 && sb.createdAtMs != null && sb.createdAtMs <= now - ageMs) {
          report.overAge += 1;
          overAgeIds.push(sb.id);
        }
        if (!sb.sessionId) {
          report.unowned += 1;
          continue;
        }
        if (await this.isOrphaned(sb.sessionId)) {
          orphanCandidates.push({ id: sb.id, sessionId: sb.sessionId });
        }
      } catch (err) {
        console.error(`SandboxReconcileSweep: reconcile failed for sandbox ${sb.id}:`, err);
      }
    }
    if (orphanCandidates.length > 0) {
      report.orphansDestroyed = await this.destroyConfirmedOrphans(orphanCandidates, list);
    }
    recordSandboxFlagged("over_age", report.overAge);
    recordSandboxFlagged("unowned", report.unowned);
    if (report.overAge > 0) {
      console.warn(
        `SandboxReconcileSweep: ${report.overAge} sandbox(es) older than the report threshold — ` +
          `an owner failed to clean up. Ids: ${overAgeIds.join(", ")}. ` +
          `Find the owning sweep and fix it; do not add an age-based kill here (CLAUDE.md: alert, don't auto-repair).`,
      );
    }
    if (report.unowned > 0) {
      console.warn(
        `SandboxReconcileSweep: ${report.unowned} sandbox(es) carry no session annotation (pre-stamping); ` +
          `ownership is unverifiable from here. Destroy them manually once identified.`,
      );
    }
    return report;
  }

  /** The orphan rule's judgment: the owning session is gone from both the
   * store and the cache. */
  private async isOrphaned(sessionId: string): Promise<boolean> {
    if (this.deps.engineHost.liveSession(sessionId) != null) return false;
    const sessionRow = await this.deps.engineStore.getSession(sessionId);
    return sessionRow == null;
  }

  /**
   * Destroy the candidates a fresh listing still confirms. Sandbox names
   * are deterministic (same workspace → same name), so a sandbox judged
   * orphaned early in a long pass can be ADOPTED by a new session before
   * the pass reaches it — `applySandbox` rewrites the owner annotation on
   * adoption. Destroying from the stale snapshot would take the new
   * session's sandbox down mid-provision. The re-list narrows the window
   * from "whole pass" to the milliseconds between the fresh read and the
   * destroy: only a candidate whose CURRENT annotation still names the
   * same, still-gone session is destroyed.
   */
  private async destroyConfirmedOrphans(
    candidates: Array<{ id: string; sessionId: string }>,
    list: NonNullable<SandboxProvider["list"]>,
  ): Promise<number> {
    let destroyed = 0;
    const fresh = new Map((await list.call(this.deps.provider)).map((sb) => [sb.id, sb.sessionId]));
    for (const cand of candidates) {
      try {
        if (fresh.get(cand.id) !== cand.sessionId) continue; // re-owned, or already gone
        if (!(await this.isOrphaned(cand.sessionId))) continue; // owner re-appeared
        // Unsettled work always wins, checked immediately before the
        // destroy (the idle sweep's race rule).
        const unsettled = await this.deps.engineStore.listUnsettledSubmissions(cand.sessionId);
        if (unsettled.length > 0) continue;
        await this.deps.engineHost.destroySandbox(cand.id);
        recordSandboxDestroyed("orphaned");
        await revokeSandboxTokens(this.deps.db, cand.sessionId);
        destroyed += 1;
        console.log(
          `SandboxReconcileSweep: destroyed sandbox ${cand.id} for session ${cand.sessionId} — orphaned (session gone)`,
        );
      } catch (err) {
        console.error(`SandboxReconcileSweep: orphan destroy failed for sandbox ${cand.id}:`, err);
      }
    }
    return destroyed;
  }

  /** Start the sweep interval (no-op when the provider cannot list). */
  start(): void {
    if (this.timer || !this.deps.provider.list) return;
    const intervalMs = this.deps.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
    this.timer = startSweepTimer("SandboxReconcileSweep", intervalMs, () => this.sweep());
  }

  stop(): void {
    this.timer?.stop();
    this.timer = null;
  }
}
