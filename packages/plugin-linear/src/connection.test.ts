import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PluginHttpRequest } from '@valet/engine';
import {
  createLinearConnectionHandlers, linearConnectionRoutes,
  type LinearConnectionCapability, type LinearConnectionSave,
} from './connection.js';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const APP = { clientId: 'app-id', clientSecret: 'app-secret', webhookSecret: 'signing-secret' };
const READY = { configured: true, clientId: 'app-id', connected: true, webhookConfigured: true, ready: true, workspaceName: 'Acme' };
const ENDPOINTS = { linearApiUrl: 'https://linear.fixture' };

function request(body = ''): PluginHttpRequest {
  return {
    url: 'http://api.test/api/plugins/linear/http/connection', headers: {}, params: {},
    rawBody: new TextEncoder().encode(body), signal: new AbortController().signal,
  };
}

function fakeCapability(overrides: Partial<LinearConnectionCapability> = {}) {
  const saved: LinearConnectionSave[] = [];
  const events: string[] = [];
  const capability: LinearConnectionCapability = {
    status: async () => READY,
    save: async (input) => { saved.push(input); return null; },
    legacyWebhooks: async () => null,
    disconnect: async () => { events.push('disconnect'); },
    ...overrides,
  };
  return { capability, saved, events };
}

/** Linear fixture: the token endpoint and the GraphQL endpoint. */
function stubLinear(handlers: { token?: () => Response; graphql?: (body: { query: string; variables?: Record<string, unknown> }) => Response } = {}) {
  const calls: string[] = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    calls.push(url);
    if (url.endsWith('/oauth/token')) return handlers.token?.() ?? Response.json({ access_token: 'app-token', expires_in: 60 });
    const body: { query: string; variables?: Record<string, unknown> } = JSON.parse(String(init.body));
    return handlers.graphql?.(body) ?? Response.json({ data: { organization: { id: 'workspace-1', name: 'Acme' }, viewer: { id: 'app' } } });
  });
  return calls;
}

describe('Linear connection route declarations', () => {
  it('declares three administrator routes with bounded bodies', () => {
    expect(linearConnectionRoutes.map(({ id, method, path, auth, maxBodyBytes }) => ({ id, method, path, auth, maxBodyBytes }))).toEqual([
      { id: 'connection-status', method: 'GET', path: '/connection', auth: 'org-admin', maxBodyBytes: 0 },
      { id: 'connection-save', method: 'PUT', path: '/connection', auth: 'org-admin', maxBodyBytes: 1024 * 1024 },
      { id: 'connection-delete', method: 'DELETE', path: '/connection', auth: 'org-admin', maxBodyBytes: 0 },
    ]);
  });
});

