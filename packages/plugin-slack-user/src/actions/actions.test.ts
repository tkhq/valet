import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActionContext } from '@valet/sdk';

const mocks = vi.hoisted(() => ({
  slackGet: vi.fn(),
  slackFetch: vi.fn(),
}));

vi.mock('./api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api.js')>();
  return {
    ...actual,
    slackGet: mocks.slackGet,
    slackFetch: mocks.slackFetch,
  };
});

import { slackUserActions } from './actions.js';

function slackOk(data: Record<string, unknown>): Response {
  return new Response(JSON.stringify({ ok: true, ...data }), { status: 200 });
}

function slackErr(error: string): Response {
  return new Response(JSON.stringify({ ok: false, error }), { status: 200 });
}

function ctxWithToken(): ActionContext {
  return { credentials: { access_token: 'xoxp-fake' }, userId: 'user-1' };
}

function ctxWithoutToken(): ActionContext {
  return { credentials: {}, userId: 'user-1' };
}

beforeEach(() => {
  mocks.slackGet.mockReset();
  mocks.slackFetch.mockReset();
});

// ─── Connection guard ──────────────────────────────────────────────────────

describe('connection guard', () => {
  it('returns a "Connect Slack (personal)" error when no token is present', async () => {
    const result = await slackUserActions.execute(
      'slack_user.search_messages',
      { query: 'hello' },
      ctxWithoutToken(),
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/connect slack \(personal\)/i);
    expect(mocks.slackGet).not.toHaveBeenCalled();
    expect(mocks.slackFetch).not.toHaveBeenCalled();
  });
});

// ─── search_messages ───────────────────────────────────────────────────────

describe('slack_user.search_messages', () => {
  it('calls search.messages with the user xoxp token and slims results', async () => {
    mocks.slackGet.mockResolvedValueOnce(
      slackOk({
        messages: {
          total: 2,
          matches: [
            {
              channel: { id: 'C1', name: 'general' },
              user: 'U1',
              ts: '1.1',
              text: 'hello world',
              permalink: 'https://slack/p1',
              score: 0.5,
            },
            {
              channel: { id: 'D1' },
              user: 'U2',
              ts: '2.2',
              text: 'dm match',
              permalink: 'https://slack/p2',
            },
          ],
          pagination: { next_cursor: 'cur-1' },
        },
      }),
    );

    const result = await slackUserActions.execute(
      'slack_user.search_messages',
      { query: 'hello', count: 50, sort: 'timestamp', sort_dir: 'desc' },
      ctxWithToken(),
    );

    expect(result.success).toBe(true);
    expect(mocks.slackGet).toHaveBeenCalledTimes(1);
    const [method, token, params] = mocks.slackGet.mock.calls[0];
    expect(method).toBe('search.messages');
    expect(token).toBe('xoxp-fake');
    expect(params).toMatchObject({ query: 'hello', count: 50, sort: 'timestamp', sort_dir: 'desc' });

    const data = result.data as {
      total: number;
      next_cursor: string;
      matches: Array<Record<string, unknown>>;
    };
    expect(data.total).toBe(2);
    expect(data.next_cursor).toBe('cur-1');
    expect(data.matches).toHaveLength(2);
    expect(data.matches[0]).toMatchObject({
      channel: 'C1',
      channel_name: 'general',
      user: 'U1',
      ts: '1.1',
      text: 'hello world',
      permalink: 'https://slack/p1',
      score: 0.5,
    });
    expect(data.matches[1].channel).toBe('D1');
  });

  it('surfaces a reconnect error and skips the result on token_revoked', async () => {
    mocks.slackGet.mockResolvedValueOnce(slackErr('token_revoked'));
    const result = await slackUserActions.execute(
      'slack_user.search_messages',
      { query: 'q' },
      ctxWithToken(),
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/reconnect/i);
  });

  it('surfaces a reconnect error on invalid_auth', async () => {
    mocks.slackGet.mockResolvedValueOnce(slackErr('invalid_auth'));
    const result = await slackUserActions.execute(
      'slack_user.search_messages',
      { query: 'q' },
      ctxWithToken(),
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/reconnect/i);
  });
});

// ─── read_history (operates on user's full visible surface) ──────────────

describe('slack_user.read_history', () => {
  it('uses the xoxp token against conversations.history and returns slim messages', async () => {
    mocks.slackGet.mockResolvedValueOnce(
      slackOk({
        messages: [
          { user: 'U1', ts: '1', text: 'a', reply_count: 0 },
          { user: 'U2', ts: '2', text: 'b' },
        ],
        has_more: false,
        response_metadata: {},
      }),
    );

    // A private channel ID — verifies we don't gate on private-channel
    // membership here (the xoxp token is the access gate, not Valet code).
    const result = await slackUserActions.execute(
      'slack_user.read_history',
      { channel: 'G_PRIVATE', limit: 50 },
      ctxWithToken(),
    );

    expect(result.success).toBe(true);
    expect(mocks.slackGet).toHaveBeenCalledWith(
      'conversations.history',
      'xoxp-fake',
      expect.objectContaining({ channel: 'G_PRIVATE', limit: 50 }),
    );
    const data = result.data as { messages: unknown[]; total: number };
    expect(data.total).toBe(2);
    expect(data.messages).toHaveLength(2);
  });
});

