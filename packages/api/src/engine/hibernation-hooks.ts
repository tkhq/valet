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
import { and, eq, isNotNull, sql } from "drizzle-orm";
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
 * `sandboxId` is recorded as `hibernated_sandbox_id` — the reaper's destroy
 * handle for sessions an api restart evicts from the host cache — and
 * `sandbox_reclaimed_at` is cleared: every hibernate starts a fresh cycle.
 *
 * `sandbox_suspended_at` keeps an existing value. A prompt that never wakes
 * the sandbox flips the row to `active`, and the next hibernate write finds
 * the sandbox still suspended; restarting the clock there would keep a
 * sandbox that has not run for months out of the reaper's reach. Only a
 * `ready` transition clears it (`clearSandboxSuspended`).
 */
export async function writeHibernated(db: AppDb, sessionId: string, sandboxId?: string): Promise<void> {
  const now = Date.now();
  await db
    .update(agentSessions)
    .set({
      status: "hibernated",
      hibernatedSandboxId: sandboxId ?? null,
      sandboxReclaimedAt: null,
      sandboxSuspendedAt: sql`COALESCE(${agentSessions.sandboxSuspendedAt}, ${now})`,
      updatedAt: now,
    })
    .where(and(eq(agentSessions.id, sessionId), eq(agentSessions.status, "active")));
}

export function buildHibernationHooks(db: AppDb): HibernationHooks {
  const clearHibernated = async (sessionId: string): Promise<void> => {
    await db
      .update(agentSessions)
      // An awake session has no hibernated sandbox to reap; a stale handle
      // would invite a misdirected destroy.
      .set({ status: "active", hibernatedSandboxId: null, sandboxReclaimedAt: null, updatedAt: Date.now() })
      .where(and(eq(agentSessions.id, sessionId), eq(agentSessions.status, "hibernated")));
  };

  // Not conditioned on status: a prompt can flip the row to `active` before
  // the sandbox wakes, and the stale clock must still go.
  const clearSandboxSuspended = async (sessionId: string): Promise<void> => {
    await db
      .update(agentSessions)
      .set({ sandboxSuspendedAt: null })
      .where(and(eq(agentSessions.id, sessionId), isNotNull(agentSessions.sandboxSuspendedAt)));
  };

  return {
    onHibernate: async (sessionId: string, sandboxId?: string) => {
      await writeHibernated(db, sessionId, sandboxId);
    },
    // `onWake` also fires from `markSessionUsed` on every prompt, including
    // prompts that never touch the sandbox, so it keeps the suspend clock.
    onWake: clearHibernated,
    onSessionReady: async (sessionId: string) => {
      await clearHibernated(sessionId);
      await clearSandboxSuspended(sessionId);
    },
  };
}
