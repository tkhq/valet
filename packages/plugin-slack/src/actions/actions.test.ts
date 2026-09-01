import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type {
  Credential,
  CredentialProvider,
  DecisionGateRequest,
  DecisionResolution,
  MessageQuery,
  Sandbox,
  SessionEntry,
  ToolContext,
} from '@valet/engine';
import { slackPlugin } from './actions.js';

type FakeSandbox = Partial<Sandbox> & { id: string };

function makeCredentials(cred: Credential | null): CredentialProvider {
  return {
    get: async (): Promise<Credential | null> => cred,
    request: async (): Promise<Credential> => {
      throw new Error('not implemented in test stub');
    },
  };
}

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  const sandbox: FakeSandbox = { id: 'sb-1' };
  return {
    userId: 'u1',
    orgId: 'o1',
    sessionId: 's1',
    threadId: 't1',
    credentials: makeCredentials({ accessToken: 'xoxb-test-token' }),
    sandbox: sandbox as Sandbox,
    requestDecision: async (_gate: DecisionGateRequest): Promise<DecisionResolution> => {
      throw new Error('not implemented in test stub');
    },
    signal: new AbortController().signal,
    threadRead: async (_key: string, _opts?: MessageQuery): Promise<SessionEntry[]> => [],
    listThreads: async () => [],
    setModel: async ({ model }: { model: string }) => ({ fromModel: model, toModel: model }),
    ...overrides,
  };
}

function pluginCtx(overrides: Partial<ToolContext> = {}) {
  return { ...makeCtx(overrides), actionId: '', service: 'slack' };
}

