import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const {
  getOrgSlackInstallMock,
  resolveUserByExternalIdMock,
  getInvocationMock,
  getSessionMock,
  decryptStringMock,
  verifySlackSignatureMock,
  checkPrivateChannelAccessMock,
  dispatchOrchestratorPromptMock,
  getChannelBindingByScopeKeyMock,
  deleteChannelBindingMock,
  getOrchestratorSessionMock,
  getOrCreateChannelThreadMock,
  getChannelThreadMappingMock,
  getChannelBindingByChannelMock,
  getTeamMembershipMock,
  updateThreadCursorDbMock,
  dispatchTeamOrchestratorPromptMock,
  parseInboundMock,
  sendMessageMock,
  setThreadStatusMock,
  scopeKeyPartsMock,
} = vi.hoisted(() => ({
  getChannelBindingByChannelMock: vi.fn(),
  getTeamMembershipMock: vi.fn(),
  updateThreadCursorDbMock: vi.fn(),
  dispatchTeamOrchestratorPromptMock: vi.fn(),
  getOrgSlackInstallMock: vi.fn(),
  resolveUserByExternalIdMock: vi.fn(),
  getInvocationMock: vi.fn(),
  getSessionMock: vi.fn(),
  decryptStringMock: vi.fn(),
  verifySlackSignatureMock: vi.fn(),
  checkPrivateChannelAccessMock: vi.fn(),
  dispatchOrchestratorPromptMock: vi.fn(),
  getChannelBindingByScopeKeyMock: vi.fn(),
  deleteChannelBindingMock: vi.fn(),
  getOrchestratorSessionMock: vi.fn(),
  getOrCreateChannelThreadMock: vi.fn(),
  getChannelThreadMappingMock: vi.fn(),
  parseInboundMock: vi.fn(),
  sendMessageMock: vi.fn(),
  setThreadStatusMock: vi.fn(),
  scopeKeyPartsMock: vi.fn(),
}));

vi.mock('../lib/db.js', () => ({
  getOrgSlackInstall: getOrgSlackInstallMock,
  resolveUserByExternalId: resolveUserByExternalIdMock,
  getInvocation: getInvocationMock,
  getSession: getSessionMock,
  getChannelBindingByScopeKey: getChannelBindingByScopeKeyMock,
  deleteChannelBinding: deleteChannelBindingMock,
  getOrchestratorSession: getOrchestratorSessionMock,
  getOrCreateChannelThread: getOrCreateChannelThreadMock,
  getChannelThreadMapping: getChannelThreadMappingMock,
  getChannelBindingByChannel: getChannelBindingByChannelMock,
  getTeamMembership: getTeamMembershipMock,
  updateThreadCursor: updateThreadCursorDbMock,
  // Real implementation, minus the dynamic teams import: mirrors
  // lib/db/sessions.ts canActOnSessionPrompt for user-owned sessions.
  canActOnSessionPrompt: vi.fn(async (_db: unknown, session: { userId: string; ownerType?: string; ownerId?: string }, userId: string) => {
    if (session.ownerType === 'team' && session.ownerId) {
      return !!(await getTeamMembershipMock({}, session.ownerId, userId));
    }
    return session.userId === userId;
  }),
}));

vi.mock('../services/team-orchestrator.js', () => ({
  dispatchTeamOrchestratorPrompt: dispatchTeamOrchestratorPromptMock,
}));

vi.mock('../lib/crypto.js', () => ({
  decryptString: decryptStringMock,
  encryptString: vi.fn().mockResolvedValue('encrypted'),
}));

vi.mock('@valet/plugin-slack/channels', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@valet/plugin-slack/channels')>();
  return {
    ...actual,
    verifySlackSignature: verifySlackSignatureMock,
  };
});

vi.mock('@valet/plugin-slack/actions', () => ({
  checkPrivateChannelAccess: checkPrivateChannelAccessMock,
}));

vi.mock('../services/orchestrator.js', () => ({
  dispatchOrchestratorPrompt: dispatchOrchestratorPromptMock,
}));

vi.mock('./channel-webhooks.js', () => ({
  handleChannelCommand: vi.fn(),
}));

vi.mock('../services/slack.js', () => ({
  getSlackUserInfo: vi.fn(),
  getSlackBotInfo: vi.fn(),
}));

vi.mock('../services/slack-threads.js', () => ({
  buildThreadContext: vi.fn(),
  buildDmContext: vi.fn(),
}));

vi.mock('../lib/db/channel-threads.js', () => ({
  updateThreadCursor: vi.fn(),
}));

