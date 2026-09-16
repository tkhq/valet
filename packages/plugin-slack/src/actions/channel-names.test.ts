import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
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
    rememberChannelName('C1', 'general');

    expect(cachedChannelName('C1')).toBe('general');
    expect(await resolveChannelName('xoxb-test-token', 'C1')).toBe('general');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reads conversations.info once for an unknown channel', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { ok: true, channel: { id: 'C2', name: 'random' } }));

    expect(await resolveChannelName('xoxb-test-token', 'C2')).toBe('random');
    expect(await resolveChannelName('xoxb-test-token', 'C2')).toBe('random');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('https://slack.com/api/conversations.info');
    expect(url).toContain('channel=C2');
  });

  it('records a conversation that Slack gives no name and does not look it up again', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { ok: true, channel: { id: 'D1', is_im: true } }));

    expect(await resolveChannelName('xoxb-test-token', 'D1')).toBeUndefined();
    expect(await resolveChannelName('xoxb-test-token', 'D1')).toBeUndefined();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns undefined for a Slack error and retries the next call', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { ok: false, error: 'channel_not_found' }))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true, channel: { id: 'C3', name: 'alerts' } }));

    expect(await resolveChannelName('xoxb-test-token', 'C3')).toBeUndefined();
    expect(await resolveChannelName('xoxb-test-token', 'C3')).toBe('alerts');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('returns undefined when the request throws', async () => {
    fetchMock.mockRejectedValue(new Error('network down'));

    expect(await resolveChannelName('xoxb-test-token', 'C4')).toBeUndefined();
    expect(cachedChannelName('C4')).toBeUndefined();
  });

  it('keeps the cache bounded and drops the oldest entry', async () => {
    for (let i = 0; i < 300; i++) rememberChannelName(`C${i}`, `chan-${i}`);

    expect(cachedChannelName('C0')).toBeUndefined();
    expect(cachedChannelName('C299')).toBe('chan-299');

    fetchMock.mockResolvedValue(jsonResponse(200, { ok: true, channel: { id: 'C0', name: 'chan-0' } }));
    expect(await resolveChannelName('xoxb-test-token', 'C0')).toBe('chan-0');
  });
});
