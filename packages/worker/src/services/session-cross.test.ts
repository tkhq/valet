import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getSessionMock, getCredentialMock } = vi.hoisted(() => ({
  getSessionMock: vi.fn(),
  getCredentialMock: vi.fn(),
}));

vi.mock('../lib/db.js', () => ({
  getSession: getSessionMock,
  getSessionGitState: vi.fn(),
  createSession: vi.fn(),
  createSessionGitState: vi.fn(),
  getUserById: vi.fn(),
  getSessionChannelBindings: vi.fn(),
  listUserChannelBindings: vi.fn(),
}));

vi.mock('../lib/db/sessions.js', () => ({
  getChildSessions: vi.fn(),
}));

vi.mock('./credentials.js', () => ({
  getCredential: getCredentialMock,
}));

import type { Env } from '../env.js';
import {
  DEFAULT_MESSAGE_LIMIT,
  MAX_PAGE_PAYLOAD_BYTES,
  MAX_TOOL_RESULT_CHARS,
  applyPagePayloadBudget,
  forwardMessages,
  getSessionMessages,
  getSessionStatus,
  terminateChild,
  truncateOversizedParts,
} from './session-cross.js';

/**
 * Stand-in DO binding that answers /messages with a fixed conversation, honouring the
 * limit and tail params the way the real endpoint does so page-window behaviour is
 * exercised rather than assumed.
 */
function messagesResponseEnv(messages: unknown[], captureUrl?: (url: string) => void): Env {
  return {
    SESSIONS: {
      idFromName: vi.fn((name: string) => `do:${name}`),
      get: vi.fn(() => ({
        fetch: vi.fn((req: Request) => {
          captureUrl?.(req.url);
          const params = new URL(req.url).searchParams;
          const limit = Number(params.get('limit') ?? messages.length);
          const page = params.get('tail') === '1'
            ? messages.slice(Math.max(0, messages.length - limit))
            : messages.slice(0, limit);
          return Promise.resolve(new Response(JSON.stringify({ messages: page })));
        }),
      })),
    },
  } as unknown as Env;
}

function conversation(count: number): Array<Record<string, unknown>> {
  return Array.from({ length: count }, (_, i) => ({
    id: `m-${i}`,
    role: i === count - 1 ? 'assistant' : 'user',
    content: i === count - 1 ? 'FINAL ANSWER' : `msg ${i}`,
    createdAt: new Date(Date.UTC(2026, 3, 6, 12, 0, i)).toISOString(),
  }));
}

describe('session-cross message access', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSessionMock.mockResolvedValue({
      id: 'child-1',
      userId: 'user-1',
      title: 'Child Session',
      workspace: 'repo',
    });
  });

  it('preserves full message payloads when reading another session', async () => {
    const env = {
      SESSIONS: {
        idFromName: vi.fn((name: string) => `do:${name}`),
        get: vi.fn(() => ({
          fetch: vi.fn().mockResolvedValue(
            new Response(
              JSON.stringify({
                messages: [
                  {
                    id: 'msg-1',
                    sessionId: 'child-1',
                    role: 'assistant',
                    content: "That's the complete audit.",
                    parts: [
                      { type: 'text', text: 'Full report body' },
                      { type: 'finish', reason: 'end_turn' },
                    ],
                    authorName: 'Worker',
                    channelType: 'thread',
                    channelId: 'thread-1',
                    threadId: 'thread-1',
                    createdAt: '2026-04-06T12:00:00.000Z',
                  },
                ],
              }),
            ),
          ),
        })),
      },
    } as any;

    const result = await getSessionMessages(env, {} as any, 'user-1', 'child-1');

    expect(result).toEqual({
      hasMore: false,
      messages: [
        {
          id: 'msg-1',
          sessionId: 'child-1',
          role: 'assistant',
          content: "That's the complete audit.",
          parts: [
            { type: 'text', text: 'Full report body' },
            { type: 'finish', reason: 'end_turn' },
          ],
          authorName: 'Worker',
          channelType: 'thread',
          channelId: 'thread-1',
          threadId: 'thread-1',
          createdAt: '2026-04-06T12:00:00.000Z',
        },
      ],
    });
  });

  it('preserves full message payloads when forwarding another session', async () => {
    const env = {
      SESSIONS: {
        idFromName: vi.fn((name: string) => `do:${name}`),
        get: vi.fn(() => ({
          fetch: vi.fn().mockResolvedValue(
            new Response(
              JSON.stringify({
                messages: [
                  {
                    id: 'msg-2',
                    sessionId: 'child-1',
                    role: 'assistant',
                    content: 'forward me',
                    parts: [{ type: 'text', text: 'verbatim body' }],
                    createdAt: '2026-04-06T12:01:00.000Z',
                  },
                ],
              }),
            ),
          ),
        })),
      },
    } as any;

    const result = await forwardMessages(env, {} as any, 'user-1', 'child-1');

    expect(result).toEqual({
      messages: [
        {
          id: 'msg-2',
          sessionId: 'child-1',
          role: 'assistant',
          content: 'forward me',
          parts: [{ type: 'text', text: 'verbatim body' }],
          createdAt: '2026-04-06T12:01:00.000Z',
        },
      ],
      sessionTitle: 'Child Session',
      sourceSessionId: 'child-1',
    });
  });
});

