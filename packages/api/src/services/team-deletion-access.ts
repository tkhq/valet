import { and, eq, gt } from "drizzle-orm";
import { NotFoundError } from "@valet/shared";
import type { AppDb, AppTx } from "../lib/drizzle.js";
import { orgMembers, teamMembers, teamDeletionRequests, teams } from "../schema/index.js";
import { lockTeamForOwnership } from "./teams.js";

export type DeletionResourceType = typeof teamDeletionRequests.$inferSelect.resourceType;

/**
 * The refusal discriminator for "you are on this team, but you are not an
 * admin". Every route that refuses a team member for that reason sends this
 * code, so one client branch covers all of them.
 */
export const TEAM_ADMIN_REQUIRED_CODE = "team_admin_required";

export class TeamAdminRequiredError extends Error {
  readonly code: typeof TEAM_ADMIN_REQUIRED_CODE = TEAM_ADMIN_REQUIRED_CODE;
  readonly statusCode = 403;
  constructor(readonly teamId: string, readonly resourceType: DeletionResourceType, readonly resourceId: string) {
    super("Only a team admin can delete this. Open a deletion request for an admin to approve or decline.");
  }
}

/** Call inside the delete transaction. Membership writers use row updates/deletes. */
export async function lockTeamDeletionAccess(db: AppTx, owner: { orgId: string; userId: string }, teamId: string) {
  await lockTeamForOwnership(db, teamId);
  const [team] = await db.select({ id: teams.id }).from(teams).where(and(eq(teams.id, teamId), eq(teams.orgId, owner.orgId))).for("share");
  if (!team) throw new NotFoundError("team", teamId);
  const [member] = await db.select({ role: orgMembers.role }).from(orgMembers).where(and(eq(orgMembers.orgId, owner.orgId), eq(orgMembers.userId, owner.userId))).for("share");
  if (!member) throw new NotFoundError("team", teamId);
  const [teamMember] = await db.select({ role: teamMembers.role }).from(teamMembers).where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, owner.userId))).for("share");
  // An absent row cannot be locked. A later rescan could observe a new
  // membership that this transaction never protected against revocation.
  if (member.role !== "admin" && !teamMember) throw new NotFoundError("team", teamId);
  return member.role === "admin" || teamMember?.role === "admin";
}

export async function teamAdminRefusal(db: AppDb, orgId: string, err: TeamAdminRequiredError) {
  const [request] = await db.select({ id: teamDeletionRequests.id }).from(teamDeletionRequests).where(and(
    eq(teamDeletionRequests.orgId, orgId), eq(teamDeletionRequests.teamId, err.teamId),
    eq(teamDeletionRequests.resourceType, err.resourceType), eq(teamDeletionRequests.resourceId, err.resourceId),
    eq(teamDeletionRequests.status, "pending"), gt(teamDeletionRequests.expiresAt, Date.now()),
  )).limit(1);
  return { error: request ? "A deletion request for this is already open. A team admin decides it." : err.message,
    code: err.code, teamId: err.teamId, requestId: request?.id };
}
