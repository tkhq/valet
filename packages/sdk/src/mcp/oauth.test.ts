import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { discoverAuthServer } from './oauth.js';

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
