/**
 * Integration tests for the MCP endpoint (Task 9):
 *
 *   - `/.well-known/oauth-authorization-server` (mounted in Task 6) reports
 *     an `authorization_endpoint` ending `/mcp/authorize` — asserted here as
 *     the discovery half of the contract this endpoint's clients rely on.
 *   - `/mcp` without a `Bearer` token 401s with a `WWW-Authenticate` header
 *     (`withMcpAuth`'s own behavior, not hand-rolled).
 *   - A seeded `oauth_access_token` row (valid expiry, pointed at a real
 *     user) drives a real `initialize` / `tools/list` / `tools/call whoami`
 *     JSON-RPC round trip over the Streamable HTTP transport, and `whoami`
 *     returns the seeded user's own identity — never a caller-supplied id.
 */
import { describe, it, expect, afterEach } from "vitest";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { users, oauthAccessToken, agentSessions } from "../schema/index.js";

let api: TestApi | undefined;

afterEach(async () => {
  await api?.cleanup();
  api = undefined;
});

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string };
}

const MCP_HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
};

async function mcpRequest(baseUrl: string, accessToken: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: { ...MCP_HEADERS, Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify(body),
  });
}

describe("MCP endpoint", () => {
  it("discovery metadata's authorization_endpoint ends /mcp/authorize", async () => {
    api = await bootTestApi({ auth: true });

    const res = await fetch(`${api.baseUrl}/.well-known/oauth-authorization-server`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { authorization_endpoint: string };
    expect(body.authorization_endpoint).toMatch(/\/mcp\/authorize$/);
  });

  it("401s with a WWW-Authenticate header when no Bearer token is presented", async () => {
    api = await bootTestApi({ auth: true });

    const res = await mcpRequest(api.baseUrl, "not-a-real-token", {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1.0" } },
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toBeTruthy();
  });

  it("401s with a WWW-Authenticate header on a request with no Authorization header at all", async () => {
    api = await bootTestApi({ auth: true });

    const res = await fetch(`${api.baseUrl}/mcp`, { method: "POST", headers: MCP_HEADERS, body: "{}" });
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toBeTruthy();
  });

  it("a valid Bearer token drives initialize / tools-list / tools-call whoami, returning the seeded user", async () => {
    api = await bootTestApi({ auth: true });
    const { db } = api.providers;

    const now = Date.now();
    db.insert(users)
      .values({
        id: "mcp-user-1",
        name: "MCP User",
        email: "mcp-user@nowhere.test",
        role: "member",
        createdAt: new Date(now),
        updatedAt: new Date(now),
      })
      .run();

    const accessToken = "mcp-test-access-token";
    db.insert(oauthAccessToken)
      .values({
        id: "mcp-token-1",
        accessToken,
        refreshToken: "mcp-refresh-token-1",
        accessTokenExpiresAt: new Date(now + 60_000),
        refreshTokenExpiresAt: new Date(now + 3_600_000),
        clientId: null,
        userId: "mcp-user-1",
        scopes: "mcp",
        createdAt: new Date(now),
        updatedAt: new Date(now),
      })
      .run();

    db.insert(agentSessions)
      .values({
        id: "mcp-session-1",
        userId: "mcp-user-1",
        orgId: "mcp-org-1",
        workspace: "/tmp/mcp-session-1",
        title: "My session",
        status: "active",
        ownerType: "user",
        ownerId: "mcp-user-1",
        createdAt: now,
        updatedAt: now,
      })
      .run();

    const initRes = await mcpRequest(api.baseUrl, accessToken, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1.0" } },
    });
    expect(initRes.status).toBe(200);
    const initBody = (await initRes.json()) as JsonRpcResponse;
    expect(initBody.error).toBeUndefined();
    expect(initBody.result).toBeDefined();

    const listRes = await mcpRequest(api.baseUrl, accessToken, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    });
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as JsonRpcResponse & { result?: { tools: Array<{ name: string }> } };
    const toolNames = listBody.result?.tools.map((t) => t.name) ?? [];
    expect(toolNames).toContain("whoami");
    expect(toolNames).toContain("list_sessions");

    const whoamiRes = await mcpRequest(api.baseUrl, accessToken, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "whoami", arguments: {} },
    });
    expect(whoamiRes.status).toBe(200);
    const whoamiBody = (await whoamiRes.json()) as JsonRpcResponse & {
      result?: { content: Array<{ type: string; text: string }>; isError?: boolean };
    };
    expect(whoamiBody.result?.isError).not.toBe(true);
    const whoamiText = whoamiBody.result?.content[0]?.text ?? "{}";
    const whoami = JSON.parse(whoamiText) as { userId: string; email: string; role: string };
    expect(whoami).toEqual({ userId: "mcp-user-1", email: "mcp-user@nowhere.test", role: "member" });

    const listSessionsRes = await mcpRequest(api.baseUrl, accessToken, {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "list_sessions", arguments: {} },
    });
    expect(listSessionsRes.status).toBe(200);
    const listSessionsBody = (await listSessionsRes.json()) as JsonRpcResponse & {
      result?: { content: Array<{ type: string; text: string }> };
    };
    const listSessionsText = listSessionsBody.result?.content[0]?.text ?? "[]";
    const sessions = JSON.parse(listSessionsText) as Array<{ id: string; title: string | null; status: string }>;
    expect(sessions).toEqual([{ id: "mcp-session-1", title: "My session", status: "active" }]);
  });

  it("an expired oauth_access_token row is rejected with 401", async () => {
    api = await bootTestApi({ auth: true });
    const { db } = api.providers;

    const now = Date.now();
    db.insert(users)
      .values({
        id: "mcp-user-expired",
        name: "MCP Expired User",
        email: "mcp-expired@nowhere.test",
        role: "member",
        createdAt: new Date(now),
        updatedAt: new Date(now),
      })
      .run();

    const accessToken = "mcp-test-access-token-expired";
    db.insert(oauthAccessToken)
      .values({
        id: "mcp-token-expired",
        accessToken,
        refreshToken: "mcp-refresh-token-expired",
        // Expired: expiry is in the past.
        accessTokenExpiresAt: new Date(now - 60_000),
        refreshTokenExpiresAt: new Date(now + 3_600_000),
        clientId: null,
        userId: "mcp-user-expired",
        scopes: "mcp",
        createdAt: new Date(now - 120_000),
        updatedAt: new Date(now - 120_000),
      })
      .run();

    const res = await mcpRequest(api.baseUrl, accessToken, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1.0" } },
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toBeTruthy();
  });
});
