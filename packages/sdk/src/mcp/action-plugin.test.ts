import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Credential, CredentialProvider, CredentialSource, PluginActionContext, RiskLevel } from '@valet/engine';
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
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json', ...headers },
  });
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

/**
 * A provider that answers differently per service name, for exercising the
 * personal-vs-app fallback: `credentials.get()` (no arg, or the plugin's own
 * service) returns `personal`; `credentials.get(appService)` returns `app`.
 */
function fakeScopedCredentialProvider(opts: {
  personal: Credential | null;
  app: Credential | null;
  appService: string;
}): CredentialProvider {
  return {
    get: vi.fn(async (service?: string) => {
      if (service === opts.appService) return opts.app;
      return opts.personal;
    }),
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

  it('raises an open-world write above a low service default (default is not a cap)', async () => {
    expect(await riskFor({ destructiveHint: false, openWorldHint: true }, 'low')).toBe('high');
  });

  it('raises an idempotent write above a low service default', async () => {
    expect(await riskFor({ destructiveHint: false, idempotentHint: true }, 'low')).toBe('medium');
  });

  it('raises destructiveHint: true to critical above a low service default', async () => {
    expect(await riskFor({ destructiveHint: true }, 'low')).toBe('critical');
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
  async function executeResult(callResult: McpToolResult) {
    vi.stubGlobal('fetch', makeFetchMock({ tools: [fixtureTools[0]], callResult }));
    const plugin = mcpActionPlugin({
      mcpUrl: 'https://mcp.example.com/mcp',
      serviceName: 'example',
      defaultRiskLevel: 'medium',
    });
    const credentials = fakeCredentialProvider({ accessToken: 'tok' });
    const [action] = await plugin.resolveActions!({ credentials });
    return action.execute({}, fakeContext(credentials));
  }

  it('prefers MCP structuredContent over text', async () => {
    const result = await executeResult({
      content: [{ type: 'text', text: '{"legacy":true}' }],
      structuredContent: { canonical: true },
    });
    expect(result.data).toEqual({ canonical: true });
  });

  it('parses JSON text before TOON', async () => {
    const result = await executeResult({ content: [{ type: 'text', text: '{"records":[1]}' }] });
    expect(result.data).toEqual({ records: [1] });
  });

  it('decodes marker-gated TOON text', async () => {
    const result = await executeResult({
      content: [{ type: 'text', text: '[1]{id,name}:\n  issue-1,Fix login' }],
    });
    expect(result.data).toEqual([{ id: 'issue-1', name: 'Fix login' }]);
  });

  it('keeps ordinary colon-delimited text plain', async () => {
    const text = 'Error: Invalid input';
    const result = await executeResult({ content: [{ type: 'text', text }] });
    expect(result.data).toBe(text);
  });
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

// ── appCredentialService fallback (Part C Linear) ───────────────────────

describe('mcpActionPlugin appCredentialService fallback', () => {
  it('exposes appCredentialService on the plugin so the catalog probe can use it', () => {
    const plugin = mcpActionPlugin({
      mcpUrl: 'https://mcp.linear.app/mcp',
      serviceName: 'linear',
      defaultRiskLevel: 'medium',
      appCredentialService: 'linear:app',
    });
    expect(plugin.appCredentialService).toBe('linear:app');
  });

  it('sends the app token as Bearer at discovery when no personal credential is connected', async () => {
    let listRequest: CapturedRequest | undefined;
    vi.stubGlobal(
      'fetch',
      makeFetchMock({
        tools: [fixtureTools[0]],
        onRequest: (req) => {
          if (req.body.method === 'tools/list') listRequest = req;
        },
      }),
    );
    const plugin = mcpActionPlugin({
      mcpUrl: 'https://mcp.linear.app/mcp',
      serviceName: 'linear',
      defaultRiskLevel: 'medium',
      appCredentialService: 'linear:app',
    });
    const credentials = fakeScopedCredentialProvider({
      personal: null,
      app: { accessToken: 'app-token' },
      appService: 'linear:app',
    });

    const actions = await plugin.resolveActions!({ credentials });

    expect(actions).toHaveLength(1);
    expect(listRequest?.headers.Authorization).toBe('Bearer app-token');
  });

  it('sends the app token as Bearer on a call when no personal credential is connected', async () => {
    let callRequest: CapturedRequest | undefined;
    vi.stubGlobal(
      'fetch',
      makeFetchMock({
        tools: [fixtureTools[0]],
        callResult: { content: [{ type: 'text', text: 'ok' }] },
        onRequest: (req) => {
          if (req.body.method === 'tools/call') callRequest = req;
        },
      }),
    );
    const plugin = mcpActionPlugin({
      mcpUrl: 'https://mcp.linear.app/mcp',
      serviceName: 'linear',
      defaultRiskLevel: 'medium',
      appCredentialService: 'linear:app',
    });
    const credentials = fakeScopedCredentialProvider({
      personal: null,
      app: { accessToken: 'app-token' },
      appService: 'linear:app',
    });
    const [action] = await plugin.resolveActions!({ credentials });

    const result = await action.execute({}, fakeContext(credentials));

    expect(result).toEqual({ success: true, data: 'ok' });
    expect(callRequest?.headers.Authorization).toBe('Bearer app-token');
  });

  it('prefers the personal credential over the app token at discovery', async () => {
    let listRequest: CapturedRequest | undefined;
    vi.stubGlobal(
      'fetch',
      makeFetchMock({
        tools: [fixtureTools[0]],
        onRequest: (req) => {
          if (req.body.method === 'tools/list') listRequest = req;
        },
      }),
    );
    const plugin = mcpActionPlugin({
      mcpUrl: 'https://mcp.linear.app/mcp',
      serviceName: 'linear',
      defaultRiskLevel: 'medium',
      appCredentialService: 'linear:app',
    });
    const credentials = fakeScopedCredentialProvider({
      personal: { accessToken: 'personal-token' },
      app: { accessToken: 'app-token' },
      appService: 'linear:app',
    });

    await plugin.resolveActions!({ credentials });

    expect(listRequest?.headers.Authorization).toBe('Bearer personal-token');
  });

  it('prefers the personal credential over the app token on a call', async () => {
    let callRequest: CapturedRequest | undefined;
    vi.stubGlobal(
      'fetch',
      makeFetchMock({
        tools: [fixtureTools[0]],
        callResult: { content: [{ type: 'text', text: 'ok' }] },
        onRequest: (req) => {
          if (req.body.method === 'tools/call') callRequest = req;
        },
      }),
    );
    const plugin = mcpActionPlugin({
      mcpUrl: 'https://mcp.linear.app/mcp',
      serviceName: 'linear',
      defaultRiskLevel: 'medium',
      appCredentialService: 'linear:app',
    });
    const credentials = fakeScopedCredentialProvider({
      personal: { accessToken: 'personal-token' },
      app: { accessToken: 'app-token' },
      appService: 'linear:app',
    });
    const [action] = await plugin.resolveActions!({ credentials });

    await action.execute({}, fakeContext(credentials));

    expect(callRequest?.headers.Authorization).toBe('Bearer personal-token');
  });

  it('throws the unchanged refusal text when neither personal nor app credential is connected', async () => {
    vi.stubGlobal('fetch', makeFetchMock({ tools: [fixtureTools[0]] }));
    const plugin = mcpActionPlugin({
      mcpUrl: 'https://mcp.linear.app/mcp',
      serviceName: 'linear',
      defaultRiskLevel: 'medium',
      appCredentialService: 'linear:app',
    });
    const credentials = fakeScopedCredentialProvider({
      personal: null,
      app: null,
      appService: 'linear:app',
    });

    await expect(plugin.resolveActions!({ credentials })).rejects.toThrow(
      'linear: no credential connected',
    );
  });

  it('leaves behavior unchanged when appCredentialService is absent (no fallback attempted)', async () => {
    const plugin = mcpActionPlugin({
      mcpUrl: 'https://mcp.example.com/mcp',
      serviceName: 'example',
      defaultRiskLevel: 'medium',
    });
    const getSpy = vi.fn(async (service?: string) => {
      // Only the no-arg (personal) lookup should ever happen.
      expect(service).toBeUndefined();
      return null;
    });
    const credentials: CredentialProvider = { get: getSpy, request: vi.fn() };

    await expect(plugin.resolveActions!({ credentials })).rejects.toThrow(
      'example: no credential connected',
    );
    expect(getSpy).toHaveBeenCalledTimes(1);
  });
});

// ── auth-rejection messages on HTTP 401/403 (fix round 1) ───────────────

function errorResponse(status: number, body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers });
}

function makeFetchMockFailingCall(status: number, body = 'nope', headers: Record<string, string> = {}) {
  return vi.fn(async (url: string | URL, init?: RequestInit) => {
    const reqBody = JSON.parse(String(init?.body ?? '{}')) as { method: string; id?: number };
    if (reqBody.method === 'initialize') {
      return jsonResponse(
        {
          jsonrpc: '2.0',
          id: reqBody.id,
          result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'test-server', version: '1.0.0' } },
        },
        { 'mcp-session-id': 'sess-1' },
      );
    }
    if (reqBody.method === 'notifications/initialized') return jsonResponse({});
    if (reqBody.method === 'tools/list') {
      return jsonResponse({ jsonrpc: '2.0', id: reqBody.id, result: { tools: [fixtureTools[0]] } });
    }
    if (reqBody.method === 'tools/call') {
      return errorResponse(status, body, headers);
    }
    throw new Error(`unexpected MCP method in test fixture: ${reqBody.method}`);
  });
}

