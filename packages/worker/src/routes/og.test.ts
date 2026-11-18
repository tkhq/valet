import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const { dbMocks } = vi.hoisted(() => ({
  dbMocks: {
    getSession: vi.fn(),
    getShareLink: vi.fn(),
    getSessionGitState: vi.fn(),
    getInviteByCodeAny: vi.fn(),
    getOrgSettings: vi.fn(),
  },
}));

vi.mock('../lib/db.js', () => dbMocks);
vi.mock('@cf-wasm/satori/workerd', () => ({ default: vi.fn() }));
vi.mock('@cf-wasm/resvg/workerd', () => ({ Resvg: { async: vi.fn() } }));

import { ogRouter } from './og.js';

function buildApp() {
  const app = new Hono<{ Variables: { db: object } }>();
  app.use('*', async (c, next) => {
    c.set('db', {});
    await next();
  });
  app.route('/og', ogRouter as unknown as Hono<{ Variables: { db: object } }>);
  return app;
}

const SESSION = { id: 'sess-1', title: 'Rotate prod keys', workspace: 'infra' };

describe('session OG metadata', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMocks.getSession.mockResolvedValue(SESSION);
    dbMocks.getSessionGitState.mockResolvedValue({ sourceRepoFullName: 'acme/secret-repo' });
  });

  it('returns generic metadata for a bare session ID without reading the session', async () => {
    const res = await buildApp().request('http://localhost/og/meta/session/sess-1');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(JSON.stringify(body)).not.toMatch(/Rotate prod keys|secret-repo|infra/);
    expect(body).toMatchObject({ title: 'Valet session' });
    expect(dbMocks.getSession).not.toHaveBeenCalled();
  });

  it('returns the same response for an unknown session ID', async () => {
    dbMocks.getSession.mockResolvedValue(null);
    const res = await buildApp().request('http://localhost/og/meta/session/missing');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ title: 'Valet session', description: 'Valet session' });
  });

  it('returns session details for an active share link', async () => {
    dbMocks.getShareLink.mockResolvedValue({ sessionId: 'sess-1' });

    const res = await buildApp().request('http://localhost/og/meta/session-token/tok-1');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      title: 'Join session: Rotate prod keys',
      description: 'acme/secret-repo · infra',
      imageUrl: 'http://localhost/og/image/session-token/tok-1',
    });
  });

  it('rejects an unknown or inactive share link', async () => {
    dbMocks.getShareLink.mockResolvedValue(null);

    const res = await buildApp().request('http://localhost/og/meta/session-token/nope');

    expect(res.status).toBe(404);
    expect(dbMocks.getSession).not.toHaveBeenCalled();
  });
});