describe('getSessionMessages window selection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSessionMock.mockResolvedValue({
      id: 'child-1',
      userId: 'user-1',
      title: 'Child Session',
      workspace: 'repo',
    });
  });

  it('returns the last page of a long conversation, in chronological order', async () => {
    const env = messagesResponseEnv(conversation(120));

    const result = await getSessionMessages(env, {} as any, 'user-1', 'child-1');

    expect(result.messages).toHaveLength(DEFAULT_MESSAGE_LIMIT);
    expect(result.messages![0].id).toBe('m-70');
    expect(result.messages!.at(-1)!.id).toBe('m-119');
    // The whole point: the child's final message is reachable in a single read.
    expect(result.messages!.at(-1)!.content).toBe('FINAL ANSWER');
    expect(result.hasMore).toBe(true);
  });

  it('asks the DO for the tail window with one extra row when no cursor is given', async () => {
    let requestedUrl = '';
    const env = messagesResponseEnv([], (url) => {
      requestedUrl = url;
    });

    await getSessionMessages(env, {} as any, 'user-1', 'child-1');

    const params = new URL(requestedUrl).searchParams;
    expect(params.get('limit')).toBe(String(DEFAULT_MESSAGE_LIMIT + 1));
    expect(params.get('tail')).toBe('1');
    expect(DEFAULT_MESSAGE_LIMIT).toBe(50);
  });

  it('does not flag hasMore when the conversation exactly fills the page', async () => {
    const env = messagesResponseEnv(conversation(DEFAULT_MESSAGE_LIMIT));

    const result = await getSessionMessages(env, {} as any, 'user-1', 'child-1');

    expect(result.messages).toHaveLength(DEFAULT_MESSAGE_LIMIT);
    expect(result.hasMore).toBe(false);
  });

  it('does not flag hasMore for a partial page', async () => {
    const env = messagesResponseEnv(conversation(1));

    const result = await getSessionMessages(env, {} as any, 'user-1', 'child-1');

    expect(result.hasMore).toBe(false);
  });

  it('pages forward from the cursor instead of tailing when after is given', async () => {
    let requestedUrl = '';
    const env = messagesResponseEnv(conversation(120), (url) => {
      requestedUrl = url;
    });

    const result = await getSessionMessages(
      env,
      {} as any,
      'user-1',
      'child-1',
      10,
      '2026-04-06T12:00:00.000Z',
    );

    const params = new URL(requestedUrl).searchParams;
    expect(params.get('tail')).toBeNull();
    expect(params.get('after')).toBe('2026-04-06T12:00:00.000Z');
    expect(params.get('limit')).toBe('11');
    // Forward paging keeps taking the window from the front of what the DO returned.
    expect(result.messages).toHaveLength(10);
    expect(result.messages![0].id).toBe('m-0');
    expect(result.messages!.at(-1)!.id).toBe('m-9');
    expect(result.hasMore).toBe(true);
  });

  it('trims a page that would exceed the aggregate payload budget and flags hasMore', async () => {
    const bulky = Array.from({ length: 20 }, (_, i) => ({
      id: `m-${i}`,
      role: 'assistant',
      content: 'q'.repeat(60_000),
      createdAt: new Date(Date.UTC(2026, 3, 6, 12, 0, i)).toISOString(),
    }));
    const env = messagesResponseEnv(bulky);

    const result = await getSessionMessages(env, {} as any, 'user-1', 'child-1');

    const bytes = new TextEncoder().encode(JSON.stringify(result.messages)).length;
    expect(bytes).toBeLessThanOrEqual(MAX_PAGE_PAYLOAD_BYTES);
    expect(result.messages!.length).toBeLessThan(bulky.length);
    // Trimming drops the oldest messages, so the newest survive.
    expect(result.messages!.at(-1)!.id).toBe('m-19');
    expect(result.hasMore).toBe(true);
  });
});

