import type { AppDb } from '../drizzle.js';
import { eq } from 'drizzle-orm';
import { authSessions } from '../schema/index.js';

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
