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
    for (let i = 0; i < 300; i++) rememberChannelName(TOKEN, `C${i}`, `chan-${i}`);

    expect(cachedChannelName(TOKEN, 'C0')).toBeUndefined();
    expect(cachedChannelName(TOKEN, 'C299')).toBe('chan-299');

    fetchMock.mockResolvedValue(jsonResponse(200, { ok: true, channel: { id: 'C0', name: 'chan-0' } }));
    expect(await resolveChannelName(TOKEN, 'C0')).toBe('chan-0');
  });
});
