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

import {
  DEFAULT_MESSAGE_LIMIT,
  MAX_TOOL_RESULT_CHARS,
  forwardMessages,
  getSessionMessages,
  terminateChild,
  truncateOversizedParts,
} from './session-cross.js';

function messagesResponseEnv(messages: unknown[], captureUrl?: (url: string) => void) {
  return {
    SESSIONS: {
      idFromName: vi.fn((name: string) => `do:${name}`),
      get: vi.fn(() => ({
        fetch: vi.fn((req: Request) => {
          captureUrl?.(req.url);
          return Promise.resolve(new Response(JSON.stringify({ messages })));
        }),
      })),
    },
  } as any;
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

describe('getSessionMessages default limit and hasMore hint', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSessionMock.mockResolvedValue({
      id: 'child-1',
      userId: 'user-1',
      title: 'Child Session',
      workspace: 'repo',
    });
  });

  it('requests the DO with the default limit of 50 when none is given', async () => {
    let requestedUrl = '';
    const env = messagesResponseEnv([], (url) => {
      requestedUrl = url;
    });

    await getSessionMessages(env, {} as any, 'user-1', 'child-1');

    expect(new URL(requestedUrl).searchParams.get('limit')).toBe(String(DEFAULT_MESSAGE_LIMIT));
    expect(DEFAULT_MESSAGE_LIMIT).toBe(50);
  });

  it('flags hasMore when the returned page fills the limit', async () => {
    const full = Array.from({ length: DEFAULT_MESSAGE_LIMIT }, (_, i) => ({
      id: `m-${i}`,
      role: 'assistant',
      content: `msg ${i}`,
      createdAt: '2026-04-06T12:00:00.000Z',
    }));
    const env = messagesResponseEnv(full);

    const result = await getSessionMessages(env, {} as any, 'user-1', 'child-1');

    expect(result.hasMore).toBe(true);
  });

  it('does not flag hasMore for a partial page', async () => {
    const env = messagesResponseEnv([
      { id: 'm-1', role: 'assistant', content: 'only one', createdAt: '2026-04-06T12:00:00.000Z' },
    ]);

    const result = await getSessionMessages(env, {} as any, 'user-1', 'child-1');

    expect(result.hasMore).toBe(false);
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

  it('preserves assistant text parts and non-array inputs', () => {
    expect(truncateOversizedParts(undefined)).toBeUndefined();
    const textOnly = [{ type: 'text', text: 'the final answer' }];
    expect(truncateOversizedParts(textOnly)).toBe(textOnly);
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