describe('Linear connection save', () => {
  it.each([
    ['malformed JSON', '{not json'],
    ['a JSON array', JSON.stringify([APP])],
    ['a missing secret', JSON.stringify({ ...APP, webhookSecret: undefined })],
    ['a blank client ID', JSON.stringify({ ...APP, clientId: '   ' })],
    ['an oversized client ID', JSON.stringify({ ...APP, clientId: 'x'.repeat(513) })],
    ['a non-string secret', JSON.stringify({ ...APP, clientSecret: 42 })],
  ])('refuses %s without calling Linear or storing anything', async (_name, body) => {
    const calls = stubLinear();
    const { capability, saved } = fakeCapability();
    const response = await createLinearConnectionHandlers(capability, ENDPOINTS)['connection-save'](request(body));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Enter the Linear app's client ID, client secret, and webhook signing secret." });
    expect(calls).toEqual([]);
    expect(saved).toEqual([]);
  });

  it('verifies with Linear, then saves trimmed values and returns the status', async () => {
    const calls = stubLinear();
    const { capability, saved } = fakeCapability();
    const body = JSON.stringify({ clientId: ' app-id ', clientSecret: 'app-secret', webhookSecret: 'signing-secret', orgId: 'foreign' });
    const response = await createLinearConnectionHandlers(capability, ENDPOINTS)['connection-save'](request(body));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ...READY, redirectUri: 'http://api.test/api/org/linear/callback' });
    expect(calls).toEqual(['https://linear.fixture/oauth/token', 'https://linear.fixture/graphql']);
    expect(saved).toEqual([{
      clientId: 'app-id', clientSecret: 'app-secret', webhookSecret: 'signing-secret',
      accessToken: 'app-token', expiresAt: expect.any(Number), workspaceId: 'workspace-1', workspaceName: 'Acme',
    }]);
    expect(Object.keys(saved[0])).not.toContain('orgId');
  });

  it.each([
    [{ error: 'unsupported_grant_type', error_description: 'Client does not support the client_credentials grant type' }, 'turn on Client credentials'],
    [{ error: 'invalid_client' }, 'Copy the client ID and client secret again'],
  ])('names the fix when Linear refuses the grant', async (refusal, fix) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    stubLinear({ token: () => Response.json(refusal, { status: 400 }) });
    const { capability, saved } = fakeCapability();
    const response = await createLinearConnectionHandlers(capability, ENDPOINTS)['connection-save'](request(JSON.stringify(APP)));
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toContain(fix);
    expect(saved).toEqual([]);
  });

  it('answers 502 when Linear is unreachable or the workspace lookup fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const handlers of [
      { token: () => Response.json({ error: 'boom' }, { status: 503 }) },
      { graphql: () => Response.json({ errors: [{ message: 'boom' }] }) },
    ]) {
      stubLinear(handlers);
      const { capability, saved } = fakeCapability();
      const response = await createLinearConnectionHandlers(capability, ENDPOINTS)['connection-save'](request(JSON.stringify(APP)));
      expect(response.status).toBe(502);
      expect(saved).toEqual([]);
    }
  });

  it('answers 409 when another workspace holds the organization', async () => {
    stubLinear();
    const { capability } = fakeCapability({ save: async () => ({ conflictWorkspaceName: 'Other' }) });
    const response = await createLinearConnectionHandlers(capability, ENDPOINTS)['connection-save'](request(JSON.stringify(APP)));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'Another Linear workspace (Other) is connected. Disconnect it first.' });
  });
});

describe('Linear connection status', () => {
  it('presents setup URLs from the public URL and offers only an HTTPS webhook URL', async () => {
    const { capability } = fakeCapability();
    const secure = await createLinearConnectionHandlers(capability, { ...ENDPOINTS, publicUrl: 'https://valet.example' })['connection-status'](request());
    expect(await secure.json()).toEqual({
      ...READY,
      redirectUri: 'https://valet.example/api/org/linear/callback',
      webhookUrl: 'https://valet.example/webhooks/events/linear',
      webhookResourceTypes: ['Issue', 'Comment', 'Project', 'Cycle', 'IssueLabel', 'Reaction'],
    });
    const plain = await createLinearConnectionHandlers(capability, { ...ENDPOINTS, publicUrl: 'http://valet.internal' })['connection-status'](request());
    expect(await plain.json()).not.toHaveProperty('webhookUrl');
  });
});

describe('Linear connection disconnect', () => {
  it('deletes legacy webhooks with the stored token, then disconnects even when deletion fails', async () => {
    const deleted: unknown[] = [];
    stubLinear({ graphql: (body) => {
      deleted.push(body.variables?.id);
      return body.variables?.id === 'bad' ? Response.json({ errors: [{ message: 'boom' }] }) : Response.json({ data: { webhookDelete: { success: true } } });
    } });
    const { capability, events } = fakeCapability({ legacyWebhooks: async () => ({ accessToken: 'org-token', webhookIds: ['bad', 'good'] }) });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const response = await createLinearConnectionHandlers(capability, ENDPOINTS)['connection-delete'](request());
    expect(response.status).toBe(204);
    expect(deleted).toEqual(['bad', 'good']);
    expect(events).toEqual(['disconnect']);
  });

  it('disconnects without provider calls when no legacy webhook exists', async () => {
    const calls = stubLinear();
    const { capability, events } = fakeCapability();
    expect((await createLinearConnectionHandlers(capability, ENDPOINTS)['connection-delete'](request())).status).toBe(204);
    expect(calls).toEqual([]);
    expect(events).toEqual(['disconnect']);
  });
});
