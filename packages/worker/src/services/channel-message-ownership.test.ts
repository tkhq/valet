import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '../test-utils/db.js';
import { actionInvocations, sessions, users } from '../lib/schema/index.js';
import { getChannelMessageRef } from '../lib/db/channel-message-refs.js';

const getOrgSlackInstallAnyMock = vi.fn();

vi.mock('../lib/db/slack.js', () => ({
  getOrgSlackInstallAny: (...args: unknown[]) => getOrgSlackInstallAnyMock(...args),
}));

import {
  createChannelMessageOwnership,
  resolveChannelMessageConnectionScope,
} from './channel-message-ownership.js';

describe('channel message ownership', () => {
  beforeEach(() => {
    getOrgSlackInstallAnyMock.mockReset();
  });

  it('binds the actor, scope, and provenance when registering a created message', async () => {
    const { db } = createTestDb();
    db.insert(users).values({ id: 'owner', email: 'owner@example.com' }).run();
    db.insert(sessions).values({ id: 'session-1', userId: 'owner', workspace: '/tmp', status: 'running' }).run();
    db.insert(actionInvocations).values({
      id: 'invocation-1', sessionId: 'session-1', userId: 'owner', service: 'slack', actionId: 'send', riskLevel: 'low', resolvedMode: 'allow',
    }).run();
    const ownership = createChannelMessageOwnership({
      db,
      actorUserId: 'owner',
      orgId: 'org-1',
      channelType: 'slack',
      connectionScope: 'T123',
      sessionId: 'session-1',
      actionInvocationId: 'invocation-1',
    });

    await ownership.registerCreated({ channelType: 'caller-controlled', channelId: 'C123', messageId: '171.000' });

    await expect(getChannelMessageRef(db, {
      orgId: 'org-1', channelType: 'slack', connectionScope: 'T123', channelId: 'C123', messageId: '171.000',
    })).resolves.toMatchObject({
      ownerUserId: 'owner', sessionId: 'session-1', actionInvocationId: 'invocation-1',
    });
  });

  it('rejects an unmanaged mutation before the provider call', async () => {
    const { db } = createTestDb();
    db.insert(users).values({ id: 'owner', email: 'owner@example.com' }).run();
    const ownership = createChannelMessageOwnership({
      db,
      actorUserId: 'owner',
      orgId: 'org-1',
      channelType: 'slack',
      connectionScope: 'T123',
    });
    const providerCall = vi.fn();
    const mutate = async () => {
      await ownership.assertCanModify({ channelType: 'slack', channelId: 'C123', messageId: 'missing' });
      return providerCall();
    };

    await expect(mutate())
      .rejects.toMatchObject({ code: 'message_not_managed' });

    expect(providerCall).not.toHaveBeenCalled();
  });

  it('uses the configured Slack team and a worker-derived user scope', async () => {
    getOrgSlackInstallAnyMock.mockResolvedValue({ teamId: 'T-configured' });
    const { db } = createTestDb();

    await expect(resolveChannelMessageConnectionScope({
      db,
      encryptionKey: 'test-key',
      channelType: 'slack',
      userId: 'user-1',
    })).resolves.toBe('T-configured');
    await expect(resolveChannelMessageConnectionScope({
      db,
      encryptionKey: 'test-key',
      channelType: 'telegram',
      userId: 'user-1',
    })).resolves.toBe('user:user-1');
  });
});
