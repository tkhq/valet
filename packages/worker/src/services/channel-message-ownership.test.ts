import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '../test-utils/db.js';
import { actionInvocations, integrations, sessions, users } from '../lib/schema/index.js';
import { getChannelMessageRef } from '../lib/db/channel-message-refs.js';
import { saveUserTelegramConfig } from '../lib/db/telegram.js';

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

  it('uses the configured Slack team and stable worker-owned connection configuration IDs', async () => {
    getOrgSlackInstallAnyMock.mockResolvedValue({ teamId: 'T-configured' });
    const { db } = createTestDb();
    db.insert(users).values({ id: 'user-1', email: 'user-1@example.com' }).run();
    await saveUserTelegramConfig(db, {
      id: 'telegram-config-before-reconnect', userId: 'user-1', botUsername: 'before', botInfo: '{}',
    });

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
    })).resolves.toBe('config:telegram-config-before-reconnect');

    await saveUserTelegramConfig(db, {
      id: 'telegram-config-after-reconnect', userId: 'user-1', botUsername: 'after', botInfo: '{}',
    });
    await expect(resolveChannelMessageConnectionScope({
      db,
      encryptionKey: 'test-key',
      channelType: 'telegram',
      userId: 'user-1',
    })).resolves.toBe('config:telegram-config-after-reconnect');
  });

  it('allows an admin to modify a member ref through their shared credential scope', async () => {
    const { db } = createTestDb();
    db.insert(users).values([
      { id: 'member', email: 'member@example.com' },
      { id: 'admin', email: 'admin@example.com', role: 'admin' },
    ]).run();
    db.insert(integrations).values({
      id: 'shared-org-connection', userId: 'member', service: 'custom-channel', config: { entities: [] }, status: 'active', scope: 'org',
    }).run();
    const shared = {
      db,
      orgId: 'org-1',
      channelType: 'custom-channel',
    };
    const memberScope = await resolveChannelMessageConnectionScope({
      db, encryptionKey: 'test-key', channelType: 'custom-channel', userId: 'member',
    });
    const adminScope = await resolveChannelMessageConnectionScope({
      db, encryptionKey: 'test-key', channelType: 'custom-channel', userId: 'admin',
    });
    expect(adminScope).toBe('integration:shared-org-connection');
    const member = createChannelMessageOwnership({ ...shared, actorUserId: 'member', connectionScope: memberScope });
    const admin = createChannelMessageOwnership({ ...shared, actorUserId: 'admin', connectionScope: adminScope });
    await member.registerCreated({ channelType: 'custom-channel', channelId: 'chat-1', messageId: 'message-1' });

    await expect(admin.assertCanModify({ channelType: 'custom-channel', channelId: 'chat-1', messageId: 'message-1' }))
      .resolves.toBeUndefined();
  });
});