function action(id: string) {
  const found = slackPlugin.actions.find((a) => a.id === id);
  if (!found) throw new Error(`action not found: ${id}`);
  return found;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Every guarded action calls checkPrivateChannelAccess first, which issues its own
 *  conversations.info request. Queue a public-channel response so the guard passes
 *  before the action's own fetch mocks are consumed. */
function mockGuardAllowsPublicChannel(fetchMock: ReturnType<typeof vi.fn>): void {
  fetchMock.mockResolvedValueOnce(
    jsonResponse(200, { ok: true, channel: { id: 'C1', is_private: false, is_im: false, is_mpim: false } }),
  );
}

describe('slack actions', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('dm_owner opens a DM with the owner and posts the message', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { ok: true, channel: { id: 'D1' } }))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true, ts: '123.456', channel: 'D1' }));

    const result = await action('slack.dm_owner').execute(
      { text: 'hello owner' },
      pluginCtx({
        credentials: makeCredentials({
          accessToken: 'xoxb-test-token',
          metadata: { owner_slack_user_id: 'U999' },
        }),
      }),
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [openUrl, openInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(openUrl).toBe('https://slack.com/api/conversations.open');
    expect(openInit.method).toBe('POST');
    expect((openInit.headers as Record<string, string>).Authorization).toBe('Bearer xoxb-test-token');
    expect(JSON.parse(openInit.body as string)).toEqual({ users: 'U999' });

    const [postUrl, postInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(postUrl).toBe('https://slack.com/api/chat.postMessage');
    expect(JSON.parse(postInit.body as string)).toEqual({ channel: 'D1', text: 'hello owner' });

    expect(result).toEqual({ success: true, data: { ts: '123.456', channel: 'D1' } });
  });

  it('dm_owner errors when the owner has not linked their Slack identity (metadata absent)', async () => {
    const result = await action('slack.dm_owner').execute(
      { text: 'hello owner' },
      pluginCtx({ credentials: makeCredentials({ accessToken: 'xoxb-test-token' }) }),
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toEqual({
      success: false,
      error: 'Owner has not linked their Slack identity. Ask them to link it in Settings > Integrations > Slack.',
    });
  });

  it('dm_user opens a DM with the given user id and posts the message, using actor name as username', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { ok: true, channel: { id: 'D2' } }))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true, ts: '111.222', channel: 'D2' }));

    const result = await action('slack.dm_user').execute(
      { user: 'U123', text: 'hi there' },
      pluginCtx({ actor: { id: 'u1', name: 'Ada' } }),
    );

    const [, postInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(JSON.parse(postInit.body as string)).toEqual({ channel: 'D2', text: 'hi there', username: 'Ada' });
    expect(result).toEqual({ success: true, data: { ts: '111.222', channel: 'D2' } });
  });

  it('add_reaction posts reactions.add with channel/timestamp/name', async () => {
    mockGuardAllowsPublicChannel(fetchMock);
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { ok: true }));

    const result = await action('slack.add_reaction').execute(
      { channel: 'C1', timestamp: '123.456', name: 'thumbsup' },
      pluginCtx(),
    );

    const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(url).toBe('https://slack.com/api/reactions.add');
    expect(JSON.parse(init.body as string)).toEqual({ channel: 'C1', timestamp: '123.456', name: 'thumbsup' });
    expect(result).toEqual({ success: true, data: { channel: 'C1', timestamp: '123.456', name: 'thumbsup' } });
  });

  it('add_reaction is denied for a private channel the owner cannot access', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { ok: true, channel: { id: 'C1', is_private: true, is_im: false, is_mpim: false } }),
    );

    const result = await action('slack.add_reaction').execute(
      { channel: 'C1', timestamp: '123.456', name: 'thumbsup' },
      pluginCtx({ credentials: makeCredentials({ accessToken: 'xoxb-test-token' }) }),
    );

    expect(result).toEqual({
      success: false,
      error: 'Owner has not linked their Slack identity. Link it in Settings > Integrations > Slack.',
    });
  });

  it('reply_to_origin posts chat.postMessage into the origin thread, no ids from the model', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { ok: true, ts: '9.9' }));
    const result = await action('slack.reply_to_origin').execute(
      { text: 'here is the answer' },
      pluginCtx({ origin: { channelType: 'slack', threadKey: 'slack:C1:1.2', reply: 'manual', messageTs: '1.5' } }),
    );
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://slack.com/api/chat.postMessage');
    expect(JSON.parse(init.body as string)).toEqual({ channel: 'C1', thread_ts: '1.2', text: 'here is the answer' });
    expect(result).toEqual({ success: true, data: { channel: 'C1', ts: '9.9' } });
  });

  it('reply_to_origin errors with no channel origin, without calling Slack', async () => {
    const result = await action('slack.reply_to_origin').execute({ text: 'x' }, pluginCtx());
    expect(result).toMatchObject({ success: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reply_to_origin posts on an addressed turn too (follow-ups after the first auto-posted message)', async () => {
    // Only a turn's first message auto-posts; the action is the sanctioned
    // path for anything after it, so an addressed origin must not refuse.
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { ok: true, ts: '9.10' }));
    const result = await action('slack.reply_to_origin').execute(
      { text: 'follow-up' },
      pluginCtx({ origin: { channelType: 'slack', threadKey: 'slack:C1:1.2', reply: 'auto', messageTs: '1.5' } }),
    );
    expect(result).toEqual({ success: true, data: { channel: 'C1', ts: '9.10' } });
  });

  it('react_to_origin adds a reaction to the origin message', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    const result = await action('slack.react_to_origin').execute(
      { emoji: 'eyes' },
      pluginCtx({ origin: { channelType: 'slack', threadKey: 'slack:C1:1.2', reply: 'manual', messageTs: '1.5' } }),
    );
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://slack.com/api/reactions.add');
    expect(JSON.parse(init.body as string)).toEqual({ channel: 'C1', timestamp: '1.5', name: 'eyes' });
    expect(result).toEqual({ success: true, data: { channel: 'C1', timestamp: '1.5', name: 'eyes' } });
  });

  it('react_to_origin errors when the origin has no message ts', async () => {
    const result = await action('slack.react_to_origin').execute(
      { emoji: 'eyes' },
      pluginCtx({ origin: { channelType: 'slack', threadKey: 'slack:C1:1.2', reply: 'manual' } }),
    );
    expect(result).toMatchObject({ success: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('list_channels fetches joined channels via users.conversations (GET, paginated)', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        ok: true,
        channels: [{ id: 'C1', name: 'general', is_private: false }],
        response_metadata: {},
      }),
    );

    const result = await action('slack.list_channels').execute({}, pluginCtx());

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('https://slack.com/api/users.conversations');
    expect(url).toContain('types=public_channel,private_channel');
    expect(init.method).toBe('GET');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer xoxb-test-token');
    expect(result).toEqual({
      success: true,
      data: { channels: [{ id: 'C1', name: 'general', is_private: false, num_members: undefined, topic: undefined, purpose: undefined }], total: 1 },
    });
  });

  it('read_history reads channel history and filters noise subtypes by default', async () => {
    mockGuardAllowsPublicChannel(fetchMock);
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        ok: true,
        messages: [
          { user: 'U1', text: 'hello', ts: '1.1' },
          { subtype: 'channel_join', text: 'joined', ts: '1.2' },
        ],
        has_more: false,
      }),
    );

    const result = await action('slack.read_history').execute({ channel: 'C1' }, pluginCtx());

    const [url] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(url).toContain('https://slack.com/api/conversations.history');
    expect(url).toContain('channel=C1');
    expect(url).toContain('limit=100');
    expect(result).toMatchObject({
      success: true,
      data: { has_more: false, total: 1 },
    });
  });

  it('read_thread reads replies for a thread_ts', async () => {
    mockGuardAllowsPublicChannel(fetchMock);
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { ok: true, messages: [{ user: 'U1', text: 'reply', ts: '1.2' }], has_more: false }),
    );

    const result = await action('slack.read_thread').execute({ channel: 'C1', thread_ts: '1.1' }, pluginCtx());

    const [url] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(url).toContain('https://slack.com/api/conversations.replies');
    expect(url).toContain('ts=1.1');
    expect(result).toMatchObject({ success: true, data: { has_more: false, total: 1 } });
  });

  it('list_users lists non-bot, non-deleted members', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        ok: true,
        members: [
          { id: 'U1', name: 'ada', is_bot: false, deleted: false, profile: { real_name: 'Ada Lovelace' } },
          { id: 'B1', name: 'bot', is_bot: true, deleted: false },
        ],
      }),
    );

    const result = await action('slack.list_users').execute({}, pluginCtx());

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('https://slack.com/api/users.list');
    expect(init.method).toBe('GET');
    expect(result).toEqual({
      success: true,
      data: {
        members: [{ id: 'U1', name: 'ada', real_name: 'Ada Lovelace', display_name: undefined, email: undefined }],
      },
    });
  });

  it('fetch_file returns text content for a text file from files.slack.com', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('hello world', { status: 200, headers: { 'Content-Type': 'text/plain' } }),
    );

    const result = await action('slack.fetch_file').execute(
      { url: 'https://files.slack.com/files-pri/T1-F1/note.txt' },
      pluginCtx(),
    );

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://files.slack.com/files-pri/T1-F1/note.txt');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer xoxb-test-token');
    expect(result).toEqual({ success: true, data: { content: 'hello world', mimetype: 'text/plain' } });
  });

  it('fetch_file rejects non-slack URLs without calling fetch', async () => {
    const result = await action('slack.fetch_file').execute(
      { url: 'https://example.com/file.png' },
      pluginCtx(),
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toEqual({
      success: false,
      error: 'This is an external file (e.g. Google Docs). Open the URL directly — it cannot be fetched through Slack. Only files hosted on Slack (files.slack.com) can be downloaded.',
    });
  });

  it('fetch_file returns an image attachment for small images', async () => {
    const bytes = new Uint8Array([137, 80, 78, 71]);
    fetchMock.mockResolvedValueOnce(
      new Response(bytes, { status: 200, headers: { 'Content-Type': 'image/png' } }),
    );

    const result = await action('slack.fetch_file').execute(
      { url: 'https://files.slack.com/files-pri/T1-F1/pic.png' },
      pluginCtx(),
    );

    expect(result.success).toBe(true);
    expect(result.attachments).toEqual([
      { type: 'image', data: bytes, mimeType: 'image/png', name: 'pic.png' },
    ]);
  });

  it('get_pins fetches pinned messages and files', async () => {
    mockGuardAllowsPublicChannel(fetchMock);
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        ok: true,
        items: [
          { type: 'message', message: { user: 'U1', text: 'pinned', ts: '1.1' } },
          { type: 'file', file: { name: 'doc.pdf', mimetype: 'application/pdf', size: 100, url_private: 'https://files.slack.com/x' } },
        ],
      }),
    );

    const result = await action('slack.get_pins').execute({ channel: 'C1' }, pluginCtx());

    const [url] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(url).toContain('https://slack.com/api/pins.list');
    expect(result).toMatchObject({ success: true, data: { total: 2 } });
  });

  it('get_channel_info returns topic/purpose/creator for a normal channel', async () => {
    mockGuardAllowsPublicChannel(fetchMock);
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(200, {
          ok: true,
          channel: {
            id: 'C1',
            name: 'general',
            is_private: false,
            is_archived: false,
            topic: { value: 'General chat' },
            purpose: { value: 'Everything' },
            num_members: 5,
            created: 1000,
            creator: 'U1',
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, { ok: true, user: { id: 'U1', name: 'ada', profile: { real_name: 'Ada Lovelace' } } }),
      );

    const result = await action('slack.get_channel_info').execute({ channel: 'C1' }, pluginCtx());

    expect(result).toEqual({
      success: true,
      data: {
        id: 'C1',
        name: 'general',
        is_private: false,
        is_archived: false,
        topic: 'General chat',
        purpose: 'Everything',
        num_members: 5,
        created: 1000,
        creator: '@ada <Ada Lovelace> (U1)',
      },
    });
  });

  it('get_reactions returns reactions with resolved user displays', async () => {
    // U9 (not U1) — the module-level user cache is shared across tests in this
    // file, and U1 is already cached by the get_channel_info test above.
    mockGuardAllowsPublicChannel(fetchMock);
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(200, {
          ok: true,
          message: { reactions: [{ name: 'thumbsup', count: 1, users: ['U9'] }] },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, { ok: true, user: { id: 'U9', name: 'bob', profile: {} } }),
      );

    const result = await action('slack.get_reactions').execute({ channel: 'C1', timestamp: '1.1' }, pluginCtx());

    expect(result).toEqual({
      success: true,
      data: { reactions: [{ name: 'thumbsup', count: 1, users: ['@bob (U9)'] }] },
    });
  });

  it('maps a non-ok Slack envelope to a Slack API error', async () => {
    mockGuardAllowsPublicChannel(fetchMock);
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { ok: false, error: 'channel_not_found' }));

    const result = await action('slack.add_reaction').execute(
      { channel: 'C1', timestamp: '1.1', name: 'thumbsup' },
      pluginCtx(),
    );

    expect(result).toEqual({ success: false, error: 'Slack API error: channel_not_found' });
  });

  it('maps a non-200 HTTP response to a Slack API status error', async () => {
    mockGuardAllowsPublicChannel(fetchMock);
    fetchMock.mockResolvedValueOnce(new Response('', { status: 500, statusText: 'Internal Server Error' }));

    const result = await action('slack.add_reaction').execute(
      { channel: 'C1', timestamp: '1.1', name: 'thumbsup' },
      pluginCtx(),
    );

    expect(result).toEqual({ success: false, error: 'Slack API 500: Internal Server Error' });
  });

  it('returns "Missing bot_token" without calling fetch when no credential is stored', async () => {
    const result = await action('slack.list_users').execute(
      {},
      pluginCtx({ credentials: makeCredentials(null) }),
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toEqual({ success: false, error: 'Missing bot_token' });
  });

  it('send_message posts a message to a channel by ID with guard check', async () => {
    mockGuardAllowsPublicChannel(fetchMock);
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { ok: true, ts: '123.456', channel: 'C1' }));

    const result = await action('slack.send_message').execute(
      { channel: 'C1', text: 'hello channel' },
      pluginCtx(),
    );

    const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(url).toBe('https://slack.com/api/chat.postMessage');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer xoxb-test-token');
    expect(JSON.parse(init.body as string)).toEqual({ channel: 'C1', text: 'hello channel' });
    expect(result).toEqual({ success: true, data: { ts: '123.456', channel: 'C1' } });
  });

  it('send_message resolves channel name (#prefix) to channel ID via users.conversations', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(200, {
          ok: true,
          channels: [{ id: 'C1', name: 'proj-valet' }],
          response_metadata: {},
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, { ok: true, channel: { id: 'C1', is_private: false, is_im: false, is_mpim: false } }),
      )
      .mockResolvedValueOnce(jsonResponse(200, { ok: true, ts: '123.456', channel: 'C1' }));

    const result = await action('slack.send_message').execute(
      { channel: '#proj-valet', text: 'hello' },
      pluginCtx(),
    );

    expect(result).toEqual({ success: true, data: { ts: '123.456', channel: 'C1' } });
  });

  it('send_message returns error when channel name not found', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        ok: true,
        channels: [{ id: 'C1', name: 'general' }],
        response_metadata: {},
      }),
    );

    const result = await action('slack.send_message').execute(
      { channel: '#not-found', text: 'hello' },
      pluginCtx(),
    );

    expect(result).toEqual({
      success: false,
      error: 'Channel "#not-found" not found or bot is not a member. Use list_channels to find available channels.',
    });
  });

  it('send_message supports optional thread_ts for threaded replies', async () => {
    mockGuardAllowsPublicChannel(fetchMock);
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { ok: true, ts: '124.567', channel: 'C1' }));

    const result = await action('slack.send_message').execute(
      { channel: 'C1', text: 'reply in thread', thread_ts: '123.456' },
      pluginCtx(),
    );

    const [, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ channel: 'C1', text: 'reply in thread', thread_ts: '123.456' });
    expect(result).toEqual({ success: true, data: { ts: '124.567', channel: 'C1' } });
  });

  it('send_message supports optional blocks for rich formatting', async () => {
    mockGuardAllowsPublicChannel(fetchMock);
    const blocks = JSON.stringify([{ type: 'section', text: { type: 'mrkdwn', text: '*bold*' } }]);
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { ok: true, ts: '125.678', channel: 'C1' }));

    const result = await action('slack.send_message').execute(
      { channel: 'C1', text: 'with blocks', blocks },
      pluginCtx(),
    );

    const [, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.blocks).toEqual(JSON.parse(blocks));
    expect(result).toEqual({ success: true, data: { ts: '125.678', channel: 'C1' } });
  });

  it('send_message uses actor name as username when provided', async () => {
    mockGuardAllowsPublicChannel(fetchMock);
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { ok: true, ts: '126.789', channel: 'C1' }));

    const result = await action('slack.send_message').execute(
      { channel: 'C1', text: 'from actor' },
      pluginCtx({ actor: { id: 'u1', name: 'Alice' } }),
    );

    const [, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toMatchObject({ username: 'Alice' });
    expect(result).toEqual({ success: true, data: { ts: '126.789', channel: 'C1' } });
  });

  it('send_message adds attribution context block for non-DM channels when owner is linked', async () => {
    mockGuardAllowsPublicChannel(fetchMock);
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { ok: true, ts: '127.890', channel: 'C1' }));

    const result = await action('slack.send_message').execute(
      { channel: 'C1', text: 'with attribution' },
      pluginCtx({
        credentials: makeCredentials({
          accessToken: 'xoxb-test-token',
          metadata: { owner_slack_user_id: 'U999' },
        }),
      }),
    );

    const [, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.blocks).toBeDefined();
    expect(body.blocks[body.blocks.length - 1]).toEqual({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: '↳ <@U999>' }],
    });
    expect(result.success).toBe(true);
  });

  it('send_message does not add attribution block for DM channels', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { ok: true, channel: { id: 'D1', is_private: false, is_im: true, is_mpim: false } }))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true, ts: '128.901', channel: 'D1' }));

    const result = await action('slack.send_message').execute(
      { channel: 'D1', text: 'dm message' },
      pluginCtx({
        credentials: makeCredentials({
          accessToken: 'xoxb-test-token',
          metadata: { owner_slack_user_id: 'U999' },
        }),
      }),
    );

    const [, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    // For DMs, blocks should NOT include attribution
    if (body.blocks) {
      const lastBlock = body.blocks[body.blocks.length - 1];
      expect(lastBlock.type).not.toBe('context');
    }
    expect(result.success).toBe(true);
  });

  it('send_message supports unfurl_links parameter', async () => {
    mockGuardAllowsPublicChannel(fetchMock);
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { ok: true, ts: '129.012', channel: 'C1' }));

    const result = await action('slack.send_message').execute(
      { channel: 'C1', text: 'no unfurls', unfurl_links: false },
      pluginCtx(),
    );

    const [, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toMatchObject({ unfurl_links: false });
    expect(result.success).toBe(true);
  });

  it('send_message supports unfurl_media parameter', async () => {
    mockGuardAllowsPublicChannel(fetchMock);
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { ok: true, ts: '130.123', channel: 'C1' }));

    const result = await action('slack.send_message').execute(
      { channel: 'C1', text: 'no media', unfurl_media: false },
      pluginCtx(),
    );

    const [, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toMatchObject({ unfurl_media: false });
    expect(result.success).toBe(true);
  });

  it('send_message rejects invalid blocks JSON', async () => {
    mockGuardAllowsPublicChannel(fetchMock);

    const result = await action('slack.send_message').execute(
      { channel: 'C1', text: 'invalid', blocks: '{invalid json}' },
      pluginCtx(),
    );

    expect(result).toEqual({
      success: false,
      error: 'blocks must be valid JSON array, e.g. [{"type":"section","text":{"type":"mrkdwn","text":"*bold*"}}]',
    });
  });

  it('send_message rejects blocks that are not a JSON array', async () => {
    mockGuardAllowsPublicChannel(fetchMock);

    const result = await action('slack.send_message').execute(
      { channel: 'C1', text: 'invalid', blocks: '{"type": "section"}' },
      pluginCtx(),
    );

    expect(result).toEqual({ success: false, error: 'blocks must be a JSON array' });
  });

  it('send_message uses buildContentBlocks for long text messages', async () => {
    mockGuardAllowsPublicChannel(fetchMock);
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { ok: true, ts: '131.234', channel: 'C1' }));

    const longText = 'a'.repeat(5000); // Longer than SLACK_TEXT_LIMIT (4000)
    const result = await action('slack.send_message').execute(
      { channel: 'C1', text: longText },
      pluginCtx(),
    );

    const [, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.blocks).toBeDefined();
    expect(Array.isArray(body.blocks)).toBe(true);
    expect(result.success).toBe(true);
  });

  it('send_message returns Slack API error passthrough (not_in_channel)', async () => {
    mockGuardAllowsPublicChannel(fetchMock);
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { ok: false, error: 'not_in_channel' }));

    const result = await action('slack.send_message').execute(
      { channel: 'C1', text: 'hello' },
      pluginCtx(),
    );

    expect(result).toEqual({ success: false, error: 'Slack API error: not_in_channel' });
  });

  it('send_message returns Slack API error passthrough (channel_not_found)', async () => {
    mockGuardAllowsPublicChannel(fetchMock);
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { ok: false, error: 'channel_not_found' }));

    const result = await action('slack.send_message').execute(
      { channel: 'C999', text: 'hello' },
      pluginCtx(),
    );

    expect(result).toEqual({ success: false, error: 'Slack API error: channel_not_found' });
  });
});