vi.mock('../channels/registry.js', () => ({
  channelRegistry: {
    getTransport: vi.fn(() => ({
      parseInbound: parseInboundMock,
      scopeKeyParts: scopeKeyPartsMock,
      sendMessage: sendMessageMock,
      setThreadStatus: setThreadStatusMock,
    })),
  },
}));

import { slackEventsRouter } from './slack-events.js';

function buildApp() {
  const app = new Hono();
  app.use('*', async (c, next) => {
    (c as any).set('db', {} as any);
    await next();
  });
  app.route('/', slackEventsRouter);
  return app;
}

function buildInteractiveRequest(payload: Record<string, unknown>) {
  return new Request('http://localhost/slack/interactive', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'x-slack-signature': 'v0=test',
      'x-slack-request-timestamp': '1234567890',
    },
    body: new URLSearchParams({
      payload: JSON.stringify(payload),
    }).toString(),
  });
}

function buildMentionEventRequest(channelId: string, channelType: string, userId: string) {
  return new Request('http://localhost/slack/events', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-slack-signature': 'v0=test',
      'x-slack-request-timestamp': String(Math.floor(Date.now() / 1000)),
    },
    body: JSON.stringify({
      type: 'event_callback',
      team_id: 'T123',
      event: {
        type: 'app_mention',
        user: userId,
        text: '<@UBOTID> hello',
        channel: channelId,
        channel_type: channelType,
        ts: '1234567890.123456',
      },
    }),
  });
}

