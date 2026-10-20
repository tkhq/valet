import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ActionPlugin, Credential, CredentialProvider } from '@valet/engine';
import { isMcpActionPlugin, mcpActionPlugin } from './action-plugin.js';
import { parseBearerChallenge } from './probe.js';
import type { McpTool } from './types.js';

// ── fixtures ─────────────────────────────────────────────────────────

function jsonResponse(body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/** An MCP server whose `tools/list` answers with `tools`, or with an HTTP
 * failure and an optional `WWW-Authenticate` challenge. Records the bearer
 * token each `tools/list` carried. */
function fakeServer(opts: {
  tools?: McpTool[];
  failure?: { status: number; wwwAuthenticate?: string };
  bearers?: string[];
}) {
  return vi.fn(async (_url: string | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { method: string; id?: number };
    if (body.method === 'initialize') {
      return jsonResponse(
        {
          jsonrpc: '2.0',
          id: body.id,
          result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'fake', version: '1' } },
        },
        { 'mcp-session-id': 'sess-1' },
      );
    }
    if (body.method === 'notifications/initialized') return jsonResponse({});
    if (body.method === 'tools/list') {
      const headers = new Headers(init?.headers);
      opts.bearers?.push(headers.get('authorization') ?? '');
      if (opts.failure) {
        return new Response('refused', {
          status: opts.failure.status,
          headers: opts.failure.wwwAuthenticate ? { 'www-authenticate': opts.failure.wwwAuthenticate } : {},
        });
      }
      return jsonResponse({ jsonrpc: '2.0', id: body.id, result: { tools: opts.tools ?? [] } });
    }
    throw new Error(`unexpected MCP method in test fixture: ${body.method}`);
  });
}

function provider(personal: Credential | null, app?: { service: string; credential: Credential }): CredentialProvider {
  return {
    get: async (service?: string) => (app && service === app.service ? app.credential : personal),
    request: async () => {
      throw new Error('request() not implemented in test fixture');
    },
  };
}

/** Metabase 1.64's shape: every tool listed, each naming its scope. */
const metabaseTools: McpTool[] = [
  { name: 'search', securitySchemes: [{ type: 'oauth2', scopes: ['agent:content:read'] }] },
  { name: 'browse_data', securitySchemes: [{ type: 'oauth2', scopes: ['agent:content:read'] }] },
  { name: 'execute_query', securitySchemes: [{ type: 'oauth2', scopes: ['agent:query:run'] }] },
];

