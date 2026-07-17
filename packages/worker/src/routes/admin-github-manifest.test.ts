import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env, Variables } from '../env.js';

const {
  getServiceConfigMock,
  setServiceConfigMock,
  getOrgSettingsMock,
  signJWTMock,
} = vi.hoisted(() => ({
  getServiceConfigMock: vi.fn(),
  setServiceConfigMock: vi.fn(),
  getOrgSettingsMock: vi.fn(),
  signJWTMock: vi.fn(),
}));

vi.mock('../lib/db/service-configs.js', () => ({
  getServiceConfig: getServiceConfigMock,
  setServiceConfig: setServiceConfigMock,
  deleteServiceConfig: vi.fn(),
  updateServiceMetadata: vi.fn(),
  getServiceMetadata: vi.fn(),
}));

vi.mock('../lib/jwt.js', () => ({
  signJWT: signJWTMock,
  verifyJWT: vi.fn(),
}));

vi.mock('../lib/db.js', () => ({
  getOrgSettings: getOrgSettingsMock,
}));

vi.mock('../lib/drizzle.js', () => ({
  getDb: vi.fn().mockReturnValue({}),
}));

// Must import after mocks
import { adminGitHubRouter } from './admin-github.js';

const WORKER_URL = 'https://worker.example.com';

function buildApp() {
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();
  app.use('*', async (c, next) => {
    (c as any).set('user', { id: 'admin-1', email: 'admin@example.com', role: 'admin' });
    (c as any).set('db', {} as any);
    await next();
  });
  app.route('/', adminGitHubRouter);
  return app;
}

describe('POST /app/manifest webhook URL', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getServiceConfigMock.mockResolvedValue(null); // app not yet configured
    getOrgSettingsMock.mockResolvedValue({ name: 'Acme' });
    signJWTMock.mockResolvedValue('signed-state');
    setServiceConfigMock.mockResolvedValue(undefined);
  });

  async function requestManifest(): Promise<{ manifest: { hook_attributes: { url: string } } }> {
    const app = buildApp();
    const res = await app.request(
      '/app/manifest',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ githubOrg: 'acme' }),
      },
      { API_PUBLIC_URL: WORKER_URL, ENCRYPTION_KEY: 'k', DB: {} } as unknown as Env,
    );
    expect(res.status).toBe(200);
    return res.json();
  }

  it('points the webhook hook_attributes at /webhooks/github, NOT under /api/', async () => {
    const { manifest } = await requestManifest();
    const hookUrl = manifest.hook_attributes.url;

    // The bug (TKAI-177): /api/* is behind authMiddleware, so an /api/webhooks
    // URL 401s GitHub's unauthenticated deliveries.
    expect(hookUrl).toBe(`${WORKER_URL}/webhooks/github`);
    expect(new URL(hookUrl).pathname.startsWith('/api/')).toBe(false);
  });
});