describe('slackEventsRouter /slack/interactive', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    getOrgSlackInstallMock.mockResolvedValue({
      signingSecret: 'decrypted-secret',
      botToken: 'decrypted-bot',
      teamId: 'T123',
      botUserId: 'B123',
      teamName: null,
      appId: null,
      configuredBy: 'user-1',
    });
    verifySlackSignatureMock.mockReturnValue(true);
    parseInboundMock.mockResolvedValue({
      channelType: 'slack',
      channelId: 'C_PRIVATE',
      senderId: 'UMENTIONER',
      senderName: 'Test User',
      text: '@Bot hello',
      attachments: [],
      messageId: '1234567890.123456',
      metadata: {
        teamId: 'T123',
        slackEventType: 'app_mention',
        slackChannelType: 'group',
      },
    });
    scopeKeyPartsMock.mockReturnValue({ channelType: 'slack', channelId: 'T123:C_PRIVATE' });
  });

  it('returns an explicit Slack error when a linked non-owner clicks a prompt button', async () => {
    resolveUserByExternalIdMock.mockResolvedValue('user-2');
    getSessionMock.mockResolvedValue({ id: 'orchestrator:user-1', userId: 'user-1' });

    const app = buildApp();
    const waitUntil = vi.fn();
    const res = await app.fetch(
      buildInteractiveRequest({
        type: 'block_actions',
        team: { id: 'T123' },
        user: { id: 'U123' },
        actions: [
          { action_id: 'approve', value: 'orchestrator:user-1:prompt-1' },
        ],
      }),
      {
        DB: {},
        ENCRYPTION_KEY: 'test-key',
        SLACK_SIGNING_SECRET: 'fallback-secret',
      } as any,
      { waitUntil } as any,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      response_type: 'ephemeral',
      replace_original: false,
      text: "You're not authorized to respond to this prompt.",
    });
    expect(waitUntil).not.toHaveBeenCalled();
  });

  it('accepts owner clicks and forwards the resolution to the session DO', async () => {
    resolveUserByExternalIdMock.mockResolvedValue('user-1');
    getSessionMock.mockResolvedValue({ id: 'orchestrator:user-1', userId: 'user-1' });

    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: true }), { status: 200 }));
    const app = buildApp();
    const waitUntil = vi.fn((promise: Promise<unknown>) => promise);
    const res = await app.fetch(
      buildInteractiveRequest({
        type: 'block_actions',
        team: { id: 'T123' },
        user: { id: 'U123' },
        actions: [
          { action_id: 'approve', value: 'orchestrator:user-1:prompt-1' },
        ],
      }),
      {
        DB: {},
        ENCRYPTION_KEY: 'test-key',
        SLACK_SIGNING_SECRET: 'fallback-secret',
        SESSIONS: {
          idFromName: vi.fn((name: string) => `do:${name}`),
          get: vi.fn(() => ({ fetch: fetchMock })),
        },
      } as any,
      { waitUntil } as any,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(waitUntil).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledOnce();

    const forwardedRequest = fetchMock.mock.calls[0][0] as Request;
    expect(forwardedRequest.url).toBe('https://session/prompt-resolved');
    expect(await forwardedRequest.json()).toEqual({
      promptId: 'prompt-1',
      actionId: 'approve',
      resolvedBy: 'user-1',
    });
  });

  it('replaces Slack processing state with an error when the session DO rejects the click', async () => {
    resolveUserByExternalIdMock.mockResolvedValue('user-1');
    getSessionMock.mockResolvedValue({ id: 'orchestrator:user-1', userId: 'user-1' });

    const responseUrlFetch = vi.fn(async (_url: string, _init: RequestInit) => Response.json({ ok: true }));
    vi.stubGlobal('fetch', responseUrlFetch);

    const doFetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ error: 'This prompt has expired.' }),
      { status: 410, headers: { 'content-type': 'application/json' } },
    ));
    const app = buildApp();
    const waitUntilPromises: Array<Promise<unknown>> = [];
    const waitUntil = vi.fn((promise: Promise<unknown>) => {
      waitUntilPromises.push(promise);
    });

    const res = await app.fetch(
      buildInteractiveRequest({
        type: 'block_actions',
        team: { id: 'T123' },
        user: { id: 'U123' },
        response_url: 'https://hooks.slack.com/actions/response',
        message: {
          text: 'Action requires approval',
          blocks: [
            { type: 'section', text: { type: 'mrkdwn', text: 'Approve?' } },
            { type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: 'Allow' } }] },
          ],
        },
        actions: [
          { action_id: 'allow_session', value: 'orchestrator:user-1:prompt-1' },
        ],
      }),
      {
        DB: {},
        ENCRYPTION_KEY: 'test-key',
        SLACK_SIGNING_SECRET: 'fallback-secret',
        SESSIONS: {
          idFromName: vi.fn((name: string) => `do:${name}`),
          get: vi.fn(() => ({ fetch: doFetchMock })),
        },
      } as any,
      { waitUntil } as any,
    );

    await Promise.all(waitUntilPromises);

    expect(res.status).toBe(200);
    expect(responseUrlFetch).toHaveBeenCalledTimes(2);
    const processingBody = JSON.parse((responseUrlFetch.mock.calls[0][1]).body as string);
    const rejectedBody = JSON.parse((responseUrlFetch.mock.calls[1][1]).body as string);
    expect(processingBody.blocks).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'context' }),
    ]));
    expect(rejectedBody.replace_original).toBe(true);
    expect(JSON.stringify(rejectedBody.blocks)).toContain('This prompt has expired.');
  });

  it('replaces Slack processing state with an error when the session DO is unreachable', async () => {
    resolveUserByExternalIdMock.mockResolvedValue('user-1');
    getSessionMock.mockResolvedValue({ id: 'orchestrator:user-1', userId: 'user-1' });

    const responseUrlFetch = vi.fn(async (_url: string, _init: RequestInit) => Response.json({ ok: true }));
    vi.stubGlobal('fetch', responseUrlFetch);

    const doFetchMock = vi.fn().mockRejectedValue(new Error('DO unreachable'));
    const app = buildApp();
    const waitUntilPromises: Array<Promise<unknown>> = [];
    const waitUntil = vi.fn((promise: Promise<unknown>) => {
      waitUntilPromises.push(promise);
    });

    const res = await app.fetch(
      buildInteractiveRequest({
        type: 'block_actions',
        team: { id: 'T123' },
        user: { id: 'U123' },
        response_url: 'https://hooks.slack.com/actions/response',
        message: {
          text: 'Action requires approval',
          blocks: [
            { type: 'section', text: { type: 'mrkdwn', text: 'Approve?' } },
            { type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: 'Allow' } }] },
          ],
        },
        actions: [
          { action_id: 'allow_session', value: 'orchestrator:user-1:prompt-1' },
        ],
      }),
      {
        DB: {},
        ENCRYPTION_KEY: 'test-key',
        SLACK_SIGNING_SECRET: 'fallback-secret',
        SESSIONS: {
          idFromName: vi.fn((name: string) => `do:${name}`),
          get: vi.fn(() => ({ fetch: doFetchMock })),
        },
      } as any,
      { waitUntil } as any,
    );

    await Promise.all(waitUntilPromises);

    expect(res.status).toBe(200);
    expect(responseUrlFetch).toHaveBeenCalledTimes(2);
    const processingBody = JSON.parse((responseUrlFetch.mock.calls[0][1]).body as string);
    const rejectedBody = JSON.parse((responseUrlFetch.mock.calls[1][1]).body as string);
    expect(processingBody.blocks).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'context' }),
    ]));
    expect(rejectedBody.replace_original).toBe(true);
    expect(JSON.stringify(rejectedBody.blocks)).toContain('The session could not be reached.');
  });
});

