import type { AppDb } from '../drizzle.js';
import { eq, and, gt, isNull, sql } from 'drizzle-orm';
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

export async function getValidInviteByCode(
  db: AppDb,
  code: string
): Promise<{ id: string } | null> {
  const result = await db
    .select({ id: invites.id })
    .from(invites)
    .where(and(eq(invites.code, code), isNull(invites.acceptedAt), gt(invites.expiresAt, sql`datetime('now')`)))
    .get();
  return result || null;
}

export async function getValidInviteByEmail(
  db: AppDb,
  email: string
): Promise<{ id: string } | null> {
  const result = await db
    .select({ id: invites.id })
    .from(invites)
    .where(and(eq(invites.email, email), isNull(invites.acceptedAt), gt(invites.expiresAt, sql`datetime('now')`)))
    .get();
  return result || null;
}
