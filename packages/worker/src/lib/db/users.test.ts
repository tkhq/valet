import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb } from '../../test-utils/db.js';
import { users, authSessions, apiTokens, credentials } from '../schema/index.js';
import { deleteUser } from './users.js';

describe('deleteUser', () => {
  it('revokes auth sessions and api tokens when the user is deleted', async () => {
    const { db } = createTestDb();

    db.insert(users).values({ id: 'u1', email: 'u1@example.com', role: 'member' }).run();
    db.insert(users).values({ id: 'u2', email: 'u2@example.com', role: 'member' }).run();

    db.insert(authSessions).values([
      { id: 's-u1-a', userId: 'u1', tokenHash: 'h-u1-a', provider: 'google', expiresAt: '2099-01-01' },
      { id: 's-u1-b', userId: 'u1', tokenHash: 'h-u1-b', provider: 'google', expiresAt: '2099-01-01' },
      { id: 's-u2-a', userId: 'u2', tokenHash: 'h-u2-a', provider: 'google', expiresAt: '2099-01-01' },
    ]).run();

    db.insert(apiTokens).values([
      { id: 't-u1-a', userId: 'u1', name: 'k1', tokenHash: 'th-u1-a' },
      { id: 't-u2-a', userId: 'u2', name: 'k2', tokenHash: 'th-u2-a' },
    ]).run();

    await deleteUser(db as never, 'u1');

    expect(db.select().from(authSessions).where(eq(authSessions.userId, 'u1')).all()).toEqual([]);
    expect(db.select().from(apiTokens).where(eq(apiTokens.userId, 'u1')).all()).toEqual([]);
    // Unrelated user's rows are untouched.
    expect(db.select().from(authSessions).where(eq(authSessions.userId, 'u2')).all()).toHaveLength(1);
    expect(db.select().from(apiTokens).where(eq(apiTokens.userId, 'u2')).all()).toHaveLength(1);
    expect(db.select().from(users).where(eq(users.id, 'u1')).all()).toEqual([]);
  });

  it('FK cascade on users delete drops auth_sessions and api_tokens', () => {
    // Pin the ON DELETE CASCADE behavior independently of our helper's
    // explicit follow-up deletes. If a future migration silently removes
    // the cascade, this test fails even though `deleteUser` would still
    // paper over it via the belt-and-suspenders cleanup calls.
    const { db, sqlite } = createTestDb();

    db.insert(users).values({ id: 'u1', email: 'u1@example.com', role: 'member' }).run();
    db.insert(users).values({ id: 'u2', email: 'u2@example.com', role: 'member' }).run();

    db.insert(authSessions).values([
      { id: 's-u1-a', userId: 'u1', tokenHash: 'h-u1-a', provider: 'google', expiresAt: '2099-01-01' },
      { id: 's-u2-a', userId: 'u2', tokenHash: 'h-u2-a', provider: 'google', expiresAt: '2099-01-01' },
    ]).run();

    db.insert(apiTokens).values([
      { id: 't-u1-a', userId: 'u1', name: 'k1', tokenHash: 'th-u1-a' },
      { id: 't-u2-a', userId: 'u2', name: 'k2', tokenHash: 'th-u2-a' },
    ]).run();

    // Bypass the helper: delete the users row directly via raw sqlite.
    sqlite.exec("DELETE FROM users WHERE id = 'u1'");

    expect(db.select().from(authSessions).where(eq(authSessions.userId, 'u1')).all()).toEqual([]);
    expect(db.select().from(apiTokens).where(eq(apiTokens.userId, 'u1')).all()).toEqual([]);
    // Unrelated user's rows are untouched.
    expect(db.select().from(authSessions).where(eq(authSessions.userId, 'u2')).all()).toHaveLength(1);
    expect(db.select().from(apiTokens).where(eq(apiTokens.userId, 'u2')).all()).toHaveLength(1);
  });

  it('credentials do NOT cascade when the owning users row is deleted', () => {
    // `credentials.owner_id` is polymorphic (users.id OR orgs.id,
    // discriminated by owner_type), so the table has never carried a FK
    // to users and cascade-on-delete was never possible. This test pins
    // that structural invariant: deleting the users row directly must
    // leave the credentials row intact.
    const { db, sqlite } = createTestDb();

    db.insert(users).values({ id: 'u1', email: 'u1@example.com', role: 'member' }).run();

    sqlite.exec(
      "INSERT INTO credentials (id, owner_type, owner_id, provider, credential_type, encrypted_data) " +
      "VALUES ('c-u1-a', 'user', 'u1', 'github', 'oauth2', 'ENCRYPTED_BLOB')",
    );

    // Sanity: the row exists before we delete the user.
    expect(db.select().from(credentials).where(eq(credentials.ownerId, 'u1')).all()).toHaveLength(1);

    sqlite.exec("DELETE FROM users WHERE id = 'u1'");

    // Credentials row survives — no cascade.
    expect(db.select().from(credentials).where(eq(credentials.ownerId, 'u1')).all()).toHaveLength(1);
  });
});