describe('private channel access control on inbound mentions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getOrgSlackInstallMock.mockResolvedValue({
      signingSecret: 'decrypted-secret',
      botToken: 'decrypted-token',
      teamId: 'T123',
      botUserId: 'B123',
      teamName: null,
      appId: null,
      configuredBy: 'user-1',
    });
    verifySlackSignatureMock.mockReturnValue(true);
    resolveUserByExternalIdMock.mockResolvedValue('user-1');
    parseInboundMock.mockResolvedValue({
      channelType: 'slack',
      channelId: 'C_PRIVATE',
      senderId: 'UMENTIONER',
      senderName: 'Test User',
      text: '@Bot hello',
      attachments: [],
      messageId: '1234567890.123456',
      metadata: {
        teamId: 'T123',
        slackEventType: 'app_mention',
        slackChannelType: 'group',
      },
    });
    scopeKeyPartsMock.mockReturnValue({ channelType: 'slack', channelId: 'T123:C_PRIVATE' });
  });

  it('silently ignores app_mention from a private channel when user is not a member', async () => {
    checkPrivateChannelAccessMock.mockResolvedValue({
      allowed: false,
      isPrivate: true,
      error: 'Access denied: you are not a member of this private channel',
    });

    const app = buildApp();
    const res = await app.fetch(
      buildMentionEventRequest('C_PRIVATE', 'group', 'UMENTIONER'),
      { DB: {}, ENCRYPTION_KEY: 'k', SLACK_SIGNING_SECRET: 's' } as any,
      { waitUntil: vi.fn() } as any,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(dispatchOrchestratorPromptMock).not.toHaveBeenCalled();
  });

  it('silently ignores app_mention from a private channel even when user is a member', async () => {
    checkPrivateChannelAccessMock.mockResolvedValue({ allowed: true, isPrivate: true });

    const app = buildApp();
    const res = await app.fetch(
      buildMentionEventRequest('C_PRIVATE', 'group', 'UMENTIONER'),
      { DB: {}, ENCRYPTION_KEY: 'k', SLACK_SIGNING_SECRET: 's' } as any,
      { waitUntil: vi.fn() } as any,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(getOrchestratorSessionMock).not.toHaveBeenCalled();
    expect(dispatchOrchestratorPromptMock).not.toHaveBeenCalled();
  });
});

