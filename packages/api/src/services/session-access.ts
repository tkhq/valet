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
 * The `agent_sessions` app row is a different row with a different stamp:
 * only `ensureOrchestratorSession` writes it, from `meta.actorUserId` — the
 * member who opened the team's assistant first. Do not read that stamp as
 * ownership. See `canAdministerSession` below.
 *
 * Two checks live here. They answer different questions, and the split is
 * deliberate:
 *
 *   - `canViewSession` — may the caller read and prompt this session? Any
 *     live member of the owning team may (GET session, GET/POST messages,
 *     GET threads, the WS connection). Viewing follows membership.
 *   - `canAdministerSession` — may the caller change the session itself:
 *     set its model, pause it, delete it? On a team-owned session this
 *     needs team-admin authority. Administering follows authority, not
 *     membership.
 *
 * `POST /api/sessions/:id/sandbox-jwt` stays direct-owner-only and uses
 * neither check. It mints a credential bound to one user, not a view of a
 * shared resource.
 */
import type { AppDb } from "../lib/drizzle.js";
import { canAdministerTeam, isTeamMember } from "./teams.js";

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

/**
 * True when `caller` may administer `session` — set its model, pause it, or
 * delete it. The deliberate mirror of `canViewSession` above.
 *
 * A team-owned session belongs to the team, not to the member who opened it
 * first. `agent_sessions.userId` on such a row holds that first actor:
 * `ensureOrchestratorSession` stamps `meta.actorUserId` when it backfills
 * the row. The direct-owner shortcut that `canViewSession` starts with is
 * therefore wrong here. It would make one arbitrary member the de-facto
 * owner of an agent the whole team shares, and it would refuse every other
 * member. The team branch replaces that comparison instead of adding to it.
 * `canAdministerTeam` (`services/teams.ts`) supplies the rule — a team
 * admin of that team, or an org admin — and is the same definition the team
 * mutation routes use.
 *
 * Every other owner type keeps the rule these routes already had: the
 * direct owner only. An org-owned session gets no org-level path here, the
 * same limit `canViewSession` has.
 */
export async function canAdministerSession(
  db: AppDb,
  session: SessionOwnerLike,
  callerId: string,
): Promise<boolean> {
  if (session.ownerType === "team") return canAdministerTeam(db, session.ownerId, callerId);
  return session.userId === callerId;
}
