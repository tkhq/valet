import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const {
  loadGitHubAppMock,
  signJWTMock,
  verifyJWTMock,
  storeCredentialMock,
  finalizeIdentityLoginMock,
  reconcileUserInstallationsMock,
  findUserByEmailMock,
  deleteIdentityLinkByExternalIdMock,
  getUserIdentityLinksMock,
  createIdentityLinkMock,
  deleteIdentityLinkMock,
  ensureIntegrationMock,
  updateUserGitHubMock,
  getAuthenticatedMock,
} = vi.hoisted(() => ({
  loadGitHubAppMock: vi.fn(),
  signJWTMock: vi.fn(),
  verifyJWTMock: vi.fn(),
  storeCredentialMock: vi.fn(),
  finalizeIdentityLoginMock: vi.fn(),
  reconcileUserInstallationsMock: vi.fn(),
  findUserByEmailMock: vi.fn(),
  deleteIdentityLinkByExternalIdMock: vi.fn(),
  getUserIdentityLinksMock: vi.fn(),
  createIdentityLinkMock: vi.fn(),
  deleteIdentityLinkMock: vi.fn(),
  ensureIntegrationMock: vi.fn(),
  updateUserGitHubMock: vi.fn(),
  getAuthenticatedMock: vi.fn(),
}));

vi.mock('octokit', () => ({
  Octokit: class {
    rest = { users: { getAuthenticated: getAuthenticatedMock, listEmailsForAuthenticatedUser: vi.fn() } };
  },
}));

vi.mock('../services/github-app.js', () => ({
  loadGitHubApp: loadGitHubAppMock,
}));

vi.mock('../lib/jwt.js', () => ({
  signJWT: signJWTMock,
  verifyJWT: verifyJWTMock,
}));

vi.mock('../services/credentials.js', () => ({
  storeCredential: storeCredentialMock,
}));

vi.mock('../services/oauth.js', () => ({
  finalizeIdentityLogin: finalizeIdentityLoginMock,
}));

vi.mock('../services/github-installations.js', () => ({
  reconcileUserInstallations: reconcileUserInstallationsMock,
}));

vi.mock('../lib/db.js', () => ({
  findUserByEmail: findUserByEmailMock,
  deleteIdentityLinkByExternalId: deleteIdentityLinkByExternalIdMock,
  getUserIdentityLinks: getUserIdentityLinksMock,
  createIdentityLink: createIdentityLinkMock,
  deleteIdentityLink: deleteIdentityLinkMock,
  ensureIntegration: ensureIntegrationMock,
  updateUserGitHub: updateUserGitHubMock,
}));

vi.mock('../lib/drizzle.js', () => ({
  getDb: vi.fn().mockReturnValue({}),
}));

// Must import after mocks
import { githubAuthRouter } from './github-auth.js';
import { openGitHubLinkClaim } from '../services/github-link-claim.js';

const FRONTEND_URL = 'http://localhost:5173';
const PAGES_FRONTEND_URL = 'https://dev-valet-client.pages.dev';

function buildApp() {
  const app = new Hono();
  app.route('/auth/github', githubAuthRouter);
  return app;
}

function buildEnv(overrides: Record<string, unknown> = {}) {
  return {
    FRONTEND_URL,
    ENCRYPTION_KEY: 'test-key',
    DB: {},
    ...overrides,
  };
}

function mockGitHubAppAuthorizeUrl(mockUrl = 'https://github.com/login/oauth/authorize?client_id=test&state=jwt') {
  const getWebFlowAuthorizationUrl = vi.fn().mockReturnValue({ url: mockUrl });
  loadGitHubAppMock.mockResolvedValue({
    oauth: {
      getWebFlowAuthorizationUrl,
    },
  });
  signJWTMock.mockResolvedValue('signed-state-jwt');
  return { mockUrl, getWebFlowAuthorizationUrl };
}

