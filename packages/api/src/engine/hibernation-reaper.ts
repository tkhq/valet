/**
 * Hibernated-sandbox reaper — the expiry authority the idle sweep
 * deliberately left out (host.ts `runIdleSweep`, "accepted Stage 1
 * limitation").
 *
 * The idle sweep only SUSPENDS: the sandbox CR and its workspace PVC are
 * retained forever, and the sweep can't even see sessions an api restart
 * evicted from the in-memory cache — those keep running pods indefinitely.
 * On a small cluster that accumulation ends in "Too many pods" scheduling
 * failures (observed on a shared deployment, Aug 2026). This sweep is the
 * close-out: a session that has sat `hibernated` past the retention window
 * (`VALET_SANDBOX_HIBERNATED_RETENTION_MINUTES`, default 60) gets its
 * sandbox destroyed for good. Reopening the session afterwards provisions a
 * fresh sandbox exactly like a first open.
 *
 * Driven by `agent_sessions` (status flip + `updated_at` timestamp written
 * by `writeHibernated`), NOT the host cache — so it survives restarts. The
 * destroy handle for uncached sessions is `hibernated_sandbox_id`, recorded
 * at hibernate time (same pattern as `child_watches.parked_sandbox_id`, and
 * for the same reason: the engine session row's sandbox_id predates
 * provisioning). Rows without a recorded handle (hibernated before that
 * column existed) fall back to `SandboxProvider.deriveId` — for providers
 * with deterministic ids the recomputed handle is byte-identical to the one
 * that would have been recorded, so the pre-upgrade backlog reaps without
 * manual intervention. Race rules mirror `ChildWatcher.sweepRetention`: unsettled
 * submissions and fresh activity always win, and are re-checked immediately
 * before a live destroy.
 */
import { and, eq, isNull, lte } from "drizzle-orm";
import type { AttachmentState } from "@valet/engine";
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
    destroy(): Promise<void>;
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
          // Only a still-suspended attachment is reaped. Any other state
          // means the session is waking or already awake (the db flip to
          // `active` may simply not have landed yet) — never destroy a
          // sandbox out from under that; the next tick re-judges.
          if (live.attachment.state !== "suspended") continue;
          // Race rule (mirrors `ChildWatcher.sweepRetention`): re-check
          // immediately before the destroy — a submission admitted since
          // the check above wins and the reap waits for the next pass.
          const recheck = await this.deps.engineStore.listUnsettledSubmissions(row.id);
          if (recheck.length > 0) continue;
          await live.attachment.destroy();
          this.deps.engineHost.evictCache(row.id);
        } else {
          // Prefer the handle recorded at hibernate time; fall back to
          // recomputing it from the workspace for providers with
          // deterministic ids (sessions hibernated before the column
          // existed). The derived id is byte-identical to what `create`
          // named, so this is exactly as targeted as the recorded path —
          // and a name that matches nothing is a tolerated 404, not a
          // misdirected destroy.
          const handle = row.hibernatedSandboxId ?? this.deps.engineHost.deriveSandboxId(row.workspace);
          if (handle) {
            await this.deps.engineHost.destroySandbox(handle);
          } else {
            // Nothing destroyable from here: not cached, no recorded handle,
            // and the provider's ids aren't derivable (backend-assigned).
            // Stamp the reclaim so the row stops sweeping, but say so.
            console.warn(
              `HibernationReaper: session ${row.id} is past retention but has no live session and no derivable sandbox handle; stamping reclaimed without a destroy`,
            );
          }
        }
        await revokeSandboxTokens(this.deps.db, row.id);
        // Conditioned on the row still being hibernated: a wake that raced
        // this sweep has already flipped the status (clearing the
        // bookkeeping itself), and must not end up stamped as reclaimed.
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
