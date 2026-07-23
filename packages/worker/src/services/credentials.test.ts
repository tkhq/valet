import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Env } from '../env.js';

// Mock the DB layer
vi.mock('../lib/db/credentials.js', () => ({
  getCredentialRow: vi.fn(),
  setCredentialFailureState: vi.fn(),
  upsertCredential: vi.fn(),
  deleteCredential: vi.fn(),
  deleteCredentialIfDataMatches: vi.fn(),
  listCredentialsByOwner: vi.fn(),
  hasCredential: vi.fn(),
  getExpiringCredentials: vi.fn(),
}));

vi.mock('../lib/db/mcp-oauth.js', () => ({
  getMcpOAuthClient: vi.fn(),
}));

vi.mock('./custom-mcp-connectors.js', () => ({
  getCustomMcpOAuthConfig: vi.fn(),
  getCustomMcpOAuthConnector: vi.fn(),
}));

vi.mock('./github-app.js', () => ({
  loadGitHubApp: vi.fn(),
}));

// Mock the crypto layer
vi.mock('../lib/crypto.js', () => ({
  encryptStringPBKDF2: vi.fn(),
  decryptStringPBKDF2: vi.fn(),
}));

// Mock the drizzle layer so we can verify getDb() return value is threaded through
const { fakeDrizzleDb } = vi.hoisted(() => {
  const fakeDrizzleDb = { __drizzle: true } as const;
  return { fakeDrizzleDb };
});
vi.mock('../lib/drizzle.js', () => ({
  getDb: vi.fn().mockReturnValue(fakeDrizzleDb),
}));

import * as credentialDb from '../lib/db/credentials.js';
import * as mcpOAuthDb from '../lib/db/mcp-oauth.js';
import { loadGitHubApp } from './github-app.js';
import { getCustomMcpOAuthConfig, getCustomMcpOAuthConnector } from './custom-mcp-connectors.js';
import { encryptStringPBKDF2, decryptStringPBKDF2 } from '../lib/crypto.js';
import {
  getCredential,
  storeCredential,
  revokeCredential,
  listCredentials,
  hasCredential,
  resolveCredentials,
} from './credentials.js';

const mockDb = credentialDb as unknown as {
  getCredentialRow: ReturnType<typeof vi.fn>;
  setCredentialFailureState: ReturnType<typeof vi.fn>;
  upsertCredential: ReturnType<typeof vi.fn>;
  deleteCredential: ReturnType<typeof vi.fn>;
  deleteCredentialIfDataMatches: ReturnType<typeof vi.fn>;
  listCredentialsByOwner: ReturnType<typeof vi.fn>;
  hasCredential: ReturnType<typeof vi.fn>;
  getExpiringCredentials: ReturnType<typeof vi.fn>;
};
const mockGetMcpOAuthClient = vi.mocked(mcpOAuthDb.getMcpOAuthClient);
const mockLoadGitHubApp = loadGitHubApp as ReturnType<typeof vi.fn>;
const mockEncrypt = encryptStringPBKDF2 as ReturnType<typeof vi.fn>;
const mockDecrypt = decryptStringPBKDF2 as ReturnType<typeof vi.fn>;
const mockGetCustomMcpOAuthConfig = getCustomMcpOAuthConfig as ReturnType<typeof vi.fn>;
const mockGetCustomMcpOAuthConnector = getCustomMcpOAuthConnector as ReturnType<typeof vi.fn>;

const fakeEnv = {
  DB: {} as unknown,
  ENCRYPTION_KEY: 'test-key',
} as Env;

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.setCredentialFailureState.mockResolvedValue(undefined);
  mockGetCustomMcpOAuthConfig.mockResolvedValue(null);
  mockGetCustomMcpOAuthConnector.mockResolvedValue(null);
  mockGetMcpOAuthClient.mockResolvedValue(null);
});

