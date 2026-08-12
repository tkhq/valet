/**
 * Session view access, beyond direct ownership. A session's `userId`
 * column is the direct-owner check every session route already had
 * (`eq(agentSessions.userId, caller)`); this adds exactly one more case —
 * a team-owned orchestrator session — without touching the rest.
 *
 * Team orchestrators are real: `orchestratorSessionId` mints
 * `orchestrator:team:{teamId}` and a team-owned workflow's `orchestrator`
 * node actually wakes one (`engine-deps.ts`'s `promptOrchestrator` with an
 * `ownerHint` of `{ownerType:"team", ownerId}`). But the session row it
 * creates gets `userId = "team:{teamId}"` (a synthetic id, never a real
 * user — `actorUserIdFor`), and every session-read route filtered strictly
 * on `userId = caller.id`, so no real user — however privileged — could
 * ever open one. This closes that specific gap.
 *
 * Deliberately READ-scoped: this governs viewing and prompting an
 * orchestrator (GET session, GET/POST messages, GET threads, the WS
 * connection), not session lifecycle (delete, pause, model change) or the
 * sandbox JWT — those stay direct-owner-only. Opening a shared team
 * resource to deletion/reconfiguration by any member is a bigger,
 * separate decision this file doesn't make.
 */
import type { AppDb } from "../lib/drizzle.js";
import { isTeamMember } from "./teams.js";

export interface SessionOwnerLike {
  userId: string;
  ownerType: string;
  ownerId: string;
}

/**
 * True when `caller` may view/prompt `session` — its direct owner, or a
 * live member of the team it belongs to (re-checked every call, never
 * cached, matching `isTeamMember`'s own contract: leaving a team drops
 * access on the very next request).
 */
export async function canViewSession(
  db: AppDb,
  session: SessionOwnerLike,
  callerId: string,
): Promise<boolean> {
  if (session.userId === callerId) return true;
  if (session.ownerType === "team") return isTeamMember(db, session.ownerId, callerId);
  return false;
}
