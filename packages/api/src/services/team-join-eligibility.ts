import { and, eq, gt, inArray, sql } from "drizzle-orm";
import { AUTH_SESSION_LIFETIME_SECONDS } from "../auth/config.js";
import type { AppDb } from "../lib/drizzle.js";
import { orgMembers, teamJoinEligibilities, teamMembers, teams } from "../schema/index.js";
import { invalidateWorkflowSources } from "./content-sync/invalidation.js";
import type { TeamClaim } from "./team-sync.js";

export interface SuggestedTeam {
  id: string;
  name: string;
  memberCount: number;
}

/**
 * Returns the parent team paths that a valid group claim currently supports.
 * Admin subgroup membership proves join eligibility but never grants a role.
 */
export function eligibleTeamPaths(claim: TeamClaim, adminGroupName: string): string[] {
  if (!claim.present) return [];
  const paths = new Set<string>();
  for (const raw of claim.paths) {
    const value = raw.trim();
    if (!value.startsWith("/")) continue;
    const segments = value.split("/").filter(Boolean);
    if (segments.length === 1 || (segments.length === 2 && segments[1] === adminGroupName)) {
      const parent = segments[0];
      if (parent) paths.add(`/${parent}`);
    }
  }
  return [...paths];
}

/**
 * Replaces one user's join eligibility from one SSO login. This writes no
 * team and no membership. An absent, unreadable, or empty claim clears the
 * prior snapshot so a stale claim cannot authorize a later join.
 */
export async function refreshTeamJoinEligibility(
  db: AppDb,
  opts: { orgId: string; userId: string; claim: TeamClaim; adminGroupName: string },
): Promise<number> {
  const paths = eligibleTeamPaths(opts.claim, opts.adminGroupName);
  return db.transaction(async (tx) => {
    const candidates = paths.length === 0
      ? []
      : await tx
          .select({ teamId: teams.id })
          .from(teams)
          .where(
            and(
              eq(teams.orgId, opts.orgId),
              eq(teams.origin, "idp"),
              inArray(teams.externalId, paths),
            ),
          )
          .for("share");

    await tx.delete(teamJoinEligibilities).where(eq(teamJoinEligibilities.userId, opts.userId));
    if (candidates.length > 0) {
      const observedAt = Date.now();
      await tx.insert(teamJoinEligibilities).values(
        candidates.map(({ teamId }) => ({ teamId, userId: opts.userId, observedAt })),
      );
    }
    return candidates.length;
  });
}

/** Lists only eligible teams in this org that the current user has not joined. */
export async function listSuggestedTeams(
  db: AppDb,
  orgId: string,
  userId: string,
): Promise<SuggestedTeam[]> {
  const freshAfter = Date.now() - AUTH_SESSION_LIFETIME_SECONDS * 1000;
  return db
    .select({
      id: teams.id,
      name: teams.name,
      memberCount: sql<number>`count(${teamMembers.userId})::int`,
    })
    .from(teamJoinEligibilities)
    .innerJoin(
      teams,
      and(
        eq(teams.id, teamJoinEligibilities.teamId),
        eq(teams.orgId, orgId),
        eq(teams.origin, "idp"),
      ),
    )
    .innerJoin(
      orgMembers,
      and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, userId)),
    )
    .leftJoin(teamMembers, eq(teamMembers.teamId, teams.id))
    .where(
      and(
        eq(teamJoinEligibilities.userId, userId),
        gt(teamJoinEligibilities.observedAt, freshAfter),
        sql`not exists (
          select 1 from ${teamMembers} membership
          where membership.team_id = ${teams.id} and membership.user_id = ${userId}
        )`,
      ),
    )
    .groupBy(teams.id, teams.name, teams.createdAt)
    .orderBy(teams.createdAt);
}

/**
 * Joins from server-held current eligibility. A missing, stale, foreign-org,
 * or crafted team ID gets the same false result and reveals no team details.
 */
export async function joinEligibleTeam(
  db: AppDb,
  opts: { orgId: string; userId: string; teamId: string },
): Promise<boolean> {
  const freshAfter = Date.now() - AUTH_SESSION_LIFETIME_SECONDS * 1000;
  return db.transaction(async (tx) => {
    const eligible = await tx
      .select({ teamId: teams.id })
      .from(teamJoinEligibilities)
      .innerJoin(
        teams,
        and(
          eq(teams.id, teamJoinEligibilities.teamId),
          eq(teams.orgId, opts.orgId),
          eq(teams.origin, "idp"),
        ),
      )
      .innerJoin(
        orgMembers,
        and(
          eq(orgMembers.orgId, opts.orgId),
          eq(orgMembers.userId, opts.userId),
        ),
      )
      .where(
        and(
          eq(teamJoinEligibilities.userId, opts.userId),
          eq(teamJoinEligibilities.teamId, opts.teamId),
          gt(teamJoinEligibilities.observedAt, freshAfter),
        ),
      )
      .limit(1)
      .for("update");
    if (!eligible[0]) return false;

    const inserted = await tx
      .insert(teamMembers)
      .values({ teamId: opts.teamId, userId: opts.userId, role: "member" })
      .onConflictDoNothing({ target: [teamMembers.teamId, teamMembers.userId] })
      .returning({ teamId: teamMembers.teamId });
    if (inserted.length > 0) await invalidateWorkflowSources(tx, { teamId: opts.teamId });
    return true;
  });
}