describe('getCredential', () => {
  it('returns not_found when no row exists', async () => {
    mockDb.getCredentialRow.mockResolvedValue(null);

    const result = await getCredential(fakeEnv, 'user', 'user-1', 'github');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toBe('not_found');
      expect(result.error.service).toBe('github');
    }
  });

  it('decrypts and returns credential (happy path)', async () => {
    mockDb.getCredentialRow.mockResolvedValue({
      id: 'cred-1',
      ownerType: 'user',
      ownerId: 'user-1',
      provider: 'github',
      credentialType: 'oauth2',
      encryptedData: 'encrypted-blob',
      metadata: null,
      scopes: 'repo user',
      expiresAt: null,
      createdAt: '2025-01-01T00:00:00Z',
      updatedAt: '2025-01-01T00:00:00Z',
    });
    mockDecrypt.mockResolvedValue(JSON.stringify({ access_token: 'ghp_abc123' }));

    const result = await getCredential(fakeEnv, 'user', 'user-1', 'github');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.credential.accessToken).toBe('ghp_abc123');
      expect(result.credential.credentialType).toBe('oauth2');
      expect(result.credential.scopes).toEqual(['repo', 'user']);
      expect(result.credential.refreshed).toBe(false);
    }
    expect(mockDecrypt).toHaveBeenCalledWith('encrypted-blob', 'test-key');
  });

  it('returns decryption_failed when decryption throws', async () => {
    mockDb.getCredentialRow.mockResolvedValue({
      id: 'cred-1',
      ownerType: 'user',
      ownerId: 'user-1',
      provider: 'github',
      credentialType: 'oauth2',
      encryptedData: 'bad-data',
      metadata: null,
      scopes: null,
      expiresAt: null,
      createdAt: '2025-01-01T00:00:00Z',
      updatedAt: '2025-01-01T00:00:00Z',
    });
    mockDecrypt.mockRejectedValue(new Error('decrypt failed'));

    const result = await getCredential(fakeEnv, 'user', 'user-1', 'github');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toBe('decryption_failed');
    }
  });

  it('logs a structured warn on failed resolution (any caller benefits)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      mockDb.getCredentialRow.mockResolvedValue({
        id: 'cred-1',
        ownerType: 'user',
        ownerId: 'user-1',
        provider: 'linear',
        credentialType: 'oauth2',
        encryptedData: 'bad-data',
        metadata: null,
        scopes: null,
        expiresAt: null,
        createdAt: '2025-01-01T00:00:00Z',
        updatedAt: '2025-01-01T00:00:00Z',
      });
      mockDecrypt.mockRejectedValue(new Error('decrypt failed'));

      await getCredential(fakeEnv, 'user', 'user-1', 'linear');

      expect(warnSpy).toHaveBeenCalledTimes(1);
      const entry = JSON.parse(warnSpy.mock.calls[0][0] as string);
      expect(entry).toMatchObject({
        level: 'warn',
        message: 'integration auth/refresh failed',
        service: 'linear',
        ownerType: 'user',
        ownerId: 'user-1',
        reason: 'decryption_failed',
      });
      expect(typeof entry.detail).toBe('string');
      // First failure is a state transition — persisted so repeats stay quiet.
      expect(mockDb.setCredentialFailureState).toHaveBeenCalledWith(fakeDrizzleDb, 'cred-1', 'decryption_failed');
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("does NOT log for not_found — that's 'never connected', not a breakage", async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      mockDb.getCredentialRow.mockResolvedValue(null);

      await getCredential(fakeEnv, 'user', 'user-1', 'github');

      expect(warnSpy).not.toHaveBeenCalled();
      expect(mockDb.setCredentialFailureState).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('does NOT re-log a repeat failure with the same reason (edge-triggered)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      mockDb.getCredentialRow.mockResolvedValue({
        id: 'cred-1',
        ownerType: 'user',
        ownerId: 'user-1',
        provider: 'linear',
        credentialType: 'oauth2',
        encryptedData: 'bad-data',
        metadata: null,
        scopes: null,
        expiresAt: null,
        lastFailureReason: 'decryption_failed',
        lastFailureAt: '2025-01-01T00:00:00Z',
        createdAt: '2025-01-01T00:00:00Z',
        updatedAt: '2025-01-01T00:00:00Z',
      });
      mockDecrypt.mockRejectedValue(new Error('decrypt failed'));

      const result = await getCredential(fakeEnv, 'user', 'user-1', 'linear');

      expect(result.ok).toBe(false);
      expect(warnSpy).not.toHaveBeenCalled();
      expect(mockDb.setCredentialFailureState).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('logs again when the failure reason CHANGES, carrying previousReason', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      mockDb.getCredentialRow.mockResolvedValue({
        id: 'cred-1',
        ownerType: 'user',
        ownerId: 'user-1',
        provider: 'linear',
        credentialType: 'oauth2',
        encryptedData: 'bad-data',
        metadata: null,
        scopes: null,
        expiresAt: null,
        lastFailureReason: 'expired',
        lastFailureAt: '2025-01-01T00:00:00Z',
        createdAt: '2025-01-01T00:00:00Z',
        updatedAt: '2025-01-01T00:00:00Z',
      });
      mockDecrypt.mockRejectedValue(new Error('decrypt failed'));

      await getCredential(fakeEnv, 'user', 'user-1', 'linear');

      expect(warnSpy).toHaveBeenCalledTimes(1);
      const entry = JSON.parse(warnSpy.mock.calls[0][0] as string);
      expect(entry).toMatchObject({ reason: 'decryption_failed', previousReason: 'expired' });
      expect(mockDb.setCredentialFailureState).toHaveBeenCalledWith(fakeDrizzleDb, 'cred-1', 'decryption_failed');
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('logs an info and clears the state when a broken credential recovers', async () => {
    const infoSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      mockDb.getCredentialRow.mockResolvedValue({
        id: 'cred-1',
        ownerType: 'user',
        ownerId: 'user-1',
        provider: 'github',
        credentialType: 'oauth2',
        encryptedData: 'encrypted-blob',
        metadata: null,
        scopes: null,
        expiresAt: null,
        lastFailureReason: 'expired',
        lastFailureAt: '2025-01-01T00:00:00Z',
        createdAt: '2025-01-01T00:00:00Z',
        updatedAt: '2025-01-01T00:00:00Z',
      });
      mockDecrypt.mockResolvedValue(JSON.stringify({ access_token: 'ghp_abc123' }));

      const result = await getCredential(fakeEnv, 'user', 'user-1', 'github');

      expect(result.ok).toBe(true);
      const recovered = infoSpy.mock.calls
        .map((c) => { try { return JSON.parse(c[0] as string); } catch { return null; } })
        .find((e) => e?.message === 'integration auth recovered');
      expect(recovered).toMatchObject({
        level: 'info',
        service: 'github',
        ownerType: 'user',
        ownerId: 'user-1',
        previousReason: 'expired',
      });
      expect(mockDb.setCredentialFailureState).toHaveBeenCalledWith(fakeDrizzleDb, 'cred-1', null);
    } finally {
      infoSpy.mockRestore();
    }
  });

  it('returns decryption_failed when token field is missing', async () => {
    mockDb.getCredentialRow.mockResolvedValue({
      id: 'cred-1',
      ownerType: 'user',
      ownerId: 'user-1',
      provider: 'github',
      credentialType: 'oauth2',
      encryptedData: 'encrypted-blob',
      metadata: null,
      scopes: null,
      expiresAt: null,
      createdAt: '2025-01-01T00:00:00Z',
      updatedAt: '2025-01-01T00:00:00Z',
    });
    // No access_token, api_key, bot_token, or token field
    mockDecrypt.mockResolvedValue(JSON.stringify({ foo: 'bar' }));

    const result = await getCredential(fakeEnv, 'user', 'user-1', 'github');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toBe('decryption_failed');
      expect(result.error.message).toContain('missing token field');
    }
  });

  it('extracts api_key when access_token is absent', async () => {
    mockDb.getCredentialRow.mockResolvedValue({
      id: 'cred-1',
      ownerType: 'user',
      ownerId: 'user-1',
      provider: 'openai',
      credentialType: 'api_key',
      encryptedData: 'encrypted-blob',
      metadata: null,
      scopes: null,
      expiresAt: null,
      createdAt: '2025-01-01T00:00:00Z',
      updatedAt: '2025-01-01T00:00:00Z',
    });
    mockDecrypt.mockResolvedValue(JSON.stringify({ api_key: 'sk-abc123' }));

    const result = await getCredential(fakeEnv, 'user', 'user-1', 'openai');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.credential.accessToken).toBe('sk-abc123');
    }
  });

  it('refreshes expired custom MCP OAuth credentials with stored client credentials and resource', async () => {
    mockDb.getCredentialRow.mockResolvedValue({
      id: 'cred-1',
      ownerType: 'user',
      ownerId: 'user-1',
      provider: 'salesforce-mcp',
      credentialType: 'oauth2',
      encryptedData: 'encrypted-blob',
      metadata: null,
      scopes: 'mcp_api refresh_token',
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
      createdAt: '2025-01-01T00:00:00Z',
      updatedAt: '2025-01-01T00:00:00Z',
    });
    mockDecrypt.mockResolvedValue(JSON.stringify({
      access_token: 'old-access',
      refresh_token: 'old-refresh',
    }));
    mockGetCustomMcpOAuthConfig.mockResolvedValue({
      serviceSlug: 'salesforce-mcp',
      serverUrl: 'https://mcp.salesforce.example.com/platform/mcp',
      tokenEndpoint: 'https://login.salesforce.example.com/token',
      authorizationEndpoint: 'https://login.salesforce.example.com/auth',
      clientId: 'client-id',
      clientSecret: 'client-secret',
      tokenEndpointAuthMethod: 'client_secret_post',
      scopes: ['mcp_api', 'refresh_token'],
    });
    mockEncrypt.mockResolvedValue('encrypted-refreshed');
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const form = init?.body as URLSearchParams;
      expect(form.get('grant_type')).toBe('refresh_token');
      expect(form.get('client_id')).toBe('client-id');
      expect(form.get('client_secret')).toBe('client-secret');
      expect(form.get('refresh_token')).toBe('old-refresh');
      expect(form.get('resource')).toBe('https://mcp.salesforce.example.com/platform/mcp');
      return Response.json({ access_token: 'new-access', expires_in: 3600 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await getCredential(fakeEnv, 'user', 'user-1', 'salesforce-mcp');

    expect(result).toMatchObject({
      ok: true,
      credential: {
        accessToken: 'new-access',
        refreshToken: 'old-refresh',
        refreshed: true,
      },
    });
    expect(mockDb.upsertCredential).toHaveBeenCalledWith(
      fakeDrizzleDb,
      expect.objectContaining({
        ownerType: 'user',
        ownerId: 'user-1',
        provider: 'salesforce-mcp',
        credentialType: 'oauth2',
        encryptedData: 'encrypted-refreshed',
        expiresAt: expect.any(String),
      }),
    );
  });

  it('refreshes expired custom MCP OAuth credentials with a dynamically registered client', async () => {
    mockDb.getCredentialRow.mockResolvedValue({
      id: 'cred-1',
      ownerType: 'user',
      ownerId: 'user-1',
      provider: 'ramp',
      credentialType: 'oauth2',
      encryptedData: 'encrypted-blob',
      metadata: null,
      scopes: 'openid profile offline_access',
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
      createdAt: '2025-01-01T00:00:00Z',
      updatedAt: '2025-01-01T00:00:00Z',
    });
    mockDecrypt.mockResolvedValue(JSON.stringify({
      access_token: 'old-access',
      refresh_token: 'old-refresh',
    }));
    mockGetCustomMcpOAuthConnector.mockResolvedValue({
      id: 'ramp-connector',
      orgId: 'default',
      serviceSlug: 'ramp',
      displayName: 'Ramp',
      serverUrl: 'https://mcp.ramp.com/mcp',
      authType: 'oauth',
      oauthClientId: null,
      oauthTokenEndpointAuthMethod: 'none',
      oauthScopes: 'openid profile offline_access',
      oauthAuthorizationEndpoint: null,
      oauthTokenEndpoint: null,
    });
    mockGetMcpOAuthClient.mockResolvedValue({
      service: 'ramp',
      clientId: 'ramp-dynamic-client',
      clientSecret: null,
      authorizationEndpoint: 'https://auth.ramp.com/oauth/authorize',
      tokenEndpoint: 'https://auth.ramp.com/oauth/token',
      registrationEndpoint: 'https://auth.ramp.com/oauth/register',
      scopesSupported: null,
      metadataJson: null,
    });
    mockEncrypt.mockResolvedValue('encrypted-refreshed');
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const form = init?.body as URLSearchParams;
      expect(form.get('grant_type')).toBe('refresh_token');
      expect(form.get('client_id')).toBe('ramp-dynamic-client');
      expect(form.get('refresh_token')).toBe('old-refresh');
      expect(form.get('resource')).toBe('https://mcp.ramp.com/mcp');
      return Response.json({ access_token: 'new-access', expires_in: 3600 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await getCredential(fakeEnv, 'user', 'user-1', 'ramp');

    expect(result).toMatchObject({
      ok: true,
      credential: {
        accessToken: 'new-access',
        refreshToken: 'old-refresh',
        refreshed: true,
      },
    });
    expect(mockDb.upsertCredential).toHaveBeenCalledWith(
      fakeDrizzleDb,
      expect.objectContaining({
        ownerType: 'user',
        ownerId: 'user-1',
        provider: 'ramp',
        credentialType: 'oauth2',
        encryptedData: 'encrypted-refreshed',
        expiresAt: expect.any(String),
      }),
    );
  });

  it('returns expired when an expired credential has no refresh token', async () => {
    mockDb.getCredentialRow.mockResolvedValue({
      id: 'cred-1',
      ownerType: 'user',
      ownerId: 'user-1',
      provider: 'salesforce-mcp',
      credentialType: 'oauth2',
      encryptedData: 'encrypted-blob',
      metadata: null,
      scopes: 'mcp_api',
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
      createdAt: '2025-01-01T00:00:00Z',
      updatedAt: '2025-01-01T00:00:00Z',
    });
    mockDecrypt.mockResolvedValue(JSON.stringify({
      access_token: 'expired-access',
    }));

    const result = await getCredential(fakeEnv, 'user', 'user-1', 'salesforce-mcp');

    expect(result).toMatchObject({
      ok: false,
      error: {
        service: 'salesforce-mcp',
        reason: 'expired',
      },
    });
    expect(mockGetCustomMcpOAuthConfig).not.toHaveBeenCalled();
  });
});

describe('getCredential — concurrent refresh', () => {
  const EXPIRED = new Date(Date.now() - 60_000).toISOString();
  const NOT_EXPIRING = new Date(Date.now() + 3_600_000).toISOString();

  /** A stored github row; `encryptedData` selects which payload `decrypt` hands back. */
  function githubRow(encryptedData: string, expiresAt: string) {
    return {
      id: 'cred-1',
      ownerType: 'user',
      ownerId: 'user-1',
      provider: 'github',
      credentialType: 'oauth2',
      encryptedData,
      metadata: null,
      scopes: null,
      expiresAt,
      lastFailureReason: null,
      lastFailureAt: null,
      createdAt: '2025-01-01T00:00:00Z',
      updatedAt: '2025-01-01T00:00:00Z',
    };
  }

  // 'stale' is what a caller reads before the race; 'winner' is what the caller
  // that spent the single-use refresh token first left behind.
  function decryptByBlob(blob: string) {
    if (blob === 'stale-blob') {
      return JSON.stringify({ access_token: 'stale-access', refresh_token: 'stale-refresh' });
    }
    if (blob === 'winner-blob') {
      return JSON.stringify({ access_token: 'winner-access', refresh_token: 'winner-refresh' });
    }
    throw new Error(`unexpected blob: ${blob}`);
  }

  beforeEach(() => {
    mockDecrypt.mockImplementation(async (blob: string) => decryptByBlob(blob));
    mockEncrypt.mockResolvedValue('rotated-blob');
  });

  it('spends a single-use refresh token once when callers race for the same credential', async () => {
    mockDb.getCredentialRow.mockResolvedValue(githubRow('stale-blob', EXPIRED));
    const refreshToken = vi.fn().mockResolvedValue({
      authentication: { token: 'rotated-access', refreshToken: 'rotated-refresh', expiresAt: NOT_EXPIRING },
    });
    mockLoadGitHubApp.mockResolvedValue({ oauth: { refreshToken } });

    const results = await Promise.all([
      getCredential(fakeEnv, 'user', 'user-1', 'github'),
      getCredential(fakeEnv, 'user', 'user-1', 'github'),
    ]);

    // The second caller joins the in-flight refresh rather than spending the
    // same token again, so GitHub sees one refresh and D1 sees one write.
    expect(refreshToken).toHaveBeenCalledTimes(1);
    expect(mockDb.upsertCredential).toHaveBeenCalledTimes(1);
    expect(mockDb.deleteCredential).not.toHaveBeenCalled();
    for (const result of results) {
      expect(result).toMatchObject({
        ok: true,
        credential: { accessToken: 'rotated-access', refreshed: true },
      });
    }
  });

  it('returns the credential another holder refreshed instead of spending a stale token', async () => {
    mockDb.getCredentialRow
      .mockResolvedValueOnce(githubRow('stale-blob', EXPIRED))
      .mockResolvedValue(githubRow('winner-blob', NOT_EXPIRING));
    const refreshToken = vi.fn();
    mockLoadGitHubApp.mockResolvedValue({ oauth: { refreshToken } });

    const result = await getCredential(fakeEnv, 'user', 'user-1', 'github');

    // The re-read inside the lock shows the token already moved on, so there is
    // nothing left to refresh and spending our copy would only invalidate the
    // token that replaced it.
    expect(refreshToken).not.toHaveBeenCalled();
    expect(mockDb.upsertCredential).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      ok: true,
      credential: { accessToken: 'winner-access', refreshToken: 'winner-refresh', refreshed: true },
    });
  });

  it('does not delete the winner credential when a losing racer is told its token was consumed', async () => {
    mockDb.getCredentialRow
      // The caller's read, then the re-read inside the lock: nothing has
      // rotated yet, so this caller goes on to spend its token and loses.
      .mockResolvedValueOnce(githubRow('stale-blob', EXPIRED))
      .mockResolvedValueOnce(githubRow('stale-blob', EXPIRED))
      // By the time the failure comes back, the winner has written its pair.
      .mockResolvedValue(githubRow('winner-blob', NOT_EXPIRING));
    const refreshToken = vi.fn().mockRejectedValue(new Error('refresh token already consumed'));
    mockLoadGitHubApp.mockResolvedValue({ oauth: { refreshToken } });

    const result = await getCredential(fakeEnv, 'user', 'user-1', 'github');

    expect(mockDb.deleteCredential).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      ok: true,
      credential: { accessToken: 'winner-access', refreshed: true },
    });
  });

  it('deletes the credential when the refresh token is definitively dead and nothing rotated underneath it', async () => {
    mockDb.getCredentialRow.mockResolvedValue(githubRow('stale-blob', EXPIRED));
    // GitHub's OAuth endpoint reports a spent refresh token as a 400 carrying
    // the error code — a definitive "this token is invalid" signal.
    const refreshToken = vi.fn().mockRejectedValue(
      Object.assign(new Error('The refresh token passed is incorrect or expired. (bad_refresh_token)'), { status: 400 }),
    );
    mockLoadGitHubApp.mockResolvedValue({ oauth: { refreshToken } });

    const result = await getCredential(fakeEnv, 'user', 'user-1', 'github');

    // Compare-and-delete keyed on the exact blob we read, so a concurrent
    // refresh that rotates the token cannot be clobbered.
    expect(mockDb.deleteCredentialIfDataMatches).toHaveBeenCalledWith(
      fakeDrizzleDb, 'user', 'user-1', 'github', 'oauth2', 'stale-blob',
    );
    expect(mockDb.deleteCredential).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: false, error: { reason: 'refresh_failed' } });
  });

  it('does NOT delete the credential when the refresh fails transiently (5xx)', async () => {
    mockDb.getCredentialRow.mockResolvedValue(githubRow('stale-blob', EXPIRED));
    // A 5xx from GitHub is transport trouble, not proof the token is dead — the
    // stored credential may still be perfectly good.
    const refreshToken = vi.fn().mockRejectedValue(
      Object.assign(new Error('service unavailable'), { status: 503 }),
    );
    mockLoadGitHubApp.mockResolvedValue({ oauth: { refreshToken } });

    const result = await getCredential(fakeEnv, 'user', 'user-1', 'github');

    expect(mockDb.deleteCredentialIfDataMatches).not.toHaveBeenCalled();
    expect(mockDb.deleteCredential).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: false, error: { reason: 'refresh_failed' } });
  });

  it('does NOT delete the credential when a status-less network error merely mentions "unauthorized"', async () => {
    mockDb.getCredentialRow.mockResolvedValue(githubRow('stale-blob', EXPIRED));
    // A rejected fetch carries no HTTP status, and its message wording proves
    // nothing about the token — treating it as definitive would delete a
    // credential that may still be good.
    const refreshToken = vi.fn().mockRejectedValue(new Error('TypeError: fetch failed: unauthorized'));
    mockLoadGitHubApp.mockResolvedValue({ oauth: { refreshToken } });

    const result = await getCredential(fakeEnv, 'user', 'user-1', 'github');

    expect(mockDb.deleteCredentialIfDataMatches).not.toHaveBeenCalled();
    expect(mockDb.deleteCredential).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: false, error: { reason: 'refresh_failed' } });
  });

  it('still deletes on an OAuth error code thrown without an HTTP status', async () => {
    mockDb.getCredentialRow.mockResolvedValue(githubRow('stale-blob', EXPIRED));
    // Providers rethrow the OAuth error codes in plain Errors; the code itself
    // is the definitive signal even when no status is attached.
    const refreshToken = vi.fn().mockRejectedValue(new Error('invalid_grant: token has been revoked'));
    mockLoadGitHubApp.mockResolvedValue({ oauth: { refreshToken } });

    const result = await getCredential(fakeEnv, 'user', 'user-1', 'github');

    expect(mockDb.deleteCredentialIfDataMatches).toHaveBeenCalledWith(
      fakeDrizzleDb, 'user', 'user-1', 'github', 'oauth2', 'stale-blob',
    );
    expect(result).toMatchObject({ ok: false, error: { reason: 'refresh_failed' } });
  });

  it('a throwing refresh resolves to a structured failure for every joined caller', async () => {
    // The google refresh path fetches directly, so a network-level rejection
    // used to escape the in-flight attempt and reject every caller that had
    // joined it. It must surface as an ok:false result instead.
    mockDb.getCredentialRow.mockResolvedValue({
      ...githubRow('stale-blob', EXPIRED),
      provider: 'google',
    });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
    try {
      const results = await Promise.all([
        getCredential(fakeEnv, 'user', 'user-1', 'google'),
        getCredential(fakeEnv, 'user', 'user-1', 'google'),
      ]);

      // One shared attempt (the second caller joined it), one fetch.
      expect(fetch).toHaveBeenCalledTimes(1);
      for (const result of results) {
        expect(result).toMatchObject({ ok: false, error: { reason: 'refresh_failed' } });
      }
      // A throw is not a definitive token failure — nothing gets deleted.
      expect(mockDb.deleteCredentialIfDataMatches).not.toHaveBeenCalled();
      expect(mockDb.deleteCredential).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('keeps the provider-reported expiry when refreshing through the generic path', async () => {
    mockDb.getCredentialRow.mockResolvedValue({
      id: 'cred-1',
      ownerType: 'user',
      ownerId: 'user-1',
      provider: 'google_workspace',
      credentialType: 'oauth2',
      encryptedData: 'stale-blob',
      metadata: null,
      scopes: null,
      expiresAt: EXPIRED,
      lastFailureReason: null,
      lastFailureAt: null,
      createdAt: '2025-01-01T00:00:00Z',
      updatedAt: '2025-01-01T00:00:00Z',
    });
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({
      access_token: 'new-access',
      expires_in: 3600,
      token_type: 'Bearer',
    })));

    const env = { ...fakeEnv, GOOGLE_CLIENT_ID: 'client-id', GOOGLE_CLIENT_SECRET: 'client-secret' } as Env;
    const result = await getCredential(env, 'user', 'user-1', 'google_workspace');

    // The upsert writes expires_at unconditionally, so an omitted expiry does
    // not merely go unrecorded — it nulls the column and leaves a credential
    // that never looks due for refresh again.
    const written = mockDb.upsertCredential.mock.calls[0][1] as { expiresAt?: string };
    expect(written.expiresAt).toBeTruthy();
    expect(new Date(written.expiresAt as string).getTime()).toBeGreaterThan(Date.now());
    expect(result).toMatchObject({ ok: true, credential: { accessToken: 'new-access', refreshed: true } });
    if (result.ok) expect(result.credential.expiresAt).toBeInstanceOf(Date);
  });
});

