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
 * Revoke every non-revoked API token belonging to `userId` by stamping
 * `revoked_at`. Matches `revokeApiToken`'s soft-delete pattern rather
 * than hard-deleting, so the row survives for audit/forensics (which
 * tokens did this user ever issue?) while the auth middleware still
 * rejects it via its `revoked_at IS NULL` guard.
 */
export async function revokeUserApiTokens(db: AppDb, userId: string): Promise<void> {
  await db
    .update(apiTokens)
    .set({ revokedAt: sql`datetime('now')` })
    .where(and(eq(apiTokens.userId, userId), isNull(apiTokens.revokedAt)));
}
