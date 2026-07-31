import type { AppDb } from '../drizzle.js';
import { eq, and, isNull, sql, desc } from 'drizzle-orm';
import { apiTokens } from '../schema/index.js';

export interface ApiTokenRow {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
}

export async function listApiTokens(db: AppDb, userId: string): Promise<ApiTokenRow[]> {
  const rows = await db
    .select({
      id: apiTokens.id,
      name: apiTokens.name,
      prefix: apiTokens.prefix,
      createdAt: apiTokens.createdAt,
      lastUsedAt: apiTokens.lastUsedAt,
      expiresAt: apiTokens.expiresAt,
    })
    .from(apiTokens)
    .where(and(eq(apiTokens.userId, userId), isNull(apiTokens.revokedAt)))
    .orderBy(desc(apiTokens.createdAt));

  return rows as ApiTokenRow[];
}

export async function insertApiToken(
  db: AppDb,
  params: { id: string; userId: string; name: string; tokenHash: string; prefix: string; expiresAt: string | null }
): Promise<void> {
  await db.insert(apiTokens).values({
    id: params.id,
    userId: params.userId,
    name: params.name,
    tokenHash: params.tokenHash,
    prefix: params.prefix,
    createdAt: sql`datetime('now')`,
    expiresAt: params.expiresAt,
  });
}

export async function revokeApiToken(db: AppDb, id: string, userId: string): Promise<boolean> {
  const result = await db
    .update(apiTokens)
    .set({ revokedAt: sql`datetime('now')` })
    .where(and(eq(apiTokens.id, id), eq(apiTokens.userId, userId), isNull(apiTokens.revokedAt)));

  return (result.meta?.changes ?? 0) > 0;
}

/**
 * Hard-delete every API token belonging to `userId`. Used by `deleteUser`
 * as an explicit companion to the `api_tokens.user_id` FK ON DELETE
 * CASCADE — the FK would delete these rows on the subsequent user delete
 * anyway, but calling this here makes the intent visible in code and
 * defends against future FK changes.
 *
 * NOTE: audit retention of "which tokens did this user ever hold" is not
 * a goal here — the FK cascade would hard-delete these rows regardless.
 * If a future caller wants to revoke tokens without deleting the user,
 * add a `revokeUserApiTokens` (soft-delete via `revoked_at`) helper for
 * that use case instead of overloading this one.
 */
export async function deleteUserApiTokens(db: AppDb, userId: string): Promise<void> {
  await db.delete(apiTokens).where(eq(apiTokens.userId, userId));
}
