/**
 * Integration tests for the MCP endpoint (Task 9):
 *
 *   - `/.well-known/oauth-authorization-server` (mounted in Task 6) reports
 *     an `authorization_endpoint` ending `/mcp/authorize` — asserted here as
 *     the discovery half of the contract this endpoint's clients rely on.
 *   - `/mcp` without a `Bearer` token 401s with a `WWW-Authenticate` header
 *     (`withMcpAuth`'s own behavior, not hand-rolled).
 *   - Seeded OAuth tokens drive real JSON-RPC calls through the stateless
 *     transport. Tool handlers use only the verified user and live team access.
 */
import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import memoryPlugin from "@valet/plugin-memory/plugin";
import { users, oauthAccessToken, agentSessions, actionInvocations, memoryFiles, orgs, orgMembers } from "../schema/index.js";
import { addMember, createTeam } from "../services/teams.js";
import { writeFile } from "../services/memory.js";

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
    await db.insert(users).values({
      id: "mcp-user-1",
      name: "MCP User",
      email: "mcp-user@nowhere.test",
      role: "member",
      createdAt: new Date(now),
      updatedAt: new Date(now),
    });

    const accessToken = "mcp-test-access-token";
    await db.insert(oauthAccessToken).values({
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
    });

    await db.insert(agentSessions).values({
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
    });

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
    await db.insert(users).values({
      id: "mcp-user-expired",
      name: "MCP Expired User",
      email: "mcp-expired@nowhere.test",
      role: "member",
      createdAt: new Date(now),
      updatedAt: new Date(now),
    });

    const accessToken = "mcp-test-access-token-expired";
    await db.insert(oauthAccessToken).values({
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
    });

    const res = await mcpRequest(api.baseUrl, accessToken, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1.0" } },
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toBeTruthy();
  });

  it("scopes memory tools to OAuth identity, confines capture, and audits calls", async () => {
    api = await bootTestApi({ auth: true, plugins: [memoryPlugin] });
    const { db } = api.providers;
    const now = Date.now();
    await db.insert(orgs).values({ id: "mcp-org", name: "MCP Org", createdAt: now });
    for (const id of ["mcp-reader", "other-user"]) {
      await db.insert(users).values({
        id,
        name: id,
        email: `${id}@nowhere.test`,
        role: "member",
        createdAt: new Date(now),
        updatedAt: new Date(now),
      });
      await db.insert(orgMembers).values({ orgId: "mcp-org", userId: id, role: "member", createdAt: now });
    }
    const token = "memory-mcp-token";
    await db.insert(oauthAccessToken).values({
      id: "memory-mcp-token-row",
      accessToken: token,
      refreshToken: "memory-mcp-refresh",
      accessTokenExpiresAt: new Date(now + 60_000),
      refreshTokenExpiresAt: new Date(now + 3_600_000),
      clientId: null,
      userId: "mcp-reader",
      scopes: "mcp",
      createdAt: new Date(now),
      updatedAt: new Date(now),
    });

    const joined = await createTeam(db, { orgId: "mcp-org", name: "Joined", creatorUserId: "other-user" });
    await addMember(db, { teamId: joined.id, userId: "mcp-reader", role: "member" });
    const forbidden = await createTeam(db, { orgId: "mcp-org", name: "Forbidden", creatorUserId: "other-user" });
    await writeFile(db, { owner: { type: "user", id: "mcp-reader" }, actorUserId: "mcp-reader" }, {
      path: "notes/mine.md", content: "oauth-scope-marker personal",
    });
    await writeFile(db, { owner: { type: "user", id: "other-user" }, actorUserId: "other-user" }, {
      path: "notes/other.md", content: "oauth-scope-marker other-private",
    });
    await writeFile(db, { owner: { type: "team", id: joined.id }, actorUserId: "other-user" }, {
      path: "notes/joined.md", content: "oauth-scope-marker joined-team",
    });
    await writeFile(db, { owner: { type: "team", id: forbidden.id }, actorUserId: "other-user" }, {
      path: "notes/forbidden.md", content: "oauth-scope-marker forbidden-team",
    });

    const rpc = async (id: number, method: string, params: Record<string, unknown>) => {
      const response = await mcpRequest(api!.baseUrl, token, { jsonrpc: "2.0", id, method, params });
      expect(response.status).toBe(200);
      return (await response.json()) as JsonRpcResponse & {
        result?: { tools?: Array<{ name: string; inputSchema?: { properties?: Record<string, unknown> } }>; content?: Array<{ type: string; text: string }>; isError?: boolean };
      };
    };
    const call = (id: number, name: string, args: Record<string, unknown>) =>
      rpc(id, "tools/call", { name, arguments: args });

    const listed = await rpc(10, "tools/list", {});
    const tools = listed.result?.tools ?? [];
    const names = tools.map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining(["mem_capture", "mem_search", "mem_read"]));
    for (const forbiddenName of ["mem_write", "mem_patch", "mem_move", "mem_rm"]) {
      expect(names).not.toContain(forbiddenName);
    }
    for (const name of ["mem_capture", "mem_search", "mem_read"]) {
      const properties = tools.find((tool) => tool.name === name)?.inputSchema?.properties ?? {};
      expect(properties).not.toHaveProperty("userId");
      expect(properties).not.toHaveProperty("owner");
      expect(properties).not.toHaveProperty("scope");
    }
    expect(tools.find((tool) => tool.name === "mem_capture")?.inputSchema?.properties).not.toHaveProperty("path");

    const capture = await call(11, "mem_capture", {
      title: "OAuth Capture",
      path: "notes/attacker-choice.md",
      owner: { type: "user", id: "other-user" },
      content: "---\nvalet:\n  origin: forged\n---\n# Captured\n\nkept body",
    });
    expect(capture.result?.isError).not.toBe(true);
    const captureText = capture.result?.content?.[0]?.text ?? "{}";
    const captured = JSON.parse(captureText) as { path: string };
    expect(captured.path).toMatch(/^90-inbox\/\d{4}-\d{2}-\d{2}-oauth-capture\.md$/);
    const [captureRow] = await db.select().from(memoryFiles).where(eq(memoryFiles.path, captured.path));
    expect(captureRow).toMatchObject({
      ownerType: "user", ownerId: "mcp-reader", origin: "mcp:external", content: "# Captured\n\nkept body",
    });
    expect((await db.select().from(memoryFiles)).some((row) => row.path === "notes/attacker-choice.md")).toBe(false);

    const overwrite = await call(15, "mem_capture", { title: "OAuth Capture", content: "replacement" });
    expect(overwrite.result?.isError).toBe(true);
    expect((await db.select().from(memoryFiles).where(eq(memoryFiles.path, captured.path)))[0]?.content).toBe("# Captured\n\nkept body");

    const search = await call(12, "mem_search", { query: "oauth-scope-marker", owner: "other-user" });
    const searchRows = JSON.parse(search.result?.content?.[0]?.text ?? "[]") as Array<{ path: string }>;
    expect(searchRows.map((row) => row.path)).toEqual(expect.arrayContaining([
      "notes/mine.md", `team:${joined.id}/notes/joined.md`,
    ]));
    expect(searchRows.map((row) => row.path)).not.toEqual(expect.arrayContaining([
      "notes/other.md", `team:${forbidden.id}/notes/forbidden.md`,
    ]));

    const teamRead = await call(13, "mem_read", { path: `team:${joined.id}/notes/joined.md` });
    expect(teamRead.result?.content?.[0]?.text).toContain("joined-team");
    const rejectedRead = await call(14, "mem_read", { path: `team:${forbidden.id}/notes/forbidden.md` });
    expect(rejectedRead.result?.isError).toBe(true);
    expect(rejectedRead.result?.content?.[0]?.text).toContain("Use mem_search");
    expect(rejectedRead.result?.content?.[0]?.text).not.toContain("forbidden-team");

    const audits = (await db.select().from(actionInvocations)).filter((row) => row.actionId?.startsWith("mem_"));
    expect(audits).toHaveLength(5);
    expect(audits.every((row) => row.createdAt > 0 && row.userId === "mcp-reader" && row.sourceIp !== null && row.sourceIp !== "unknown")).toBe(true);
    expect(audits.find((row) => row.actionId === "mem_read" && row.status === "error")).toBeDefined();
    const captureAudit = audits.find((row) => row.actionId === "mem_capture");
    expect(captureAudit?.params).toEqual({ title: "OAuth Capture", content: "[redacted memory content]" });
    expect(JSON.stringify(audits)).not.toContain("kept body");
    expect(JSON.stringify(audits)).not.toContain("forbidden-team");
  });
});
