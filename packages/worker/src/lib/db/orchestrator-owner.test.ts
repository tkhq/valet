import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb } from '../../test-utils/db.js';
import {
  createOrchestratorIdentity,
  getOrchestratorIdentity,
  getOrchestratorIdentityByOwner,
  getCurrentOrchestratorSessionByOwner,
  getNonTerminalOrchestratorSessionsByOwner,
} from './orchestrator.js';

const ALICE = 'user-alice';
const TEAM = 'team-1234';

// The D1-flavored helpers use raw `db.prepare(...)`; adapt better-sqlite3.
function makeD1Adapter(sqlite: any) {
  return {
    prepare(sql: string) {
      return {
        bind: (...args: any[]) => ({
          async first() { return sqlite.prepare(sql).get(...args) ?? null; },
          async all() { return { results: sqlite.prepare(sql).all(...args) }; },
          async run() { return sqlite.prepare(sql).run(...args); },
        }),
      };
    },
  } as any;
}

describe('owner-keyed orchestrator helpers', () => {
  let db: ReturnType<typeof createTestDb>['db'];
  let sqlite: ReturnType<typeof createTestDb>['sqlite'];
  let rawDb: any;

  beforeEach(() => {
    ({ db, sqlite } = createTestDb());
    rawDb = makeD1Adapter(sqlite);
    sqlite.prepare("INSERT INTO users (id, email, role) VALUES (?, ?, 'member')").run(ALICE, 'a@x.com');
    sqlite.prepare("INSERT INTO teams (id, name, created_by) VALUES (?, 'Platform', ?)").run(TEAM, ALICE);
  });

  it('creates and fetches a team identity by owner (userId null, type team)', async () => {
    const created = await createOrchestratorIdentity(db, {
      id: 'oi-team',
      owner: { type: 'team', id: TEAM },
      name: 'Platform Bot',
      handle: 'platform-bot',
    });
    expect(created.userId).toBeUndefined();
    expect(created.type).toBe('team');
    expect(created.ownerType).toBe('team');
    expect(created.ownerId).toBe(TEAM);

    const fetched = await getOrchestratorIdentityByOwner(db, { type: 'team', id: TEAM });
    expect(fetched?.id).toBe('oi-team');
    expect(fetched?.handle).toBe('platform-bot');
  });

  it('user identities remain fetchable by userId and by owner', async () => {
    await createOrchestratorIdentity(db, {
      id: 'oi-user',
      userId: ALICE,
      name: 'Jarvis',
      handle: 'jarvis',
    });
    const byUser = await getOrchestratorIdentity(db, ALICE);
    expect(byUser?.id).toBe('oi-user');
    expect(byUser?.type).toBe('personal');
    const byOwner = await getOrchestratorIdentityByOwner(db, { type: 'user', id: ALICE });
    expect(byOwner?.id).toBe('oi-user');
  });

  it('finds non-terminal team orchestrator sessions by owner', async () => {
    sqlite
      .prepare(
        `INSERT INTO sessions (id, user_id, workspace, status, is_orchestrator, purpose, owner_type, owner_id)
         VALUES (?, ?, 'orchestrator', ?, 1, 'orchestrator', 'team', ?)`
      )
      .run(`orchestrator:team:${TEAM}`, ALICE, 'running', TEAM);

    const current = await getCurrentOrchestratorSessionByOwner(rawDb, { type: 'team', id: TEAM });
    expect(current?.id).toBe(`orchestrator:team:${TEAM}`);
    expect(current?.ownerType).toBe('team');

    const all = await getNonTerminalOrchestratorSessionsByOwner(rawDb, { type: 'team', id: TEAM });
    expect(all).toHaveLength(1);

    // Terminated sessions are excluded.
    sqlite.prepare("UPDATE sessions SET status = 'terminated' WHERE id = ?").run(`orchestrator:team:${TEAM}`);
    expect(await getCurrentOrchestratorSessionByOwner(rawDb, { type: 'team', id: TEAM })).toBeNull();
  });
});
