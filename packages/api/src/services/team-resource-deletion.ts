/** Shared deletion operations for direct requests and approved requests. */
import { and, eq, gt, lte } from "drizzle-orm";
import { NotFoundError } from "@valet/shared";
import type { AppDb } from "../lib/drizzle.js";
import { apikey, assistants, credentials, teamDeletionRequests } from "../schema/index.js";
import { markAttentionNotificationsRead } from "../orchestrator/attention.js";
import { invalidateWorkflowSources } from "./content-sync/invalidation.js";
import { deleteTeam } from "./teams.js";
import { reapTeamWorkflows } from "../workflows/service.js";
import { lockTeamDeletionAccess, TeamAdminRequiredError } from "./team-deletion-access.js";

type Actor = { orgId: string; userId: string };
export async function deleteTeamCredential(db: AppDb, actor: Actor, teamId: string, service: string) {
  return db.transaction(async (tx) => {
    const admin = await lockTeamDeletionAccess(tx, actor, teamId);
    const where = and(eq(credentials.ownerType, "team"), eq(credentials.ownerId, teamId), eq(credentials.service, service));
    const [row] = await tx.select({ service: credentials.service }).from(credentials).where(where).limit(1);
    if (!row) throw new NotFoundError("credential", service);
    if (!admin) throw new TeamAdminRequiredError(teamId, "credential", service);
    await tx.delete(credentials).where(where);
    await invalidateWorkflowSources(tx, { teamId });
  });
}
export async function deleteTeamApiKey(db: AppDb, actor: Actor, teamId: string, keyId: string) {
  return db.transaction(async (tx) => {
    // Team API keys are shared credentials. lockTeamDeletionAccess verifies
    // that the caller is an organization admin or a member of this team.
    await lockTeamDeletionAccess(tx, actor, teamId);
    const where = and(eq(apikey.teamId, teamId), eq(apikey.id, keyId));
    const [row] = await tx.select({ id: apikey.id }).from(apikey).where(where).limit(1);
    if (!row) throw new NotFoundError("api key", keyId);
    await tx.delete(apikey).where(where);
    // A member can revoke a shared key directly. Settle any review request for
    // the key in this transaction so an admin never approves a deleted key.
    const now = Date.now();
    const pending = and(
      eq(teamDeletionRequests.orgId, actor.orgId),
      eq(teamDeletionRequests.teamId, teamId),
      eq(teamDeletionRequests.resourceType, "api_key"),
      eq(teamDeletionRequests.resourceId, keyId),
      eq(teamDeletionRequests.status, "pending"),
    );
    // Match replacement-request expiry handling. An expired request is not
    // an approval by the member who later revokes the key.
    const expired = await tx.update(teamDeletionRequests).set({
      status: "declined", decidedAt: now,
      decisionNote: "Expired. Open a new request if deletion is still needed.",
    }).where(and(pending, lte(teamDeletionRequests.expiresAt, now)))
      .returning({ id: teamDeletionRequests.id });
    const settled = await tx.update(teamDeletionRequests).set({
      status: "approved", decidedBy: actor.userId, decidedAt: now,
      decisionNote: "API key was revoked directly.", lastRefusal: null,
    }).where(and(pending, gt(teamDeletionRequests.expiresAt, now)))
      .returning({ id: teamDeletionRequests.id });
    for (const request of [...expired, ...settled]) await markAttentionNotificationsRead(tx, "review", request.id);
  });
}
/** Returns sessions for teardown only after the enclosing transaction commits. */
export async function deleteTeamResources(db: AppDb, actor: Actor, teamId: string): Promise<string[]> {
  return db.transaction(async (tx) => {
    if (!(await lockTeamDeletionAccess(tx, actor, teamId))) throw new TeamAdminRequiredError(teamId, "team", teamId);
    const rows = await tx.select({ sessionId: assistants.sessionId }).from(assistants)
      .where(and(eq(assistants.ownerType, "team"), eq(assistants.ownerId, teamId)));
    await deleteTeam(tx, { teamId, reapOwnedWorkflows: (inner) => reapTeamWorkflows(inner, teamId) });
    return rows.map((r) => r.sessionId);
  });
}