describe('forwardMessages leaves the payload it persists alone', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSessionMock.mockResolvedValue({
      id: 'child-1',
      userId: 'user-1',
      title: 'Child Session',
      workspace: 'repo',
    });
  });

  it('forwards a screenshot with its base64 data intact', async () => {
    // Forwarded messages are written into the destination session's own store and
    // broadcast to its clients, so capping here would not bound a transient read — it
    // would persist a truncated screenshot in place of the real one.
    const screenshot = 'A'.repeat(MAX_TOOL_RESULT_CHARS * 3);
    const env = messagesResponseEnv([
      {
        id: 'm-img',
        role: 'assistant',
        content: 'here is the screen',
        parts: { type: 'image', mimeType: 'image/png', data: screenshot },
        createdAt: '2026-04-06T12:00:00.000Z',
      },
    ]);

    const result = await forwardMessages(env, {} as any, 'user-1', 'child-1');

    const parts = result.messages![0].parts as { data: string; mimeType: string };
    expect(parts.data).toBe(screenshot);
    expect(parts.data).not.toContain('[truncated');
    expect(parts.mimeType).toBe('image/png');
  });

  it('forwards an oversized tool result verbatim', async () => {
    const dump = 'z'.repeat(MAX_TOOL_RESULT_CHARS + 1_000);
    const env = messagesResponseEnv([
      {
        id: 'm-tool',
        role: 'assistant',
        content: 'done',
        parts: [{ type: 'tool-call', toolName: 'calendar', status: 'complete', result: dump }],
        createdAt: '2026-04-06T12:00:00.000Z',
      },
    ]);

    const result = await forwardMessages(env, {} as any, 'user-1', 'child-1');

    const parts = result.messages![0].parts as Array<{ result: string }>;
    expect(parts[0].result).toBe(dump);
  });
});

describe('getSessionStatus recent messages', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSessionMock.mockResolvedValue({
      id: 'child-1',
      userId: 'user-1',
      title: 'Child Session',
      workspace: 'repo',
      status: 'running',
    });
  });

  /** DO stand-in that answers /messages like the real endpoint and /status with runtime state. */
  function statusEnv(messages: unknown[], captureUrl?: (url: string) => void) {
    return {
      SESSIONS: {
        idFromName: vi.fn((name: string) => `do:${name}`),
        get: vi.fn(() => ({
          fetch: vi.fn((req: Request) => {
            const url = new URL(req.url);
            if (url.pathname !== '/messages') {
              return Promise.resolve(new Response(JSON.stringify({ runnerConnected: true, runnerBusy: false, queuedPrompts: 0 })));
            }
            captureUrl?.(req.url);
            const limit = Number(url.searchParams.get('limit') ?? messages.length);
            const page = url.searchParams.get('tail') === '1'
              ? messages.slice(Math.max(0, messages.length - limit))
              : messages.slice(0, limit);
            return Promise.resolve(new Response(JSON.stringify({ messages: page })));
          }),
        })),
      },
    } as unknown as Env;
  }

  it('returns the newest ten messages of a long session, not its opening ten', async () => {
    const env = statusEnv(conversation(200));

    const result = await getSessionStatus({} as any, env, 'user-1', 'child-1');

    const recent = result.sessionStatus!.recentMessages;
    expect(recent).toHaveLength(10);
    expect((recent[0] as any).id).toBe('m-190');
    // An orchestrator reads this to decide whether the child is finished.
    expect(recent.at(-1)!.content).toBe('FINAL ANSWER');
  });

  it('asks the DO for a tail window', async () => {
    let requestedUrl = '';
    const env = statusEnv(conversation(30), (url) => {
      requestedUrl = url;
    });

    await getSessionStatus({} as any, env, 'user-1', 'child-1');

    const params = new URL(requestedUrl).searchParams;
    expect(params.get('tail')).toBe('1');
    expect(params.get('limit')).toBe('10');
  });
});

