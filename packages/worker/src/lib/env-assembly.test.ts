import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createTestDb } from '../test-utils/db.js';
import { users } from './schema/users.js';
import { upsertGithubInstallation } from './db/github-installations.js';
import type { Env } from '../env.js';

// ── Mocks ──────────────────────────────────────────────────────────────────

vi.mock('../services/credentials.js', () => ({
  getCredential: vi.fn(),
}));

vi.mock('../services/github-app.js', () => ({
  loadGitHubApp: vi.fn(),
  mintInstallationToken: vi.fn(),
}));

vi.mock('./db/service-configs.js', () => ({
  getServiceMetadata: vi.fn(),
}));

// ── Imports (after mocks) ──────────────────────────────────────────────────

const { getCredential } = await import('../services/credentials.js');
const { loadGitHubApp, mintInstallationToken } = await import('../services/github-app.js');
const { getServiceMetadata } = await import('./db/service-configs.js');
const { assembleRepoEnv } = await import('./env-assembly.js');

// ── Helpers ────────────────────────────────────────────────────────────────

const USER_ID = 'user-b';
const REPO_URL = 'https://github.com/alice/private-repo';

const mockGetCredential = vi.mocked(getCredential);
const mockLoadGitHubApp = vi.mocked(loadGitHubApp);
const mockMintInstallationToken = vi.mocked(mintInstallationToken);
const mockGetServiceMetadata = vi.mocked(getServiceMetadata);

describe('assembleRepoEnv — installation token fallback authorization', () => {
  let db: ReturnType<typeof createTestDb>['db'];

  const env = { DB: {}, ENCRYPTION_KEY: 'test-key' } as unknown as Env;

  beforeEach(() => {
    db = createTestDb().db;
    vi.clearAllMocks();

    db.insert(users)
      .values({ id: USER_ID, email: 'bob@example.com', name: 'Bob', role: 'member' })
      .run();

    mockLoadGitHubApp.mockResolvedValue({} as never);
    mockMintInstallationToken.mockResolvedValue({
      token: 'ghs_installation_token',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    } as never);
  });

  /** An installation the app holds for Alice's account — not for the caller. */
  async function seedAliceInstallation() {
    await upsertGithubInstallation(db, {
      githubInstallationId: '4242',
      accountLogin: 'alice',
      accountId: '1',
      accountType: 'User',
      repositorySelection: 'all',
    });
  }

  /** The caller has no GitHub of their own. */
  function noUserCredential() {
    mockGetCredential.mockResolvedValue({
      ok: false,
      error: { service: 'github', reason: 'not_found', message: 'No credentials for github' },
    });
  }

  it('mints no token for an unlinked user when the org has not allowed anonymous access', async () => {
    await seedAliceInstallation();
    noUserCredential();
    mockGetServiceMetadata.mockResolvedValue({ allowAnonymousGitHubAccess: false });

    const result = await assembleRepoEnv(db as never, env, USER_ID, undefined, { repoUrl: REPO_URL });

    // Naming a repo under a login the app is installed on must not be enough to
    // be handed a push-capable token for it.
    expect(mockMintInstallationToken).not.toHaveBeenCalled();
    expect(result.token).toBeUndefined();
    expect(result.error).toContain('No github credentials found');
  });

  it('mints no token when the org setting is absent, matching the resolver default', async () => {
    await seedAliceInstallation();
    noUserCredential();
    mockGetServiceMetadata.mockResolvedValue(null);

    const result = await assembleRepoEnv(db as never, env, USER_ID, undefined, { repoUrl: REPO_URL });

    expect(mockMintInstallationToken).not.toHaveBeenCalled();
    expect(result.token).toBeUndefined();
    expect(result.error).toContain('No github credentials found');
  });

  it('mints no token when the metadata read fails', async () => {
    await seedAliceInstallation();
    noUserCredential();
    mockGetServiceMetadata.mockRejectedValue(new Error('d1 unavailable'));

    const result = await assembleRepoEnv(db as never, env, USER_ID, undefined, { repoUrl: REPO_URL });

    expect(mockMintInstallationToken).not.toHaveBeenCalled();
    expect(result.token).toBeUndefined();
  });

  it('mints no token for an installation not linked to the caller, even with anonymous access on', async () => {
    await seedAliceInstallation();
    noUserCredential();
    mockGetServiceMetadata.mockResolvedValue({ allowAnonymousGitHubAccess: true });

    const result = await assembleRepoEnv(db as never, env, USER_ID, undefined, { repoUrl: REPO_URL });

    // The installation belongs to Alice's account and is not linked to user-b.
    // allowAnonymousGitHubAccess is an org-wide toggle that defaults on, so it is
    // not authority for user-b to mint a token against someone else's account.
    expect(mockMintInstallationToken).not.toHaveBeenCalled();
    expect(result.token).toBeUndefined();
    expect(result.error).toContain('No github credentials found');
  });

  it('mints an installation token when the installation is linked to the caller', async () => {
    // The caller installed the app themselves, so the installation carries their
    // user id — that link, not the org-wide flag, is the authorization.
    await upsertGithubInstallation(db, {
      githubInstallationId: '4242',
      accountLogin: 'alice',
      accountId: '1',
      accountType: 'User',
      repositorySelection: 'all',
      linkedUserId: USER_ID,
    });
    noUserCredential();
    mockGetServiceMetadata.mockResolvedValue({ allowAnonymousGitHubAccess: true });

    const result = await assembleRepoEnv(db as never, env, USER_ID, undefined, { repoUrl: REPO_URL });

    expect(mockMintInstallationToken).toHaveBeenCalledTimes(1);
    expect(result.token).toBe('ghs_installation_token');
    expect(result.error).toBeUndefined();
  });

  it('uses a linked user own token and never reaches the installation fallback', async () => {
    await seedAliceInstallation();
    mockGetCredential.mockResolvedValue({
      ok: true,
      credential: {
        accessToken: 'gho_user_token',
        expiresAt: new Date(Date.now() + 3_600_000),
        credentialType: 'oauth2',
        refreshed: false,
      },
    });
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ permissions: { push: true } })));

    const result = await assembleRepoEnv(db as never, env, USER_ID, undefined, { repoUrl: REPO_URL });

    expect(result.token).toBe('gho_user_token');
    expect(mockMintInstallationToken).not.toHaveBeenCalled();
    // A linked user is authorized by their own credential, so the org-wide
    // anonymous-access setting is not consulted at all.
    expect(mockGetServiceMetadata).not.toHaveBeenCalled();
  });

  it('mints no token when no installation exists for the repo owner', async () => {
    noUserCredential();
    mockGetServiceMetadata.mockResolvedValue({ allowAnonymousGitHubAccess: true });

    const result = await assembleRepoEnv(db as never, env, USER_ID, undefined, { repoUrl: REPO_URL });

    expect(mockMintInstallationToken).not.toHaveBeenCalled();
    expect(result.error).toContain('No github credentials found');
  });
});
