import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb } from '../../test-utils/db.js';
import { filterWebEnabledUsers, enqueueNotificationsBatch, getUserNotificationCount } from './notifications.js';

// filterWebEnabledUsers reads raw D1-style SQL; adapt better-sqlite3.
function makeD1Adapter(sqlite: any) {
  return {
    prepare(sql: string) {
      return {
        bind: (...args: any[]) => ({
          async all() { return { results: sqlite.prepare(sql).all(...args) }; },
          async first() { return sqlite.prepare(sql).get(...args) ?? null; },
          async run() { return sqlite.prepare(sql).run(...args); },
        }),
      };
    },
  } as any;
}

describe('attention-router batch helpers', () => {
  let db: ReturnType<typeof createTestDb>['db'];
  let sqlite: ReturnType<typeof createTestDb>['sqlite'];
  let rawDb: any;

  const seedUser = (id: string) =>
    sqlite.prepare("INSERT INTO users (id, email, role) VALUES (?, ?, 'member')").run(id, `${id}@x.com`);
  const seedPref = (userId: string, messageType: string, eventType: string, webEnabled: number) =>
    sqlite
      .prepare(
        "INSERT INTO user_notification_preferences (id, user_id, message_type, event_type, web_enabled) VALUES (?, ?, ?, ?, ?)"
      )
      .run(`${userId}-${messageType}-${eventType}`, userId, messageType, eventType, webEnabled);

  beforeEach(() => {
    ({ db, sqlite } = createTestDb());
    rawDb = makeD1Adapter(sqlite);
    for (const id of ['alice', 'bob', 'carol', 'dave']) seedUser(id);
  });

  it('filterWebEnabledUsers: default-on, explicit-off, and event-type specificity', async () => {
    // alice: no row → default enabled.
    // bob: explicit web disabled for this kind.
    seedPref('bob', 'escalation', '*', 0);
    // carol: '*' disabled but an exact event_type row re-enables (specificity wins).
    seedPref('carol', 'escalation', '*', 0);
    seedPref('carol', 'escalation', 'session.lifecycle', 1);
    // dave: '*' enabled.
    seedPref('dave', 'escalation', '*', 1);

    const enabled = await filterWebEnabledUsers(
      rawDb,
      ['alice', 'bob', 'carol', 'dave'],
      'escalation',
      'session.lifecycle'
    );
    expect([...enabled].sort()).toEqual(['alice', 'carol', 'dave']);
  });

  it('filterWebEnabledUsers returns empty for an empty audience', async () => {
    expect((await filterWebEnabledUsers(rawDb, [], 'notification')).size).toBe(0);
  });

  it('enqueueNotificationsBatch inserts one row per recipient', async () => {
    await enqueueNotificationsBatch(db, [
      { toUserId: 'alice', messageType: 'escalation', content: 'x' },
      { toUserId: 'bob', messageType: 'escalation', content: 'x' },
    ]);
    expect(await getUserNotificationCount(db, 'alice')).toBe(1);
    expect(await getUserNotificationCount(db, 'bob')).toBe(1);
    expect(await getUserNotificationCount(db, 'carol')).toBe(0);
  });

  it('enqueueNotificationsBatch is a no-op for an empty list', async () => {
    await enqueueNotificationsBatch(db, []);
    expect(await getUserNotificationCount(db, 'alice')).toBe(0);
  });
});