describe('getSessionMessages truncation reason', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSessionMock.mockResolvedValue({ id: 'child-1', userId: 'user-1' });
  });

  it('reports a window truncation when the conversation outgrows the limit', async () => {
    const env = messagesResponseEnv(conversation(120));

    const result = await getSessionMessages(env, {} as any, 'user-1', 'child-1');

    expect(result.hasMore).toBe(true);
    expect(result.moreReason).toBe('window');
  });

  it('reports a size truncation when the page is trimmed to the payload budget', async () => {
    const bulky = Array.from({ length: 20 }, (_, i) => ({
      id: `m-${i}`,
      role: 'assistant',
      content: 'q'.repeat(60_000),
      createdAt: new Date(Date.UTC(2026, 3, 6, 12, 0, i)).toISOString(),
    }));
    const env = messagesResponseEnv(bulky);

    const result = await getSessionMessages(env, {} as any, 'user-1', 'child-1');

    // A larger limit cannot help here, so the reason has to say so.
    expect(result.hasMore).toBe(true);
    expect(result.moreReason).toBe('size');
  });

  it('reports no reason when the whole conversation fits', async () => {
    const env = messagesResponseEnv(conversation(3));

    const result = await getSessionMessages(env, {} as any, 'user-1', 'child-1');

    expect(result.hasMore).toBe(false);
    expect(result.moreReason).toBeUndefined();
  });
});

describe('applyPagePayloadBudget', () => {
  const message = (id: string, size: number) => ({ id, content: 'x'.repeat(size) });

  it('keeps a page that fits untouched', () => {
    const page = [message('a', 10), message('b', 10)];
    expect(applyPagePayloadBudget(page, 'start')).toEqual({ messages: page, dropped: 0 });
  });

  it('drops the oldest messages first for a tail window', () => {
    const page = [message('a', 500_000), message('b', 500_000)];
    const { messages, dropped } = applyPagePayloadBudget(page, 'start');
    expect(messages.map((m) => m.id)).toEqual(['b']);
    expect(dropped).toBe(1);
  });

  it('drops the newest messages first when paging forward from a cursor', () => {
    const page = [message('a', 500_000), message('b', 500_000)];
    const { messages, dropped } = applyPagePayloadBudget(page, 'end');
    expect(messages.map((m) => m.id)).toEqual(['a']);
    expect(dropped).toBe(1);
  });

  it('returns a single oversized message rather than an empty page', () => {
    const page = [message('a', MAX_PAGE_PAYLOAD_BYTES + 1_000)];
    const { messages, dropped } = applyPagePayloadBudget(page, 'start');
    expect(messages.map((m) => m.id)).toEqual(['a']);
    expect(dropped).toBe(0);
  });
});

