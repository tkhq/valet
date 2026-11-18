import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const { storeCredentialMock, reconcileMock, dbMocks } = vi.hoisted(() => ({
  storeCredentialMock: vi.fn(),
  reconcileMock: vi.fn(),
  dbMocks: {
    deleteIdentityLinkByExternalId: vi.fn(),
    getUserIdentityLinks: vi.fn(),
    deleteIdentityLink: vi.fn(),
    createIdentityLink: vi.fn(),
    ensureIntegration: vi.fn(),
    updateUserGitHub: vi.fn(),
    getUserById: vi.fn(),
  },
}));

vi.mock('../services/credentials.js', () => ({ storeCredential: storeCredentialMock }));
vi.mock('../services/github-installations.js', () => ({ reconcileUserInstallations: reconcileMock }));
vi.mock('../lib/db.js', () => dbMocks);
vi.mock('octokit', () => ({ Octokit: class {} }));

import { githubMeRouter } from './github-me.js';
import { sealGitHubLinkClaim, type GitHubLinkClaim } from '../services/github-link-claim.js';

const KEY = 'test-key';

function claimFor(userId: string): GitHubLinkClaim {
  return {
    v: 1,
    userId,
    githubId: '42',
    login: 'octocat',
    name: null,
    avatarUrl: null,
    accessToken: 'ghu_token',
    refreshToken: 'ghr_token',
    expiresAt: null,
    exp: Math.floor(Date.now() / 1000) + 300,
  };
}

function buildApp(sessionUserId: string) {
  const app = new Hono<{ Variables: { user: { id: string }; db: object } }>();
  app.use('*', async (c, next) => {
    c.set('user', { id: sessionUserId });
    c.set('db', {});
    await next();
  });
  app.route('/api/me/github', githubMeRouter as unknown as Hono<{ Variables: { user: { id: string }; db: object } }>);
  return app;
}

async function redeem(sessionUserId: string, claim: string) {
  return buildApp(sessionUserId).request(
    'http://localhost/api/me/github/link/claim',
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ claim }) },
    { ENCRYPTION_KEY: KEY },
  );
}

describe('POST /api/me/github/link/claim', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMocks.getUserIdentityLinks.mockResolvedValue([]);
  });

  it('refuses a claim started by another user and changes nothing', async () => {
    const res = await redeem('victim', await sealGitHubLinkClaim(claimFor('attacker'), KEY));

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'user_mismatch' });
    expect(dbMocks.deleteIdentityLinkByExternalId).not.toHaveBeenCalled();
    expect(dbMocks.createIdentityLink).not.toHaveBeenCalled();
    expect(storeCredentialMock).not.toHaveBeenCalled();
  });

  it('links the GitHub account to the signed-in user who started the flow', async () => {
    const res = await redeem('user-a', await sealGitHubLinkClaim(claimFor('user-a'), KEY));

    expect(res.status).toBe(200);
    expect(dbMocks.createIdentityLink).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ userId: 'user-a', provider: 'github', externalId: '42' }),
    );
    expect(storeCredentialMock).toHaveBeenCalledWith(
      expect.anything(),
      'user',
      'user-a',
      'github',
      { access_token: 'ghu_token', refresh_token: 'ghr_token' },
      expect.objectContaining({ credentialType: 'oauth2' }),
    );
  });

  it('rejects a missing claim', async () => {
    const res = await redeem('user-a', '');
    expect(res.status).toBe(400);
  });
});
