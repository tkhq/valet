import { createHash } from 'node:crypto';
import type { McpTool, McpToolResult, JsonRpcRequest, JsonRpcResponse } from './types.js';

/**
 * Lightweight MCP client using JSON-RPC over HTTP (streamable HTTP transport).
 *
 * Handles the required initialization handshake per the MCP spec:
 * 1. POST initialize → get Mcp-Session-Id
 * 2. POST notifications/initialized (one-way notification)
 * 3. Subsequent requests include Mcp-Session-Id header
 *
 * Supports both JSON and SSE response formats per the Streamable HTTP transport spec.
 */
export class McpClient {
  private url: string;
  private serviceName: string;
  private nextId = 1;
  /** When set, token is sent as a URL query parameter instead of Authorization header. */
  private authQueryParam?: string;

  /**
   * Per-credential session IDs to avoid re-initializing on every call.
   * Keyed by a hash of the bearer token (never the raw token — see credentialKey()),
   * so that concurrent callers with different tokens never share an
   * `Mcp-Session-Id`. A single McpClient instance is a singleton per service
   * across all requests in the process, so keying on serviceName alone would
   * let one user's session (and thus session-scoped authorization context) be
   * reused for another user's tools/list + tools/call requests.
   */
  private sessions = new Map<string, string | null>();

  constructor(opts: { url: string; serviceName: string; authQueryParam?: string }) {
    this.url = opts.url;
    this.serviceName = opts.serviceName;
    this.authQueryParam = opts.authQueryParam;
  }

  /** Build fetch URL and headers with auth + session. */
  private buildFetchOpts(token?: string, sessionId?: string | null): { url: string; headers: Record<string, string> } {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    };

    let url = this.url;
    if (token && this.authQueryParam) {
      const sep = this.url.includes('?') ? '&' : '?';
      url = `${this.url}${sep}${this.authQueryParam}=${encodeURIComponent(token)}`;
    } else if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }
    if (sessionId) {
      headers['Mcp-Session-Id'] = sessionId;
    }

    return { url, headers };
  }

  /** Send a JSON-RPC request, handling both JSON and SSE response formats. */
  private async rpc<T>(
    method: string,
    params: Record<string, unknown> | undefined,
    token: string | undefined,
    sessionId?: string | null,
  ): Promise<{ result: T; sessionId: string | null }> {
    const req: JsonRpcRequest = {
      jsonrpc: '2.0',
      id: this.nextId++,
      method,
      ...(params !== undefined && { params }),
    };

    const { url: fetchUrl, headers } = this.buildFetchOpts(token, sessionId);

    const res = await fetch(fetchUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(req),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`MCP ${this.serviceName} ${method} failed: HTTP ${res.status}${body ? ` — ${body.slice(0, 200)}` : ''}`);
    }

    // Capture session ID from response header
    const respSessionId = res.headers.get('mcp-session-id') ?? sessionId ?? null;

    // Parse response — server may respond with JSON or SSE
    const contentType = res.headers.get('content-type') ?? '';
    let rpcRes: JsonRpcResponse<T>;

    if (contentType.includes('text/event-stream')) {
      // SSE response: parse events to find the JSON-RPC result
      rpcRes = await this.parseSseResponse<T>(res);
    } else {
      rpcRes = (await res.json()) as JsonRpcResponse<T>;
    }

    if (rpcRes.error) {
      throw new Error(`MCP ${this.serviceName} ${method} error: [${rpcRes.error.code}] ${rpcRes.error.message}`);
    }

    return { result: rpcRes.result as T, sessionId: respSessionId };
  }

  /** Parse an SSE response stream to extract the JSON-RPC response. */
  private async parseSseResponse<T>(res: Response): Promise<JsonRpcResponse<T>> {
    const text = await res.text();
    // SSE format: lines like "event: message\ndata: {...}\n\n"
    const lines = text.split('\n');
    for (const line of lines) {
      if (line.startsWith('data: ')) {
        const data = line.slice(6).trim();
        if (data) {
          try {
            return JSON.parse(data) as JsonRpcResponse<T>;
          } catch {
            // Not valid JSON, skip
          }
        }
      }
    }
    throw new Error(`MCP ${this.serviceName}: no JSON-RPC message found in SSE response`);
  }

  /** Send a one-way JSON-RPC notification (no id, no response expected). */
  private async notify(
    method: string,
    params: Record<string, unknown> | undefined,
    token: string | undefined,
    sessionId?: string | null,
  ): Promise<void> {
    const req = {
      jsonrpc: '2.0' as const,
      method,
      ...(params !== undefined && { params }),
    };

    const { url: fetchUrl, headers } = this.buildFetchOpts(token, sessionId);

    // Fire and forget — notifications don't have responses
    await fetch(fetchUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(req),
    });
  }

  /** Derive a cache key from the credential identity — a short hash of the bearer
   *  token, never the raw token itself. `"anon"` is used for the no-auth / no-token
   *  case. This client instance is a per-service singleton shared across all
   *  callers in the process, so the key must be scoped to the credential, not just
   *  the service — otherwise one user's session (and its server-side authorization
   *  context) would be reused for another user's requests. */
  private credentialKey(token?: string): string {
    if (!token) return 'anon';
    return createHash('sha256').update(token).digest('hex').slice(0, 16);
  }

  /**
   * Ensure the session is initialized for this token.
   * MCP Streamable HTTP spec requires initialize before other methods.
   * Falls back to no-session mode if initialize fails (some servers don't require it).
   */
  private async ensureInitialized(token?: string): Promise<string | null> {
    // Key on a hash of the credential (per credentialKey()), not just service name.
    // Sessions are server-side and are re-initialized whenever the credential
    // changes — including on token rotation, since we can't tell a rotated token
    // apart from a different user's token without re-running initialize. That's an
    // accepted cost: it trades a few extra initialize + notify round-trips for never
    // reusing one caller's session (and authorization context) for another's calls.
    const cacheKey = this.credentialKey(token);
    if (this.sessions.has(cacheKey)) {
      return this.sessions.get(cacheKey) ?? null;
    }

    try {
      const { result, sessionId } = await this.rpc<{
        protocolVersion: string;
        capabilities: Record<string, unknown>;
        serverInfo: { name: string; version: string };
      }>(
        'initialize',
        {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'valet', version: '1.0.0' },
        },
        token,
      );

      console.log(`[McpClient] ${this.serviceName} initialized: protocol=${result?.protocolVersion}, sessionId=${sessionId}, server=${result?.serverInfo?.name}/${result?.serverInfo?.version}`);

      this.sessions.set(cacheKey, sessionId);

      // Send initialized notification
      await this.notify('notifications/initialized', undefined, token, sessionId);

      return sessionId;
    } catch (err) {
      console.warn(
        `[McpClient] ${this.serviceName} initialize failed, falling back to no-session mode:`,
        err instanceof Error ? err.message : String(err),
      );
      // Cache null so we don't retry initialization on every call
      this.sessions.set(cacheKey, null);
      return null;
    }
  }

  /** List available tools from the MCP server. */
  async listTools(token?: string): Promise<McpTool[]> {
    const sessionId = await this.ensureInitialized(token);
    const { result } = await this.rpc<{ tools: McpTool[] }>('tools/list', {}, token, sessionId);
    return result?.tools ?? [];
  }

  /** Call a tool by name with arguments. */
  async callTool(token: string | undefined, name: string, args: unknown): Promise<McpToolResult> {
    const sessionId = await this.ensureInitialized(token);
    const { result } = await this.rpc<McpToolResult>('tools/call', { name, arguments: args }, token, sessionId);
    return result;
  }
}
