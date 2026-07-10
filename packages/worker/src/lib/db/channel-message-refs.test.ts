import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb } from '../../test-utils/db.js';
import { channelMessageRefs } from '../schema/channel-message-refs.js';
import { users } from '../schema/users.js';
import {
  assertCanModifyChannelMessageRef,
  getChannelMessageRef,
  markChannelMessageRefDeleted,
  registerChannelMessageRef,
} from './channel-message-refs.js';

describe('channel message reference DB helpers', () => {
  let db: ReturnType<typeof createTestDb>['db'];

  const ref = {
    orgId: 'org-1',
    channelType: 'slack',
    connectionScope: 'team-1',
    channelId: 'C123',
    messageId: '1710000000.000001',
  };

  beforeEach(() => {
    db = createTestDb().db;
    db.insert(users).values([
      { id: 'owner', email: 'owner@example.com', role: 'member' },
      { id: 'member', email: 'member@example.com', role: 'member' },
      { id: 'admin', email: 'admin@example.com', role: 'admin' },
    ]).run();
  });

  async function register(ownerUserId: string | null = 'owner') {
    await registerChannelMessageRef(db as any, {
      ...ref,
      ownerUserId,
      sessionId: null,
      actionInvocationId: null,
    });
  }

  it('registers and looks up an exact external identity without storing content', async () => {
    await register();

    await expect(getChannelMessageRef(db as any, ref)).resolves.toMatchObject({
      ...ref,
      ownerUserId: 'owner',
      sessionId: null,
      actionInvocationId: null,
      deletedAt: null,
    });

    await expect(getChannelMessageRef(db as any, {
      ...ref,
      connectionScope: 'team-2',
    })).resolves.toBeNull();
  });

  it('registers the same owner idempotently without replacing provenance', async () => {
    await register();
    await register();

    const rows = db.select().from(channelMessageRefs).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ ownerUserId: 'owner', sessionId: null, actionInvocationId: null });
  });

  it('rejects registration that would transfer an existing message to another owner', async () => {
    await register();

    await expect(registerChannelMessageRef(db as any, {
      ...ref,
      ownerUserId: 'member',
      sessionId: null,
      actionInvocationId: null,
    })).rejects.toMatchObject({
      code: 'message_owner_conflict',
    });

    await expect(getChannelMessageRef(db as any, ref)).resolves.toMatchObject({ ownerUserId: 'owner' });
  });

  it('authorizes the owner of a live ref', async () => {
    await register();

    await expect(assertCanModifyChannelMessageRef(db as any, {
      ...ref,
      actorUserId: 'owner',
    })).resolves.toBeUndefined();
  });

  it('does not authorize a member to mutate another user’s ref', async () => {
    await register();

    await expect(assertCanModifyChannelMessageRef(db as any, {
      ...ref,
      actorUserId: 'member',
    })).rejects.toMatchObject({
      code: 'message_not_owned',
    });
  });

  it('authorizes an admin to mutate another user’s live ref', async () => {
    await register();

    await expect(assertCanModifyChannelMessageRef(db as any, {
      ...ref,
      actorUserId: 'admin',
    })).resolves.toBeUndefined();
  });

  it('does not authorize an unknown or differently-scoped ref', async () => {
    await expect(assertCanModifyChannelMessageRef(db as any, {
      ...ref,
      actorUserId: 'owner',
    })).rejects.toMatchObject({
      code: 'message_not_managed',
    });

    await register();
    await expect(assertCanModifyChannelMessageRef(db as any, {
      ...ref,
      connectionScope: 'team-2',
      actorUserId: 'admin',
    })).rejects.toMatchObject({
      code: 'message_not_managed',
    });
  });

  it('tombstones a ref and reports deleted to its owner and an admin', async () => {
    await register();
    await markChannelMessageRefDeleted(db as any, ref);

    await expect(getChannelMessageRef(db as any, ref)).resolves.toMatchObject({
      deletedAt: expect.any(String),
    });

    for (const actorUserId of ['owner', 'admin']) {
      await expect(assertCanModifyChannelMessageRef(db as any, {
        ...ref,
        actorUserId,
      })).rejects.toMatchObject({
        code: 'message_deleted',
      });
    }
  });

  it('does not reveal a tombstone to a member who is not the owner', async () => {
    await register();
    await markChannelMessageRefDeleted(db as any, ref);

    await expect(assertCanModifyChannelMessageRef(db as any, {
      ...ref,
      actorUserId: 'member',
    })).rejects.toMatchObject({
      code: 'message_not_owned',
    });
  });

  it('allows only an admin to mutate a live system ref with no owner', async () => {
    await register(null);

    await expect(assertCanModifyChannelMessageRef(db as any, {
      ...ref,
      actorUserId: 'member',
    })).rejects.toMatchObject({
      code: 'message_not_owned',
    });

    await expect(assertCanModifyChannelMessageRef(db as any, {
      ...ref,
      actorUserId: 'admin',
    })).resolves.toBeUndefined();
  });

  it('allows an admin but not a member to mutate a live ref whose owner was deleted', async () => {
    await register();
    db.delete(users).where(eq(users.id, 'owner')).run();

    await expect(getChannelMessageRef(db as any, ref)).resolves.toMatchObject({ ownerUserId: null });

    await expect(assertCanModifyChannelMessageRef(db as any, {
      ...ref,
      actorUserId: 'member',
    })).rejects.toMatchObject({
      code: 'message_not_owned',
    });

    await expect(assertCanModifyChannelMessageRef(db as any, {
      ...ref,
      actorUserId: 'admin',
    })).resolves.toBeUndefined();
  });
});
