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

export function buildHibernationHooks(db: AppDb): HibernationHooks {
  const clearHibernated = async (sessionId: string): Promise<void> => {
    await db
      .update(agentSessions)
      .set({ status: "active", updatedAt: Date.now() })
      .where(and(eq(agentSessions.id, sessionId), eq(agentSessions.status, "hibernated")));
  };

  return {
    onHibernate: async (sessionId: string) => {
      await db
        .update(agentSessions)
        .set({ status: "hibernated", updatedAt: Date.now() })
        .where(and(eq(agentSessions.id, sessionId), eq(agentSessions.status, "active")));
    },
    onWake: clearHibernated,
    onSessionReady: clearHibernated,
  };
}
