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
 */
import { and, eq, isNull, lte } from "drizzle-orm";
import { recordSandboxDestroyed, type AttachmentState } from "@valet/engine";
import type { AppDb } from "../lib/drizzle.js";
import { agentSessions } from "../schema/index.js";
import { revokeSandboxTokens } from "../auth/sandbox-tokens.js";

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
    deriveSandboxId(sessionKey: string): string | null;
    evictCache(sessionId: string): void;
  };
  engineStore: {
    listUnsettledSubmissions(sessionId: string): Promise<unknown[]>;
    latestActivityAt(sessionId: string): Promise<number | null>;
  };
  /** Resolved via `resolveHibernatedRetentionMs` at boot; `<= 0` disables. */
  retentionMs: number;
  /** Override for tests. */
  sweepIntervalMs?: number;
}

export class HibernationReaper {
  private timer: ReturnType<typeof setInterval> | null = null;

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
          isNull(agentSessions.sandboxReclaimedAt),
          lte(agentSessions.updatedAt, cutoff),
        ),
      );
    for (const row of rows) {
      try {
        const unsettled = await this.deps.engineStore.listUnsettledSubmissions(row.id);
        if (unsettled.length > 0) continue;
        const activityAt = await this.deps.engineStore.latestActivityAt(row.id);
        if (activityAt != null && activityAt > cutoff) continue;

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
            await this.deps.engineHost.destroySandbox(handle);
            recordSandboxDestroyed("hibernation_retention");
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
      } catch (err) {
        console.error(`HibernationReaper: reclaim failed for session ${row.id}:`, err);
      }
    }
  }

  /** Start the sweep interval (no-op when retention is off). Unref'd — never holds the process open. */
  start(): void {
    if (this.timer || this.deps.retentionMs <= 0) return;
    const intervalMs = this.deps.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
    const timer = setInterval(() => {
      void this.sweep().catch((err) => console.error("HibernationReaper: sweep failed:", err));
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