// ─── set_status ───────────────────────────────────────────────────────────

describe('slack_user.set_status', () => {
  it('POSTs users.profile.set with status_text/emoji as the user', async () => {
    mocks.slackFetch.mockResolvedValueOnce(slackOk({}));
    const result = await slackUserActions.execute(
      'slack_user.set_status',
      { status_text: 'In a meeting', status_emoji: ':spiral_calendar_pad:' },
      ctxWithToken(),
    );
    expect(result.success).toBe(true);
    expect(mocks.slackFetch).toHaveBeenCalledWith(
      'users.profile.set',
      'xoxp-fake',
      {
        profile: {
          status_text: 'In a meeting',
          status_emoji: ':spiral_calendar_pad:',
        },
      },
    );
  });

  it('passes through to users.profile.set even when emoji is omitted', async () => {
    mocks.slackFetch.mockResolvedValueOnce(slackOk({}));
    await slackUserActions.execute(
      'slack_user.set_status',
      { status_text: 'BRB' },
      ctxWithToken(),
    );
    const profile = (mocks.slackFetch.mock.calls[0][2] as { profile: Record<string, unknown> }).profile;
    expect(profile.status_text).toBe('BRB');
    expect(profile.status_emoji).toBe('');
  });
});

// ─── send_dm ──────────────────────────────────────────────────────────────

describe('slack_user.send_dm', () => {
  it('opens a DM channel and posts using the user xoxp token', async () => {
    mocks.slackFetch
      .mockResolvedValueOnce(slackOk({ channel: { id: 'D9' } }))
      .mockResolvedValueOnce(slackOk({ ts: '1.0', channel: 'D9' }));

    const result = await slackUserActions.execute(
      'slack_user.send_dm',
      { user: 'U2', text: 'hello (as me)' },
      ctxWithToken(),
    );

    expect(result.success).toBe(true);
    expect(mocks.slackFetch).toHaveBeenNthCalledWith(1, 'conversations.open', 'xoxp-fake', { users: 'U2' });
    expect(mocks.slackFetch).toHaveBeenNthCalledWith(2, 'chat.postMessage', 'xoxp-fake', {
      channel: 'D9',
      text: 'hello (as me)',
    });
    expect(result.data).toMatchObject({ ok: true, ts: '1.0', channel: 'D9' });
  });

  it('surfaces a reconnect error if the user token has been revoked', async () => {
    mocks.slackFetch.mockResolvedValueOnce(slackErr('token_revoked'));
    const result = await slackUserActions.execute(
      'slack_user.send_dm',
      { user: 'U2', text: 'hi' },
      ctxWithToken(),
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/reconnect/i);
  });
});

// ─── Action metadata — riskLevel is what drives the policy gate ──────────

describe('action surface metadata', () => {
  it('exposes slack_user.* actions only (no slack.* leakage)', () => {
    const actions = (slackUserActions.listActions() as Array<{ id: string }>) || [];
    expect(actions.length).toBeGreaterThan(0);
    for (const a of actions) expect(a.id.startsWith('slack_user.')).toBe(true);
  });

  it('marks every write/act-as action high-risk so policy can gate it', () => {
    const writeIds = [
      'slack_user.set_status',
      'slack_user.set_dnd',
      'slack_user.end_dnd',
      'slack_user.send_dm',
      'slack_user.post_message',
      'slack_user.add_reaction',
      'slack_user.upload_file',
      'slack_user.add_pin',
      'slack_user.add_bookmark',
      'slack_user.add_reminder',
    ];
    const actions = (slackUserActions.listActions() as Array<{ id: string; riskLevel: string }>) || [];
    for (const id of writeIds) {
      const a = actions.find((x) => x.id === id);
      expect(a, `missing action def: ${id}`).toBeDefined();
      expect(a!.riskLevel).toBe('high');
    }
  });

  it('marks read actions low-risk', () => {
    const readIds = [
      'slack_user.search_messages',
      'slack_user.list_channels',
      'slack_user.read_history',
      'slack_user.read_thread',
    ];
    const actions = (slackUserActions.listActions() as Array<{ id: string; riskLevel: string }>) || [];
    for (const id of readIds) {
      const a = actions.find((x) => x.id === id);
      expect(a, `missing action def: ${id}`).toBeDefined();
      expect(a!.riskLevel).toBe('low');
    }
  });
});
