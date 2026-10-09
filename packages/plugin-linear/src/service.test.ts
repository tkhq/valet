import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLinearService, LinearTokenError } from './service.js';

afterEach(() => vi.unstubAllGlobals());

const config = { clientId: 'app-id', clientSecret: 'app-secret' };
const environment = { LINEAR_API_URL: 'https://linear.fixture' };

describe('Linear provider client', () => {
  it('requests an app token with the existing scopes and converts expiry to milliseconds', async () => {
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      expect(url).toBe('https://linear.fixture/oauth/token');
      expect(init.method).toBe('POST');
      const form = new URLSearchParams(String(init.body));
      expect(Object.fromEntries(form)).toEqual({
        client_id: 'app-id', client_secret: 'app-secret', grant_type: 'client_credentials', scope: 'read,write',
      });
      return Response.json({ access_token: 'token', expires_in: 120 });
    });
    const before = Date.now();
    const token = await createLinearService(config, environment).clientCredentialsToken();
    expect(token.accessToken).toBe('token');
    expect(token.expiresAt).toBeGreaterThanOrEqual(before + 120_000);
    expect(token.expiresAt).toBeLessThanOrEqual(Date.now() + 120_000);
  });

  it('preserves provider refusal details in the shared error type', async () => {
    vi.stubGlobal('fetch', async () => Response.json({ error_description: 'Client credentials are disabled' }, { status: 400 }));
    const pending = createLinearService(config, environment).clientCredentialsToken();
    await expect(pending).rejects.toBeInstanceOf(LinearTokenError);
    await expect(pending).rejects.toMatchObject({ status: 400, detail: 'Client credentials are disabled' });
  });

  it('rejects malformed GraphQL data with a provider diagnostic', async () => {
    vi.stubGlobal('fetch', async () => Response.json(null));
    await expect(createLinearService(config, environment).fetchWorkspace('token'))
      .rejects.toThrow('Linear fetchWorkspace: response has no data');
  });

  it('requires successful legacy webhook deletion', async () => {
    vi.stubGlobal('fetch', async () => Response.json({ data: { webhookDelete: { success: false } } }));
    await expect(createLinearService(config, environment).deleteWebhook('token', 'legacy-hook'))
      .rejects.toThrow('mutation did not succeed');
  });
});

describe('Linear provider client environment', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('defaults to the public API host and does not read the process environment', async () => {
    vi.stubEnv('LINEAR_API_URL', 'https://ambient.example');
    const urls: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      urls.push(url);
      return Response.json({ access_token: 'token', expires_in: 60 });
    });
    await createLinearService(config).clientCredentialsToken();
    expect(urls).toEqual(['https://api.linear.app/oauth/token']);
  });
});

describe('Linear provider client malformed responses', () => {
  const cases: Array<[string, () => Response, string]> = [
    ['a JSON null body', () => Response.json(null), 'Linear fetchWorkspace: response has no data'],
    ['a JSON array body', () => Response.json([]), 'Linear fetchWorkspace: response has no data'],
    ['a JSON string body', () => Response.json('ok'), 'Linear fetchWorkspace: response has no data'],
    ['a non-JSON body', () => new Response('<html>', { status: 200 }), 'Linear fetchWorkspace: malformed (non-JSON) response'],
    ['a body without data', () => Response.json({}), 'Linear fetchWorkspace: response has no data'],
    ['a null organization', () => Response.json({ data: { organization: null } }), 'Linear fetchWorkspace: malformed organization in response'],
    ['GraphQL errors with HTTP 200', () => Response.json({ errors: [{ message: 'denied' }] }), 'Linear fetchWorkspace: GraphQL errors: [{"message":"denied"}]'],
    ['an HTTP error', () => Response.json({}, { status: 503 }), 'Linear fetchWorkspace: API returned 503'],
  ];

  it.each(cases)('reports %s as a provider diagnostic', async (_label, respond, message) => {
    vi.stubGlobal('fetch', async () => respond());
    const err = await createLinearService(config, environment).fetchWorkspace('token').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(TypeError);
    expect((err as Error).message).toBe(message);
  });
});