describe('storeCredential', () => {
  it('encrypts and upserts', async () => {
    mockEncrypt.mockResolvedValue('encrypted-output');
    mockDb.upsertCredential.mockResolvedValue(undefined);

    await storeCredential(fakeEnv, 'user', 'user-1', 'github', { access_token: 'ghp_abc' }, {
      credentialType: 'oauth2',
      scopes: 'repo',
      expiresAt: '2026-01-01T00:00:00Z',
    });

    expect(mockEncrypt).toHaveBeenCalledWith(
      JSON.stringify({ access_token: 'ghp_abc' }),
      'test-key',
    );
    expect(mockDb.upsertCredential).toHaveBeenCalledWith(
      fakeDrizzleDb,
      expect.objectContaining({
        ownerType: 'user',
        ownerId: 'user-1',
        provider: 'github',
        credentialType: 'oauth2',
        encryptedData: 'encrypted-output',
        scopes: 'repo',
        expiresAt: '2026-01-01T00:00:00Z',
      }),
    );
  });

  it('defaults credentialType to api_key', async () => {
    mockEncrypt.mockResolvedValue('enc');
    mockDb.upsertCredential.mockResolvedValue(undefined);

    await storeCredential(fakeEnv, 'user', 'user-1', 'custom', { token: 'tok' });

    expect(mockDb.upsertCredential).toHaveBeenCalledWith(
      fakeDrizzleDb,
      expect.objectContaining({ credentialType: 'api_key' }),
    );
  });
});

