import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { AppEnv } from '../env.js';
import { eq } from 'drizzle-orm';
import type { PluginHttpRequest, PluginHttpCaller, ValetPlugin } from '@valet/engine';
import { bootTestApi, type TestApi } from '../integration/_setup.js';
import type { CreateTeamResponse, CreateTeamApiKeyResponse } from '../wire/types.js';
import { orgMembers } from '../schema/index.js';
import { mountPluginHttpRoutes, readPluginBody } from './http-routes.js';

let api: TestApi | undefined;
afterEach(async () => { await api?.cleanup(); api = undefined; });

const handle = vi.fn((_request: PluginHttpRequest, caller: PluginHttpCaller) => Response.json(caller));
const plugin: ValetPlugin = {
  name: 'route-test', version: '1', httpRoutes: [
    { id: 'public', path: '/ping', method: 'GET', maxBodyBytes: 0, auth: 'public', handle: () => new Response('pong') },
    { id: 'user', path: '/items/:id', method: 'POST', maxBodyBytes: 64, auth: 'user', handle },
    { id: 'admin', path: '/admin', method: 'POST', maxBodyBytes: 64, auth: 'org-admin', handle },
  ],
};

describe('plugin route mounting', () => {
  it('strips host credentials while preserving provider signature headers and bytes', async () => {
    const app = new Hono<AppEnv>();
    let received: PluginHttpRequest | undefined;
    mountPluginHttpRoutes(app, [{ name: 'header-test', version: '1', httpRoutes: [{
      id: 'headers', path: '/headers', method: 'POST', maxBodyBytes: 64, auth: 'public',
      handle: (request) => { received = request; return new Response('ok'); },
    }] }], 'public');
    const response = await app.request('/plugins/header-test/http/headers', {
      method: 'POST', body: 'exact body', headers: {
        cookie: 'session=secret', authorization: 'Bearer secret', 'x-api-key': 'secret',
        'x-valet-sandbox': 'secret', 'x-valet-test-user-id': 'secret', 'x-valet-internal': 'secret', 'linear-signature': 'signature',
      },
    });
    expect(response.status).toBe(200);
    expect(received?.headers['linear-signature']).toBe('signature');
    for (const header of ['cookie', 'authorization', 'x-api-key', 'x-valet-sandbox', 'x-valet-test-user-id', 'x-valet-internal']) {
      expect(received?.headers[header]).toBeUndefined();
    }
    expect(new TextDecoder().decode(received?.rawBody)).toBe('exact body');
  });

  it('does not treat inherited object properties as legacy route aliases', async () => {
    const app = new Hono<AppEnv>();
    mountPluginHttpRoutes(app, [{ name: 'linear', version: '1', httpRoutes: [{
      id: 'constructor', method: 'GET', path: '/status', auth: 'public', maxBodyBytes: 0,
      handle: () => new Response('ok'),
    }] }], 'public');
    expect(await (await app.request('/plugins/linear/http/status')).text()).toBe('ok');
    expect((await app.request('/webhooks/events/linear')).status).toBe(404);
  });

  it('refuses Slack bindings and compatibility URLs with a different method or authentication', () => {
    const handle = () => new Response('ok');
    expect(() => mountPluginHttpRoutes(new Hono<AppEnv>(), [{ name: 'slack', version: '1', httpRoutes: [{
      id: 'events', method: 'POST', path: '/events', auth: 'org-admin', maxBodyBytes: 0, handle,
    }] }], 'authenticated')).toThrow('Host binding for slack route events requires public authentication.');
    expect(() => mountPluginHttpRoutes(new Hono<AppEnv>(), [{ name: 'slack', version: '1', httpRoutes: [{
      id: 'app', method: 'POST', path: '/app', auth: 'org-admin', maxBodyBytes: 0, handle,
    }] }], 'authenticated')).toThrow('Compatibility route GET /api/org/slack requires org-admin authentication.');
  });

  it('refuses GitHub bindings and compatibility URLs with a different method or authentication', () => {
    const handle = () => new Response('ok');
    expect(() => mountPluginHttpRoutes(new Hono<AppEnv>(), [{ name: 'github', version: '1', httpRoutes: [{
      id: 'webhook', method: 'POST', path: '/webhook', auth: 'user', maxBodyBytes: 0, handle,
    }] }], 'authenticated')).toThrow('Host binding for github route webhook requires public authentication.');
    expect(() => mountPluginHttpRoutes(new Hono<AppEnv>(), [{ name: 'github', version: '1', httpRoutes: [{
      id: 'app-status', method: 'POST', path: '/app', auth: 'org-admin', maxBodyBytes: 0, handle,
    }] }], 'authenticated')).toThrow('Compatibility route GET /api/org/github-app requires org-admin authentication.');
  });

  it('mounts public handlers without authentication and refuses anonymous protected handlers', async () => {
    api = await bootTestApi({ plugins: [plugin], auth: true });
    handle.mockClear();
    expect(await (await fetch(`${api.baseUrl}/plugins/route-test/http/ping`)).text()).toBe('pong');
    const response = await fetch(`${api.baseUrl}/api/plugins/route-test/http/items/one`, { method: 'POST' });
    expect(response.status).toBe(401);
    expect(handle).not.toHaveBeenCalled();
    const signup = await fetch(`${api.baseUrl}/api/auth/sign-up/email`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'plugin@nowhere.test', name: 'Admin', password: 'correct-horse-battery' }),
    });
    const cookie = signup.headers.get('set-cookie')?.match(/better-auth\.session_token=[^;]+/)?.[0];
    if (!cookie) throw new Error('Missing session cookie');
    // These casts describe fixture responses from the real team-key endpoints.
    const team = await (await fetch(`${api.baseUrl}/api/teams`, {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Plugin team' }),
    })).json() as CreateTeamResponse;
    const key = await (await fetch(`${api.baseUrl}/api/teams/${team.team.id}/api-keys`, {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'CI' }),
    })).json() as CreateTeamApiKeyResponse;
    expect((await fetch(`${api.baseUrl}/api/plugins/route-test/http/admin`, {
      method: 'POST', headers: { 'x-api-key': key.key },
    })).status).toBe(403);
    expect(handle).not.toHaveBeenCalled();
  });

  it('uses host identity, checks membership and gates administrators before calling plugins', async () => {
    api = await bootTestApi({ plugins: [plugin] });
    handle.mockClear();
    const url = `${api.baseUrl}/api/plugins/route-test/http`;
    const request = { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"orgId":"foreign"}' };
    const response = await fetch(`${url}/items/one`, request);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ userId: 'local-user', orgId: 'local-org' });
    expect(handle.mock.calls[0][0].params).toEqual({ id: 'one' });
    expect((await fetch(`${url}/admin`, request)).status).toBe(200);
    handle.mockClear();
    expect((await fetch(`${url}/items/one`, { ...request, body: 'x'.repeat(65) })).status).toBe(413);
    expect(handle).not.toHaveBeenCalled();
    await api.providers.db.update(orgMembers).set({ role: 'member' }).where(eq(orgMembers.userId, 'local-user'));
    handle.mockClear();
    expect((await fetch(`${url}/admin`, request)).status).toBe(403);
    expect(handle).not.toHaveBeenCalled();
    await api.providers.db.delete(orgMembers).where(eq(orgMembers.userId, 'local-user'));
    expect((await fetch(`${url}/items/one`, request)).status).toBe(403);
    expect(handle).not.toHaveBeenCalled();
  });
});

describe('bounded request bodies', () => {
  it('keeps exact bytes', async () => {
    const bytes = new Uint8Array([0, 255, 32, 13, 10]);
    expect(await readPluginBody(new Request('https://example.test', { method: 'POST', body: bytes }), 5)).toEqual(bytes);
  });
  it.each([undefined, '1'])('cancels an oversized stream with content-length %s', async (length) => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(new Uint8Array(4)); }, cancel,
    });
    // Node requires duplex for streaming request fixtures.
    const init: RequestInit & { duplex: 'half' } = { method: 'POST', body, duplex: 'half', headers: length ? { 'content-length': length } : {} };
    const result = await readPluginBody(new Request('https://example.test', init), 5);
    expect(result).toBeNull();
    expect(cancel).toHaveBeenCalledOnce();
  });
});