describe('personal orchestrator Slack surface policy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getOrgSlackInstallMock.mockResolvedValue({
      signingSecret: 'decrypted-secret',
      botToken: 'decrypted-token',
      teamId: 'T123',
      botUserId: 'B123',
      teamName: null,
      appId: null,
      configuredBy: 'user-1',
    });
    verifySlackSignatureMock.mockReturnValue(true);
    resolveUserByExternalIdMock.mockResolvedValue('user-1');
    scopeKeyPartsMock.mockReturnValue({ channelType: 'slack', channelId: 'D123' });
  });

  it('silently ignores public-channel mentions before personal orchestrator resolution', async () => {
    parseInboundMock.mockResolvedValue({
      channelType: 'slack',
      channelId: 'C_PUBLIC',
      senderId: 'UMENTIONER',
      senderName: 'Test User',
      text: '@Bot hello',
      attachments: [],
      messageId: '1234567890.123456',
      metadata: {
        teamId: 'T123',
        slackEventType: 'app_mention',
        slackChannelType: 'channel',
      },
    });

    const app = buildApp();
    const res = await app.fetch(
      buildMentionEventRequest('C_PUBLIC', 'channel', 'UMENTIONER'),
      { DB: {}, ENCRYPTION_KEY: 'k', SLACK_SIGNING_SECRET: 's' } as any,
      { waitUntil: vi.fn() } as any,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(resolveUserByExternalIdMock).not.toHaveBeenCalled();
    expect(getOrchestratorSessionMock).not.toHaveBeenCalled();
    expect(dispatchOrchestratorPromptMock).not.toHaveBeenCalled();
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it('still routes Slack DMs to the personal orchestrator', async () => {
    parseInboundMock.mockResolvedValue({
      channelType: 'slack',
      channelId: 'D123',
      senderId: 'UDM',
      senderName: 'DM User',
      text: 'hello from dm',
      attachments: [],
      messageId: '1234567890.123456',
      metadata: {
        teamId: 'T123',
        slackEventType: 'message',
        slackChannelType: 'im',
      },
    });
    getChannelBindingByScopeKeyMock.mockResolvedValue(null);
    getOrchestratorSessionMock.mockResolvedValue({ id: 'orchestrator:user-1' });
    getOrCreateChannelThreadMock.mockResolvedValue('thread-uuid-dm');
    getChannelThreadMappingMock.mockResolvedValue(null);
    dispatchOrchestratorPromptMock.mockResolvedValue({ dispatched: true });

    const app = buildApp();
    const waitUntil = vi.fn();
    const res = await app.fetch(
      new Request('http://localhost/slack/events', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-slack-signature': 'v0=test',
          'x-slack-request-timestamp': String(Math.floor(Date.now() / 1000)),
        },
        body: JSON.stringify({
          type: 'event_callback',
          team_id: 'T123',
          event: {
            type: 'message',
            user: 'UDM',
            text: 'hello from dm',
            channel: 'D123',
            channel_type: 'im',
            ts: '1234567890.123456',
          },
        }),
      }),
      { DB: {}, ENCRYPTION_KEY: 'k', SLACK_SIGNING_SECRET: 's' } as any,
      { waitUntil } as any,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(resolveUserByExternalIdMock).toHaveBeenCalledOnce();
    expect(dispatchOrchestratorPromptMock).toHaveBeenCalledOnce();
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it('passes scopeKey from scopeKeyParts to dispatchOrchestratorPrompt', async () => {
    parseInboundMock.mockResolvedValue({
      channelType: 'slack',
      channelId: 'D123',
      senderId: 'UDM',
      senderName: 'DM User',
      text: 'hello',
      attachments: [],
      messageId: '1234567890.123456',
      metadata: {
        teamId: 'T456',
        slackEventType: 'message',
        slackChannelType: 'im',
      },
    });
    scopeKeyPartsMock.mockReturnValue({ channelType: 'slack', channelId: 'T456:D123' });
    getChannelBindingByScopeKeyMock.mockResolvedValue(null);
    getOrchestratorSessionMock.mockResolvedValue({ id: 'orchestrator:user-1' });
    getOrCreateChannelThreadMock.mockResolvedValue('thread-uuid');
    getChannelThreadMappingMock.mockResolvedValue(null);
    dispatchOrchestratorPromptMock.mockResolvedValue({ dispatched: true });

    const app = buildApp();
    await app.fetch(
      new Request('http://localhost/slack/events', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-slack-signature': 'v0=test',
          'x-slack-request-timestamp': String(Math.floor(Date.now() / 1000)),
        },
        body: JSON.stringify({
          type: 'event_callback',
          team_id: 'T456',
          event: { type: 'message', user: 'UDM', text: 'hello', channel: 'D123', channel_type: 'im', ts: '1234567890.123456' },
        }),
      }),
      { DB: {}, ENCRYPTION_KEY: 'k', SLACK_SIGNING_SECRET: 's' } as any,
      { waitUntil: vi.fn() } as any,
    );

    expect(dispatchOrchestratorPromptMock).toHaveBeenCalledOnce();
    expect(dispatchOrchestratorPromptMock.mock.calls[0][1]).toMatchObject({
      scopeKey: 'user:user-1:slack:T456:D123',
    });
  });
});