describe('truncateOversizedParts', () => {
  it('caps a tool-call result larger than the limit and appends a marker', () => {
    const big = 'x'.repeat(MAX_TOOL_RESULT_CHARS + 500);
    const parts = [
      { type: 'text', text: 'hello' },
      { type: 'tool-call', callId: 'c1', toolName: 'calendar', status: 'complete', result: big },
    ];

    const capped = truncateOversizedParts(parts) as any[];

    expect(capped[0]).toEqual({ type: 'text', text: 'hello' });
    expect(capped[1].result).toMatch(/\[truncated 500 chars\]$/);
    expect(capped[1].result.length).toBeLessThan(big.length);
    expect(capped[1].toolName).toBe('calendar');
  });

  it('leaves a small tool-call result untouched', () => {
    const parts = [
      { type: 'tool-call', callId: 'c1', toolName: 'ls', status: 'complete', result: 'small output' },
    ];

    const capped = truncateOversizedParts(parts);

    expect(capped).toBe(parts);
  });

  it('serializes and caps a large non-string result', () => {
    const bigObj = { data: 'y'.repeat(MAX_TOOL_RESULT_CHARS + 10) };
    const parts = [
      { type: 'tool-call', callId: 'c1', toolName: 'fetch', status: 'complete', result: bigObj },
    ];

    const capped = truncateOversizedParts(parts) as any[];

    expect(typeof capped[0].result).toBe('string');
    expect(capped[0].result).toContain('[truncated');
  });

  it('preserves assistant text parts and empty inputs', () => {
    expect(truncateOversizedParts(undefined)).toBeUndefined();
    expect(truncateOversizedParts(null)).toBeNull();
    const textOnly = [{ type: 'text', text: 'the final answer' }];
    expect(truncateOversizedParts(textOnly)).toBe(textOnly);
  });

  it('caps an image message whose parts are a single object rather than an array', () => {
    const parts = {
      type: 'image',
      mimeType: 'image/png',
      data: 'A'.repeat(MAX_TOOL_RESULT_CHARS + 2_000),
    };

    const capped = truncateOversizedParts(parts) as Record<string, string>;

    expect(Array.isArray(capped)).toBe(false);
    expect(capped.type).toBe('image');
    expect(capped.mimeType).toBe('image/png');
    expect(capped.data).toContain('[truncated 2000 chars]');
    expect(capped.data.length).toBeLessThan(parts.data.length);
  });

  it('leaves a small non-array part untouched', () => {
    const parts = { type: 'image', mimeType: 'image/png', data: 'AAAA' };
    expect(truncateOversizedParts(parts)).toBe(parts);
  });

  it('caps an oversized text part, not just tool results', () => {
    const parts = [{ type: 'text', text: 'T'.repeat(MAX_TOOL_RESULT_CHARS + 5) }];

    const capped = truncateOversizedParts(parts) as Array<Record<string, string>>;

    expect(capped[0].text).toContain('[truncated 5 chars]');
  });
});

describe('getSessionMessages truncates oversized tool results end to end', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSessionMock.mockResolvedValue({ id: 'child-1', userId: 'user-1' });
  });

  it('caps an oversized tool result in the returned messages', async () => {
    const big = 'z'.repeat(MAX_TOOL_RESULT_CHARS + 1000);
    const env = messagesResponseEnv([
      {
        id: 'm-1',
        role: 'assistant',
        content: 'done',
        parts: [
          { type: 'text', text: 'here is the report' },
          { type: 'tool-call', callId: 'c1', toolName: 'calendar', status: 'complete', result: big },
        ],
        createdAt: '2026-04-06T12:00:00.000Z',
      },
    ]);

    const result = await getSessionMessages(env, {} as any, 'user-1', 'child-1');
    const parts = (result.messages![0].parts as any[]);

    expect(parts[0]).toEqual({ type: 'text', text: 'here is the report' });
    expect(parts[1].result).toContain('[truncated');
    expect(parts[1].result.length).toBeLessThan(big.length);
  });
});

describe('terminateChild', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSessionMock.mockResolvedValue({
      id: 'child-1',
      userId: 'user-1',
      parentSessionId: 'orch-1',
    });
  });

  it('sends reason terminated_by_parent to the child DO', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: true })));
    const env = {
      SESSIONS: {
        idFromName: vi.fn(() => 'do-id'),
        get: vi.fn(() => ({ fetch: fetchMock })),
      },
    } as any;

    await terminateChild({} as any, env, 'orch-1', 'user-1', 'child-1');

    const call = fetchMock.mock.calls[0][0] as Request;
    const body = await call.json() as { reason: string };
    expect(body.reason).toBe('terminated_by_parent');
  });
});
