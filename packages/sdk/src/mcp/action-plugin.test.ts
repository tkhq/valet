import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Credential, CredentialProvider, PluginActionContext, RiskLevel } from '@valet/engine';
import { mcpActionPlugin } from './action-plugin.js';
import type { McpTool, McpToolResult } from './types.js';

// ── fixtures ─────────────────────────────────────────────────────────

const fixtureTools: McpTool[] = [
  {
    name: 'list_zones',
    description: 'List DNS zones',
    inputSchema: { type: 'object', properties: { page: { type: 'number' } } },
  },
  {
    name: 'delete_zone',
    description: 'Delete a zone',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
    annotations: { destructiveHint: true },
  },
  {
    name: 'read_only_tool',
    // No description — mapping falls back to "<service>: <tool>".
    annotations: { readOnlyHint: true },
  },
];

interface CapturedRequest {
  url: string;
  headers: Record<string, string>;
  body: { method: string; id?: number };
}

function jsonResponse(body: unknown, headers: Record<string, string> = {}): Response {
  const lowered: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lowered[k.toLowerCase()] = v;
  if (!lowered['content-type']) lowered['content-type'] = 'application/json';
  // Hand-rolled Response double for the test's mocked `fetch` — McpClient
  // only reads .ok/.headers.get/.json/.text, so a full DOM Response isn't
  // needed. The cast bridges this minimal shape to the global fetch type.
  return {
    ok: true,
    status: 200,
    headers: { get: (k: string) => lowered[k.toLowerCase()] ?? null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

function makeFetchMock(opts: {
  tools?: McpTool[];
  callResult?: McpToolResult;
  onRequest?: (req: CapturedRequest) => void;
}) {
  return vi.fn(async (url: string | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { method: string; id?: number };
    const headers: Record<string, string> = {};
    if (init?.headers) {
      for (const [k, v] of Object.entries(init.headers as Record<string, string>)) headers[k] = v;
    }
    opts.onRequest?.({ url: String(url), headers, body });

    if (body.method === 'initialize') {
      return jsonResponse(
        {
          jsonrpc: '2.0',
          id: body.id,
          result: {
            protocolVersion: '2024-11-05',
            capabilities: {},
            serverInfo: { name: 'test-server', version: '1.0.0' },
          },
        },
        { 'mcp-session-id': 'sess-1' },
      );
    }
    if (body.method === 'notifications/initialized') {
      return jsonResponse({});
    }
    if (body.method === 'tools/list') {
      return jsonResponse({ jsonrpc: '2.0', id: body.id, result: { tools: opts.tools ?? [] } });
    }
    if (body.method === 'tools/call') {
      return jsonResponse({ jsonrpc: '2.0', id: body.id, result: opts.callResult });
    }
    throw new Error(`unexpected MCP method in test fixture: ${body.method}`);
  });
}

function fakeCredentialProvider(cred: Credential | null): CredentialProvider {
  return {
    get: vi.fn(async () => cred),
    request: vi.fn(async () => {
      throw new Error('request() not implemented in test fixture');
    }),
  };
}

function fakeContext(credentials: CredentialProvider): PluginActionContext {
  const notImplemented = () => {
    throw new Error('not implemented in test fixture');
  };
  return {
    actionId: 'test.action',
    service: 'test',
    userId: 'user-1',
    orgId: 'org-1',
    sessionId: 'session-1',
    threadId: 'thread-1',
    credentials,
    sandbox: {
      id: 'sandbox-1',
      readFile: async () => notImplemented(),
      readBinary: async () => notImplemented(),
      writeFile: async () => notImplemented(),
      writeBinary: async () => notImplemented(),
      readdir: async () => notImplemented(),
      stat: async () => notImplemented(),
      mkdir: async () => notImplemented(),
      rm: async () => notImplemented(),
      exec: async () => notImplemented(),
    },
    requestDecision: async () => notImplemented(),
    signal: new AbortController().signal,
    threadRead: async () => notImplemented(),
    listThreads: async () => notImplemented(),
    setModel: async () => notImplemented(),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── resolveActions ───────────────────────────────────────────────────

describe('mcpActionPlugin resolveActions', () => {
  it('maps a fixture MCP tool list to PluginAction[] with prefixed ids and passthrough schemas', async () => {
    vi.stubGlobal('fetch', makeFetchMock({ tools: fixtureTools }));
    const plugin = mcpActionPlugin({
      mcpUrl: 'https://mcp.example.com/mcp',
      serviceName: 'example',
      defaultRiskLevel: 'medium',
    });
    const credentials = fakeCredentialProvider({ accessToken: 'tok-abc' });

    const actions = await plugin.resolveActions!({ credentials });

    expect(actions.map((a) => a.id)).toEqual([
      'example.list_zones',
      'example.delete_zone',
      'example.read_only_tool',
    ]);
    expect(actions[0].name).toBe('list_zones');
    expect(actions[0].description).toBe('List DNS zones');
    expect(actions[0].parameters).toEqual(fixtureTools[0].inputSchema);
    expect(actions[1].parameters).toEqual(fixtureTools[1].inputSchema);
    // No description on the server tool → legacy fallback text.
    expect(actions[2].description).toBe('example tool: read_only_tool');
  });

  it('derives risk level from tool annotations, falling back to defaultRiskLevel', async () => {
    vi.stubGlobal('fetch', makeFetchMock({ tools: fixtureTools }));
    const plugin = mcpActionPlugin({
      mcpUrl: 'https://mcp.example.com/mcp',
      serviceName: 'example',
      defaultRiskLevel: 'medium',
    });
    const credentials = fakeCredentialProvider({ accessToken: 'tok-abc' });

    const actions = await plugin.resolveActions!({ credentials });

    expect(actions[0].riskLevel).toBe('medium'); // no annotations -> default
    expect(actions[1].riskLevel).toBe('critical'); // destructiveHint
    expect(actions[2].riskLevel).toBe('low'); // readOnlyHint
  });

  // One tool with the given annotations → its derived risk level.
  async function riskFor(
    annotations: McpTool['annotations'],
    defaultRiskLevel: RiskLevel,
  ): Promise<RiskLevel> {
    vi.stubGlobal('fetch', makeFetchMock({ tools: [{ name: 'the_tool', annotations }] }));
    const plugin = mcpActionPlugin({
      mcpUrl: 'https://mcp.example.com/mcp',
      serviceName: 'example',
      defaultRiskLevel,
    });
    const actions = await plugin.resolveActions!({
      credentials: fakeCredentialProvider({ accessToken: 'tok-abc' }),
    });
    return actions[0].riskLevel;
  }

  it('lowers a declared non-destructive idempotent write to medium', async () => {
    expect(await riskFor({ destructiveHint: false, idempotentHint: true }, 'high')).toBe('medium');
  });

  it('raises a declared non-destructive open-world write to high', async () => {
    expect(await riskFor({ destructiveHint: false, openWorldHint: true }, 'medium')).toBe('high');
  });

  it('prefers idempotency over open-world for non-destructive writes', async () => {
    expect(
      await riskFor({ destructiveHint: false, idempotentHint: true, openWorldHint: true }, 'high'),
    ).toBe('medium');
  });

  it('keeps the service default for a bare destructiveHint: false', async () => {
    expect(await riskFor({ destructiveHint: false }, 'high')).toBe('high');
  });

  it('keeps destructiveHint: true critical even when idempotent', async () => {
    expect(await riskFor({ destructiveHint: true, idempotentHint: true }, 'medium')).toBe(
      'critical',
    );
  });

  it('never moves risk on idempotent/open-world hints without an explicit destructiveHint', async () => {
    expect(await riskFor({ idempotentHint: true, openWorldHint: true }, 'high')).toBe('high');
  });

  it('keeps readOnlyHint: true low even when open-world', async () => {
    expect(await riskFor({ readOnlyHint: true, openWorldHint: true }, 'medium')).toBe('low');
  });

  it('throws the connect message when no credential is connected and noAuth is unset', async () => {
    const plugin = mcpActionPlugin({
      mcpUrl: 'https://mcp.example.com/mcp',
      serviceName: 'example',
      defaultRiskLevel: 'medium',
    });
    const credentials = fakeCredentialProvider(null);

    await expect(plugin.resolveActions!({ credentials })).rejects.toThrow(
      'example: no credential connected',
    );
  });

  it('uses staticToken without reading the credential store, and clears requiresCredential', async () => {
    let listRequest: CapturedRequest | undefined;
    vi.stubGlobal(
      'fetch',
      makeFetchMock({
        tools: fixtureTools,
        onRequest: (req) => {
          if (req.body.method === 'tools/list') listRequest = req;
        },
      }),
    );
    const plugin = mcpActionPlugin({
      mcpUrl: 'https://mcp.internal.example/mcp',
      serviceName: 'internal',
      defaultRiskLevel: 'medium',
      staticToken: 'instance-token',
    });
    const getSpy = vi.fn(async () => {
      throw new Error('credentials.get() should not be called when staticToken is set');
    });
    const credentials: CredentialProvider = { get: getSpy, request: vi.fn() };

    const actions = await plugin.resolveActions!({ credentials });

    expect(plugin.requiresCredential).toBe(false);
    expect(getSpy).not.toHaveBeenCalled();
    expect(actions.length).toBe(3);
    expect(listRequest?.headers.Authorization).toBe('Bearer instance-token');
  });

  it('skips the credential read entirely when noAuth is set', async () => {
    vi.stubGlobal('fetch', makeFetchMock({ tools: fixtureTools }));
    const plugin = mcpActionPlugin({
      mcpUrl: 'https://mcp.deepwiki.com/mcp',
      serviceName: 'deepwiki',
      defaultRiskLevel: 'low',
      noAuth: true,
    });
    const getSpy = vi.fn(async () => {
      throw new Error('credentials.get() should not be called when noAuth is set');
    });
    const credentials: CredentialProvider = { get: getSpy, request: vi.fn() };

    const actions = await plugin.resolveActions!({ credentials });

    expect(getSpy).not.toHaveBeenCalled();
    expect(actions.length).toBe(3);
  });
});

// ── execute ──────────────────────────────────────────────────────────

describe('mcpActionPlugin generated action execute', () => {
  it('sends an Authorization bearer header derived from ctx.credentials.get()', async () => {
    let captured: CapturedRequest | undefined;
    vi.stubGlobal(
      'fetch',
      makeFetchMock({
        tools: [fixtureTools[0]],
        callResult: { content: [{ type: 'text', text: 'ok' }] },
        onRequest: (req) => {
          if (req.body.method === 'tools/call') captured = req;
        },
      }),
    );
    const plugin = mcpActionPlugin({
      mcpUrl: 'https://mcp.example.com/mcp',
      serviceName: 'example',
      defaultRiskLevel: 'medium',
    });
    const credentials = fakeCredentialProvider({ accessToken: 'tok-xyz' });
    const [action] = await plugin.resolveActions!({ credentials });

    const result = await action.execute({}, fakeContext(credentials));

    expect(result).toEqual({ success: true, data: 'ok' });
    expect(captured?.headers.Authorization).toBe('Bearer tok-xyz');
  });

  it('sends the credential as the configured query param instead of a header', async () => {
    let captured: CapturedRequest | undefined;
    vi.stubGlobal(
      'fetch',
      makeFetchMock({
        tools: [fixtureTools[0]],
        callResult: { content: [{ type: 'text', text: 'queued' }] },
        onRequest: (req) => {
          if (req.body.method === 'tools/call') captured = req;
        },
      }),
    );
    const plugin = mcpActionPlugin({
      mcpUrl: 'https://mcp.typefully.com/mcp',
      serviceName: 'typefully',
      defaultRiskLevel: 'medium',
      authQueryParam: 'TYPEFULLY_API_KEY',
    });
    const credentials = fakeCredentialProvider({ accessToken: 'secret-key' });
    const [action] = await plugin.resolveActions!({ credentials });

    const result = await action.execute({}, fakeContext(credentials));

    expect(result).toEqual({ success: true, data: 'queued' });
    expect(captured?.url).toContain('TYPEFULLY_API_KEY=secret-key');
    expect(captured?.headers.Authorization).toBeUndefined();
  });

  it('re-reads the credential at execute time rather than the one captured at discovery', async () => {
    vi.stubGlobal('fetch', makeFetchMock({ tools: [fixtureTools[0]], callResult: { content: [{ type: 'text', text: 'ok' }] } }));
    const plugin = mcpActionPlugin({
      mcpUrl: 'https://mcp.example.com/mcp',
      serviceName: 'example',
      defaultRiskLevel: 'medium',
    });
    const discoveryCredentials = fakeCredentialProvider({ accessToken: 'discovery-token' });
    const [action] = await plugin.resolveActions!({ credentials: discoveryCredentials });

    const executeCredentials = fakeCredentialProvider({ accessToken: 'refreshed-token' });
    await action.execute({}, fakeContext(executeCredentials));

    expect(executeCredentials.get).toHaveBeenCalled();
  });

  it('maps a successful multi-part text result by joining with newlines (legacy parity)', async () => {
    vi.stubGlobal(
      'fetch',
      makeFetchMock({
        tools: [fixtureTools[0]],
        callResult: {
          content: [
            { type: 'text', text: 'first' },
            { type: 'text', text: 'second' },
          ],
        },
      }),
    );
    const plugin = mcpActionPlugin({
      mcpUrl: 'https://mcp.example.com/mcp',
      serviceName: 'example',
      defaultRiskLevel: 'medium',
    });
    const credentials = fakeCredentialProvider({ accessToken: 'tok' });
    const [action] = await plugin.resolveActions!({ credentials });

    const result = await action.execute({}, fakeContext(credentials));

    expect(result).toEqual({ success: true, data: 'first\nsecond' });
  });

  it('maps an isError MCP result to a failed PluginActionResult (legacy parity)', async () => {
    vi.stubGlobal(
      'fetch',
      makeFetchMock({
        tools: [fixtureTools[0]],
        callResult: { content: [{ type: 'text', text: 'zone not found' }], isError: true },
      }),
    );
    const plugin = mcpActionPlugin({
      mcpUrl: 'https://mcp.example.com/mcp',
      serviceName: 'example',
      defaultRiskLevel: 'medium',
    });
    const credentials = fakeCredentialProvider({ accessToken: 'tok' });
    const [action] = await plugin.resolveActions!({ credentials });

    const result = await action.execute({}, fakeContext(credentials));

    expect(result).toEqual({ success: false, error: 'zone not found' });
  });

  it('does not share an Mcp-Session-Id across two callers with different tokens', async () => {
    const initializeCalls: CapturedRequest[] = [];
    let sessionCounter = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? '{}')) as { method: string; id?: number };
        const headers: Record<string, string> = {};
        if (init?.headers) {
          for (const [k, v] of Object.entries(init.headers as Record<string, string>)) headers[k] = v;
        }
        if (body.method === 'initialize') {
          sessionCounter += 1;
          initializeCalls.push({ url: String(url), headers, body });
          return jsonResponse(
            {
              jsonrpc: '2.0',
              id: body.id,
              result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'test-server', version: '1.0.0' } },
            },
            { 'mcp-session-id': `sess-${sessionCounter}` },
          );
        }
        if (body.method === 'notifications/initialized') return jsonResponse({});
        if (body.method === 'tools/list') {
          return jsonResponse({ jsonrpc: '2.0', id: body.id, result: { tools: [fixtureTools[0]] } });
        }
        if (body.method === 'tools/call') {
          return jsonResponse({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: 'ok' }] } });
        }
        throw new Error(`unexpected MCP method in test fixture: ${body.method}`);
      }),
    );

    const plugin = mcpActionPlugin({
      mcpUrl: 'https://mcp.example.com/mcp',
      serviceName: 'example',
      defaultRiskLevel: 'medium',
    });

    // Two "users" sharing the process-wide singleton McpClient (the bug
    // scenario), each with their own credential provider / token.
    const credsA = fakeCredentialProvider({ accessToken: 'tok-user-a' });
    const credsB = fakeCredentialProvider({ accessToken: 'tok-user-b' });
    const [actionA] = await plugin.resolveActions!({ credentials: credsA });
    const [actionB] = await plugin.resolveActions!({ credentials: credsB });

    await actionA.execute({}, fakeContext(credsA));
    await actionB.execute({}, fakeContext(credsB));

    expect(initializeCalls).toHaveLength(2); // one handshake per distinct credential
    const sentSessionIds = initializeCalls.map((c) => c.headers['Mcp-Session-Id']);
    // Neither initialize call should carry the other credential's session id.
    expect(sentSessionIds.every((id) => id === undefined)).toBe(true);
  });

  it('reuses the cached session for repeated calls with the same token (one initialize)', async () => {
    let initializeCount = 0;
    let toolsCallCount = 0;
    const seenSessionIds = new Set<string | undefined>();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? '{}')) as { method: string; id?: number };
        const headers: Record<string, string> = {};
        if (init?.headers) {
          for (const [k, v] of Object.entries(init.headers as Record<string, string>)) headers[k] = v;
        }
        if (body.method === 'initialize') {
          initializeCount += 1;
          return jsonResponse(
            {
              jsonrpc: '2.0',
              id: body.id,
              result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'test-server', version: '1.0.0' } },
            },
            { 'mcp-session-id': 'sess-shared' },
          );
        }
        if (body.method === 'notifications/initialized') return jsonResponse({});
        if (body.method === 'tools/list') {
          return jsonResponse({ jsonrpc: '2.0', id: body.id, result: { tools: [fixtureTools[0]] } });
        }
        if (body.method === 'tools/call') {
          toolsCallCount += 1;
          seenSessionIds.add(headers['Mcp-Session-Id']);
          return jsonResponse({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: 'ok' }] } });
        }
        throw new Error(`unexpected MCP method in test fixture: ${body.method}`);
      }),
    );

    const plugin = mcpActionPlugin({
      mcpUrl: 'https://mcp.example.com/mcp',
      serviceName: 'example',
      defaultRiskLevel: 'medium',
    });
    const creds = fakeCredentialProvider({ accessToken: 'tok-same' });
    const [action1] = await plugin.resolveActions!({ credentials: creds });
    const [action2] = await plugin.resolveActions!({ credentials: creds });

    await action1.execute({}, fakeContext(creds));
    await action2.execute({}, fakeContext(creds));

    expect(initializeCount).toBe(1);
    expect(toolsCallCount).toBe(2);
    expect(seenSessionIds).toEqual(new Set(['sess-shared']));
  });

  it('noAuth callers still initialize and call tools successfully (anon cache key)', async () => {
    let initializeCount = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? '{}')) as { method: string; id?: number };
        if (body.method === 'initialize') {
          initializeCount += 1;
          return jsonResponse(
            {
              jsonrpc: '2.0',
              id: body.id,
              result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'test-server', version: '1.0.0' } },
            },
            { 'mcp-session-id': 'sess-anon' },
          );
        }
        if (body.method === 'notifications/initialized') return jsonResponse({});
        if (body.method === 'tools/list') return jsonResponse({ jsonrpc: '2.0', id: body.id, result: { tools: [fixtureTools[0]] } });
        if (body.method === 'tools/call') {
          return jsonResponse({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: 'ok' }] } });
        }
        throw new Error(`unexpected MCP method in test fixture: ${body.method}`);
      }),
    );

    const plugin = mcpActionPlugin({
      mcpUrl: 'https://mcp.deepwiki.com/mcp',
      serviceName: 'deepwiki',
      defaultRiskLevel: 'low',
      noAuth: true,
    });
    const credentials: CredentialProvider = {
      get: vi.fn(async () => {
        throw new Error('credentials.get() should not be called when noAuth is set');
      }),
      request: vi.fn(),
    };

    const [action] = await plugin.resolveActions!({ credentials });
    const result1 = await action.execute({}, fakeContext(credentials));
    const result2 = await action.execute({}, fakeContext(credentials));

    expect(result1).toEqual({ success: true, data: 'ok' });
    expect(result2).toEqual({ success: true, data: 'ok' });
    expect(initializeCount).toBe(1); // anon key cached across calls
  });

  it('maps an empty MCP response to a failed PluginActionResult (legacy parity)', async () => {
    vi.stubGlobal(
      'fetch',
      makeFetchMock({
        tools: [fixtureTools[0]],
        callResult: undefined,
      }),
    );
    const plugin = mcpActionPlugin({
      mcpUrl: 'https://mcp.example.com/mcp',
      serviceName: 'example',
      defaultRiskLevel: 'medium',
    });
    const credentials = fakeCredentialProvider({ accessToken: 'tok' });
    const [action] = await plugin.resolveActions!({ credentials });

    const result = await action.execute({}, fakeContext(credentials));

    expect(result).toEqual({ success: false, error: 'MCP tool returned empty response' });
  });
});
