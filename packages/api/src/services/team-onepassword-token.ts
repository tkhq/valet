/** Team token writes and retirement of the former reference allowlist. */
import { and, eq, sql } from "drizzle-orm";
import type { AppDb } from "../lib/drizzle.js";
import { deriveSecretKey, encryptSecret } from "../lib/secret-crypto.js";
import { credentials, orgMembers, teamMembers, teams } from "../schema/index.js";
import { lockTeamForOwnership } from "./teams.js";
import { ONEPASSWORD_SERVICE } from "./onepassword.js";
import { invalidateWorkflowSources } from "./content-sync/invalidation.js";

type Mutation = { kind: "token"; token: string | null };

/**
 * Lock the tenant-scoped team row, including when no credential exists yet.
 * Token rotation and disconnect share this transaction. Obsolete refs are
 * ignored on reads and removed only during an explicit token replacement.
 */
export async function mutateTeamOnePassword(
  db: AppDb,
  key: string,
  ctx: { orgId: string; teamId: string; userId: string },
  mutation: Mutation,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    // Same lock order as team OAuth writes and deleteTeam.
    await lockTeamForOwnership(tx, ctx.teamId);
    const [team] = await tx.select({ id: teams.id }).from(teams)
      .where(and(eq(teams.id, ctx.teamId), eq(teams.orgId, ctx.orgId))).for("share");
    if (!team) return false;
    // SHARE also conflicts with role demotion, unlike KEY SHARE.
    const [orgMember] = await tx.select({ role: orgMembers.role }).from(orgMembers)
      .where(and(eq(orgMembers.orgId, ctx.orgId), eq(orgMembers.userId, ctx.userId))).for("share");
    if (!orgMember) return false;
    const [teamMember] = await tx.select({ role: teamMembers.role }).from(teamMembers)
      .where(and(eq(teamMembers.teamId, team.id), eq(teamMembers.userId, ctx.userId))).for("share");
    if (orgMember.role !== "admin" && teamMember?.role !== "admin") return false;
    const where = and(eq(credentials.ownerType, "team"), eq(credentials.ownerId, team.id), eq(credentials.service, ONEPASSWORD_SERVICE));
    const metadata = sql`COALESCE(${credentials.metadata}, '{}'::jsonb) - 'refs'`;
    const now = Date.now();
    if (mutation.kind === "token" && mutation.token !== null) {
      const apiKeyEnc = encryptSecret(mutation.token, deriveSecretKey(key));
      await tx.insert(credentials).values({
        ownerType: "team", ownerId: team.id, service: ONEPASSWORD_SERVICE,
        type: "service_account", apiKeyEnc, metadata: {}, createdAt: now, updatedAt: now,
      }).onConflictDoUpdate({
        target: [credentials.ownerType, credentials.ownerId, credentials.service],
        set: { type: "service_account", apiKeyEnc, accessTokenEnc: null, refreshTokenEnc: null, expiresAt: null, scopes: null, metadata, updatedAt: now },
      });
    } else {
      await tx.delete(credentials).where(where);
    }
    await invalidateWorkflowSources(tx, { teamId: team.id });
    return true;
  });
}
