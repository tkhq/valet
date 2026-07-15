import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb } from '../../test-utils/db.js';
import { users, authSessions, apiTokens } from '../schema/index.js';
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
});
