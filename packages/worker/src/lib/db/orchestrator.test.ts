import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb } from '../../test-utils/db.js';
import { getOrCreateUser } from './users.js';
import {
  createOrchestratorIdentity,
  getOrchestratorIdentity,
  getOrchestratorIdentityByHandle,
  insertLiveOrchestratorSession,
  bumpOrchestratorSessionGeneration,
  isOrchestratorSpawnClaimHeld,
} from './orchestrator.js';
import { orchestratorIdentities, sessions } from '../schema/index.js';

const USER_A = 'user-orch-a';
const USER_B = 'user-orch-b';

describe('createOrchestratorIdentity', () => {
  let db: ReturnType<typeof createTestDb>['db'];

  beforeEach(async () => {
    const testDb = createTestDb();
    db = testDb.db;
    await getOrCreateUser(db, { id: USER_A, email: 'a@example.com' });
    await getOrCreateUser(db, { id: USER_B, email: 'b@example.com' });
  });

  it('inserts a new identity for a user with no row', async () => {
    const result = await createOrchestratorIdentity(db, {
      id: 'idn-1',
      userId: USER_A,
      name: 'Jarvis',
      handle: 'jarvis',
    });

    expect(result).toEqual({
      ok: true,
      identity: expect.objectContaining({
        id: 'idn-1',
        userId: USER_A,
        name: 'Jarvis',
        handle: 'jarvis',
      }),
    });
  });

  it('reuses the existing row when the same user inserts again', async () => {
    const first = await createOrchestratorIdentity(db, {
      id: 'idn-1',
      userId: USER_A,
      name: 'Jarvis',
      handle: 'jarvis',
    });
    expect(first.ok).toBe(true);

    const second = await createOrchestratorIdentity(db, {
      id: 'idn-2',
      userId: USER_A,
      name: 'Friday',
      handle: 'friday',
    });

    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.identity.id).toBe('idn-1');
    expect(second.identity.handle).toBe('jarvis');

    const rows = await db.select().from(orchestratorIdentities).all();
    expect(rows).toHaveLength(1);
  });

  it('returns handle_taken when another user already owns the handle', async () => {
    const first = await createOrchestratorIdentity(db, {
      id: 'idn-1',
      userId: USER_A,
      name: 'Jarvis',
      handle: 'jarvis',
    });
    expect(first.ok).toBe(true);

    const second = await createOrchestratorIdentity(db, {
      id: 'idn-2',
      userId: USER_B,
      name: 'Also Jarvis',
      handle: 'jarvis',
    });

    expect(second).toEqual({ ok: false, reason: 'handle_taken' });
    expect(await getOrchestratorIdentity(db, USER_B)).toBeNull();
    expect((await getOrchestratorIdentityByHandle(db, 'jarvis'))?.userId).toBe(USER_A);

    const rows = await db.select().from(orchestratorIdentities).all();
    expect(rows).toHaveLength(1);
  });
});

describe('insertLiveOrchestratorSession', () => {
  let db: ReturnType<typeof createTestDb>['db'];

  beforeEach(async () => {
    const testDb = createTestDb();
    db = testDb.db;
    await getOrCreateUser(db, { id: USER_A, email: 'a@example.com' });
    await getOrCreateUser(db, { id: USER_B, email: 'b@example.com' });
  });

  it('inserts the first live orchestrator session for a user', async () => {
    const result = await insertLiveOrchestratorSession(db, {
      id: 'orchestrator:user-orch-a:one',
      userId: USER_A,
      title: 'Jarvis (Orchestrator)',
    });

    expect(result.inserted).toBe(true);
    expect(result.session.id).toBe('orchestrator:user-orch-a:one');
    expect(result.session.isOrchestrator).toBe(true);
  });

  it('returns the existing live row when the same user inserts again', async () => {
    const first = await insertLiveOrchestratorSession(db, {
      id: 'orchestrator:user-orch-a:one',
      userId: USER_A,
    });
    expect(first.inserted).toBe(true);

    const second = await insertLiveOrchestratorSession(db, {
      id: 'orchestrator:user-orch-a:two',
      userId: USER_A,
    });

    expect(second.inserted).toBe(false);
    expect(second.session.id).toBe('orchestrator:user-orch-a:one');

    const rows = await db.select().from(sessions).where(eq(sessions.userId, USER_A)).all();
    expect(rows).toHaveLength(1);
  });

  it('allows a new live session after the previous one is terminated', async () => {
    await insertLiveOrchestratorSession(db, {
      id: 'orchestrator:user-orch-a:one',
      userId: USER_A,
    });
    await db.update(sessions).set({ status: 'terminated' }).where(eq(sessions.id, 'orchestrator:user-orch-a:one'));

    const second = await insertLiveOrchestratorSession(db, {
      id: 'orchestrator:user-orch-a:two',
      userId: USER_A,
    });

    expect(second.inserted).toBe(true);
    expect(second.session.id).toBe('orchestrator:user-orch-a:two');
  });

  it('lets two users each hold one live orchestrator session', async () => {
    const a = await insertLiveOrchestratorSession(db, {
      id: 'orchestrator:user-orch-a:one',
      userId: USER_A,
    });
    const b = await insertLiveOrchestratorSession(db, {
      id: 'orchestrator:user-orch-b:one',
      userId: USER_B,
    });

    expect(a.inserted).toBe(true);
    expect(b.inserted).toBe(true);
    expect(a.session.id).not.toBe(b.session.id);
  });
});

describe('orchestrator spawn claim generation', () => {
  let db: ReturnType<typeof createTestDb>['db'];

  beforeEach(async () => {
    const testDb = createTestDb();
    db = testDb.db;
    await getOrCreateUser(db, { id: USER_A, email: 'a@example.com' });
    await createOrchestratorIdentity(db, {
      id: 'idn-1',
      userId: USER_A,
      name: 'Jarvis',
      handle: 'jarvis',
    });
  });

  it('holds the claim for a live session stamped with the current generation', async () => {
    const inserted = await insertLiveOrchestratorSession(db, {
      id: 'orchestrator:user-orch-a:one',
      userId: USER_A,
    });
    expect(inserted.inserted).toBe(true);
    expect(await isOrchestratorSpawnClaimHeld(db, inserted.session.id)).toBe(true);
  });

  it('drops the claim when rotation bumps the generation', async () => {
    const inserted = await insertLiveOrchestratorSession(db, {
      id: 'orchestrator:user-orch-a:one',
      userId: USER_A,
    });
    expect(await bumpOrchestratorSessionGeneration(db, USER_A)).toBe(1);
    expect(await isOrchestratorSpawnClaimHeld(db, inserted.session.id)).toBe(false);
  });

  it('stamps the new live row with the bumped generation', async () => {
    await insertLiveOrchestratorSession(db, {
      id: 'orchestrator:user-orch-a:one',
      userId: USER_A,
    });
    await db.update(sessions).set({ status: 'terminated' }).where(eq(sessions.id, 'orchestrator:user-orch-a:one'));
    await bumpOrchestratorSessionGeneration(db, USER_A);

    const next = await insertLiveOrchestratorSession(db, {
      id: 'orchestrator:user-orch-a:two',
      userId: USER_A,
    });
    expect(next.inserted).toBe(true);
    expect(await isOrchestratorSpawnClaimHeld(db, 'orchestrator:user-orch-a:one')).toBe(false);
    expect(await isOrchestratorSpawnClaimHeld(db, next.session.id)).toBe(true);
  });
});
