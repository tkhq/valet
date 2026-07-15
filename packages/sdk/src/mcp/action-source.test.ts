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