describe('mcpActionPlugin auth-rejection messages (HTTP 401/403)', () => {
  // Metabase 1.64: the challenge lists the scopes the token holds plus the
  // one the tool needs.
  const metabaseScopeChallenge = {
    'www-authenticate': 'Bearer error="insufficient_scope", scope="agent:query:run agent:content:read"',
  };
  async function insufficientScopeError(source: CredentialSource, sessionPurpose?: 'workflow'): Promise<unknown> {
    vi.stubGlobal('fetch', makeFetchMockFailingCall(403, 'forbidden', metabaseScopeChallenge));
    const plugin = mcpActionPlugin({
      mcpUrl: 'https://mb.example.com/api/metabase-mcp',
      serviceName: 'metabase',
      defaultRiskLevel: 'low',
      displayName: 'Turnkey Metabase',
      configScopes: ['agent:query:run'],
    });
    const credentials = fakeCredentialProvider({ accessToken: 'tok', scopes: ['agent:query:run'], source });
    const [action] = await plugin.resolveActions!({ credentials });
    const result = await action.execute({}, { ...fakeContext(credentials), ...(sessionPurpose ? { sessionPurpose } : {}) });
    return result.success ? undefined : result.error;
  }

  it('links the caller to grant the missing scope on their own connection (step-up)', async () => {
    expect(await insufficientScopeError({ kind: 'personal' })).toBe(
      'Turnkey Metabase refused this call: the connection does not hold the agent:content:read scope. ' +
        'To grant it, open /api/credentials/metabase/connect?addScopes=agent%3Acontent%3Aread+agent%3Aquery%3Arun ' +
        "and approve the request on Turnkey Metabase's screen. Then ask me to retry.",
    );
  });

  it('links a team step-up through the session, and says it swaps the team account', async () => {
    const error = await insufficientScopeError({ kind: 'team' });
    expect(error).toContain('/api/credentials/metabase/connect?addScopes=agent%3Acontent%3Aread+agent%3Aquery%3Arun&session=session-1');
    expect(error).toContain("This replaces the team's Turnkey Metabase connection with your own Turnkey Metabase account.");
  });

  it('keeps the admin fix for a team connection in a workflow run, which has no conversation to link', async () => {
    expect(await insufficientScopeError({ kind: 'team' }, 'workflow')).toBe(
      'Turnkey Metabase refused this call: the connection does not hold the agent:content:read scope. ' +
        "Ask an admin to add agent:content:read to the Turnkey Metabase integration's scopes. Then reconnect Turnkey Metabase.",
    );
  });

  it('keeps the admin fix for a connection the caller cannot re-grant', async () => {
    expect(await insufficientScopeError({ kind: 'app' })).toBe(
      'Turnkey Metabase refused this call: the connection does not hold the agent:content:read scope. ' +
        "Ask an admin to add agent:content:read to the Turnkey Metabase integration's scopes. Then reconnect Turnkey Metabase.",
    );
  });

  // The scope is declared, but the server granted less (the user lacks the
  // permission). Editing the entry cannot help, so no config advice.
  it('keeps the account fix when the missing scope is already declared', async () => {
    vi.stubGlobal(
      'fetch',
      makeFetchMockFailingCall(403, 'forbidden', {
        'www-authenticate': 'Bearer error="insufficient_scope", scope="agent:sql:run"',
      }),
    );
    const plugin = mcpActionPlugin({
      mcpUrl: 'https://mb.example.com/api/metabase-mcp',
      serviceName: 'metabase',
      defaultRiskLevel: 'low',
      displayName: 'Turnkey Metabase',
      configScopes: ['agent:query:run', 'agent:sql:run'],
    });
    const credentials = fakeCredentialProvider({ accessToken: 'tok', scopes: ['agent:query:run'] });
    const [action] = await plugin.resolveActions!({ credentials });

    expect(await action.execute({}, fakeContext(credentials))).toEqual({
      success: false,
      error:
        'Turnkey Metabase has not granted the agent:sql:run scope to this connection. ' +
        'Turnkey Metabase rejected your connected account. Reconnect Turnkey Metabase on the Integrations page.',
    });
  });

  // A pasted token records no grant, so Valet cannot tell which scopes it lacks.
  it('names no scope when the credential records no grant', async () => {
    vi.stubGlobal(
      'fetch',
      makeFetchMockFailingCall(403, 'forbidden', {
        'www-authenticate': 'Bearer error="insufficient_scope", scope="agent:query:run agent:content:read"',
      }),
    );
    const plugin = mcpActionPlugin({
      mcpUrl: 'https://mb.example.com/api/metabase-mcp',
      serviceName: 'metabase',
      defaultRiskLevel: 'low',
      displayName: 'Turnkey Metabase',
      configScopes: ['agent:query:run'],
    });
    const credentials = fakeCredentialProvider({ accessToken: 'pasted' });
    const [action] = await plugin.resolveActions!({ credentials });

    expect(await action.execute({}, fakeContext(credentials))).toEqual({
      success: false,
      error: 'Turnkey Metabase rejected your connected account. Reconnect Turnkey Metabase on the Integrations page.',
    });
  });

  it('reads an unquoted, capitalized insufficient_scope challenge (RFC 7235)', async () => {
    vi.stubGlobal(
      'fetch',
      makeFetchMockFailingCall(403, 'forbidden', {
        'www-authenticate': 'Bearer Error=insufficient_scope, Scope="agent:query:run agent:content:read"',
      }),
    );
    const plugin = mcpActionPlugin({
      mcpUrl: 'https://mb.example.com/api/metabase-mcp',
      serviceName: 'metabase',
      defaultRiskLevel: 'low',
      displayName: 'Turnkey Metabase',
      configScopes: ['agent:query:run'],
    });
    const credentials = fakeCredentialProvider({ accessToken: 'tok', scopes: ['agent:query:run'] });
    const [action] = await plugin.resolveActions!({ credentials });

    const result = await action.execute({}, fakeContext(credentials));
    expect(result.error).toContain('the connection does not hold the agent:content:read scope.');
    expect(result.error).toContain('addScopes=agent%3Acontent%3Aread+agent%3Aquery%3Arun');
  });

  it('names the missing scope but keeps the account fix when config cannot supply scopes', async () => {
    // A bundled plugin keeps its scopes in code: no admin can add one.
    vi.stubGlobal(
      'fetch',
      makeFetchMockFailingCall(403, 'forbidden', {
        'www-authenticate': 'Bearer error="insufficient_scope", scope="admin:read"',
      }),
    );
    const plugin = mcpActionPlugin({
      mcpUrl: 'https://mcp.linear.app/mcp',
      serviceName: 'linear',
      defaultRiskLevel: 'medium',
      displayName: 'Linear',
    });
    const credentials = fakeCredentialProvider({ accessToken: 'tok', scopes: ['read'] });
    const [action] = await plugin.resolveActions!({ credentials });

    expect(await action.execute({}, fakeContext(credentials))).toEqual({
      success: false,
      error:
        'Linear has not granted the admin:read scope to this connection. ' +
        'Linear rejected your connected account. Reconnect Linear on the Integrations page.',
    });
  });

  it('names the Valet app and the admin fix when the APP token is rejected', async () => {
    vi.stubGlobal('fetch', makeFetchMockFailingCall(401));
    const plugin = mcpActionPlugin({
      mcpUrl: 'https://mcp.linear.app/mcp',
      serviceName: 'linear',
      defaultRiskLevel: 'medium',
      appCredentialService: 'linear:app',
      displayName: 'Linear',
      appConnectHint: 'Settings, Organization, Linear',
    });
    const credentials = fakeScopedCredentialProvider({
      personal: null,
      app: { accessToken: 'app-token' },
      appService: 'linear:app',
    });
    const [action] = await plugin.resolveActions!({ credentials });

    const result = await action.execute({}, fakeContext(credentials));

    expect(result).toEqual({
      success: false,
      error:
        "Linear rejected the Valet app's access. Ask an admin to reconnect the Linear app in Settings, Organization, Linear, or connect your own Linear account on the Integrations page.",
    });
  });

  it('names the reconnect fix when the PERSONAL token is rejected', async () => {
    vi.stubGlobal('fetch', makeFetchMockFailingCall(403));
    const plugin = mcpActionPlugin({
      mcpUrl: 'https://mcp.linear.app/mcp',
      serviceName: 'linear',
      defaultRiskLevel: 'medium',
      appCredentialService: 'linear:app',
      displayName: 'Linear',
      appConnectHint: 'Settings, Organization, Linear',
    });
    const credentials = fakeScopedCredentialProvider({
      personal: { accessToken: 'personal-token' },
      app: { accessToken: 'app-token' },
      appService: 'linear:app',
    });
    const [action] = await plugin.resolveActions!({ credentials });

    const result = await action.execute({}, fakeContext(credentials));

    expect(result).toEqual({
      success: false,
      error: 'Linear rejected your connected account. Reconnect Linear on the Integrations page.',
    });
  });

  // A rejected account gets the fix from whoever holds it, not the caller.
  it.each([
    [
      'the team connection',
      { kind: 'team' },
      "Linear rejected the team's Linear connection. Ask a team admin to reconnect Linear for the team, or connect your own Linear account on the Integrations page.",
    ],
    [
      "another member's share",
      { kind: 'shared', memberId: 'u-002', memberName: 'Dana' },
      'Linear rejected the Linear account that Dana shared with the team. Ask Dana to reconnect Linear, or connect your own Linear account on the Integrations page.',
    ],
    [
      'a share whose member has no name',
      { kind: 'shared', memberId: 'u-002' },
      'Linear rejected a Linear account a team member shared. Ask that member to reconnect Linear, or connect your own Linear account on the Integrations page.',
    ],
    [
      'the org credential',
      { kind: 'org' },
      "Linear rejected the organization's Linear credential. Ask an organization admin to reconnect Linear in Settings, Organization, or connect your own Linear account on the Integrations page.",
    ],
    [
      'the app identity the host resolved',
      { kind: 'app' },
      "Linear rejected the Valet app's access. Ask an admin to reconnect the Linear app in Settings, Organization, Linear, or connect your own Linear account on the Integrations page.",
    ],
    [
      'a 1Password item',
      { kind: 'vault' },
      'Linear rejected the token from its 1Password item. Ask the owner of the Linear item in 1Password to update it, or connect your own Linear account on the Integrations page.',
    ],
  ] satisfies [string, CredentialSource, string][])('names the fix for %s', async (_label, source, error) => {
    vi.stubGlobal('fetch', makeFetchMockFailingCall(401));
    const plugin = mcpActionPlugin({
      mcpUrl: 'https://mcp.linear.app/mcp',
      serviceName: 'linear',
      defaultRiskLevel: 'medium',
      appCredentialService: 'linear:app',
      displayName: 'Linear',
      appConnectHint: 'Settings, Organization, Linear',
    });
    const credentials = fakeScopedCredentialProvider({
      personal: { accessToken: 'held-token', source },
      app: { accessToken: 'app-token' },
      appService: 'linear:app',
    });
    const [action] = await plugin.resolveActions!({ credentials });

    expect(await action.execute({}, fakeContext(credentials))).toEqual({ success: false, error });
  });

  it('falls back to the service id when no displayName is configured', async () => {
    vi.stubGlobal('fetch', makeFetchMockFailingCall(401));
    const plugin = mcpActionPlugin({
      mcpUrl: 'https://mcp.example.com/mcp',
      serviceName: 'example',
      defaultRiskLevel: 'medium',
    });
    const credentials = fakeCredentialProvider({ accessToken: 'tok' });
    const [action] = await plugin.resolveActions!({ credentials });

    const result = await action.execute({}, fakeContext(credentials));

    expect(result).toEqual({
      success: false,
      error:
        "example rejected your connected account. Reconnect example on the Integrations page.",
    });
  });

  it('keeps today\'s verbatim text for a non-auth failure (HTTP 500)', async () => {
    vi.stubGlobal('fetch', makeFetchMockFailingCall(500, 'server exploded'));
    const plugin = mcpActionPlugin({
      mcpUrl: 'https://mcp.linear.app/mcp',
      serviceName: 'linear',
      defaultRiskLevel: 'medium',
      appCredentialService: 'linear:app',
      displayName: 'Linear',
      appConnectHint: 'Settings, Organization, Linear',
    });
    const credentials = fakeScopedCredentialProvider({
      personal: { accessToken: 'personal-token' },
      app: null,
      appService: 'linear:app',
    });
    const [action] = await plugin.resolveActions!({ credentials });

    const result = await action.execute({}, fakeContext(credentials));

    expect(result).toEqual({
      success: false,
      error: 'MCP linear tools/call failed: HTTP 500 — server exploded',
    });
  });

  it('does not misclassify a 500 whose body text contains "HTTP 401" as an auth rejection', async () => {
    // Fix round 2, finding 1: detection must key off McpHttpError.status, not
    // a text match on the message — the message's tail is the server's own
    // response body, verbatim.
    vi.stubGlobal('fetch', makeFetchMockFailingCall(500, 'upstream returned HTTP 401'));
    const plugin = mcpActionPlugin({
      mcpUrl: 'https://mcp.linear.app/mcp',
      serviceName: 'linear',
      defaultRiskLevel: 'medium',
      appCredentialService: 'linear:app',
      displayName: 'Linear',
      appConnectHint: 'Settings, Organization, Linear',
    });
    const credentials = fakeScopedCredentialProvider({
      personal: { accessToken: 'personal-token' },
      app: null,
      appService: 'linear:app',
    });
    const [action] = await plugin.resolveActions!({ credentials });

    const result = await action.execute({}, fakeContext(credentials));

    expect(result).toEqual({
      success: false,
      error: 'MCP linear tools/call failed: HTTP 500 — upstream returned HTTP 401',
    });
  });
});

