import type { AppDb } from '../drizzle.js';
import { eq, and, gt, isNull } from 'drizzle-orm';
import { authSessions, invites } from '../schema/index.js';

export async function createAuthSession(
  db: AppDb,
  data: { id: string; userId: string; tokenHash: string; provider: string; expiresAt: string }
): Promise<void> {
  await db.insert(authSessions).values({
    id: data.id,
    userId: data.userId,
    tokenHash: data.tokenHash,
    provider: data.provider,
    expiresAt: data.expiresAt,
  });
}

export async function deleteAuthSession(db: AppDb, tokenHash: string): Promise<void> {
  await db.delete(authSessions).where(eq(authSessions.tokenHash, tokenHash));
}

export async function deleteUserAuthSessions(db: AppDb, userId: string): Promise<void> {
  await db.delete(authSessions).where(eq(authSessions.userId, userId));
}

// `invites.expires_at` is written as `new Date(...).toISOString()`
// (T-separated, Z-suffixed). SQLite's `datetime('now')` returns a
// space-separated string without the trailing Z, and under BINARY
// collation the two formats sort inconsistently on the same UTC date —
// an expired invite would keep validating until the date rolls over.
// Compare ISO-to-ISO by binding `nowIso` as a parameter.
export async function getValidInviteByCode(
  db: AppDb,
  code: string
): Promise<{ id: string } | null> {
  const nowIso = new Date().toISOString();
  const result = await db
    .select({ id: invites.id })
    .from(invites)
    .where(and(eq(invites.code, code), isNull(invites.acceptedAt), gt(invites.expiresAt, nowIso)))
    .get();
  return result || null;
}

export async function getValidInviteByEmail(
  db: AppDb,
  email: string
): Promise<{ id: string } | null> {
  const nowIso = new Date().toISOString();
  const result = await db
    .select({ id: invites.id })
    .from(invites)
    .where(and(eq(invites.email, email), isNull(invites.acceptedAt), gt(invites.expiresAt, nowIso)))
    .get();
  return result || null;
}