describe('Slack DM thread reply routes to pre-registered orchestrator thread', () => {
  const sessionFetchMock = vi.fn();

  function buildThreadReplyRequest(threadTs: string) {
    return new Request('http://localhost/slack/events', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-slack-signature': 'v0=test',
        'x-slack-request-timestamp': String(Math.floor(Date.now() / 1000)),
      },
      body: JSON.stringify({
        type: 'event_callback',
        team_id: 'T123',
        event: {
          type: 'message',
          user: 'UDM',
          text: 'suh',
          channel: 'D123',
          channel_type: 'im',
          ts: '1700000001.000001',
          thread_ts: threadTs,
        },
      }),
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    getOrgSlackInstallMock.mockResolvedValue({
      signingSecret: 'secret', botToken: 'token', teamId: 'T123',
      botUserId: 'B123', teamName: null, appId: null, configuredBy: 'user-1',
    });
    verifySlackSignatureMock.mockReturnValue(true);
    resolveUserByExternalIdMock.mockResolvedValue('user-1');
    parseInboundMock.mockResolvedValue({
      channelType: 'slack', channelId: 'D123', senderId: 'UDM', senderName: 'DM User',
      text: 'suh', attachments: [], messageId: '1700000001.000001',
      metadata: {
        teamId: 'T123',
        threadTs: '1700000000.000001',
        eventTs: '1700000001.000001',
        slackEventType: 'message',
        slackChannelType: 'im',
      },
    });
    // 3-part scope key for the thread reply
    scopeKeyPartsMock.mockReturnValue({ channelType: 'slack', channelId: 'T123:D123:1700000000.000001' });
    getChannelBindingByScopeKeyMock.mockResolvedValue({
      id: 'binding-1',
      sessionId: 'orchestrator:user-1',
      channelType: 'slack',
      channelId: 'T123:D123:1700000000.000001',
      scopeKey: 'user:user-1:slack:T123:D123:1700000000.000001',
      userId: 'user-1',
      orgId: 'default',
      queueMode: 'followup',
      collectDebounceMs: 3000,
      createdAt: new Date().toISOString(),
    });
    getSessionMock.mockResolvedValue({ id: 'orchestrator:user-1', status: 'running' });
    sessionFetchMock.mockReset();
    sessionFetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
  });

  it('dispatches to bound session with the pre-registered thread ID from channel mapping', async () => {
    // Simulate registerChannelThread having been called when the DM was sent:
    // getOrCreateChannelThread returns the pre-registered web conversation thread ID.
    getOrCreateChannelThreadMock.mockResolvedValue('existing-web-thread-uuid');
    getChannelThreadMappingMock.mockResolvedValue(null);

    const app = buildApp();
    const res = await app.fetch(
      buildThreadReplyRequest('1700000000.000001'),
      {
        DB: {},
        ENCRYPTION_KEY: 'k',
        SLACK_SIGNING_SECRET: 's',
        SESSIONS: {
          idFromName: vi.fn((name: string) => `do:${name}`),
          get: vi.fn(() => ({ fetch: sessionFetchMock })),
        },
      } as any,
      { waitUntil: vi.fn() } as any,
    );

    expect(res.status).toBe(200);
    expect(sessionFetchMock).toHaveBeenCalledOnce();

    const dispatchedRequest = sessionFetchMock.mock.calls[0][0] as Request;
    const body = await dispatchedRequest.json() as Record<string, unknown>;
    // The pre-registered thread ID must be passed so the reply lands in the
    // originating web conversation, not a new one.
    expect(body.threadId).toBe('existing-web-thread-uuid');
  });

  it('dispatches with a fresh thread ID when no pre-registration exists', async () => {
    // No pre-registration — getOrCreateChannelThread creates a new thread.
    getOrCreateChannelThreadMock.mockResolvedValue('new-thread-uuid');
    getChannelThreadMappingMock.mockResolvedValue(null);

    const app = buildApp();
    const res = await app.fetch(
      buildThreadReplyRequest('1700000000.000001'),
      {
        DB: {},
        ENCRYPTION_KEY: 'k',
        SLACK_SIGNING_SECRET: 's',
        SESSIONS: {
          idFromName: vi.fn((name: string) => `do:${name}`),
          get: vi.fn(() => ({ fetch: sessionFetchMock })),
        },
      } as any,
      { waitUntil: vi.fn() } as any,
    );

    expect(res.status).toBe(200);
    expect(sessionFetchMock).toHaveBeenCalledOnce();

    const dispatchedRequest = sessionFetchMock.mock.calls[0][0] as Request;
    const body = await dispatchedRequest.json() as Record<string, unknown>;
    expect(body.threadId).toBe('new-thread-uuid');
  });
});

