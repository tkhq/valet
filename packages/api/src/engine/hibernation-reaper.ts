/**
 * Hibernated-sandbox reaper. The idle sweep only SUSPENDS: the sandbox CR
 * and workspace PVC are retained forever, which accumulates into "Too many
 * pods" scheduling failures on small clusters. This sweep destroys the
 * sandbox of any session hibernated past the retention window
 * (`VALET_SANDBOX_HIBERNATED_RETENTION_MINUTES`, default 72h); reopening the
 * session afterwards provisions a fresh sandbox like a first open.
 *
 * Driven by `agent_sessions` rather than the host cache so it survives api
 * restarts: uncached sessions are destroyed via `hibernated_sandbox_id`
 * (recorded at hibernate time), falling back to `SandboxProvider.deriveId`
 * for rows hibernated before that column existed. Race rules mirror
 * `ChildWatcher.sweepRetention`.
 *
 * The idle clock is `sandbox_suspended_at`: when the sandbox itself was
 * suspended. Session activity is not the clock. A prompt that never wakes
 * the sandbox moves `updated_at` and adds engine activity, so either clock
 * kept sandboxes suspended for months out of reach while their owners
 * chatted. Rows hibernated before the column existed fall back to
 * `updated_at` and the engine activity check.
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import { recordSandboxDestroyed, type AttachmentState, reportError } from "@valet/engine";
import type { AppDb } from "../lib/drizzle.js";
import { agentSessions } from "../schema/index.js";
import { revokeSandboxTokens } from "../auth/sandbox-tokens.js";
import { startSweepTimer, type SweepTimer } from "../lib/sweep-timer.js";
import { sandboxReclaimBackoff } from "../lib/retry-backoff.js";

const DEFAULT_SWEEP_INTERVAL_MS = 5 * 60_000;

/** The slice of a cached `Session` the reaper touches. Structural (rather
 * than `Pick`s of the real `EngineHost`/`Session`) so tests can hand in
 * plain fakes without casts; the real `EngineHost` satisfies it as-is. */
interface ReaperLiveSession {
  attachment: {
    readonly state: AttachmentState;
    /** Resolves false when the provider destroy failed (see
     * `SandboxAttachment.destroy`); the reaper stamps regardless — the
     * reconcile sweep's over-age report is the backstop for that case. */
    destroy(reason?: string): Promise<boolean>;
  };
}

export interface HibernationReaperDeps {
  db: AppDb;
  engineHost: {
    liveSession(sessionId: string): ReaperLiveSession | null;
    destroySandbox(sandboxId: string): Promise<void>;
    sandboxStatus(sandboxId: string): Promise<{ state: string }>;
    deriveSandboxId(sessionKey: string): string | null;
    evictCache(sessionId: string): void;
  };
  engineStore: {
    listUnsettledSubmissions(sessionId: string): Promise<unknown[]>;
    latestActivityAt(sessionId: string): Promise<number | null>;
    countActiveLeases(sessionId: string): Promise<number>;
  };
  /** Resolved via `resolveHibernatedRetentionMs` at boot; `<= 0` disables. */
  retentionMs: number;
  /** Override for tests. */
  sweepIntervalMs?: number;
}

export class HibernationReaper {
  private timer: SweepTimer | null = null;
  private readonly backoff = sandboxReclaimBackoff();

  constructor(private readonly deps: HibernationReaperDeps) {}

  async sweep(now = Date.now()): Promise<void> {
    const retentionMs = this.deps.retentionMs;
    if (retentionMs <= 0) return;
    const cutoff = now - retentionMs;
    const rows = await this.deps.db
      .select()
      .from(agentSessions)
      .where(
        and(
          eq(agentSessions.status, "hibernated"),
          // Legacy team roots retain mixed-audience files for explicit recovery.
          // Only isolated executions resume normal destructive retention.
          sql`NOT EXISTS (SELECT 1 FROM assistants a WHERE a.session_id=${agentSessions.id} AND a.owner_type='team')`,
          isNull(agentSessions.sandboxReclaimedAt),
          sql`COALESCE(${agentSessions.sandboxSuspendedAt}, ${agentSessions.updatedAt}) <= ${cutoff}`,
        ),
      );
    for (const row of rows) {
      if (!this.backoff.ready(row.id, now)) continue;
      try {
        const unsettled = await this.deps.engineStore.listUnsettledSubmissions(row.id);
        if (unsettled.length > 0) continue;
        // A lease holds the sandbox, the same rule as the idle sweep.
        if ((await this.deps.engineStore.countActiveLeases(row.id)) > 0) continue;
        if (row.sandboxSuspendedAt == null) {
          const activityAt = await this.deps.engineStore.latestActivityAt(row.id);
          if (activityAt != null && activityAt > cutoff) continue;
        }

        const live = this.deps.engineHost.liveSession(row.id);
        if (live) {
          // Any state other than `suspended` means the session is waking or
          // awake — never destroy under that; the next tick re-judges.
          if (live.attachment.state !== "suspended") continue;
          // Re-check immediately before the destroy: a submission admitted
          // since the check above wins.
          const recheck = await this.deps.engineStore.listUnsettledSubmissions(row.id);
          if (recheck.length > 0) continue;
          await live.attachment.destroy("hibernation_retention");
          this.deps.engineHost.evictCache(row.id);
          console.log(`HibernationReaper: reclaimed cached sandbox for session ${row.id}`);
        } else {
          // Recorded handle first; derived handle (deterministic providers
          // only) covers rows hibernated before the column existed. A name
          // matching nothing is a tolerated 404.
          const handle = row.hibernatedSandboxId ?? this.deps.engineHost.deriveSandboxId(row.workspace);
          if (handle) {
            // A derived name can match nothing. Count only a sandbox that was
            // there, so created minus destroyed stays a true gap.
            const present = (await this.deps.engineHost.sandboxStatus(handle)).state !== "released";
            await this.deps.engineHost.destroySandbox(handle);
            if (present) recordSandboxDestroyed("hibernation_retention");
            console.log(`HibernationReaper: reclaimed sandbox ${handle} for session ${row.id}`);
          } else {
            console.warn(
              `HibernationReaper: session ${row.id} is past retention but has no live session and no derivable sandbox handle; stamping reclaimed without a destroy`,
            );
          }
        }
        await revokeSandboxTokens(this.deps.db, row.id);
        // Conditioned on `status='hibernated'`: a wake that raced this sweep
        // must not end up stamped as reclaimed.
        await this.deps.db
          .update(agentSessions)
          .set({ sandboxReclaimedAt: now, updatedAt: now })
          .where(and(eq(agentSessions.id, row.id), eq(agentSessions.status, "hibernated")));
        this.backoff.succeeded(row.id);
      } catch (err) {
        const waitMs = this.backoff.failed(row.id, now);
        reportError({ area: "sandbox", reason: "hibernation_reclaim" }, `HibernationReaper: reclaim failed for session ${row.id}; next attempt in ${Math.round(waitMs / 60_000)} min`, err);
      }
    }
  }

  /** Start the sweep interval (no-op when retention is off). */
  start(): void {
    if (this.timer || this.deps.retentionMs <= 0) return;
    const intervalMs = this.deps.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
    this.timer = startSweepTimer("HibernationReaper", intervalMs, () => this.sweep());
  }

  stop(): void {
    this.timer?.stop();
    this.timer = null;
  }
}
