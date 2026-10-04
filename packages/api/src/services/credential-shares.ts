/**
 * Shared team credentials: a member's own account for a service, shared with
 * a team. Each member keeps their own share, so a team can hold several per
 * service beside its own team connection. A share holds no secret: a read
 * follows it to the member's live user credential, and a share never
 * outlives its source. Every route that deletes a user row calls
 * `deleteSharesFrom`, so the shares go with it.
 *
 * Which account a team action uses is decided in
 * `credential-resolution.ts#readTeamCredential`: the acting member's own
 * share, then the team's connection, then another member's share with that
 * member's approval.
 */
import { invalidateWorkflowSources } from "./content-sync/invalidation.js";
import { and, asc, eq, sql } from "drizzle-orm";
import type { AppDb, AppQueryable } from "../lib/drizzle.js";
import { credentialShares } from "../schema/index.js";

export interface CredentialShare {
  teamId: string;
  service: string;
  userId: string;
  createdAt: number;
}

/** The members sharing `service` with `teamId` who are still on the team,
 * oldest share first, so the member asked to lend an account is stable. */
export async function membersSharing(db: AppQueryable, teamId: string, service: string): Promise<string[]> {
  const rows = await db.select({ userId: credentialShares.userId }).from(credentialShares)
    .where(and(eq(credentialShares.teamId, teamId), eq(credentialShares.service, service),
      sql`EXISTS (SELECT 1 FROM team_members m WHERE m.team_id = ${credentialShares.teamId} AND m.user_id = ${credentialShares.userId})`))
    .orderBy(asc(credentialShares.createdAt), asc(credentialShares.userId));
  return rows.map((row) => row.userId);
}

/** Every share a team holds, every service, oldest first. */
export async function listTeamShares(db: AppQueryable, teamId: string): Promise<CredentialShare[]> {
  return db.select().from(credentialShares).where(eq(credentialShares.teamId, teamId))
    .orderBy(asc(credentialShares.service), asc(credentialShares.createdAt), asc(credentialShares.userId));
}

/** Records `userId`'s share of `service` with `teamId`. Sharing again is a no-op. */
export async function shareCredential(db: AppQueryable, share: CredentialShare): Promise<void> {
  await db.insert(credentialShares).values(share).onConflictDoNothing();
}

/** Ends one member's share. Returns whether a share existed. */
export async function revokeShare(db: AppQueryable, share: Omit<CredentialShare, "createdAt">): Promise<boolean> {
  const removed = await db.delete(credentialShares).where(and(
    eq(credentialShares.teamId, share.teamId), eq(credentialShares.service, share.service), eq(credentialShares.userId, share.userId),
  )).returning({ teamId: credentialShares.teamId });
  return removed.length > 0;
}

/** The ids of the teams `userId` shares their `service` account with. A
 * write that would leave that account unusable to a team read consults this
 * first, so the shares are revoked on purpose rather than broken by
 * accident. */
export async function listShareTeamsFrom(db: AppQueryable, source: { userId: string; service: string }): Promise<string[]> {
  const rows = await db.select({ teamId: credentialShares.teamId }).from(credentialShares)
    .where(and(eq(credentialShares.userId, source.userId), eq(credentialShares.service, source.service)));
  return rows.map((row) => row.teamId);
}

/** Ends every share of `userId`'s `service` account. Returns the ids of the
 * teams that lost one, so a caller can resync the workflows those teams own. */
export async function deleteSharesFrom(db: AppDb, source: { userId: string; service: string }): Promise<string[]> {
  return db.transaction(async (tx) => {
    const revoked = await tx.delete(credentialShares)
      .where(and(eq(credentialShares.userId, source.userId), eq(credentialShares.service, source.service)))
      .returning({ teamId: credentialShares.teamId });
    for (const { teamId } of revoked) await invalidateWorkflowSources(tx, { teamId });
    return revoked.map((row) => row.teamId);
  });
}