describe('bound-session dispatch failure handling', () => {
  const sessionFetchMock = vi.fn();

  function buildDmRequest() {
    return new Request('http://localhost/slack/events', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-slack-signature': 'v0=test',
        'x-slack-request-timestamp': String(Math.floor(Date.now() / 1000)),
      },
      body: JSON.stringify({
        type: 'event_callback',
        team_id: 'T123',
        event: { type: 'message', user: 'UDM', text: 'hello', channel: 'D123', channel_type: 'im', ts: '1234567890.123456' },
      }),
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    getOrgSlackInstallMock.mockResolvedValue({
      signingSecret: 'secret', botToken: 'token', teamId: 'T123',
      botUserId: 'B123', teamName: null, appId: null, configuredBy: 'user-1',
    });
    verifySlackSignatureMock.mockReturnValue(true);
    resolveUserByExternalIdMock.mockResolvedValue('user-1');
    parseInboundMock.mockResolvedValue({
      channelType: 'slack', channelId: 'D123', senderId: 'UDM', senderName: 'DM User',
      text: 'hello', attachments: [], messageId: '1234567890.123456',
      metadata: { teamId: 'T123', slackEventType: 'message', slackChannelType: 'im' },
    });
    scopeKeyPartsMock.mockReturnValue({ channelType: 'slack', channelId: 'T123:D123' });
    getChannelBindingByScopeKeyMock.mockResolvedValue({
      id: 'binding-1', sessionId: 'child-session-1', channelType: 'slack',
      channelId: 'D123:1234567890.123456', scopeKey: 'user:user-1:slack:T123:D123',
      userId: 'user-1', orgId: 'default', queueMode: 'steer', collectDebounceMs: 3000,
      createdAt: new Date().toISOString(),
    });
    getSessionMock.mockResolvedValue({ id: 'child-session-1', status: 'running' });
    getOrchestratorSessionMock.mockResolvedValue({ id: 'orchestrator:user-1' });
    getOrCreateChannelThreadMock.mockResolvedValue('thread-uuid');
    getChannelThreadMappingMock.mockResolvedValue(null);
    sessionFetchMock.mockReset();
  });

  function buildEnvWithSession() {
    return {
      DB: {},
      ENCRYPTION_KEY: 'k',
      SLACK_SIGNING_SECRET: 's',
      SESSIONS: {
        idFromName: vi.fn((name: string) => `do:${name}`),
        get: vi.fn(() => ({ fetch: sessionFetchMock })),
      },
    } as any;
  }

  it('does NOT dispatch to orchestrator when bound session returns non-200 (non-409)', async () => {
    sessionFetchMock.mockResolvedValue(new Response('internal error', { status: 500 }));

    const app = buildApp();
    const res = await app.fetch(
      buildDmRequest(),
      buildEnvWithSession(),
      { waitUntil: vi.fn() } as any,
    );

    expect(res.status).toBe(200);
    expect(sessionFetchMock).toHaveBeenCalledOnce();
    expect(dispatchOrchestratorPromptMock).not.toHaveBeenCalled();
    expect(deleteChannelBindingMock).not.toHaveBeenCalled();
  });

  it('evicts binding and dispatches to orchestrator on 409 (session terminated)', async () => {
    sessionFetchMock.mockResolvedValue(new Response('terminated', { status: 409 }));
    dispatchOrchestratorPromptMock.mockResolvedValue({ dispatched: true });

    const app = buildApp();
    const res = await app.fetch(
      buildDmRequest(),
      buildEnvWithSession(),
      { waitUntil: vi.fn() } as any,
    );

    expect(res.status).toBe(200);
    expect(sessionFetchMock).toHaveBeenCalledOnce();
    expect(deleteChannelBindingMock).toHaveBeenCalledWith({}, 'binding-1');
    expect(dispatchOrchestratorPromptMock).toHaveBeenCalledOnce();
  });

  it('evicts binding and dispatches to orchestrator when bound session is unreachable', async () => {
    sessionFetchMock.mockRejectedValue(new Error('DO unreachable'));
    dispatchOrchestratorPromptMock.mockResolvedValue({ dispatched: true });

    const app = buildApp();
    const res = await app.fetch(
      buildDmRequest(),
      buildEnvWithSession(),
      { waitUntil: vi.fn() } as any,
    );

    expect(res.status).toBe(200);
    expect(sessionFetchMock).toHaveBeenCalledOnce();
    expect(deleteChannelBindingMock).toHaveBeenCalledWith({}, 'binding-1');
    expect(dispatchOrchestratorPromptMock).toHaveBeenCalledOnce();
  });
});

