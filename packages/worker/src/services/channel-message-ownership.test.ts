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

  it('uses the configured Slack team and a stable credential fingerprint that changes on reconnect', async () => {
    getOrgSlackInstallAnyMock.mockResolvedValue({ teamId: 'T-configured' });
    const { db } = createTestDb();

    await expect(resolveChannelMessageConnectionScope({
      db,
      encryptionKey: 'test-key',
      channelType: 'slack',
      userId: 'user-1',
    })).resolves.toBe('T-configured');
    const scope = await resolveChannelMessageConnectionScope({
      db,
      encryptionKey: 'test-key',
      channelType: 'telegram',
      userId: 'user-1',
      credentialScopeMaterial: 'bot-token-before-reconnect',
    });
    const repeatedScope = await resolveChannelMessageConnectionScope({
      db,
      encryptionKey: 'test-key',
      channelType: 'telegram',
      userId: 'user-1',
      credentialScopeMaterial: 'bot-token-before-reconnect',
    });
    expect(repeatedScope).toBe(scope);
    expect(scope).not.toContain('bot-token-before-reconnect');

    const reconnectedScope = await resolveChannelMessageConnectionScope({
      db,
      encryptionKey: 'test-key',
      channelType: 'telegram',
      userId: 'user-1',
      credentialScopeMaterial: 'bot-token-after-reconnect',
    });
    expect(reconnectedScope).not.toBe(scope);
    expect(reconnectedScope).not.toContain('bot-token-after-reconnect');
  });

  it('allows an admin to modify a member ref through their shared credential scope', async () => {
    const { db } = createTestDb();
    db.insert(users).values([
      { id: 'member', email: 'member@example.com' },
      { id: 'admin', email: 'admin@example.com', role: 'admin' },
    ]).run();
    const shared = {
      db,
      orgId: 'org-1',
      channelType: 'telegram',
    };
    const memberScope = await resolveChannelMessageConnectionScope({
      db, encryptionKey: 'test-key', channelType: 'telegram', userId: 'member', credentialScopeMaterial: 'shared-bot-token',
    });
    const adminScope = await resolveChannelMessageConnectionScope({
      db, encryptionKey: 'test-key', channelType: 'telegram', userId: 'admin', credentialScopeMaterial: 'shared-bot-token',
    });
    expect(adminScope).toBe(memberScope);
    const member = createChannelMessageOwnership({ ...shared, actorUserId: 'member', connectionScope: memberScope });
    const admin = createChannelMessageOwnership({ ...shared, actorUserId: 'admin', connectionScope: adminScope });
    await member.registerCreated({ channelType: 'telegram', channelId: 'chat-1', messageId: 'message-1' });

    await expect(admin.assertCanModify({ channelType: 'telegram', channelId: 'chat-1', messageId: 'message-1' }))
      .resolves.toBeUndefined();
  });
});
