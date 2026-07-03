import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { createTestDb } from '../../test-utils/db.js';
import { users } from '../../lib/schema/users.js';
import { upsertGithubInstallation } from '../../lib/db/github-installations.js';
import type { CredentialResult } from '../../services/credentials.js';
import type { CredentialResolverContext } from '../registry.js';

// ── Mocks ──────────────────────────────────────────────────────────────────

vi.mock('../../services/credentials.js', () => ({
  getCredential: vi.fn(),
}));

vi.mock('../../services/github-app.js', () => ({
  loadGitHubApp: vi.fn(),
  getOrMintInstallationToken: vi.fn(),
}));

vi.mock('../../lib/db/service-configs.js', () => ({
  getServiceMetadata: vi.fn(),
}));

// Mock getDb to return whatever db we hand it via env.DB
vi.mock('../../lib/drizzle.js', () => ({
  getDb: vi.fn((binding: unknown) => binding),
}));

// ── Imports (after mocks) ──────────────────────────────────────────────────

const { getCredential } = await import('../../services/credentials.js');
const { loadGitHubApp, getOrMintInstallationToken } = await import('../../services/github-app.js');
const { getServiceMetadata } = await import('../../lib/db/service-configs.js');
const { githubCredentialResolver } = await import('./github.js');

// ── Helpers ────────────────────────────────────────────────────────────────

function makeEnv(db: unknown) {
  return { DB: db, ENCRYPTION_KEY: 'test-key' } as any;
}

const USER_ID = 'user-1';

