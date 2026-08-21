/**
 * Shared `EngineHostOpts` hibernation hooks (sandbox hibernation plan,
 * Task 4) — the db-writing side of the `onHibernate`/`onWake`/
 * `onSessionReady` seams `EngineHost` exposes (Task 3's seam,
 * `packages/api/src/engine/host.ts`). One implementation shared by
 * `providers/node.ts` (real boot) and `integration/_setup.ts`
 * (`bootTestApi`'s default wiring) so the status-flip behavior under test
 * is the exact behavior production runs.
 *
 * Both writes are conditioned on the row's CURRENT status (`active` for
 * hibernate, `hibernated` for wake/ready) so they never clobber
 * `archived`/`deleted`, and so `onSessionReady` — which fires on every
 * `ready` transition, not just genuine wakes (see its doc comment on
 * `EngineHostOpts`) — is a no-op on the vast majority of calls where the
 * row isn't currently hibernated.
 */
import { and, eq } from "drizzle-orm";
import type { AppDb } from "../lib/drizzle.js";
import { agentSessions } from "../schema/index.js";
import type { EngineHostOpts } from "./host.js";

export type HibernationHooks = Pick<EngineHostOpts, "onHibernate" | "onWake" | "onSessionReady">;

/**
 * The single guarded "flip to hibernated" write: conditioned on the row's
 * CURRENT status being `active` so it never clobbers `archived`/`deleted`
 * (or a row that's already hibernated). Shared by `buildHibernationHooks`'s
 * `onHibernate` (fires from engine-internal hibernation) and the
 * `POST /:id/pause` route (fires from an explicit user pause) so there is
 * exactly one place that writes this transition.
 *
 * `sandboxId` (when the caller has the attachment's live handle) is recorded
 * as `hibernated_sandbox_id` — the hibernated-sandbox reaper's destroy
 * handle for sessions an api restart has evicted from the host cache.
 * `sandbox_reclaimed_at` is cleared in the same write: every hibernate
 * starts a fresh reclaim cycle.
 */
export async function writeHibernated(db: AppDb, sessionId: string, sandboxId?: string): Promise<void> {
  await db
    .update(agentSessions)
    .set({
      status: "hibernated",
      hibernatedSandboxId: sandboxId ?? null,
      sandboxReclaimedAt: null,
      updatedAt: Date.now(),
    })
    .where(and(eq(agentSessions.id, sessionId), eq(agentSessions.status, "active")));
}

export function buildHibernationHooks(db: AppDb): HibernationHooks {
  const clearHibernated = async (sessionId: string): Promise<void> => {
    await db
      .update(agentSessions)
      // The reclaim bookkeeping is cleared alongside the status flip: an
      // awake session has no hibernated sandbox to reap, and leaving a stale
      // handle behind would only invite a future misdirected destroy.
      .set({ status: "active", hibernatedSandboxId: null, sandboxReclaimedAt: null, updatedAt: Date.now() })
      .where(and(eq(agentSessions.id, sessionId), eq(agentSessions.status, "hibernated")));
  };

  return {
    onHibernate: async (sessionId: string, sandboxId?: string) => {
      await writeHibernated(db, sessionId, sandboxId);
    },
    onWake: clearHibernated,
    onSessionReady: clearHibernated,
  };
}
