/**
 * Delegated team credentials (team credentials design, decision 4): a
 * team row that carries `metadata.delegatedFrom` is a reference to one
 * user's own row, and a reference never outlives its source. Every route
 * that deletes a user row calls `deleteDelegationsFrom` so the references
 * go with it. The references hold no secret of their own, so there is
 * nothing to revoke beyond the row.
 */
import { and, eq, sql } from "drizzle-orm";
import type { AppDb } from "../lib/drizzle.js";
import { credentials } from "../schema/index.js";

/** Deletes every team reference that points at `userId`'s `service` row.
 * Returns the ids of the teams that lost a reference, so a caller can
 * resync the workflows those teams own. */
export async function deleteDelegationsFrom(
  db: AppDb,
  source: { userId: string; service: string },
): Promise<string[]> {
  const revoked = await db
    .delete(credentials)
    .where(
      and(
        eq(credentials.ownerType, "team"),
        eq(credentials.service, source.service),
        sql`${credentials.metadata}->>'delegatedFrom' = ${source.userId}`,
      ),
    )
    .returning({ teamId: credentials.ownerId });
  return revoked.map((row) => row.teamId);
}
