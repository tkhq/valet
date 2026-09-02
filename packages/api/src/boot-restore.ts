/**
 * Boot-restore session routing (Phase 5, boot-restore fix follow-up).
 * Extracted out of `main.ts` so the `wf:` vs regular-session routing
 * decision can be unit-tested without importing `main.ts` — which runs
 * side-effecting boot code (env checks, `buildNodeProviders`, `process.exit`)
 * at module load time and cannot be safely imported from a test.
 *
 * See CLAUDE.md's persistence-shape-drift guidance: this routing decision
 * used to be exercised only by the key-gated Docker E2E.
 */
import type { RepoBinding } from "./wire/types.js";

/** The regular (non-workflow) session restore meta this module threads
 * from `lookupAgentSession` into `sessionFor` — mirrors `EngineHost`'s
 * `SessionMeta` (GitHub/repo integration plan, Task 9's `repos`/
 * `userName`/`userEmail` addition, following the `profile` precedent) but
 * declared locally so this module stays importable without pulling in
 * `engine/host.ts`.
 *
 * `targetDir` on each repo is required (spec decision 15): it is computed
 * once at bind time and persisted on `session_repos.target_dir`. Rows with
 * a NULL column use the legacy fallback in `loadSessionMeta`. */
export interface RestoreSessionMeta {
  userId: string;
  orgId: string;
  workspace: string;
  profile: "headless" | "full";
  /** Rootless docker-in-sandbox flag from the `agent_sessions` row — must
   * survive restore or the rebuilt sandbox loses its docker caps/mounts
   * (already flowed structurally at runtime; declared so the type matches). */
  docker?: boolean;
  repos?: (RepoBinding & { targetDir: string })[];
  userName?: string;
  userEmail?: string;
  /** Owning team for a team-owned session (TKAI-255) — must survive
   * restore or a rebuilt session with no persisted model would skip the
   * team tier of the model cascade (flows structurally from
   * `loadSessionMeta`; declared so the type matches). */
  ownerTeamId?: string;
}

/**
 * Narrow, dependency-injected surface for {@link restoreOneSession} — lets
 * the routing decision be unit-tested without a real
 * `EngineHost`/`Providers`/sqlite db. Production callers (`main.ts`) build
 * this from `Providers`.
 */
export interface RestoreSessionDeps {
  ensureWorkflowSession: (sessionId: string) => Promise<{ id: string }>;
  lookupAgentSession: (sessionId: string) => Promise<RestoreSessionMeta | undefined>;
  sessionFor: (sessionId: string, meta: RestoreSessionMeta) => Promise<unknown>;
}

/**
 * Routes a single unsettled-submission session id to the right restore path
 * and materializes it.
 *
 * Workflow sessions (`wf:{runId}:{nodeId}`) have no `agent_sessions` app
 * row — their context lives in `workflow_runs` — so they must be
 * materialized through the workflow engine-deps path instead of the
 * app-row lookup. Without this branch a restart mid-session-node leaves the
 * workflow run parked on a submission that never settles.
 *
 * Does NOT catch errors itself — callers are responsible for per-session
 * isolation (see the try/catch around each call in `main.ts`'s
 * `restoreUnsettledSessions`), so one bad row can't stall the rest of boot.
 */
export async function restoreOneSession(sessionId: string, deps: RestoreSessionDeps): Promise<void> {
  if (sessionId.startsWith("wf:")) {
    await deps.ensureWorkflowSession(sessionId);
    return;
  }
  const row = await deps.lookupAgentSession(sessionId);
  if (!row) {
    console.warn(`boot restore: skipping ${sessionId} — no app session row`);
    return;
  }
  await deps.sessionFor(sessionId, row);
}