// ── auth-rejection messages on discovery (fix round 2, finding 2) ──────

function makeFetchMockFailingList(status: number, body = 'nope') {
  return vi.fn(async (url: string | URL, init?: RequestInit) => {
    const reqBody = JSON.parse(String(init?.body ?? '{}')) as { method: string; id?: number };
    if (reqBody.method === 'initialize') {
      return jsonResponse(
        {
          jsonrpc: '2.0',
          id: reqBody.id,
          result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'test-server', version: '1.0.0' } },
        },
        { 'mcp-session-id': 'sess-1' },
      );
    }
    if (reqBody.method === 'notifications/initialized') return jsonResponse({});
    if (reqBody.method === 'tools/list') return errorResponse(status, body);
    throw new Error(`unexpected MCP method in test fixture: ${reqBody.method}`);
  });
}

describe('mcpActionPlugin auth-rejection messages on discovery (HTTP 401/403)', () => {
  it('rethrows the app-token guidance when discovery is rejected using the app token', async () => {
    vi.stubGlobal('fetch', makeFetchMockFailingList(401));
    const plugin = mcpActionPlugin({
      mcpUrl: 'https://mcp.linear.app/mcp',
      serviceName: 'linear',
      defaultRiskLevel: 'medium',
      appCredentialService: 'linear:app',
      displayName: 'Linear',
      appConnectHint: 'Settings, Organization, Linear',
    });
    const credentials = fakeScopedCredentialProvider({
      personal: null,
      app: { accessToken: 'app-token' },
      appService: 'linear:app',
    });

    await expect(plugin.resolveActions!({ credentials })).rejects.toThrow(
      "Linear rejected the Valet app's access. Ask an admin to reconnect the Linear app in Settings, Organization, Linear, or connect your own Linear account on the Integrations page.",
    );
  });

  it('rethrows the personal reconnect guidance when discovery is rejected using the personal token', async () => {
    vi.stubGlobal('fetch', makeFetchMockFailingList(403));
    const plugin = mcpActionPlugin({
      mcpUrl: 'https://mcp.linear.app/mcp',
      serviceName: 'linear',
      defaultRiskLevel: 'medium',
      appCredentialService: 'linear:app',
      displayName: 'Linear',
      appConnectHint: 'Settings, Organization, Linear',
    });
    const credentials = fakeScopedCredentialProvider({
      personal: { accessToken: 'personal-token' },
      app: { accessToken: 'app-token' },
      appService: 'linear:app',
    });

    await expect(plugin.resolveActions!({ credentials })).rejects.toThrow(
      'Linear rejected your connected account. Reconnect Linear on the Integrations page.',
    );
  });

  it('tells the user to disconnect and sign in when an oauthOnly server rejects the personal account', async () => {
    vi.stubGlobal('fetch', makeFetchMockFailingList(401));
    const plugin = mcpActionPlugin({
      mcpUrl: 'https://mcp.usepylon.com',
      serviceName: 'pylon',
      defaultRiskLevel: 'low',
      displayName: 'Pylon',
      oauthOnly: true,
    });
    const credentials = fakeCredentialProvider({ accessToken: 'pasted-api-token' });

    await expect(plugin.resolveActions!({ credentials })).rejects.toThrow(
      'Pylon rejected your connected account. Disconnect Pylon on the Integrations page, then select Connect to sign in with Pylon.',
    );
  });

  it('rethrows a non-auth discovery failure unchanged (HTTP 500)', async () => {
    vi.stubGlobal('fetch', makeFetchMockFailingList(500, 'server exploded'));
    const plugin = mcpActionPlugin({
      mcpUrl: 'https://mcp.linear.app/mcp',
      serviceName: 'linear',
      defaultRiskLevel: 'medium',
      appCredentialService: 'linear:app',
      displayName: 'Linear',
      appConnectHint: 'Settings, Organization, Linear',
    });
    const credentials = fakeScopedCredentialProvider({
      personal: { accessToken: 'personal-token' },
      app: null,
      appService: 'linear:app',
    });

    await expect(plugin.resolveActions!({ credentials })).rejects.toThrow(
      'MCP linear tools/list failed: HTTP 500 — server exploded',
    );
  });
});
