import type { AppDb } from '../drizzle.js';
import { eq } from 'drizzle-orm';
import { authSessions } from '../schema/index.js';
import { findValidInviteRow } from './org.js';

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

// Validity semantics (`acceptedAt IS NULL AND expiresAt > now`) and the
// ISO-8601 comparison rationale live with the shared `findValidInviteRow`
// helper in `./org.js`. These wrappers project the full row down to `{ id }`
// so callers don't pull in the `Invite` mapping.
export async function getValidInviteByCode(
  db: AppDb,
  code: string
): Promise<{ id: string } | null> {
  const row = await findValidInviteRow(db, { code });
  return row ? { id: row.id } : null;
}

export async function getValidInviteByEmail(
  db: AppDb,
  email: string
): Promise<{ id: string } | null> {
  const row = await findValidInviteRow(db, { email });
  return row ? { id: row.id } : null;
}
