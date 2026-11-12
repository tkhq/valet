import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildAuthorizationUrl, discoverAuthServer, exchangeCodePkce, refreshTokenPkce } from './oauth.js';

// ── fixtures ─────────────────────────────────────────────────────────

const AS_METADATA = {
  authorization_endpoint: 'https://auth.example.com/authorize',
  token_endpoint: 'https://auth.example.com/token',
  registration_endpoint: 'https://auth.example.com/register',
};

/** Map of exact URL → JSON body. Any URL not in the map gets a 404. */
function mockFetchRoutes(routes: Record<string, unknown>): ReturnType<typeof vi.fn> {
  const calls: string[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    const body = routes[url];
    if (body === undefined) {
      return new Response('not found', { status: 404 });
    }
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── discoverAuthServer ───────────────────────────────────────────────

describe('discoverAuthServer', () => {
  it('follows protected-resource metadata to the authorization server (Notion/Cloudflare shape)', async () => {
    // Real-world shape: the MCP server lives at /mcp, PRM lives at the
    // origin root with the path inserted AFTER the well-known segment
    // (RFC 9728), and points at a separate issuer.
    const fetchMock = mockFetchRoutes({
      'https://mcp.example.com/.well-known/oauth-protected-resource/mcp': {
        resource: 'https://mcp.example.com/mcp',
        authorization_servers: ['https://auth.example.com'],
      },
      'https://auth.example.com/.well-known/oauth-authorization-server': AS_METADATA,
    });

    const meta = await discoverAuthServer('https://mcp.example.com/mcp');
    expect(meta.authorization_endpoint).toBe(AS_METADATA.authorization_endpoint);
    expect(meta.token_endpoint).toBe(AS_METADATA.token_endpoint);
    // Never the pre-fix suffix form as the first probe.
    expect(fetchMock.mock.calls[0]?.[0]).not.toBe(
      'https://mcp.example.com/mcp/.well-known/oauth-authorization-server',
    );
  });

  it('returns the scopes the protected resource advertises apart from the issuer scopes', async () => {
    // Metabase 1.64 shape: the resource gates tools on five scopes, while
    // the issuer also lists the scopes of the older tool surface.
    mockFetchRoutes({
      'https://mb.example.com/.well-known/oauth-protected-resource/api/metabase-mcp': {
        resource: 'https://mb.example.com/api/metabase-mcp',
        authorization_servers: ['https://mb.example.com'],
        scopes_supported: ['agent:content:read', 'agent:query:run'],
      },
      'https://mb.example.com/.well-known/oauth-authorization-server': {
        ...AS_METADATA,
        scopes_supported: ['agent:content:read', 'agent:query', 'agent:query:run'],
      },
    });

    const meta = await discoverAuthServer('https://mb.example.com/api/metabase-mcp');
    expect(meta.resource_scopes_supported).toEqual(['agent:content:read', 'agent:query:run']);
    expect(meta.scopes_supported).toEqual(['agent:content:read', 'agent:query', 'agent:query:run']);
    expect(meta.resource).toBe('https://mb.example.com/api/metabase-mcp');
  });

  it('returns the resource scopes when the metadata names no authorization server', async () => {
    // RFC 9728 makes authorization_servers optional; the scopes still count.
    mockFetchRoutes({
      'https://mcp.example.com/.well-known/oauth-protected-resource/mcp': {
        resource: 'https://mcp.example.com/mcp',
        scopes_supported: ['new:read'],
      },
      'https://mcp.example.com/.well-known/oauth-authorization-server': AS_METADATA,
    });

    const meta = await discoverAuthServer('https://mcp.example.com/mcp');
    expect(meta.resource_scopes_supported).toEqual(['new:read']);
    expect(meta.authorization_endpoint).toBe(AS_METADATA.authorization_endpoint);
  });

  it('ignores resource scopes from metadata that describes a different resource', async () => {
    // The path document is down; the root document describes another
    // resource, so its scopes must not reach the authorize request.
    mockFetchRoutes({
      'https://mcp.example.com/.well-known/oauth-protected-resource': {
        resource: 'https://mcp.example.com/',
        authorization_servers: ['https://auth.example.com'],
        scopes_supported: ['admin:all'],
      },
      'https://auth.example.com/.well-known/oauth-authorization-server': AS_METADATA,
    });

    const meta = await discoverAuthServer('https://mcp.example.com/api/mcp');
    expect(meta.resource_scopes_supported).toBeUndefined();
    expect(meta.resource).toBeUndefined();
  });

  it('treats a resource that differs by a trailing slash as a different resource', async () => {
    mockFetchRoutes({
      'https://mcp.example.com/.well-known/oauth-protected-resource': {
        resource: 'https://mcp.example.com/api/mcp/',
        scopes_supported: ['admin:all'],
      },
      'https://mcp.example.com/.well-known/oauth-authorization-server': AS_METADATA,
    });

    const meta = await discoverAuthServer('https://mcp.example.com/api/mcp');
    expect(meta.resource_scopes_supported).toBeUndefined();
  });

  it('falls back to AS metadata on the MCP origin when there is no protected-resource metadata', async () => {
    mockFetchRoutes({
      'https://mcp.example.com/.well-known/oauth-authorization-server/mcp': AS_METADATA,
    });

    const meta = await discoverAuthServer('https://mcp.example.com/mcp');
    expect(meta.token_endpoint).toBe(AS_METADATA.token_endpoint);
  });

  it('falls back to the origin-root AS metadata for a path-bearing server URL (Linear shape)', async () => {
    mockFetchRoutes({
      'https://mcp.example.com/.well-known/oauth-authorization-server': AS_METADATA,
    });

    const meta = await discoverAuthServer('https://mcp.example.com/mcp');
    expect(meta.authorization_endpoint).toBe(AS_METADATA.authorization_endpoint);
  });

  it('discovers a path-bearing issuer via the RFC 8414 path-inserted form', async () => {
    mockFetchRoutes({
      'https://mcp.example.com/.well-known/oauth-protected-resource/mcp': {
        resource: 'https://mcp.example.com/mcp',
        authorization_servers: ['https://idp.example.com/tenant1'],
      },
      'https://idp.example.com/.well-known/oauth-authorization-server/tenant1': AS_METADATA,
    });

    const meta = await discoverAuthServer('https://mcp.example.com/mcp');
    expect(meta.token_endpoint).toBe(AS_METADATA.token_endpoint);
  });

  it('falls back to OpenID Connect discovery when OAuth AS metadata is absent', async () => {
    mockFetchRoutes({
      'https://mcp.example.com/.well-known/oauth-protected-resource/mcp': {
        resource: 'https://mcp.example.com/mcp',
        authorization_servers: ['https://idp.example.com'],
      },
      'https://idp.example.com/.well-known/openid-configuration': AS_METADATA,
    });

    const meta = await discoverAuthServer('https://mcp.example.com/mcp');
    expect(meta.authorization_endpoint).toBe(AS_METADATA.authorization_endpoint);
  });

  it('still supports the legacy suffix form as a last resort', async () => {
    mockFetchRoutes({
      'https://mcp.example.com/mcp/.well-known/oauth-authorization-server': AS_METADATA,
    });

    const meta = await discoverAuthServer('https://mcp.example.com/mcp');
    expect(meta.token_endpoint).toBe(AS_METADATA.token_endpoint);
  });

  it('ignores metadata responses that lack the endpoints', async () => {
    mockFetchRoutes({
      // Root form answers 200 but with an incomplete body; the legacy
      // suffix form has the real metadata.
      'https://mcp.example.com/.well-known/oauth-authorization-server': { issuer: 'x' },
      'https://mcp.example.com/mcp/.well-known/oauth-authorization-server': AS_METADATA,
    });

    const meta = await discoverAuthServer('https://mcp.example.com/mcp');
    expect(meta.token_endpoint).toBe(AS_METADATA.token_endpoint);
  });

  it('throws an error naming every attempted URL when discovery fails everywhere', async () => {
    mockFetchRoutes({});

    await expect(discoverAuthServer('https://mcp.example.com/mcp')).rejects.toThrow(
      /MCP OAuth discovery failed[\s\S]*oauth-authorization-server/,
    );
  });

  it('handles a server URL with no path component', async () => {
    mockFetchRoutes({
      'https://mcp.example.com/.well-known/oauth-authorization-server': AS_METADATA,
    });

    const meta = await discoverAuthServer('https://mcp.example.com');
    expect(meta.token_endpoint).toBe(AS_METADATA.token_endpoint);
  });
});

// ── RFC 8707 resource indicator ──────────────────────────────────────

describe('resource indicator', () => {
  const resource = 'https://mb.example.com/api/metabase-mcp';

  function captureTokenRequests(): URLSearchParams[] {
    const bodies: URLSearchParams[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(new URLSearchParams(String(init?.body)));
      return new Response(JSON.stringify({ access_token: 'at', refresh_token: 'rt' }), { status: 200 });
    }));
    return bodies;
  }

  it('names the resource on the authorize URL, the code exchange, and the refresh', async () => {
    const url = new URL(buildAuthorizationUrl({
      authorizationEndpoint: 'https://mb.example.com/oauth/authorize',
      clientId: 'c1', redirectUri: 'https://valet.example/cb', codeChallenge: 'ch', state: 's',
      scopes: ['agent:content:read'], resource,
    }));
    expect(url.searchParams.get('resource')).toBe(resource);

    const bodies = captureTokenRequests();
    await exchangeCodePkce({ tokenEndpoint: 'https://mb.example.com/oauth/token', clientId: 'c1', code: 'code', redirectUri: 'https://valet.example/cb', codeVerifier: 'v', resource });
    await refreshTokenPkce({ tokenEndpoint: 'https://mb.example.com/oauth/token', clientId: 'c1', refreshToken: 'rt', resource });
    expect(bodies.map((b) => b.get('resource'))).toEqual([resource, resource]);
  });

  it('sends no resource parameter when none is given', async () => {
    const url = new URL(buildAuthorizationUrl({
      authorizationEndpoint: 'https://auth.example.com/authorize',
      clientId: 'c1', redirectUri: 'https://valet.example/cb', codeChallenge: 'ch', state: 's',
    }));
    expect(url.searchParams.has('resource')).toBe(false);

    const bodies = captureTokenRequests();
    await exchangeCodePkce({ tokenEndpoint: 'https://auth.example.com/token', clientId: 'c1', code: 'code', redirectUri: 'https://valet.example/cb', codeVerifier: 'v' });
    await refreshTokenPkce({ tokenEndpoint: 'https://auth.example.com/token', clientId: 'c1', refreshToken: 'rt' });
    expect(bodies.map((b) => b.has('resource'))).toEqual([false, false]);
  });
});
