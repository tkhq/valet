import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  CHANNEL_NAME_MAX_AGE_MS,
  cachedChannelName,
  clearChannelNameCache,
  rememberChannelName,
  resolveChannelName,
} from './channel-names.js';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const TOKEN = 'xoxb-test-token';
const OTHER_TOKEN = 'xoxb-other-workspace';

describe('channel name cache', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    clearChannelNameCache();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('answers a remembered name without a request', async () => {
    rememberChannelName(TOKEN, 'C1', 'general');

    expect(cachedChannelName(TOKEN, 'C1')).toBe('general');
    expect(await resolveChannelName(TOKEN, 'C1')).toBe('general');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reads conversations.info once for an unknown channel', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { ok: true, channel: { id: 'C2', name: 'random' } }));

    expect(await resolveChannelName(TOKEN, 'C2')).toBe('random');
    expect(await resolveChannelName(TOKEN, 'C2')).toBe('random');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('https://slack.com/api/conversations.info');
    expect(url).toContain('channel=C2');
  });

  it('records a conversation that Slack gives no name and does not look it up again', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { ok: true, channel: { id: 'D1', is_im: true } }));

    expect(await resolveChannelName(TOKEN, 'D1')).toBeUndefined();
    expect(await resolveChannelName(TOKEN, 'D1')).toBeUndefined();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns undefined for a Slack error and retries the next call', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { ok: false, error: 'channel_not_found' }))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true, channel: { id: 'C3', name: 'alerts' } }));

    expect(await resolveChannelName(TOKEN, 'C3')).toBeUndefined();
    expect(await resolveChannelName(TOKEN, 'C3')).toBe('alerts');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('returns undefined when the request throws', async () => {
    fetchMock.mockRejectedValue(new Error('network down'));

    expect(await resolveChannelName(TOKEN, 'C4')).toBeUndefined();
    expect(cachedChannelName(TOKEN, 'C4')).toBeUndefined();
  });

  it('keeps a name for one credential away from another credential', async () => {
    rememberChannelName(TOKEN, 'C1', 'acme-mna');

    expect(cachedChannelName(OTHER_TOKEN, 'C1')).toBeUndefined();

    // The second credential asks Slack for itself, and its answer does not
    // change what the first credential sees.
    fetchMock.mockResolvedValue(jsonResponse(200, { ok: false, error: 'channel_not_found' }));
    expect(await resolveChannelName(OTHER_TOKEN, 'C1')).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(cachedChannelName(TOKEN, 'C1')).toBe('acme-mna');
  });

  it('keeps the cache bounded and drops the oldest entry', async () => {
    for (let i = 0; i < 1100; i++) rememberChannelName(TOKEN, `C${i}`, `chan-${i}`);

    expect(cachedChannelName(TOKEN, 'C0')).toBeUndefined();
    expect(cachedChannelName(TOKEN, 'C1099')).toBe('chan-1099');

    fetchMock.mockResolvedValue(jsonResponse(200, { ok: true, channel: { id: 'C0', name: 'chan-0' } }));
    expect(await resolveChannelName(TOKEN, 'C0')).toBe('chan-0');
  });

  it('reads Slack again once an entry is older than the max age, so a rename shows', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      fetchMock
        .mockResolvedValueOnce(jsonResponse(200, { ok: true, channel: { id: 'C5', name: 'alerts-old' } }))
        .mockResolvedValueOnce(jsonResponse(200, { ok: true, channel: { id: 'C5', name: 'alerts-new' } }));

      expect(await resolveChannelName(TOKEN, 'C5')).toBe('alerts-old');
      vi.setSystemTime(Date.now() + CHANNEL_NAME_MAX_AGE_MS - 1);
      expect(await resolveChannelName(TOKEN, 'C5')).toBe('alerts-old');
      expect(fetchMock).toHaveBeenCalledTimes(1);

      vi.setSystemTime(Date.now() + 1);
      expect(cachedChannelName(TOKEN, 'C5')).toBeUndefined();
      expect(await resolveChannelName(TOKEN, 'C5')).toBe('alerts-new');
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('replaces a cached name at once when a rename is recorded', async () => {
    rememberChannelName(TOKEN, 'C6', 'alerts-prod');
    rememberChannelName(TOKEN, 'C6', 'archive-prod');

    expect(await resolveChannelName(TOKEN, 'C6')).toBe('archive-prod');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends one request with no retry when the caller sets a timeout', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 429, headers: { 'Retry-After': '30' } }));

    expect(await resolveChannelName(TOKEN, 'C7', { timeoutMs: 1_000 })).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('shares one lookup between reads that arrive together', async () => {
    let answer: (res: Response) => void = () => {};
    fetchMock.mockReturnValue(new Promise<Response>((resolve) => { answer = resolve; }));

    const first = resolveChannelName(TOKEN, 'C8', { timeoutMs: 1_000 });
    const second = resolveChannelName(TOKEN, 'C8', { timeoutMs: 1_000 });
    answer(jsonResponse(200, { ok: true, channel: { id: 'C8', name: 'alerts-eu' } }));

    expect(await Promise.all([first, second])).toEqual(['alerts-eu', 'alerts-eu']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not make a read with a timeout wait on a lookup that retries', async () => {
    let answerUntimed: (res: Response) => void = () => {};
    fetchMock
      .mockReturnValueOnce(new Promise<Response>((resolve) => { answerUntimed = resolve; }))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true, channel: { id: 'C9', name: 'alerts-us' } }));

    const untimed = resolveChannelName(TOKEN, 'C9');
    expect(await resolveChannelName(TOKEN, 'C9', { timeoutMs: 1_000 })).toBe('alerts-us');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [, timedInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(timedInit.signal).toBeInstanceOf(AbortSignal);

    answerUntimed(jsonResponse(200, { ok: true, channel: { id: 'C9', name: 'alerts-us' } }));
    expect(await untimed).toBe('alerts-us');
  });

  it('keeps a rename that arrives while a lookup waits', async () => {
    let answer: (res: Response) => void = () => {};
    fetchMock.mockReturnValue(new Promise<Response>((resolve) => { answer = resolve; }));

    const lookup = resolveChannelName(TOKEN, 'C10', { timeoutMs: 1_000 });
    rememberChannelName(TOKEN, 'C10', 'archive-prod');
    answer(jsonResponse(200, { ok: true, channel: { id: 'C10', name: 'alerts-prod' } }));

    expect(await lookup).toBe('archive-prod');
    expect(cachedChannelName(TOKEN, 'C10')).toBe('archive-prod');
  });
});
