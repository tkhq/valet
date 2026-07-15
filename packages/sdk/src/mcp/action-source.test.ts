import { describe, expect, it, vi } from 'vitest';
import { McpActionSource } from './action-source.js';

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json', ...init.headers },
    ...init,
  });
}

async function readRpc(init?: RequestInit): Promise<{ method: string; id: number }> {
  return JSON.parse(String(init?.body));
}

describe('McpActionSource', () => {
  it('uses a text output schema when an MCP tool does not advertise one', async () => {
    const fakeFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const rpc = await readRpc(init);
      if (rpc.method === 'initialize') {
        return jsonResponse({
          jsonrpc: '2.0',
          id: rpc.id,
          result: {
            protocolVersion: '2025-11-25',
            capabilities: {},
            serverInfo: { name: 'fake', version: '1.0.0' },
          },
        }, { headers: { 'mcp-session-id': 'session-1' } });
      }
      if (rpc.method === 'notifications/initialized') {
        return new Response(null, { status: 202 });
      }
      return jsonResponse({
        jsonrpc: '2.0',
        id: rpc.id,
        result: {
          tools: [{
            name: 'query',
            description: 'Query data',
            inputSchema: { type: 'object' },
          }],
        },
      });
    });

    const source = new McpActionSource({
      mcpUrl: 'https://mcp.example.com',
      serviceName: 'custom',
      noAuth: true,
      fetch: fakeFetch,
    });

    await expect(source.listActions()).resolves.toMatchObject([{
      id: 'custom.query',
      outputSchema: { type: 'string' },
    }]);
  });

  it('preserves advertised MCP output schemas', async () => {
    const advertisedOutputSchema = {
      type: 'object',
      properties: {
        records: { type: 'array', items: { type: 'object' } },
      },
    };
    const fakeFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const rpc = await readRpc(init);
      if (rpc.method === 'initialize') {
        return jsonResponse({
          jsonrpc: '2.0',
          id: rpc.id,
          result: {
            protocolVersion: '2025-11-25',
            capabilities: {},
            serverInfo: { name: 'fake', version: '1.0.0' },
          },
        }, { headers: { 'mcp-session-id': 'session-1' } });
      }
      if (rpc.method === 'notifications/initialized') {
        return new Response(null, { status: 202 });
      }
      return jsonResponse({
        jsonrpc: '2.0',
        id: rpc.id,
        result: {
          tools: [{
            name: 'query',
            inputSchema: { type: 'object' },
            outputSchema: advertisedOutputSchema,
          }],
        },
      });
    });

    const source = new McpActionSource({
      mcpUrl: 'https://mcp.example.com',
      serviceName: 'custom',
      noAuth: true,
      fetch: fakeFetch,
    });

    await expect(source.listActions()).resolves.toMatchObject([{
      id: 'custom.query',
      outputSchema: advertisedOutputSchema,
    }]);
  });

  it('parses JSON-in-text tool results into structured data', async () => {
    // Older MCP servers stringify their JSON output into a text block.
    // Without parsing here, `data` is a string and downstream template
    // paths like `{{nodes.query.data.records}}` resolve to null.
    const fakeFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const rpc = await readRpc(init);
      if (rpc.method === 'initialize') {
        return jsonResponse({
          jsonrpc: '2.0', id: rpc.id,
          result: { protocolVersion: '2025-11-25', capabilities: {}, serverInfo: { name: 'fake', version: '1.0.0' } },
        }, { headers: { 'mcp-session-id': 'session-1' } });
      }
      if (rpc.method === 'notifications/initialized') return new Response(null, { status: 202 });
      return jsonResponse({
        jsonrpc: '2.0', id: rpc.id,
        result: {
          content: [{ type: 'text', text: '{"totalSize":3,"records":[{"Name":"Stripe"}]}' }],
        },
      });
    });

    const source = new McpActionSource({ mcpUrl: 'https://mcp.example.com', serviceName: 'custom', noAuth: true, fetch: fakeFetch });
    const result = await source.execute('custom.soqlQuery', {}, { credentials: {}, userId: 'u' });
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ totalSize: 3, records: [{ Name: 'Stripe' }] });
  });

  it('prefers structuredContent over parsed text when both are present', async () => {
    const fakeFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const rpc = await readRpc(init);
      if (rpc.method === 'initialize') {
        return jsonResponse({
          jsonrpc: '2.0', id: rpc.id,
          result: { protocolVersion: '2025-11-25', capabilities: {}, serverInfo: { name: 'fake', version: '1.0.0' } },
        }, { headers: { 'mcp-session-id': 'session-1' } });
      }
      if (rpc.method === 'notifications/initialized') return new Response(null, { status: 202 });
      return jsonResponse({
        jsonrpc: '2.0', id: rpc.id,
        result: {
          content: [{ type: 'text', text: '{"legacy":"ignore me"}' }],
          structuredContent: { canonical: 'use me', count: 42 },
        },
      });
    });

    const source = new McpActionSource({ mcpUrl: 'https://mcp.example.com', serviceName: 'custom', noAuth: true, fetch: fakeFetch });
    const result = await source.execute('custom.tool', {}, { credentials: {}, userId: 'u' });
    expect(result.data).toEqual({ canonical: 'use me', count: 42 });
  });

  it('decodes TOON-formatted text tool results into structured data', async () => {
    // Attio's MCP server emits TOON (see https://attio.com/engineering/blog/building-the-attio-mcp-server)
    // for token efficiency and never populates structuredContent.
    // JSON.parse fails on TOON, so without a TOON decode fallback every
    // downstream template path against Attio outputs resolves to null.
    const toonPayload = '[1]:\n  - record_id: abc-123\n    attributes:\n      name: BVNK\n      domains[1]: bvnk.com';
    const fakeFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const rpc = await readRpc(init);
      if (rpc.method === 'initialize') {
        return jsonResponse({
          jsonrpc: '2.0', id: rpc.id,
          result: { protocolVersion: '2025-11-25', capabilities: {}, serverInfo: { name: 'fake', version: '1.0.0' } },
        }, { headers: { 'mcp-session-id': 'session-1' } });
      }
      if (rpc.method === 'notifications/initialized') return new Response(null, { status: 202 });
      return jsonResponse({
        jsonrpc: '2.0', id: rpc.id,
        result: { content: [{ type: 'text', text: toonPayload }] },
      });
    });

    const source = new McpActionSource({ mcpUrl: 'https://mcp.example.com', serviceName: 'attio', noAuth: true, fetch: fakeFetch });
    const result = await source.execute('attio.get-records-by-ids', {}, { credentials: {}, userId: 'u' });
    expect(result.success).toBe(true);
    expect(Array.isArray(result.data)).toBe(true);
    const arr = result.data as Array<{ record_id: string; attributes: { name: string; domains: string[] } }>;
    expect(arr[0]?.record_id).toBe('abc-123');
    expect(arr[0]?.attributes.name).toBe('BVNK');
    expect(arr[0]?.attributes.domains).toEqual(['bvnk.com']);
  });

  it('prefers JSON parsing over TOON decoding when text is valid JSON', async () => {
    // TOON is lenient enough to decode a JSON string into a mangled
    // object (e.g. `{"records":[...]}` → `{'"records"': '[...]'}`).
    // JSON must win. This test picks a payload where the TOON decode
    // WOULD produce a different (and clearly wrong) shape, so a future
    // reorder or gate change would break the assertion loudly.
    const jsonText = '{"records":[{"Name":"Stripe"}]}';
    const fakeFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const rpc = await readRpc(init);
      if (rpc.method === 'initialize') {
        return jsonResponse({
          jsonrpc: '2.0', id: rpc.id,
          result: { protocolVersion: '2025-11-25', capabilities: {}, serverInfo: { name: 'fake', version: '1.0.0' } },
        }, { headers: { 'mcp-session-id': 'session-1' } });
      }
      if (rpc.method === 'notifications/initialized') return new Response(null, { status: 202 });
      return jsonResponse({
        jsonrpc: '2.0', id: rpc.id,
        result: { content: [{ type: 'text', text: jsonText }] },
      });
    });

    const source = new McpActionSource({ mcpUrl: 'https://mcp.example.com', serviceName: 'custom', noAuth: true, fetch: fakeFetch });
    const result = await source.execute('custom.query', {}, { credentials: {}, userId: 'u' });
    // Precise shape: an array of records, not the string-keyed object
    // shape TOON would produce.
    const data = result.data as { records: Array<{ Name: string }> };
    expect(Array.isArray(data.records)).toBe(true);
    expect(data.records[0]?.Name).toBe('Stripe');
  });

  it('does not decode plain-text output containing a colon as TOON', async () => {
    // Regression guard: TOON accepts `"Error: Invalid input"` and
    // returns `{Error: 'Invalid input'}`. Without the TOON structural-
    // marker gate, any text tool response with a colon on the first
    // line would silently coerce into an object, corrupting downstream
    // consumers that expect a string. The gate requires a `[N]:` /
    // `field[N]:` / `field[N]{...}:` marker before decoding.
    const cases = [
      'Error: Invalid input',
      'Summary: My take is that this workflow is fine',
      'Overview:\n  status: ok\n  count: 3',
    ];
    for (const text of cases) {
      const fakeFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        const rpc = await readRpc(init);
        if (rpc.method === 'initialize') {
          return jsonResponse({
            jsonrpc: '2.0', id: rpc.id,
            result: { protocolVersion: '2025-11-25', capabilities: {}, serverInfo: { name: 'fake', version: '1.0.0' } },
          }, { headers: { 'mcp-session-id': 'session-1' } });
        }
        if (rpc.method === 'notifications/initialized') return new Response(null, { status: 202 });
        return jsonResponse({
          jsonrpc: '2.0', id: rpc.id,
          result: { content: [{ type: 'text', text }] },
        });
      });
      const source = new McpActionSource({ mcpUrl: 'https://mcp.example.com', serviceName: 'custom', noAuth: true, fetch: fakeFetch });
      const result = await source.execute('custom.echo', {}, { credentials: {}, userId: 'u' });
      expect(result.success).toBe(true);
      expect(result.data).toBe(text);
    }
  });

  it('preserves plain-text output that is not JSON', async () => {
    const fakeFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const rpc = await readRpc(init);
      if (rpc.method === 'initialize') {
        return jsonResponse({
          jsonrpc: '2.0', id: rpc.id,
          result: { protocolVersion: '2025-11-25', capabilities: {}, serverInfo: { name: 'fake', version: '1.0.0' } },
        }, { headers: { 'mcp-session-id': 'session-1' } });
      }
      if (rpc.method === 'notifications/initialized') return new Response(null, { status: 202 });
      return jsonResponse({
        jsonrpc: '2.0', id: rpc.id,
        result: { content: [{ type: 'text', text: 'hello, world' }] },
      });
    });

    const source = new McpActionSource({ mcpUrl: 'https://mcp.example.com', serviceName: 'custom', noAuth: true, fetch: fakeFetch });
    const result = await source.execute('custom.echo', {}, { credentials: {}, userId: 'u' });
    expect(result.data).toBe('hello, world');
  });

  it('reports listTools failures via onListError, not shared instance state', async () => {
    // Two concurrent listActions calls on the same instance: one
    // fails, one succeeds. Each caller must observe its own outcome
    // — the successful call must not clobber the failing call's
    // error, and vice versa.
    let sessionCounter = 0;
    let toolsListCount = 0;
    const fakeFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const rpc = await readRpc(init);
      if (rpc.method === 'initialize') {
        return jsonResponse({
          jsonrpc: '2.0',
          id: rpc.id,
          result: { protocolVersion: '2025-11-25', capabilities: {}, serverInfo: { name: 'fake', version: '1.0.0' } },
        }, { headers: { 'mcp-session-id': `session-${++sessionCounter}` } });
      }
      if (rpc.method === 'notifications/initialized') return new Response(null, { status: 202 });
      // First tools/list succeeds; second throws. Interleaving is
      // deterministic because both callers hit the same fetch mock
      // sequentially — this is enough to prove the sinks are per-call.
      toolsListCount++;
      if (toolsListCount === 1) {
        return jsonResponse({ jsonrpc: '2.0', id: rpc.id, result: { tools: [{ name: 'ok', inputSchema: { type: 'object' } }] } });
      }
      throw new Error('mcp server exploded');
    });

    const source = new McpActionSource({
      mcpUrl: 'https://mcp.example.com',
      serviceName: 'custom',
      noAuth: true,
      fetch: fakeFetch,
    });

    let firstError: string | null = null;
    let secondError: string | null = null;
    const okActions = await source.listActions({ onListError: (e) => { firstError = e; } });
    const failActions = await source.listActions({ onListError: (e) => { secondError = e; } });

    expect(okActions.length).toBe(1);
    expect(firstError).toBeNull();
    expect(failActions.length).toBe(0);
    expect(secondError).toMatch(/mcp server exploded/);
    // Prior behavior stashed error on the instance — a third call
    // starting fresh would inherit the second call's error via
    // getLastListError(). With per-call sinks, a fresh call with no
    // onListError observes nothing.
    let thirdError: string | null = null;
    await source.listActions({ onListError: (e) => { thirdError = e; } });
    // Third call fails too (mock's toolsListCount > 1 always throws),
    // but it must write to ITS sink, not leak into secondError.
    expect(secondError).toMatch(/mcp server exploded/);
    expect(thirdError).toMatch(/mcp server exploded/);
  });
});
