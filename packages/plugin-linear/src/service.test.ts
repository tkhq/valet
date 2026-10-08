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