describe('team-bound shared channels', () => {
  const TEAM_BINDING = {
    id: 'binding-team',
    sessionId: 'orchestrator:team:team-1',
    channelType: 'slack',
    channelId: 'C_TEAM',
    scopeKey: 'team:team-1:slack:C_TEAM',
    ownerType: 'team',
    ownerId: 'team-1',
    triggerMode: 'mention',
    orgId: 'default',
    queueMode: 'followup',
    collectDebounceMs: 3000,
    createdAt: 'x',
  };

  const teamMessage = (overrides: Record<string, unknown> = {}) => ({
    channelType: 'slack',
    channelId: 'C_TEAM',
    senderId: 'USLACK',
    senderName: 'Alice',
    text: 'ship it',
    attachments: [],
    messageId: '1111.2222',
    // Channel messages arrive as `message.*`; the bot's own @mention arrives as
    // a separate `app_mention` that the team branch drops (dedup), so mention
    // detection uses the raw text (see buildTeamRequest).
    metadata: { teamId: 'T123', slackEventType: 'message', slackChannelType: 'channel' },
    ...overrides,
  });

  // Raw payload with configurable text; `<@B123>` in the text is how the team
  // branch detects a mention now that app_mention events are dropped.
  const buildTeamRequest = (text: string, threadTs?: string) =>
    new Request('http://localhost/slack/events', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-slack-signature': 'v0=test',
        'x-slack-request-timestamp': String(Math.floor(Date.now() / 1000)),
      },
      body: JSON.stringify({
        type: 'event_callback',
        team_id: 'T123',
        event: {
          type: 'message',
          user: 'USLACK',
          text,
          channel: 'C_TEAM',
          channel_type: 'channel',
          ts: '1111.2222',
          ...(threadTs ? { thread_ts: threadTs } : {}),
        },
      }),
    });

  // Default fire: a member @mention (raw text carries the bot mention).
  const fire = (text = '<@B123> ship it', threadTs?: string) =>
    buildApp().fetch(
      buildTeamRequest(text, threadTs),
      { DB: {}, ENCRYPTION_KEY: 'k', SLACK_SIGNING_SECRET: 's' } as any,
      { waitUntil: vi.fn() } as any,
    );

  beforeEach(() => {
    vi.clearAllMocks();
    getOrgSlackInstallMock.mockResolvedValue({
      signingSecret: 'decrypted-secret',
      botToken: 'decrypted-bot',
      teamId: 'T123',
      botUserId: 'B123',
      teamName: null,
      appId: null,
      configuredBy: 'user-1',
    });
    verifySlackSignatureMock.mockReturnValue(true);
    getChannelBindingByChannelMock.mockResolvedValue(TEAM_BINDING);
    parseInboundMock.mockResolvedValue(teamMessage());
    resolveUserByExternalIdMock.mockResolvedValue('user-alice');
    getTeamMembershipMock.mockResolvedValue({ teamId: 'team-1', userId: 'user-alice', role: 'member' });
    getOrCreateChannelThreadMock.mockResolvedValue('thread-1');
    getChannelThreadMappingMock.mockResolvedValue(null);
    dispatchTeamOrchestratorPromptMock.mockResolvedValue({ dispatched: true, sessionId: TEAM_BINDING.sessionId });
  });

  it('routes a member mention to the team orchestrator with attribution', async () => {
    const res = await fire();
    expect(res.status).toBe(200);
    expect(dispatchTeamOrchestratorPromptMock).toHaveBeenCalledOnce();
    const [, teamId, params] = dispatchTeamOrchestratorPromptMock.mock.calls[0];
    expect(teamId).toBe('team-1');
    expect(params.actor.userId).toBe('user-alice');
    expect(params.authorName).toBe('Alice');
    expect(params.queueMode).toBe('followup');
    expect(params.replyTo.channelType).toBe('slack');
    expect(dispatchOrchestratorPromptMock).not.toHaveBeenCalled();
  });

  it('drops the duplicate app_mention event (message.* is canonical)', async () => {
    // Slack double-delivers a channel @mention: one app_mention + one message.
    // The team branch must dispatch only once — for the message event.
    parseInboundMock.mockResolvedValue(
      teamMessage({ metadata: { teamId: 'T123', slackEventType: 'app_mention', slackChannelType: 'channel' } })
    );
    const res = await fire();
    expect(res.status).toBe(200);
    expect(dispatchTeamOrchestratorPromptMock).not.toHaveBeenCalled();
  });

  it('silently ignores unmapped slack users', async () => {
    resolveUserByExternalIdMock.mockResolvedValue(null);
    const res = await fire();
    expect(res.status).toBe(200);
    expect(dispatchTeamOrchestratorPromptMock).not.toHaveBeenCalled();
    expect(sendMessageMock).not.toHaveBeenCalled(); // no authorization chatter
  });

  it('silently ignores non-members', async () => {
    getTeamMembershipMock.mockResolvedValue(null);
    const res = await fire();
    expect(res.status).toBe(200);
    expect(dispatchTeamOrchestratorPromptMock).not.toHaveBeenCalled();
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it('mention mode ignores plain messages outside active threads', async () => {
    const res = await fire('just chatting, no mention');
    expect(res.status).toBe(200);
    expect(dispatchTeamOrchestratorPromptMock).not.toHaveBeenCalled();
  });

  it('mention mode accepts replies in threads the orchestrator is active in', async () => {
    parseInboundMock.mockResolvedValue(
      teamMessage({
        metadata: { teamId: 'T123', slackEventType: 'message', slackChannelType: 'channel', threadTs: '1111.0000' },
      })
    );
    getChannelThreadMappingMock.mockResolvedValue({ lastSeenTs: '1111.0000' });
    const res = await fire('reply without a mention', '1111.0000');
    expect(res.status).toBe(200);
    expect(dispatchTeamOrchestratorPromptMock).toHaveBeenCalledOnce();
  });

  it("'all' mode dispatches plain member messages via collect", async () => {
    getChannelBindingByChannelMock.mockResolvedValue({ ...TEAM_BINDING, triggerMode: 'all' });
    const res = await fire('hi team, no mention');
    expect(res.status).toBe(200);
    const [, , params] = dispatchTeamOrchestratorPromptMock.mock.calls[0];
    expect(params.queueMode).toBe('collect');
  });

  it('user-owned bindings on shared channels do not route (personal stays DM-only)', async () => {
    getChannelBindingByChannelMock.mockResolvedValue({ ...TEAM_BINDING, ownerType: 'user', ownerId: 'user-alice' });
    const res = await fire();
    expect(res.status).toBe(200);
    expect(dispatchTeamOrchestratorPromptMock).not.toHaveBeenCalled();
    expect(dispatchOrchestratorPromptMock).not.toHaveBeenCalled();
  });
});