/** Bounds for {@link runBoundedRestore}. */
export interface BoundedRestoreOpts {
  /** Max sessions restored at once. */
  concurrency: number;
  /** Per-session wait budget in ms. A session past it is abandoned by the
   * restore pass only — its underlying work keeps running, and
   * `EngineHost.sessionFor`'s single-flight map hands later callers the same
   * in-flight promise. */
  timeoutMs: number;
  /** Checked before each session is pulled; true stops the pass (shutdown). */
  shouldStop?: () => boolean;
  /**
   * Called once per session that exceeds `timeoutMs` (fix 10a). Production
   * passes `recordBootRestoreTimeout` so an un-restorable session is visible
   * as a metric, not just a log line. Injected (not imported here) to keep
   * this module free of the OTel dependency chain so it stays unit-testable.
   */
  onTimeout?: (sessionId: string) => void;
}

export interface BoundedRestoreResult {
  restored: number;
  failed: number;
  timedOut: number;
  /** True when `shouldStop` ended the pass before the id list was drained. */
  stopped: boolean;
}

/**
 * Restore sessions with bounded concurrency and a per-session timeout.
 *
 * Boot restore used to run on the critical path in front of the HTTP
 * listener, strictly sequentially and with no per-session bound — one wedged
 * in-sandbox exec (a `git fetch` into a full disk, in the sha-a6eadbe
 * rollout) stalled the whole pass, boot never bound the port, and the
 * kubelet killed the pod at the startup budget. The listener now binds
 * first (`main.ts`), and this runner bounds the pass itself so a single
 * slow session cannot serialize the rest or hold readiness forever.
 *
 * Per-session failures and timeouts are logged and counted, never thrown.
 */
export async function runBoundedRestore(
  ids: string[],
  restore: (sessionId: string) => Promise<void>,
  opts: BoundedRestoreOpts,
): Promise<BoundedRestoreResult> {
  const result: BoundedRestoreResult = { restored: 0, failed: 0, timedOut: 0, stopped: false };
  let next = 0;
  // Abandoned (timed-out) attempts that have not settled yet. Real in-flight
  // work is `concurrency + abandonedInFlight`; the refresh-path exec timeout
  // (workspace-prep.ts's GIT_REFRESH_TIMEOUT_MS, plus each provider's own
  // exec bound) makes abandoned attempts self-terminate, which caps the
  // overlap at roughly `concurrency * (execTimeout / timeoutMs)`. Reported
  // in the timeout log line so a pile-up is visible as it happens.
  let abandonedInFlight = 0;

  async function worker(): Promise<void> {
    while (next < ids.length) {
      if (opts.shouldStop?.()) {
        result.stopped = true;
        return;
      }
      const id = ids[next++];
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<"timeout">((res) => {
        timer = setTimeout(() => res("timeout"), opts.timeoutMs);
        timer.unref();
      });
      try {
        const attempt = restore(id).then(() => "done" as const);
        const raced = await Promise.race([attempt, timeout]);
        if (raced === "timeout") {
          result.timedOut++;
          abandonedInFlight++;
          // Emit the alert per timed-out session (fix 10a). Best-effort: a
          // throwing hook must never abort the restore pass.
          try {
            opts.onTimeout?.(id);
          } catch (err) {
            console.error(`boot restore: onTimeout hook threw for ${id}:`, err);
          }
          // The attempt is now unobserved by the race; keep watching it so
          // its outcome is never silent — a late failure logged here is the
          // only trail an operator gets for a session that never came back.
          // Attached synchronously in the same tick the race settles, so a
          // later rejection cannot surface as an unhandledRejection.
          attempt
            .then(
              () => console.log(`boot restore: abandoned session ${id} finished restoring in the background`),
              (err: unknown) =>
                console.error(`boot restore: abandoned session ${id} later failed in the background:`, err),
            )
            .finally(() => {
              abandonedInFlight--;
            });
          console.error(
            `boot restore: session ${id} exceeded ${opts.timeoutMs}ms — abandoning the wait ` +
              `(${abandonedInFlight} abandoned restore${abandonedInFlight === 1 ? "" : "s"} still running)`,
          );
        } else {
          result.restored++;
        }
      } catch (err) {
        result.failed++;
        console.error(`boot restore: failed to restore session ${id}:`, err);
      } finally {
        clearTimeout(timer);
      }
    }
  }

  const workers = Array.from({ length: Math.max(1, opts.concurrency) }, () => worker());
  await Promise.all(workers);
  return result;
}