describe('githubCredentialResolver', () => {
  let db: ReturnType<typeof createTestDb>['db'];

  beforeEach(() => {
    const testDb = createTestDb();
    db = testDb.db;
    vi.clearAllMocks();
  });

  function seedUser(opts?: { name?: string; email?: string }) {
    db.insert(users)
      .values({
        id: USER_ID,
        email: opts?.email ?? 'alice@example.com',
        name: opts?.name ?? 'Alice Dev',
        role: 'member',
      })
      .run();
  }

  // ── 1. User token found ────────────────────────────────────────────────

  it('returns user oauth2 token when getCredential succeeds', async () => {
    const userCredResult: CredentialResult = {
      ok: true,
      credential: {
        accessToken: 'gho_user_token',
        credentialType: 'oauth2',
        refreshed: false,
      },
    };
    (getCredential as Mock).mockResolvedValueOnce(userCredResult);

    const result = await githubCredentialResolver(
      'github',
      makeEnv(db),
      USER_ID,
      {},
    );

    expect(result).toEqual(userCredResult);
    // Should not have attempted to load installations or the GitHub App
    expect(loadGitHubApp).not.toHaveBeenCalled();
    expect(getOrMintInstallationToken).not.toHaveBeenCalled();
  });

  // ── 2. Anonymous access disabled ───────────────────────────────────────

  it('returns "not connected" error when user has no token and anonymous access disabled', async () => {
    (getCredential as Mock).mockResolvedValueOnce({
      ok: false,
      error: { service: 'github', reason: 'not_found', message: 'No credentials' },
    });
    (getServiceMetadata as Mock).mockResolvedValueOnce({
      allowAnonymousGitHubAccess: false,
    });

    const result = await githubCredentialResolver(
      'github',
      makeEnv(db),
      USER_ID,
      {},
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toBe('not_found');
      expect(result.error.message).toMatch(/not connected/i);
    }
  });

  it('returns "not connected" error when metadata is null (anonymous not explicitly allowed)', async () => {
    (getCredential as Mock).mockResolvedValueOnce({
      ok: false,
      error: { service: 'github', reason: 'not_found', message: 'No credentials' },
    });
    (getServiceMetadata as Mock).mockResolvedValueOnce(null);

    const result = await githubCredentialResolver(
      'github',
      makeEnv(db),
      USER_ID,
      {},
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toBe('not_found');
      expect(result.error.message).toMatch(/not connected/i);
    }
  });

  // ── 3. Owner specified, matching installation ──────────────────────────

  it('mints bot token with attribution when owner matches an installation', async () => {
    seedUser({ name: 'Alice Dev', email: 'alice@example.com' });

    // User has no personal token
    (getCredential as Mock).mockResolvedValueOnce({
      ok: false,
      error: { service: 'github', reason: 'not_found', message: 'No credentials' },
    });
    (getServiceMetadata as Mock).mockResolvedValueOnce({
      allowAnonymousGitHubAccess: true,
    });

    // Seed a matching installation
    await upsertGithubInstallation(db as any, {
      githubInstallationId: '42',
      accountLogin: 'my-org',
      accountId: 'acct-1',
      accountType: 'Organization',
      repositorySelection: 'all',
    });

    const mockApp = { appId: '99' };
    (loadGitHubApp as Mock).mockResolvedValueOnce(mockApp);
    (getOrMintInstallationToken as Mock).mockResolvedValueOnce({
      token: 'ghs_bot_token',
      expiresAt: Date.now() + 3600_000,
    });

    const context: CredentialResolverContext = {
      params: { owner: 'my-org' },
    };

    const result = await githubCredentialResolver(
      'github',
      makeEnv(db),
      USER_ID,
      context,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.credential.accessToken).toBe('ghs_bot_token');
      expect(result.credential.credentialType).toBe('app_install');
      expect(result.credential.refreshed).toBe(false);
      expect(result.credential.attribution).toEqual({
        name: 'Alice Dev',
        email: 'alice@example.com',
      });
    }
  });

  // ── 3b. credentialMode='app' — prefer the bot over the user's token ────

  it("credentialMode='app' uses the bot token even when the user HAS a personal token", async () => {
    seedUser({ name: 'Bot Runner', email: 'bot@example.com' });

    // The user's personal token would resolve fine — but app mode must skip it.
    // (No getCredential mock is consumed on the app-first path.)
    (getServiceMetadata as Mock).mockResolvedValueOnce({ allowAnonymousGitHubAccess: true });
    await upsertGithubInstallation(db as any, {
      githubInstallationId: '42', accountLogin: 'my-org', accountId: 'acct-1',
      accountType: 'Organization', repositorySelection: 'all',
    });
    (loadGitHubApp as Mock).mockResolvedValueOnce({ appId: '99' });
    (getOrMintInstallationToken as Mock).mockResolvedValueOnce({ token: 'ghs_bot_token', expiresAt: Date.now() + 3600_000 });

    const result = await githubCredentialResolver('github', makeEnv(db), USER_ID, {
      params: { owner: 'my-org' }, credentialMode: 'app',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.credential.accessToken).toBe('ghs_bot_token');
      expect(result.credential.credentialType).toBe('app_install');
    }
    // The user token was never consulted.
    expect(getCredential as Mock).not.toHaveBeenCalled();
  });

  it("credentialMode='app' FAILS (no user fallback) when no App installation exists", async () => {
    seedUser();
    // App path: anon allowed but NO installation → strict failure. The user's
    // own token must never be used — a bot action must not post as a person.
    (getServiceMetadata as Mock).mockResolvedValueOnce({ allowAnonymousGitHubAccess: true });

    const result = await githubCredentialResolver('github', makeEnv(db), USER_ID, {
      params: {}, credentialMode: 'app',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toMatch(/GitHub App credential unavailable/i);
      expect(result.error.message).toMatch(/ask an admin/i);
    }
    // The personal-token path was never consulted.
    expect(getCredential as Mock).not.toHaveBeenCalled();
  });

  it("credentialMode='app' FAILS (no user fallback) when minting the bot token THROWS (misconfigured App)", async () => {
    seedUser({ name: 'Strict User', email: 'strict@example.com' });
    (getServiceMetadata as Mock).mockResolvedValueOnce({ allowAnonymousGitHubAccess: true });
    await upsertGithubInstallation(db as any, {
      githubInstallationId: '42', accountLogin: 'my-org', accountId: 'acct-1',
      accountType: 'Organization', repositorySelection: 'all',
    });
    (loadGitHubApp as Mock).mockResolvedValueOnce({ appId: '99' });
    // The App is present but broken — minting throws (e.g. bad private key / JWT).
    (getOrMintInstallationToken as Mock).mockRejectedValueOnce(new Error('A JSON web token could not be decoded'));

    const result = await githubCredentialResolver('github', makeEnv(db), USER_ID, {
      params: { owner: 'my-org' }, credentialMode: 'app',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toMatch(/JSON web token could not be decoded/i);
    }
    expect(getCredential as Mock).not.toHaveBeenCalled();
  });

  // ── 4. Owner specified, NO matching installation (strict) ──────────────

  it('fails with specific error when owner has no matching installation (strict, no fallthrough)', async () => {
    seedUser();

    (getCredential as Mock).mockResolvedValueOnce({
      ok: false,
      error: { service: 'github', reason: 'not_found', message: 'No credentials' },
    });
    (getServiceMetadata as Mock).mockResolvedValueOnce({
      allowAnonymousGitHubAccess: true,
    });

    // No installation for 'unknown-org'

    const context: CredentialResolverContext = {
      params: { owner: 'unknown-org' },
    };

    const result = await githubCredentialResolver(
      'github',
      makeEnv(db),
      USER_ID,
      context,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toBe('not_found');
      expect(result.error.message).toContain('unknown-org');
    }

    // Must NOT have tried to load any installations or fall through
    expect(getOrMintInstallationToken).not.toHaveBeenCalled();
  });

  // ── 5. No owner, org installation exists ───────────────────────────────

  it('uses any active org installation when no owner specified', async () => {
    seedUser({ name: 'Bob Builder', email: 'bob@example.com' });

    (getCredential as Mock).mockResolvedValueOnce({
      ok: false,
      error: { service: 'github', reason: 'not_found', message: 'No credentials' },
    });
    (getServiceMetadata as Mock).mockResolvedValueOnce({
      allowAnonymousGitHubAccess: true,
    });

    // Seed an org installation
    await upsertGithubInstallation(db as any, {
      githubInstallationId: '100',
      accountLogin: 'org-a',
      accountId: 'acct-org-a',
      accountType: 'Organization',
      repositorySelection: 'all',
    });

    const mockApp = { appId: '99' };
    (loadGitHubApp as Mock).mockResolvedValueOnce(mockApp);
    (getOrMintInstallationToken as Mock).mockResolvedValueOnce({
      token: 'ghs_org_token',
      expiresAt: Date.now() + 3600_000,
    });

    const context: CredentialResolverContext = {
      params: {}, // no owner
    };

    const result = await githubCredentialResolver(
      'github',
      makeEnv(db),
      USER_ID,
      context,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.credential.accessToken).toBe('ghs_org_token');
      expect(result.credential.credentialType).toBe('app_install');
      expect(result.credential.attribution).toEqual({
        name: 'Bob Builder',
        email: 'bob@example.com',
      });
    }
  });

  it('prefers Organization installation over User installation when no owner specified', async () => {
    seedUser({ name: 'Carol', email: 'carol@example.com' });

    (getCredential as Mock).mockResolvedValueOnce({
      ok: false,
      error: { service: 'github', reason: 'not_found', message: 'No credentials' },
    });
    (getServiceMetadata as Mock).mockResolvedValueOnce({
      allowAnonymousGitHubAccess: true,
    });

    // Seed a User installation first
    await upsertGithubInstallation(db as any, {
      githubInstallationId: '200',
      accountLogin: 'personal-user',
      accountId: 'acct-user',
      accountType: 'User',
      repositorySelection: 'all',
    });

    // Seed an Organization installation
    await upsertGithubInstallation(db as any, {
      githubInstallationId: '300',
      accountLogin: 'org-preferred',
      accountId: 'acct-org',
      accountType: 'Organization',
      repositorySelection: 'all',
    });

    const mockApp = { appId: '99' };
    (loadGitHubApp as Mock).mockResolvedValueOnce(mockApp);
    (getOrMintInstallationToken as Mock).mockResolvedValueOnce({
      token: 'ghs_org_preferred',
      expiresAt: Date.now() + 3600_000,
    });

    const result = await githubCredentialResolver(
      'github',
      makeEnv(db),
      USER_ID,
      { params: {} },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.credential.accessToken).toBe('ghs_org_preferred');
    }

    // Verify the mock was called with the org installation, not the user one
    expect(getOrMintInstallationToken).toHaveBeenCalledWith(
      mockApp,
      db,
      'test-key',
      expect.objectContaining({ githubInstallationId: '300' }),
    );
  });

  it('falls back to User installation when no Organization installations exist', async () => {
    seedUser({ name: 'Dave', email: 'dave@example.com' });

    (getCredential as Mock).mockResolvedValueOnce({
      ok: false,
      error: { service: 'github', reason: 'not_found', message: 'No credentials' },
    });
    (getServiceMetadata as Mock).mockResolvedValueOnce({
      allowAnonymousGitHubAccess: true,
    });

    // Only a User installation
    await upsertGithubInstallation(db as any, {
      githubInstallationId: '200',
      accountLogin: 'personal-user',
      accountId: 'acct-user',
      accountType: 'User',
      repositorySelection: 'all',
    });

    const mockApp = { appId: '99' };
    (loadGitHubApp as Mock).mockResolvedValueOnce(mockApp);
    (getOrMintInstallationToken as Mock).mockResolvedValueOnce({
      token: 'ghs_user_install',
      expiresAt: Date.now() + 3600_000,
    });

    const result = await githubCredentialResolver(
      'github',
      makeEnv(db),
      USER_ID,
      { params: {} },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.credential.accessToken).toBe('ghs_user_install');
      expect(result.credential.credentialType).toBe('app_install');
    }
  });

  // ── 6. No owner, no installation at all ────────────────────────────────

  it('fails when no installations exist and no owner specified', async () => {
    seedUser();

    (getCredential as Mock).mockResolvedValueOnce({
      ok: false,
      error: { service: 'github', reason: 'not_found', message: 'No credentials' },
    });
    (getServiceMetadata as Mock).mockResolvedValueOnce({
      allowAnonymousGitHubAccess: true,
    });

    // No installations seeded

    const result = await githubCredentialResolver(
      'github',
      makeEnv(db),
      USER_ID,
      { params: {} },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toBe('not_found');
      expect(result.error.message).toMatch(/no github installation available/i);
    }
  });

  // ── Edge: GitHub App not configured ────────────────────────────────────

  it('fails when GitHub App is not configured but installation exists', async () => {
    seedUser();

    (getCredential as Mock).mockResolvedValueOnce({
      ok: false,
      error: { service: 'github', reason: 'not_found', message: 'No credentials' },
    });
    (getServiceMetadata as Mock).mockResolvedValueOnce({
      allowAnonymousGitHubAccess: true,
    });

    await upsertGithubInstallation(db as any, {
      githubInstallationId: '42',
      accountLogin: 'my-org',
      accountId: 'acct-1',
      accountType: 'Organization',
      repositorySelection: 'all',
    });

    // loadGitHubApp returns null (not configured)
    (loadGitHubApp as Mock).mockResolvedValueOnce(null);

    const result = await githubCredentialResolver(
      'github',
      makeEnv(db),
      USER_ID,
      { params: { owner: 'my-org' } },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toBe('not_found');
      expect(result.error.message).toMatch(/github app.*not configured/i);
    }
  });

  // ── Edge: User has no name/email (attribution fallback) ────────────────

  it('uses fallback attribution when user has no name', async () => {
    // Seed user with no name
    db.insert(users)
      .values({ id: USER_ID, email: 'anon@example.com', role: 'member' })
      .run();

    (getCredential as Mock).mockResolvedValueOnce({
      ok: false,
      error: { service: 'github', reason: 'not_found', message: 'No credentials' },
    });
    (getServiceMetadata as Mock).mockResolvedValueOnce({
      allowAnonymousGitHubAccess: true,
    });

    await upsertGithubInstallation(db as any, {
      githubInstallationId: '42',
      accountLogin: 'my-org',
      accountId: 'acct-1',
      accountType: 'Organization',
      repositorySelection: 'all',
    });

    const mockApp = { appId: '99' };
    (loadGitHubApp as Mock).mockResolvedValueOnce(mockApp);
    (getOrMintInstallationToken as Mock).mockResolvedValueOnce({
      token: 'ghs_bot',
      expiresAt: Date.now() + 3600_000,
    });

    const result = await githubCredentialResolver(
      'github',
      makeEnv(db),
      USER_ID,
      { params: { owner: 'my-org' } },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.credential.attribution).toEqual({
        name: 'anon@example.com',
        email: 'anon@example.com',
      });
    }
  });
});