describe('revokeCredential', () => {
  it('delegates to deleteCredential', async () => {
    mockDb.deleteCredential.mockResolvedValue(undefined);

    await revokeCredential(fakeEnv, 'user', 'user-1', 'github');

    expect(mockDb.deleteCredential).toHaveBeenCalledWith(fakeDrizzleDb, 'user', 'user-1', 'github');
  });
});

describe('listCredentials', () => {
  it('transforms rows', async () => {
    mockDb.listCredentialsByOwner.mockResolvedValue([
      { provider: 'github', credentialType: 'oauth2', scopes: 'repo', expiresAt: null, createdAt: '2025-01-01', updatedAt: '2025-01-01' },
      { provider: 'google', credentialType: 'oauth2', scopes: null, expiresAt: '2026-01-01', createdAt: '2025-06-01', updatedAt: '2025-06-01' },
    ]);

    const result = await listCredentials(fakeEnv, 'user', 'user-1');

    expect(result).toHaveLength(2);
    expect(result[0].provider).toBe('github');
    expect(result[0].scopes).toBe('repo');
    expect(result[1].expiresAt).toBe('2026-01-01');
    // null scopes become undefined
    expect(result[1].scopes).toBeUndefined();
  });
});

describe('hasCredential', () => {
  it('delegates to DB hasCredential', async () => {
    mockDb.hasCredential.mockResolvedValue(true);

    const result = await hasCredential(fakeEnv, 'user', 'user-1', 'github');

    expect(result).toBe(true);
    expect(mockDb.hasCredential).toHaveBeenCalledWith(fakeDrizzleDb, 'user', 'user-1', 'github');
  });

  it('returns false when DB returns false', async () => {
    mockDb.hasCredential.mockResolvedValue(false);

    const result = await hasCredential(fakeEnv, 'user', 'user-1', 'nonexistent');

    expect(result).toBe(false);
  });
});

describe('resolveCredentials', () => {
  it('resolves multiple providers', async () => {
    mockDb.getCredentialRow.mockImplementation(async (_db: unknown, _ownerType: string, _ownerId: string, provider: string) => {
      if (provider === 'github') {
        return {
          id: 'cred-1', ownerType: 'user', ownerId: 'user-1', provider: 'github', credentialType: 'oauth2',
          encryptedData: 'enc-github', metadata: null, scopes: 'repo', expiresAt: null,
          createdAt: '2025-01-01', updatedAt: '2025-01-01',
        };
      }
      return null;
    });
    mockDecrypt.mockResolvedValue(JSON.stringify({ access_token: 'ghp_abc' }));

    const results = await resolveCredentials(fakeEnv, 'user', 'user-1', ['github', 'slack']);

    expect(results.size).toBe(2);

    const github = results.get('github')!;
    expect(github.ok).toBe(true);

    const slack = results.get('slack')!;
    expect(slack.ok).toBe(false);
    if (!slack.ok) {
      expect(slack.error.reason).toBe('not_found');
    }
  });
});
