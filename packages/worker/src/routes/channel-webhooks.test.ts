import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const {
  getCredentialMock,
  getUserTelegramConfigMock,
  getInvocationMock,
  getChannelBindingByScopeKeyMock,
  getOrchestratorSessionMock,
  getSessionMock,
  getOrCreateChannelThreadMock,
  deleteChannelBindingMock,
  getTransportMock,
  dispatchOrchestratorPromptMock,
} = vi.hoisted(() => ({
  getCredentialMock: vi.fn(),
  getUserTelegramConfigMock: vi.fn(),
  getInvocationMock: vi.fn(),
  getChannelBindingByScopeKeyMock: vi.fn(),
  getOrchestratorSessionMock: vi.fn(),
  getSessionMock: vi.fn(),
  getOrCreateChannelThreadMock: vi.fn(),
  deleteChannelBindingMock: vi.fn(),
  getTransportMock: vi.fn(),
  dispatchOrchestratorPromptMock: vi.fn(),
}));

vi.mock('../services/credentials.js', () => ({
  getCredential: getCredentialMock,
}));

vi.mock('../lib/db.js', () => ({
  getUserTelegramConfig: getUserTelegramConfigMock,
  getInvocation: getInvocationMock,
  getChannelBindingByScopeKey: getChannelBindingByScopeKeyMock,
  getOrchestratorSession: getOrchestratorSessionMock,
  getSession: getSessionMock,
  getOrCreateChannelThread: getOrCreateChannelThreadMock,
  deleteChannelBinding: deleteChannelBindingMock,
}));

vi.mock('../channels/registry.js', () => ({
  channelRegistry: {
    getTransport: getTransportMock,
  },
}));

vi.mock('../services/orchestrator.js', () => ({
  dispatchOrchestratorPrompt: dispatchOrchestratorPromptMock,
}));

import { channelWebhooksRouter } from './channel-webhooks.js';
import { TELEGRAM_SECRET_HEADER, telegramWebhookSecret } from '../services/telegram.js';

const ENCRYPTION_KEY = 'test-encryption-key';
let secret = '';
beforeAll(async () => {
  secret = await telegramWebhookSecret(ENCRYPTION_KEY, 'user-1');
});

function buildApp() {
  const app = new Hono();
  app.use('*', async (c, next) => {
    (c as any).set('db', {} as any);
    await next();
  });
  app.route('/', channelWebhooksRouter);
  return app;
}

