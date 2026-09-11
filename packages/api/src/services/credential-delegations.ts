/**
 * Delegated team credentials (team credentials design, decision 4): a
 * team row that carries `metadata.delegatedFrom` is a reference to one
 * user's own row, and a reference never outlives its source. Every route
 * that deletes a user row calls `deleteDelegationsFrom` so the references
 * go with it. The references hold no secret of their own, so there is
 * nothing to revoke beyond the row.
 */
import { invalidateWorkflowSources } from "./content-sync/invalidation.js";
import { and, eq, sql } from "drizzle-orm";
import type { AppDb } from "../lib/drizzle.js";
import { credentials } from "../schema/index.js";

/** The ids of the teams holding a reference to `userId`'s `service` row.
 * A write that would leave that row unusable to a team read consults this
 * first, so the shares are revoked on purpose rather than broken by
 * accident. */
export async function listDelegationsFrom(
  db: AppDb,
  source: { userId: string; service: string },
): Promise<string[]> {
  const rows = await db
    .select({ teamId: credentials.ownerId })
    .from(credentials)
    .where(
      and(
        eq(credentials.ownerType, "team"),
        eq(credentials.service, source.service),
        sql`${credentials.metadata}->>'delegatedFrom' = ${source.userId}`,
      ),
    );
  return rows.map((row) => row.teamId);
}

/** Deletes every team reference that points at `userId`'s `service` row.
 * Returns the ids of the teams that lost a reference, so a caller can
 * resync the workflows those teams own. */
export async function deleteDelegationsFrom(
  db: AppDb,
  source: { userId: string; service: string },
): Promise<string[]> {
  return db.transaction(async (tx) => {
    const revoked = await tx
      .delete(credentials)
      .where(
        and(
          eq(credentials.ownerType, "team"),
          eq(credentials.service, source.service),
          sql`${credentials.metadata}->>'delegatedFrom' = ${source.userId}`,
        ),
      )
      .returning({ teamId: credentials.ownerId });
    for (const { teamId } of revoked) await invalidateWorkflowSources(tx, { teamId });
    return revoked.map((row) => row.teamId);
  });
}