describe('githubAuthRouter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('GET / (login initiation)', () => {
    it('redirects to GitHub authorize URL when App is configured', async () => {
      const { mockUrl } = mockGitHubAppAuthorizeUrl();

      const app = buildApp();
      const res = await app.request(
        'http://localhost/auth/github',
        { method: 'GET' },
        buildEnv(),
      );

      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe(mockUrl);
    });

    it('stores valid preview return origins in login state', async () => {
      mockGitHubAppAuthorizeUrl();

      const app = buildApp();
      const res = await app.request(
        'http://localhost/auth/github?return_to_origin=https%3A%2F%2Fpr-123.dev-valet-client.pages.dev',
        { method: 'GET' },
        buildEnv({
          FRONTEND_URL: PAGES_FRONTEND_URL,
          FRONTEND_PREVIEW_ORIGIN_SUFFIX: 'dev-valet-client.pages.dev',
        }),
      );

      expect(res.status).toBe(302);
      expect(signJWTMock).toHaveBeenCalledWith(
        expect.objectContaining({
          return_to_origin: 'https://pr-123.dev-valet-client.pages.dev',
        }),
        'test-key',
      );
    });

    it('omits invalid preview return origins from login state', async () => {
      mockGitHubAppAuthorizeUrl();

      const app = buildApp();
      const res = await app.request(
        'http://localhost/auth/github?return_to_origin=https%3A%2F%2Fevil.example.com',
        { method: 'GET' },
        buildEnv({
          FRONTEND_URL: PAGES_FRONTEND_URL,
          FRONTEND_PREVIEW_ORIGIN_SUFFIX: 'dev-valet-client.pages.dev',
        }),
      );

      expect(res.status).toBe(302);
      expect(signJWTMock).toHaveBeenCalledWith(
        expect.not.objectContaining({
          return_to_origin: expect.any(String),
        }),
        'test-key',
      );
    });

    it('redirects to login error when App is not configured', async () => {
      loadGitHubAppMock.mockResolvedValue(null);

      const app = buildApp();
      const res = await app.request(
        'http://localhost/auth/github',
        { method: 'GET' },
        buildEnv(),
      );

      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe(
        `${FRONTEND_URL}/login?error=github_not_configured`,
      );
    });
  });

  describe('GET /callback', () => {
    it('rejects missing code/state params', async () => {
      const app = buildApp();
      const res = await app.request(
        'http://localhost/auth/github/callback',
        { method: 'GET' },
        buildEnv(),
      );

      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe(
        `${FRONTEND_URL}/login?error=missing_params`,
      );
    });

    it('rejects invalid state JWT', async () => {
      verifyJWTMock.mockResolvedValue(null);

      const app = buildApp();
      const res = await app.request(
        'http://localhost/auth/github/callback?code=test-code&state=bad-jwt',
        { method: 'GET' },
        buildEnv(),
      );

      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe(
        `${FRONTEND_URL}/login?error=invalid_state`,
      );
    });

    it('link flow persists nothing and hands the frontend a claim for the initiating user', async () => {
      verifyJWTMock.mockResolvedValue({ sub: 'user-a', purpose: 'github-link', exp: 9_999_999_999 });
      loadGitHubAppMock.mockResolvedValue({
        oauth: {
          createToken: vi.fn().mockResolvedValue({ authentication: { token: 'ghu_token' } }),
        },
      });
      getAuthenticatedMock.mockResolvedValue({
        data: { id: 42, login: 'octocat', email: 'o@example.com', name: null, avatar_url: '' },
      });

      const app = buildApp();
      const res = await app.request(
        'http://localhost/auth/github/callback?code=test-code&state=link-jwt',
        { method: 'GET' },
        buildEnv(),
      );

      expect(res.status).toBe(302);
      const location = new URL(res.headers.get('location') ?? '');
      expect(`${location.origin}${location.pathname}`).toBe(`${FRONTEND_URL}/integrations`);
      expect(location.searchParams.get('github')).toBe('claim');
      const opened = await openGitHubLinkClaim(location.searchParams.get('claim') ?? '', 'test-key', 'user-a');
      expect(opened).toMatchObject({ ok: true, claim: { userId: 'user-a', githubId: '42', accessToken: 'ghu_token' } });

      expect(createIdentityLinkMock).not.toHaveBeenCalled();
      expect(deleteIdentityLinkByExternalIdMock).not.toHaveBeenCalled();
      expect(storeCredentialMock).not.toHaveBeenCalled();
      expect(updateUserGitHubMock).not.toHaveBeenCalled();
    });
  });
});