function metabase() {
  return mcpActionPlugin({ mcpUrl: 'https://mb.test/api/mcp', serviceName: 'metabase', defaultRiskLevel: 'medium' });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── probe ────────────────────────────────────────────────────────────

describe('McpActionPlugin.probe on a listed server', () => {
  it('names the scope the grant lacks and counts the tools it blocks', async () => {
    vi.stubGlobal('fetch', fakeServer({ tools: metabaseTools }));
    const result = await metabase().probe({
      credentials: provider({ accessToken: 't', scopes: ['agent:query:run', 'agent:sql:run'] }),
    });
    expect(result).toEqual({ kind: 'listed', toolCount: 3, missingScopes: ['agent:content:read'], blockedTools: 2 });
  });

  it('reports nothing missing when the grant holds every declared scope', async () => {
    vi.stubGlobal('fetch', fakeServer({ tools: metabaseTools }));
    const result = await metabase().probe({
      credentials: provider({ accessToken: 't', scopes: ['agent:content:read', 'agent:query:run'] }),
    });
    expect(result).toEqual({ kind: 'listed', toolCount: 3, missingScopes: [], blockedTools: 0 });
  });

  it('treats a noauth scheme, or any one satisfied alternative, as callable', async () => {
    const tools: McpTool[] = [
      { name: 'public', securitySchemes: [{ type: 'noauth' }, { type: 'oauth2', scopes: ['x:write'] }] },
      {
        name: 'either',
        securitySchemes: [
          { type: 'oauth2', scopes: ['x:admin'] },
          { type: 'oauth2', scopes: ['x:read'] },
        ],
      },
      { name: 'plain' },
    ];
    vi.stubGlobal('fetch', fakeServer({ tools }));
    const result = await metabase().probe({ credentials: provider({ accessToken: 't', scopes: ['x:read'] }) });
    expect(result).toEqual({ kind: 'listed', toolCount: 3, missingScopes: [], blockedTools: 0 });
  });

  it('skips the scope check when the credential stores no grant', async () => {
    vi.stubGlobal('fetch', fakeServer({ tools: metabaseTools }));
    const result = await metabase().probe({ credentials: provider({ accessToken: 'pasted' }) });
    expect(result).toEqual({ kind: 'listed', toolCount: 3, missingScopes: [], blockedTools: 0 });
  });

  it('treats an empty grant as known: every scoped tool is blocked', async () => {
    vi.stubGlobal('fetch', fakeServer({ tools: metabaseTools }));
    const result = await metabase().probe({ credentials: provider({ accessToken: 't', scopes: [] }) });
    expect(result).toEqual({
      kind: 'listed',
      toolCount: 3,
      missingScopes: ['agent:content:read', 'agent:query:run'],
      blockedTools: 3,
    });
  });
});

describe('McpActionPlugin.probe on a refused listing', () => {
  it('reports rejected for a 401 (a token the server does not accept)', async () => {
    vi.stubGlobal(
      'fetch',
      fakeServer({ failure: { status: 401, wwwAuthenticate: 'Bearer error="invalid_token"' } }),
    );
    const plugin = mcpActionPlugin({ mcpUrl: 'https://mcp.pylon.test', serviceName: 'pylon', defaultRiskLevel: 'medium' });
    const result = await plugin.probe({ credentials: provider({ accessToken: 'pasted-api-key' }) });
    expect(result).toEqual({ kind: 'rejected' });
  });

  it('names the missing scope from a 403 insufficient_scope challenge, minus the scopes held', async () => {
    vi.stubGlobal(
      'fetch',
      fakeServer({
        failure: {
          status: 403,
          wwwAuthenticate: 'Bearer error="insufficient_scope", scope="agent:query:run agent:content:read"',
        },
      }),
    );
    const result = await metabase().probe({ credentials: provider({ accessToken: 't', scopes: ['agent:query:run'] }) });
    expect(result).toEqual({ kind: 'insufficient_scope', missingScopes: ['agent:content:read'] });
  });

  it('reports rejected for a 403 insufficient_scope that names no scope the grant lacks', async () => {
    vi.stubGlobal(
      'fetch',
      fakeServer({ failure: { status: 403, wwwAuthenticate: 'Bearer error="insufficient_scope", scope="a"' } }),
    );
    const result = await metabase().probe({ credentials: provider({ accessToken: 't', scopes: ['a'] }) });
    expect(result).toEqual({ kind: 'rejected' });
  });

  it('reports rejected for a 403 with no challenge', async () => {
    vi.stubGlobal('fetch', fakeServer({ failure: { status: 403 } }));
    const result = await metabase().probe({ credentials: provider({ accessToken: 't' }) });
    expect(result).toEqual({ kind: 'rejected' });
  });

  it('throws for a failure that says nothing about the credential (HTTP 500)', async () => {
    vi.stubGlobal('fetch', fakeServer({ failure: { status: 500 } }));
    await expect(metabase().probe({ credentials: provider({ accessToken: 't' }) })).rejects.toThrow('HTTP 500');
  });

  it('throws when no credential is connected', async () => {
    vi.stubGlobal('fetch', fakeServer({ tools: metabaseTools }));
    await expect(metabase().probe({ credentials: provider(null) })).rejects.toThrow('metabase: no credential connected');
  });
});

describe('McpActionPlugin.probe credential choice', () => {
  it('probes with the app identity, and its grant, when no personal credential is connected', async () => {
    const bearers: string[] = [];
    vi.stubGlobal('fetch', fakeServer({ tools: metabaseTools, bearers }));
    const plugin = mcpActionPlugin({
      mcpUrl: 'https://mb.test/api/mcp',
      serviceName: 'metabase',
      defaultRiskLevel: 'medium',
      appCredentialService: 'metabase:app',
    });
    const result = await plugin.probe({
      credentials: provider(null, {
        service: 'metabase:app',
        credential: { accessToken: 'app-token', scopes: ['agent:content:read', 'agent:query:run'] },
      }),
    });
    expect(bearers).toEqual(['Bearer app-token']);
    expect(result).toEqual({ kind: 'listed', toolCount: 3, missingScopes: [], blockedTools: 0 });
  });
});

describe('isMcpActionPlugin', () => {
  it('recognizes an MCP plugin, also after a spread (config-mcp spreads it)', () => {
    const plugin = metabase();
    expect(isMcpActionPlugin(plugin)).toBe(true);
    const spread: ActionPlugin = { ...plugin, displayName: 'Metabase' };
    expect(isMcpActionPlugin(spread)).toBe(true);
  });

  it('refuses a plain action plugin', () => {
    const plain: ActionPlugin = { service: 'plain', actions: [], resolveActions: async () => [] };
    expect(isMcpActionPlugin(plain)).toBe(false);
  });
});

// ── challenge parsing ────────────────────────────────────────────────

describe('parseBearerChallenge', () => {
  it('reads the error code and the scope list', () => {
    expect(
      parseBearerChallenge('Bearer error="insufficient_scope", scope="a b", error_description="needs b"'),
    ).toEqual({ error: 'insufficient_scope', scope: ['a', 'b'] });
  });

  it('accepts any case for the scheme and parameter names, and unquoted tokens', () => {
    expect(parseBearerChallenge('bearer Error=invalid_token')).toEqual({ error: 'invalid_token' });
  });

  it('reads a parameter only at a parameter boundary', () => {
    expect(parseBearerChallenge('Bearer error_description="the scope=\\"x\\" is gone", error="invalid_token"')).toEqual({
      error: 'invalid_token',
    });
  });

  it('returns nothing for another scheme', () => {
    expect(parseBearerChallenge('Basic realm="x"')).toEqual({});
  });
});