describe('channelWebhooksRouter Telegram', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getCredentialMock.mockResolvedValue({ ok: true, credential: { accessToken: 'telegram-token' } });
    getUserTelegramConfigMock.mockResolvedValue({ ownerTelegramUserId: 'tg-owner' });
    getInvocationMock.mockResolvedValue(null);
    getChannelBindingByScopeKeyMock.mockResolvedValue(null);
    getSessionMock.mockResolvedValue({ id: 'session-bound', userId: 'user-1', status: 'running' });
    getOrchestratorSessionMock.mockResolvedValue({ id: 'orchestrator:user-1' });
    getOrCreateChannelThreadMock.mockResolvedValue('thread-telegram');
    dispatchOrchestratorPromptMock.mockResolvedValue({ dispatched: true });
    getTransportMock.mockReturnValue({
      verifySignature: vi.fn(() => true),
      parseInbound: vi.fn(),
      scopeKeyParts: vi.fn((message) => ({ channelType: message.channelType, channelId: message.channelId })),
      sendMessage: vi.fn(),
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('routes question button callbacks to the bound Telegram session before falling back to the orchestrator', async () => {
    const app = buildApp();
    const forwardedRequests: Request[] = [];
    const doFetch = vi.fn(async (request: Request) => {
      forwardedRequests.push(request);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    const env = {
      SESSIONS: {
        idFromName: vi.fn((name: string) => `id:${name}`),
        get: vi.fn(() => ({ fetch: doFetch })),
      },
      DB: {},
      ENCRYPTION_KEY,
    };
    const executionCtx = { waitUntil: vi.fn((promise: Promise<unknown>) => promise) };
    getChannelBindingByScopeKeyMock.mockResolvedValue({
      id: 'binding-1',
      sessionId: 'session-bound',
      queueMode: 'steer',
    });
    getOrchestratorSessionMock.mockResolvedValue({ id: 'orchestrator:user-1' });

    const res = await app.request(
      '/telegram/webhook/user-1',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', [TELEGRAM_SECRET_HEADER]: secret },
        body: JSON.stringify({
          update_id: 1,
          callback_query: {
            id: 'callback-1',
            data: 'option_0|q-telegram',
            from: { id: 'tg-owner' },
            message: {
              message_id: 42,
              chat: { id: 12345, type: 'private' },
            },
          },
        }),
      },
      env as any,
      executionCtx as any,
    );

    expect(res.status).toBe(200);
    await Promise.all(executionCtx.waitUntil.mock.calls.map(([promise]) => promise));

    expect(getChannelBindingByScopeKeyMock).toHaveBeenCalledWith(expect.anything(), 'user:user-1:telegram:12345');
    expect(env.SESSIONS.idFromName).toHaveBeenCalledWith('session-bound');
    expect(env.SESSIONS.idFromName).not.toHaveBeenCalledWith('orchestrator:user-1');
    expect(doFetch).toHaveBeenCalled();
    expect(forwardedRequests[0]?.url).toBe('https://session/prompt-resolved');
    const forwarded = forwardedRequests[0];
    await expect(forwarded.json()).resolves.toMatchObject({
      promptId: 'q-telegram',
      actionId: 'option_0',
      resolvedBy: 'user-1',
    });
  });

  it('preserves Telegram voice attachments when dispatching to the orchestrator thread', async () => {
    const app = buildApp();
    const voiceUrl = 'data:audio/ogg;base64,T2dnUw==';
    const transport = {
      verifySignature: vi.fn(() => true),
      parseInbound: vi.fn().mockResolvedValue({
        channelType: 'telegram',
        channelId: '12345',
        senderId: 'tg-owner',
        senderName: 'Conner',
        text: '[Voice note, 2s]',
        attachments: [{
          type: 'audio',
          mimeType: 'audio/ogg',
          url: voiceUrl,
          fileName: 'file_0.oga',
        }],
        messageId: '47',
      }),
      scopeKeyParts: vi.fn((message) => ({ channelType: message.channelType, channelId: message.channelId })),
      sendMessage: vi.fn(),
    };
    getTransportMock.mockReturnValue(transport);
    const env = { DB: {}, ENCRYPTION_KEY };
    const executionCtx = { waitUntil: vi.fn((promise: Promise<unknown>) => promise) };

    const res = await app.request(
      '/telegram/webhook/user-1',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', [TELEGRAM_SECRET_HEADER]: secret },
        body: JSON.stringify({
          update_id: 2,
          message: {
            message_id: 47,
            from: { id: 'tg-owner', first_name: 'Conner' },
            chat: { id: 12345, type: 'private' },
            voice: { file_id: 'voice-1', duration: 2 },
          },
        }),
      },
      env as any,
      executionCtx as any,
    );

    expect(res.status).toBe(200);
    expect(getOrCreateChannelThreadMock).toHaveBeenCalledWith(expect.anything(), {
      channelType: 'telegram',
      channelId: '12345',
      externalThreadId: '12345',
      sessionId: 'orchestrator:user-1',
      userId: 'user-1',
    });
    expect(dispatchOrchestratorPromptMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      userId: 'user-1',
      content: '[Voice note, 2s]',
      channelType: 'telegram',
      channelId: '12345',
      threadId: 'thread-telegram',
      authorName: 'Conner',
      attachments: [{
        type: 'file',
        mime: 'audio/ogg',
        url: voiceUrl,
        filename: 'file_0.oga',
      }],
      replyTo: { channelType: 'telegram', channelId: '12345' },
      scopeKey: 'user:user-1:telegram:12345',
    }));
  });

  describe('webhook authentication', () => {
    const update = JSON.stringify({ update_id: 9, message: { message_id: 1, chat: { id: 1 }, from: { id: 1 }, text: 'hi' } });

    function post(path: string, headers: Record<string, string>) {
      return buildApp().request(
        path,
        { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: update },
        { DB: {}, ENCRYPTION_KEY } as any,
      );
    }

    it('rejects a call with the wrong secret before parsing it', async () => {
      const parseInbound = vi.fn();
      getTransportMock.mockReturnValue({ parseInbound });

      const res = await post('/telegram/webhook/user-1', { [TELEGRAM_SECRET_HEADER]: 'forged' });

      expect(res.status).toBe(401);
      expect(parseInbound).not.toHaveBeenCalled();
      expect(dispatchOrchestratorPromptMock).not.toHaveBeenCalled();
    });

    it('refuses a call without a secret and re-registers the webhook with one, once', async () => {
      const parseInbound = vi.fn();
      getTransportMock.mockReturnValue({ parseInbound });
      const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ ok: true }), { status: 200 }));
      vi.stubGlobal('fetch', fetchMock);

      const first = await post('/telegram/webhook/user-legacy', {});
      const second = await post('/telegram/webhook/user-legacy', {});

      expect(first.status).toBe(401);
      expect(second.status).toBe(401);
      expect(parseInbound).not.toHaveBeenCalled();
      const setWebhookCalls = fetchMock.mock.calls.filter((call) => String(call[0]).endsWith('/setWebhook'));
      expect(setWebhookCalls).toHaveLength(1);
      const body = JSON.parse(String(setWebhookCalls[0][1]?.body));
      expect(body).toEqual({
        url: 'http://localhost/telegram/webhook/user-legacy',
        secret_token: await telegramWebhookSecret(ENCRYPTION_KEY, 'user-legacy'),
      });
    });

    it('retries the re-registration when setWebhook fails', async () => {
      getTransportMock.mockReturnValue({ parseInbound: vi.fn() });
      const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response('down', { status: 502 }));
      vi.stubGlobal('fetch', fetchMock);

      await post('/telegram/webhook/user-retry', {});
      fetchMock.mockImplementation(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
      await post('/telegram/webhook/user-retry', {});
      await post('/telegram/webhook/user-retry', {});

      const setWebhookCalls = fetchMock.mock.calls.filter((call) => String(call[0]).endsWith('/setWebhook'));
      expect(setWebhookCalls).toHaveLength(2);
    });

    it('does not accept Slack or other channels on the unsigned route', async () => {
      const res = await post('/slack/webhook/user-1', { [TELEGRAM_SECRET_HEADER]: secret });

      expect(res.status).toBe(404);
      expect(getCredentialMock).not.toHaveBeenCalled();
    });
  });
});
