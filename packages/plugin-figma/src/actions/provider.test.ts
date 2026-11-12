import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { figmaProvider } from './provider.js';

const fetchMock = vi.fn<typeof fetch>();
const oauth = { clientId: 'client-id', clientSecret: 'client-secret' };

function tokenRequest(): { url: string; headers: Headers; body: URLSearchParams } {
  const [url, init] = fetchMock.mock.calls[0];
  return {
    url: String(url),
    headers: new Headers(init?.headers),
    body: new URLSearchParams(String(init?.body)),
  };
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  vi.useFakeTimers({ now: new Date('2026-01-01T00:00:00Z'), toFake: ['Date'] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('figmaProvider', () => {
  it('builds the authorize URL with the read scopes', () => {
    const url = new URL(figmaProvider.getOAuthUrl!(oauth, 'https://app.example.com/integrations/callback', 'state-1'));
    expect(url.origin + url.pathname).toBe('https://www.figma.com/oauth');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: 'client-id',
      redirect_uri: 'https://app.example.com/integrations/callback',
      scope: 'file_content:read current_user:read',
      state: 'state-1',
      response_type: 'code',
    });
  });

  it('exchanges the code with HTTP Basic client auth and a form body', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      user_id_string: '123',
      access_token: 'access-1',
      refresh_token: 'refresh-1',
      expires_in: 3600,
      token_type: 'bearer',
    })));

    const creds = await figmaProvider.exchangeOAuthCode!(oauth, 'code-1', 'https://app.example.com/integrations/callback');

    const req = tokenRequest();
    expect(req.url).toBe('https://api.figma.com/v1/oauth/token');
    expect(req.headers.get('Authorization')).toBe(`Basic ${btoa('client-id:client-secret')}`);
    expect(req.headers.get('Content-Type')).toBe('application/x-www-form-urlencoded');
    expect(Object.fromEntries(req.body)).toEqual({
      redirect_uri: 'https://app.example.com/integrations/callback',
      code: 'code-1',
      grant_type: 'authorization_code',
    });
    expect(creds).toEqual({
      access_token: 'access-1',
      refresh_token: 'refresh-1',
      expires_at: '2026-01-01T01:00:00.000Z',
      token_type: 'bearer',
    });
  });

  it('throws when the code exchange fails', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{"error":"invalid_grant"}', { status: 400 }));
    await expect(figmaProvider.exchangeOAuthCode!(oauth, 'bad', 'https://x/cb')).rejects.toThrow('invalid_grant');
  });

  it('refreshes at /v1/oauth/token and keeps the refresh token when none is returned', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      access_token: 'access-2',
      expires_in: 7200,
      token_type: 'bearer',
    })));

    const creds = await figmaProvider.refreshOAuthTokens!(oauth, 'refresh-1');

    const req = tokenRequest();
    expect(req.url).toBe('https://api.figma.com/v1/oauth/token');
    expect(req.headers.get('Authorization')).toBe(`Basic ${btoa('client-id:client-secret')}`);
    expect(Object.fromEntries(req.body)).toEqual({ refresh_token: 'refresh-1', grant_type: 'refresh_token' });
    expect(creds).toEqual({
      access_token: 'access-2',
      refresh_token: 'refresh-1',
      expires_at: '2026-01-01T02:00:00.000Z',
      token_type: 'bearer',
    });
  });

  it('throws when refresh fails', async () => {
    fetchMock.mockResolvedValueOnce(new Response('nope', { status: 401 }));
    await expect(figmaProvider.refreshOAuthTokens!(oauth, 'refresh-1')).rejects.toThrow('401');
  });

  it('tests the connection with /v1/me', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 200 }));
    expect(await figmaProvider.testConnection({ access_token: 'access-1' })).toBe(true);
    expect(String(fetchMock.mock.calls[0][0])).toBe('https://api.figma.com/v1/me');
    expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get('Authorization')).toBe('Bearer access-1');

    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 403 }));
    expect(await figmaProvider.testConnection({ access_token: 'expired' })).toBe(false);
  });
});
