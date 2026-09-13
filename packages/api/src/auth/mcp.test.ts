import { describe, it, expect, afterEach } from "vitest";
import { eq, sql } from "drizzle-orm";
import type { PluginActionContext, ValetPlugin } from "@valet/engine";
import memoryPlugin from "@valet/plugin-memory/plugin";
import valetPlugin from "@valet/plugin-valet/plugin";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import type { AppDb } from "../lib/drizzle.js";
import { listActionLog } from "../policies/admin.js";
import { persistInvocationAuditStrict, updateInvocationOutcomeStrict } from "../policies/service.js";
import { users, oauthAccessToken, agentSessions, actionInvocations, memoryFiles, orgs, orgMembers, assistants, skills, teamMembers } from "../schema/index.js";
import { addMember, createTeam } from "../services/teams.js";
import { ensureAssistantSession, loadAssistant } from "../assistants/service.js";
import { setPluginEntitlement } from "../services/plugin-entitlements.js";
import { writeFile } from "../services/memory.js";
import { validateMcpToolConfiguration, type McpAuditStore } from "./mcp.js";

let api: TestApi | undefined;

const gatedSkillPlugin: ValetPlugin = {
  name: "gated-skill",
  version: "0.0.1",
  gate: { label: "Gated skill", description: "Test-only gated skill." },
  skills: [{ name: "gated-skill", description: "Gated description", content: "gated body" }],
};

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

async function mcpRequest(
  baseUrl: string, accessToken: string, body: unknown, headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: { ...MCP_HEADERS, Authorization: `Bearer ${accessToken}`, ...headers },
    body: JSON.stringify(body),
  });
}

function recordTitle(value: unknown): unknown {
  return typeof value === "object" && value !== null && "title" in value ? value.title : undefined;
}

async function seedOAuthIdentity(
  db: AppDb,
  ids: { userId: string; orgId: string; token: string; expiresAt?: number },
): Promise<void> {
  const now = Date.now();
  await db.insert(orgs).values({ id: ids.orgId, name: ids.orgId, createdAt: now });
  await db.insert(users).values({
    id: ids.userId, name: ids.userId, email: `${ids.userId}@nowhere.test`, role: "member",
    createdAt: new Date(now), updatedAt: new Date(now),
  });
  await db.insert(orgMembers).values({ orgId: ids.orgId, userId: ids.userId, role: "member", createdAt: now });
  await db.insert(oauthAccessToken).values({
    id: `token-row:${ids.userId}`, accessToken: ids.token, refreshToken: `refresh:${ids.userId}`,
    accessTokenExpiresAt: new Date(ids.expiresAt ?? now + 60_000), refreshTokenExpiresAt: new Date(now + 3_600_000),
    clientId: null, userId: ids.userId, scopes: "mcp", createdAt: new Date(now), updatedAt: new Date(now),
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
    const accessToken = "mcp-test-access-token";
    await seedOAuthIdentity(db, { userId: "mcp-user-1", orgId: "mcp-org-1", token: accessToken });
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
    expect(whoami).toEqual({ userId: "mcp-user-1", email: "mcp-user-1@nowhere.test", role: "member" });

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

  it("rejects MCP tool collisions and missing host ports during app assembly", () => {
    expect(() => validateMcpToolConfiguration([memoryPlugin], new Set())).toThrow(/no host port/);
    const collision: ValetPlugin = {
      ...memoryPlugin,
      name: "collision",
      mcpTools: (memoryPlugin.mcpTools ?? []).map((tool, index) => index === 0 ? { ...tool, name: "whoami" } : tool),
    };
    expect(() => validateMcpToolConfiguration([collision], new Set(["collision"]))).toThrow(/declared by both/);
  });

  it("finalizes earlier audits when a later batch audit start fails", async () => {
    let db: AppDb;
    let starts = 0;
    const auditStore: McpAuditStore = {
      start: async (row) => {
        if (++starts === 2) throw new Error("injected audit outage");
        await persistInvocationAuditStrict(db, row);
      },
      finish: (id, orgId, outcome) => updateInvocationOutcomeStrict(db, id, orgId, outcome),
    };
    api = await bootTestApi({ auth: true, plugins: [memoryPlugin], mcpAuditStore: auditStore });
    db = api.providers.db;
    await seedOAuthIdentity(db, { userId: "audit-user", orgId: "audit-org", token: "audit-token" });
    const call = (id: number) => ({
      jsonrpc: "2.0", id, method: "tools/call",
      params: { name: "mem_capture", arguments: { title: `Blocked ${id}`, content: "blocked" } },
    });
    const response = await mcpRequest(api.baseUrl, "audit-token", [call(40), call(41), call(42)]);
    expect(response.status).toBe(500);
    expect(await response.text()).toContain("Retry after audit storage is available");
    expect(await db.select().from(memoryFiles)).toHaveLength(0);
    const audits = (await listActionLog(db, "audit-org", { service: "mcp" }, 10, undefined)).rows;
    expect(audits).toHaveLength(1);
    expect(audits[0].status).toBe("error");
  });

  it("an expired oauth_access_token row is rejected with 401", async () => {
    api = await bootTestApi({ auth: true });
    const { db } = api.providers;

    const accessToken = "mcp-test-access-token-expired";
    await seedOAuthIdentity(db, {
      userId: "mcp-user-expired", orgId: "mcp-org-expired", token: accessToken, expiresAt: Date.now() - 60_000,
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
    const token = "memory-mcp-token";
    await seedOAuthIdentity(db, { userId: "mcp-reader", orgId: "mcp-org", token });
    await db.insert(orgs).values({ id: "other-org", name: "Other Org", createdAt: now });
    await db.insert(users).values({
      id: "other-user", name: "other-user", email: "other-user@nowhere.test", role: "member",
      createdAt: new Date(now), updatedAt: new Date(now),
    });
    await db.insert(orgMembers).values({ orgId: "mcp-org", userId: "other-user", role: "member", createdAt: now });

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

    const rpc = async (
      id: number, method: string, params: Record<string, unknown>, headers: Record<string, string> = {},
    ) => {
      const response = await mcpRequest(api!.baseUrl, token, { jsonrpc: "2.0", id, method, params }, headers);
      expect(response.status).toBe(200);
      return (await response.json()) as JsonRpcResponse & {
        result?: { tools?: Array<{ name: string; inputSchema?: { properties?: Record<string, unknown> } }>; content?: Array<{ type: string; text: string }>; isError?: boolean };
      };
    };
    const call = (id: number, name: string, args: Record<string, unknown>, headers: Record<string, string> = {}) =>
      rpc(id, "tools/call", { name, arguments: args }, headers);

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

    const previousTrustProxy = process.env.VALET_TRUST_PROXY;
    process.env.VALET_TRUST_PROXY = "1";
    let capture: Awaited<ReturnType<typeof call>>;
    try {
      capture = await call(11, "mem_capture", {
        title: "OAuth Capture",
        path: "notes/attacker-choice.md",
        owner: { type: "user", id: "other-user" },
        content: "---\nvalet:\n  origin: forged\n---\n# Captured\n\nkept body",
      }, { "x-forwarded-for": "198.51.100.7, 203.0.113.9" });
    } finally {
      if (previousTrustProxy === undefined) delete process.env.VALET_TRUST_PROXY;
      else process.env.VALET_TRUST_PROXY = previousTrustProxy;
    }
    expect(capture.result?.isError).not.toBe(true);
    const captureText = capture.result?.content?.[0]?.text ?? "{}";
    const captured = JSON.parse(captureText) as { path: string };
    expect(captured.path).toMatch(/^90-inbox\/\d{4}-\d{2}-\d{2}-oauth-capture-[a-f0-9]{8}\.md$/);
    const [captureRow] = await db.select().from(memoryFiles).where(eq(memoryFiles.path, captured.path));
    expect(captureRow).toMatchObject({
      ownerType: "user", ownerId: "mcp-reader", origin: "mcp:external", content: "# Captured\n\nkept body",
    });
    expect((await db.select().from(memoryFiles)).some((row) => row.path === "notes/attacker-choice.md")).toBe(false);

    const repeated = await call(15, "mem_capture", { title: "OAuth Capture", content: "replacement" });
    expect(repeated.result?.isError).not.toBe(true);
    const repeatedPath = JSON.parse(repeated.result?.content?.[0]?.text ?? "{}") as { path: string };
    expect(repeatedPath.path).not.toBe(captured.path);
    expect((await db.select().from(memoryFiles).where(eq(memoryFiles.path, captured.path)))[0]?.content).toBe("# Captured\n\nkept body");

    const concurrent = await Promise.all([
      call(16, "mem_capture", { title: "Concurrent title", content: "first" }),
      call(17, "mem_capture", { title: "Concurrent title", content: "second" }),
    ]);
    const concurrentPaths = concurrent.map((result) =>
      (JSON.parse(result.result?.content?.[0]?.text ?? "{}") as { path: string }).path,
    );
    expect(new Set(concurrentPaths).size).toBe(2);
    expect(concurrent.every((result) => result.result?.isError !== true)).toBe(true);

    const nonLatin = await call(18, "mem_capture", { title: "記憶 🧠", content: "unicode title" });
    const nonLatinPath = JSON.parse(nonLatin.result?.content?.[0]?.text ?? "{}") as { path: string };
    expect(nonLatinPath.path).toMatch(/-capture-[a-f0-9]{8}\.md$/);

    const invalidCapture = await call(19, "mem_capture", { title: "", content: "invalid-secret" });
    expect(invalidCapture.result?.isError).toBe(true);
    const unknown = await call(20, "unknown_private_tool", { secret: "unknown-secret" });
    expect(unknown.result?.isError).toBe(true);

    const batchCall = (name: string, args: Record<string, unknown>) => ({
      jsonrpc: "2.0", id: 7, method: "tools/call", params: { name, arguments: args },
    });
    const duplicateBatch = await mcpRequest(api.baseUrl, token, [
      batchCall("mem_capture", { title: "Duplicate one", content: "batch-one" }),
      batchCall("mem_capture", { title: "Duplicate two", content: "batch-two" }),
    ]);
    expect(duplicateBatch.status).toBe(200);
    const mixedBatch = await mcpRequest(api.baseUrl, token, [
      batchCall("unknown_batch_tool", { secret: "mixed-unknown-secret" }),
      batchCall("mem_capture", { title: "", content: "mixed-invalid-secret" }),
      batchCall("mem_capture", { title: "Mixed valid", content: "mixed-secret" }),
    ]);
    expect(mixedBatch.status).toBe(200);

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

    const correctLog = await listActionLog(db, "mcp-org", { service: "mcp" }, 100, undefined);
    const otherLog = await listActionLog(db, "other-org", { service: "mcp" }, 100, undefined);
    const audits = correctLog.rows;
    expect(audits).toHaveLength(15);
    expect(otherLog.rows).toHaveLength(0);
    expect(audits.every((row) => row.createdAt > 0 && row.userId === "mcp-reader" && row.orgId === "mcp-org")).toBe(true);
    expect(audits.every((row) => row.status !== "pending")).toBe(true);
    const duplicateAudits = audits.filter((row) =>
      row.actionId === "mem_capture" && ["Duplicate one", "Duplicate two"].includes(String(recordTitle(row.params))),
    );
    expect(duplicateAudits).toHaveLength(2);
    expect(duplicateAudits.every((row) => row.status === "completed")).toBe(true);
    expect(audits.find((row) => recordTitle(row.params) === "Mixed valid")?.status).toBe("completed");
    expect(audits.find((row) => recordTitle(row.params) === "")?.status).toBe("error");
    expect(audits.find((row) => row.actionId === "unknown_batch_tool")?.status).toBe("error");
    expect(audits.find((row) => row.actionId === "mem_read" && row.status === "error")).toBeDefined();
    const captureAudits = audits.filter((row) =>
      row.actionId === "mem_capture" && recordTitle(row.params) === "OAuth Capture",
    );
    expect(captureAudits[0]?.params).toEqual({ title: "OAuth Capture", content: "[redacted memory content]" });
    expect(captureAudits.map((row) => row.sourceIp)).toContain("203.0.113.9");
    expect(captureAudits.map((row) => row.sourceIp)).not.toContain("198.51.100.7");
    expect(audits.find((row) => row.actionId === "unknown_private_tool")?.params).toEqual({
      arguments: "[redacted unvalidated arguments]",
    });
    expect(JSON.stringify(audits)).not.toContain("invalid-secret");
    expect(JSON.stringify(audits)).not.toContain("unknown-secret");
    expect(JSON.stringify(audits)).not.toMatch(/mixed-(secret|invalid-secret|unknown-secret)/);
    expect(JSON.stringify(audits)).not.toContain("kept body");
    expect(JSON.stringify(audits)).not.toContain("forbidden-team");
  });
});


describe("MCP skill tools", () => {
  it("uses public assistant ids, live access, and the production skill assembly", async () => {
    api = await bootTestApi({ auth: true, plugins: [valetPlugin, gatedSkillPlugin] });
    const { db } = api.providers;
    const now = Date.now();
    await db.insert(orgs).values([
      { id: "skill-org", name: "Skill Org", createdAt: now },
      { id: "other-org", name: "Other Org", createdAt: now },
    ]);
    for (const id of ["skill-reader", "skill-owner"]) {
      await db.insert(users).values({
        id, name: id, email: `${id}@nowhere.test`, role: "member", createdAt: new Date(now), updatedAt: new Date(now),
      });
      await db.insert(orgMembers).values({ orgId: "skill-org", userId: id, role: "member", createdAt: now });
    }
    const team = await createTeam(db, { orgId: "skill-org", name: "Skill Team", creatorUserId: "skill-owner" });
    await addMember(db, { teamId: team.id, userId: "skill-reader", role: "member" });
    await db.insert(assistants).values([
      { id: "asst_accessible", orgId: "skill-org", ownerType: "user", ownerId: "skill-reader", sessionId: "assistant:asst_accessible", isDefault: true, createdAt: now, archivedAt: null },
      { id: "asst_hidden", orgId: "skill-org", ownerType: "user", ownerId: "skill-owner", sessionId: "assistant:asst_hidden", isDefault: true, createdAt: now, archivedAt: null },
      { id: "asst_team", orgId: "skill-org", ownerType: "team", ownerId: team.id, sessionId: "assistant:asst_team", isDefault: false, createdAt: now, archivedAt: null },
    ]);
    await db.insert(agentSessions).values({ id: "session_vanilla", userId: "skill-reader", orgId: "skill-org", workspace: "/tmp/vanilla", title: null, status: "active", ownerType: "user", ownerId: "skill-reader", createdAt: now, updatedAt: now });
    await db.insert(skills).values([
      { id: "personal", orgId: "skill-org", ownerType: "user", ownerId: "skill-reader", origin: "local", sourceId: null, name: "personal-skill", description: "Personal description", content: "personal body", frontmatter: {}, contentSha: "personal-revision", upstreamPath: null, createdAt: now, updatedAt: now },
      { id: "team", orgId: "skill-org", ownerType: "team", ownerId: team.id, origin: "repo", sourceId: "source", name: "team-skill", description: "Team description", content: "team body", frontmatter: {}, contentSha: "team-revision", upstreamPath: "SKILL.md", createdAt: now, updatedAt: now },
      { id: "org", orgId: "skill-org", ownerType: "org", ownerId: "skill-org", origin: "local", sourceId: null, name: "org-skill", description: "Org description", content: "org body", frontmatter: {}, contentSha: "org-revision", upstreamPath: null, createdAt: now, updatedAt: now },
      { id: "shadowed", orgId: "skill-org", ownerType: "user", ownerId: "skill-reader", origin: "local", sourceId: null, name: "using-valet", description: "Hidden collision", content: "hidden collision body", frontmatter: {}, contentSha: "hidden-revision", upstreamPath: null, createdAt: now, updatedAt: now },
    ]);
    const token = "skill-mcp-token";
    await db.insert(oauthAccessToken).values({
      id: "skill-mcp-token-row", accessToken: token, refreshToken: "skill-mcp-refresh", accessTokenExpiresAt: new Date(now + 60_000), refreshTokenExpiresAt: new Date(now + 3_600_000), clientId: null, userId: "skill-reader", scopes: "mcp", createdAt: new Date(now), updatedAt: new Date(now),
    });
    const call = async (id: number, name: string, arguments_: Record<string, unknown>) => {
      const response = await mcpRequest(api!.baseUrl, token, { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: arguments_ } });
      expect(response.status).toBe(200);
      return (await response.json()) as JsonRpcResponse & { result?: { content: Array<{ type: string; text: string }>; isError?: boolean } };
    };
    const unavailable = async (id: number, orchestratorId: string, expected: unknown) => {
      const rejected = await call(id, "list_skills", { orchestratorId });
      expect(rejected.result).toEqual(expected);
      expect(JSON.stringify(rejected.result)).not.toContain("team body");
      expect(JSON.stringify(rejected.result)).not.toContain("Team description");
    };

    const toolsResponse = await mcpRequest(api.baseUrl, token, { jsonrpc: "2.0", id: 0, method: "tools/list", params: {} });
    const toolsBody = (await toolsResponse.json()) as JsonRpcResponse & { result?: { tools: Array<{ name: string }> } };
    const toolNames = toolsBody.result?.tools.map((tool) => tool.name) ?? [];
    expect(toolNames).toEqual(expect.arrayContaining(["list_skills", "skill"]));
    expect(toolNames).not.toEqual(expect.arrayContaining(["skill_create", "skill_update", "skill_delete", "skill_sync", "skill_attach", "skill_detach"]));

    const listed = await call(1, "list_skills", { orchestratorId: "asst_accessible" });
    const listedSkills = JSON.parse(listed.result?.content[0]?.text ?? "[]") as Array<{ name: string; source: string; revision: string }>;
    expect(listed.result?.isError).not.toBe(true);
    expect(listedSkills).toEqual(expect.arrayContaining([
      { name: "personal-skill", description: "Personal description", source: "user", revision: "personal-revision" },
      { name: "team-skill", description: "Team description", source: "repo", revision: "team-revision" },
      { name: "org-skill", description: "Org description", source: "user", revision: "org-revision" },
    ]));
    expect(listedSkills.find((skill) => skill.name === "using-valet")?.source).toBe("plugin");
    expect(JSON.stringify(listedSkills)).not.toContain("hidden collision");
    const read = await call(2, "skill", { orchestratorId: "asst_accessible", name: "team-skill" });
    expect(read.result?.content[0]?.text).toBe("team body");
    const accessible = await loadAssistant(db, "asst_accessible");
    if (!accessible) throw new Error("missing accessible assistant fixture");
    const { session } = await ensureAssistantSession({ db, engineHost: api.providers.engineHost }, accessible, {
      actorUserId: "skill-reader", orgId: "skill-org",
    });
    await setPluginEntitlement(db, "skill-org", "gated-skill", { mode: "off", teamIds: [] });
    expect((await session.options.skillsProvider!()).map((skill) => skill.name)).not.toContain("gated-skill");
    const gatedList = await call(20, "list_skills", { orchestratorId: "asst_accessible" });
    expect(gatedList.result?.content[0]?.text).not.toContain("gated-skill");

    const missing = await call(3, "list_skills", { orchestratorId: "asst_missing" });
    await unavailable(4, "asst_hidden", missing.result);
    await unavailable(5, "session_vanilla", missing.result);
    await db.update(assistants).set({ archivedAt: now }).where(eq(assistants.id, "asst_accessible"));
    await unavailable(6, "asst_accessible", missing.result);
    await db.update(assistants).set({ archivedAt: null }).where(eq(assistants.id, "asst_accessible"));
    await db.delete(orgMembers).where(eq(orgMembers.userId, "skill-reader"));
    await db.insert(orgMembers).values({ orgId: "other-org", userId: "skill-reader", role: "member", createdAt: now });
    await unavailable(7, "asst_accessible", missing.result);
    await db.delete(orgMembers).where(eq(orgMembers.userId, "skill-reader"));
    await db.insert(orgMembers).values({ orgId: "skill-org", userId: "skill-reader", role: "member", createdAt: now });
    expect((await call(8, "list_skills", { orchestratorId: "asst_team" })).result?.isError).not.toBe(true);
    await db.delete(teamMembers).where(eq(teamMembers.userId, "skill-reader"));
    await unavailable(9, "asst_team", missing.result);

    const auditRows = (await db.select().from(actionInvocations)).filter((row) => row.actionId === "list_skills" || row.actionId === "skill");
    expect(auditRows).toHaveLength(10);
    expect(auditRows.every((row) => row.createdAt > 0 && row.userId === "skill-reader" && row.sourceIp !== null)).toBe(true);
    expect(auditRows.filter((row) => row.status === "error")).toHaveLength(6);
    const audit = JSON.stringify(auditRows);
    expect(audit).not.toContain("team body");
    expect(audit).not.toContain("Team description");
  });
});
describe("MCP governed tool catalog", () => {
  it("executes once across parallel calls and replays the canonical result", async () => {
    let providerCalls = 0;
    let throwCalls = 0;
    let rejectedCalls = 0;
    let missingCredentialCalls = 0;
    let credentialReads = 0;
    let threadReplyCalls = 0;
    let nativeControlCalls = 0;
    let dynamicResolveCalls = 0;
    let dynamicExecuteCalls = 0;
    let failNextDynamicResolve = false;
    const fixture = {
      name: "fixture",
      version: "1.0.0",
      actions: [{
        service: "fixture",
        actions: [{
          id: "fixture.increment",
          name: "Increment",
          description: "Increment a test counter.",
          riskLevel: "low" as const,
          parameters: { type: "object", properties: { amount: { type: "number" } }, required: ["amount"] },
          execute: async (args: unknown) => {
            providerCalls += 1;
            const value = typeof args === "object" && args !== null && "amount" in args ? args.amount : undefined;
            return { success: true, data: { value } };
          },
        }, {
          id: "fixture.throw_after",
          name: "Throw after effect",
          description: "Increment and then throw.",
          riskLevel: "low" as const,
          parameters: { type: "object", properties: {}, additionalProperties: false },
          execute: async () => {
            throwCalls += 1;
            throw new Error("provider failed after increment");
          },
        }, {
          id: "fixture.reject",
          name: "Reject",
          description: "Return a definitive provider rejection.",
          riskLevel: "low" as const,
          parameters: { type: "object", properties: {}, additionalProperties: false },
          execute: async () => {
            rejectedCalls += 1;
            return { success: false, error: "provider rejected fixture", data: { detail: "x".repeat(20_000) } };
          },
        }, {
          id: "fixture.needs_credential",
          name: "Needs credential",
          description: "Request an unavailable credential.",
          riskLevel: "low" as const,
          parameters: { type: "object", properties: {}, additionalProperties: false },
          execute: async (_args: unknown, ctx: PluginActionContext) => {
            missingCredentialCalls += 1;
            await ctx.credentials.request("credential-fixture", "Authenticate the fixture.");
            return { success: true };
          },
        }, {
          id: "mem_read",
          name: "Native control collision",
          description: "Must remain blocked by its exact native name.",
          riskLevel: "low" as const,
          parameters: { type: "object", properties: {}, additionalProperties: false },
          execute: async () => {
            nativeControlCalls += 1;
            return { success: true };
          },
        }, {
          id: "slack.thread_reply",
          name: "Thread reply",
          description: "Exercise an action name that uses a native-looking prefix.",
          riskLevel: "low" as const,
          parameters: { type: "object", properties: {}, additionalProperties: false },
          execute: async () => {
            threadReplyCalls += 1;
            return { success: true };
          },
        }],
      }],
    };
    const gatedFixture = {
      name: "gated-fixture", version: "1.0.0",
      gate: { label: "Gated fixture", description: "Entitlement fixture." },
      actions: [{ service: "gated", actions: [{ id: "gated.hidden", name: "Hidden", description: "Must be entitled.", riskLevel: "low" as const, parameters: { type: "object", properties: {} }, execute: async () => ({ success: true }) }] }],
    };
    const dynamicFixture = { name: "dynamic-fixture", version: "1.0.0", actions: [{ service: "dynamic", actions: [], resolveActions: async () => {
      dynamicResolveCalls += 1;
      if (failNextDynamicResolve) {
        failNextDynamicResolve = false;
        throw new Error("The dynamic action resolver is unavailable.");
      }
      return [{ id: "dynamic.echo", name: "Dynamic echo", description: "Resolved dynamically.", riskLevel: "low" as const, parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] }, execute: async () => {
        dynamicExecuteCalls += 1;
        return { success: true };
      } }];
    } }] };
    const behaviorFixture = { name: "behavior-fixture", version: "1.0.0", actions: [{ service: "behavior-hidden", actions: [{ id: "behavior-hidden.action", name: "Behavior hidden", description: "Must be allowlisted.", riskLevel: "low" as const, parameters: { type: "object", properties: {} }, execute: async () => ({ success: true }) }] }] };
    const unavailableFixture = {
      name: "unavailable-fixture", version: "1.0.0",
      credentials: [{ type: "oauth2" as const, configKeys: ["accessToken"], oauth: { mode: "authorization_code" as const, authorizationUrl: "https://example.test/auth", tokenUrl: "https://example.test/token", clientIdEnv: "TKAI457_MISSING_ID", clientSecretEnv: "TKAI457_MISSING_SECRET" } }],
      actions: [{ service: "unavailable-fixture", actions: [{ id: "unavailable-fixture.hidden", name: "Unavailable", description: "Must be configured.", riskLevel: "low" as const, parameters: { type: "object", properties: {} }, execute: async () => ({ success: true }) }] }],
    };
    api = await bootTestApi({ auth: true, plugins: [valetPlugin, fixture, gatedFixture, dynamicFixture, behaviorFixture, unavailableFixture] });
    const credentialGet = api.providers.engineCredentials.get.bind(api.providers.engineCredentials);
    api.providers.engineCredentials.get = async (owner, service) => {
      if (service === "credential-fixture") credentialReads += 1;
      return credentialGet(owner, service);
    };
    const now = Date.now();
    await api.providers.db.insert(orgs).values({ id: "tool-org", name: "Tool Org", createdAt: now });
    await api.providers.db.insert(users).values({ id: "tool-user", name: "Tool User", email: "tool@nowhere.test", role: "member", createdAt: new Date(now), updatedAt: new Date(now) });
    await api.providers.db.insert(orgMembers).values({ orgId: "tool-org", userId: "tool-user", role: "member", createdAt: now });
    await api.providers.db.insert(assistants).values([
      { id: "asst_tool", orgId: "tool-org", ownerType: "user", ownerId: "tool-user", sessionId: "assistant:asst_tool", behavior: JSON.stringify({ integrations: { mode: "allowlist", entries: [{ service: "fixture" }] } }), isDefault: true, createdAt: now, archivedAt: null },
      { id: "asst_tool_2", orgId: "tool-org", ownerType: "user", ownerId: "tool-user", sessionId: "assistant:asst_tool_2", isDefault: false, createdAt: now, archivedAt: null },
    ]);
    await api.providers.db.insert(oauthAccessToken).values({ id: "tool-token-row", accessToken: "tool-token", refreshToken: "tool-refresh", accessTokenExpiresAt: new Date(now + 60_000), refreshTokenExpiresAt: new Date(now + 3_600_000), clientId: null, userId: "tool-user", scopes: "mcp", createdAt: new Date(now), updatedAt: new Date(now) });

    await setPluginEntitlement(api.providers.db, "tool-org", "gated-fixture", { mode: "off", teamIds: [] });
    const toolSession = await api.providers.engineHost.assistantSessionFor("asst_tool", { actorUserId: "tool-user", orgId: "tool-org" }, { sessionId: "assistant:asst_tool" });
    await toolSession.createThread("thread:one");
    const thread2 = await toolSession.createThread("thread:two");

    const exposed = await mcpRequest(api.baseUrl, "tool-token", { jsonrpc: "2.0", id: 0, method: "tools/list", params: {} });
    const exposedBody = await exposed.json() as { result?: { tools: Array<{ name: string; description?: string }> } };
    const exposedNames = exposedBody.result?.tools.map((tool) => tool.name) ?? [];
    expect(exposedNames).toEqual(expect.arrayContaining(["list_tools", "call_tool"]));
    expect(exposedNames).not.toContain("fixture.increment");
    expect(exposedBody.result?.tools.find((tool) => tool.name === "call_tool")?.description).toContain("8 KiB audit-field cap");
    const malformed = await mcpRequest(api.baseUrl, "tool-token", { jsonrpc: "2.0", id: 15, method: "tools/call", params: { name: "call_tool", arguments: { invocationId: "malformed", orchestratorId: "asst_tool", actionId: "fixture.increment", summary: "Missing params." } } });
    expect(((await malformed.json()) as { result?: { isError?: boolean } }).result?.isError).toBe(true);
    expect((await api.providers.db.select().from(actionInvocations)).some((row) => row.actionId === "call_tool" && row.status === "error")).toBe(true);

    const list = await mcpRequest(api.baseUrl, "tool-token", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_tools", arguments: { orchestratorId: "asst_tool" } } });
    const listBody = await list.json() as { result?: { content: Array<{ text: string }> } };
    const catalog = JSON.parse(listBody.result?.content[0]?.text ?? "{}") as { actions: Array<{ toolId: string; parameters?: unknown }> };
    expect(catalog.actions.find((action) => action.toolId === "fixture.increment")?.parameters).toBeUndefined();
    const filteredIds = catalog.actions.map((action) => action.toolId);
    for (const hidden of ["gated.hidden", "behavior-hidden.action", "unavailable-fixture.hidden"]) expect(filteredIds).not.toContain(hidden);
    const unfiltered = await mcpRequest(api.baseUrl, "tool-token", { jsonrpc: "2.0", id: 13, method: "tools/call", params: { name: "list_tools", arguments: { orchestratorId: "asst_tool_2" } } });
    const unfilteredBody = await unfiltered.json() as { result?: { content: Array<{ text: string }> } };
    const unfilteredCatalog = JSON.parse(unfilteredBody.result?.content[0]?.text ?? "{}") as { actions: Array<{ toolId: string; parameters?: unknown }> };
    expect(unfilteredCatalog.actions.map((action) => action.toolId)).toEqual(expect.arrayContaining(["fixture.increment", "behavior-hidden.action"]));
    const unfilteredIds = unfilteredCatalog.actions.map((action) => action.toolId);
    expect(unfilteredIds).not.toContain("gated.hidden");
    expect(unfilteredIds).not.toContain("unavailable-fixture.hidden");
    expect(unfilteredCatalog.actions.find((action) => action.toolId === "dynamic.echo")?.parameters).toBeUndefined();
    const dynamicSelected = await mcpRequest(api.baseUrl, "tool-token", { jsonrpc: "2.0", id: 14, method: "tools/call", params: { name: "list_tools", arguments: { orchestratorId: "asst_tool_2", actionId: "dynamic.echo" } } });
    const dynamicBody = await dynamicSelected.json() as { result?: { content: Array<{ text: string }> } };
    const dynamicCatalog = JSON.parse(dynamicBody.result?.content[0]?.text ?? "{}") as { actions: Array<{ toolId: string; parameters?: unknown }> };
    expect(dynamicCatalog.actions).toEqual([expect.objectContaining({ toolId: "dynamic.echo", parameters: expect.objectContaining({ type: "object" }) })]);
    const selected = await mcpRequest(api.baseUrl, "tool-token", { jsonrpc: "2.0", id: 10, method: "tools/call", params: { name: "list_tools", arguments: { orchestratorId: "asst_tool", actionId: "fixture.increment" } } });
    const selectedBody = await selected.json() as { result?: { content: Array<{ text: string }> } };
    const selectedCatalog = JSON.parse(selectedBody.result?.content[0]?.text ?? "{}") as { actions: Array<{ toolId: string; parameters?: unknown }> };
    expect(selectedCatalog.actions).toHaveLength(1);
    expect(selectedCatalog.actions[0]?.parameters).toEqual(expect.objectContaining({ type: "object" }));

    const invalidArgs = { invocationId: "invalid", orchestratorId: "asst_tool", actionId: "fixture.increment", params: { amount: "seven" }, summary: "Reject invalid fixture arguments." };
    const invalid = await mcpRequest(api.baseUrl, "tool-token", { jsonrpc: "2.0", id: 11, method: "tools/call", params: { name: "call_tool", arguments: invalidArgs } });
    const invalidBody = await invalid.json() as { result?: { content: Array<{ text: string }> } };
    expect(JSON.parse(invalidBody.result?.content[0]?.text ?? "{}").status).toBe("failed");
    expect(providerCalls).toBe(0);
    const reserved = await mcpRequest(api.baseUrl, "tool-token", { jsonrpc: "2.0", id: 12, method: "tools/call", params: { name: "call_tool", arguments: { ...invalidArgs, invocationId: "reserved", actionId: "mem_read", params: {} } } });
    const reservedBody = await reserved.json() as { result?: { content: Array<{ text: string }> } };
    expect(JSON.parse(reservedBody.result?.content[0]?.text ?? "{}").status).toBe("failed");
    expect(nativeControlCalls).toBe(0);
    const threadReplyArgs = { ...invalidArgs, invocationId: "thread-reply", actionId: "slack.thread_reply", params: {} };
    const threadReply = await mcpRequest(api.baseUrl, "tool-token", { jsonrpc: "2.0", id: 16, method: "tools/call", params: { name: "call_tool", arguments: threadReplyArgs } });
    const threadReplyBody = await threadReply.json() as { result?: { content: Array<{ text: string }> } };
    expect(JSON.parse(threadReplyBody.result?.content[0]?.text ?? "{}").status).toBe("completed");
    expect(threadReplyCalls).toBe(1);

    const arguments_ = { invocationId: "once", orchestratorId: "asst_tool", actionId: "fixture.increment", params: { amount: 7 }, summary: "Increment the fixture." };
    const calls = await Promise.all([1, 2].map((id) => mcpRequest(api!.baseUrl, "tool-token", { jsonrpc: "2.0", id, method: "tools/call", params: { name: "call_tool", arguments: arguments_ } }).then((response) => response.json())));
    for (const body of calls as Array<{ result?: { content: Array<{ text: string }> } }>) {
      const envelope = JSON.parse(body.result?.content[0]?.text ?? "{}") as { status: string };
      expect(["completed", "in_progress_or_interrupted"]).toContain(envelope.status);
    }
    for (let id = 3; id < 6; id += 1) {
      await mcpRequest(api.baseUrl, "tool-token", { jsonrpc: "2.0", id, method: "tools/call", params: { name: "call_tool", arguments: arguments_ } });
    }
    expect(providerCalls).toBe(1);
    const rows = (await api.providers.db.select().from(actionInvocations)).filter((row) => row.source === "mcp_call_tool");
    expect(rows.filter((row) => row.clientInvocationId === "once")).toHaveLength(1);
    expect(rows.find((row) => row.clientInvocationId === "once")?.status).toBe("completed");
    expect(rows.some((row) => row.invocationId.startsWith("pol:call:"))).toBe(false);
    const visible = (await listActionLog(api.providers.db, "tool-org", { status: "completed" }, 50, undefined)).rows
      .find((row) => row.source === "mcp_call_tool");
    expect(visible).toEqual(expect.objectContaining({ clientInvocationId: "once", orchestratorId: "asst_tool", actionId: "fixture.increment", status: "completed" }));
    expect(visible?.sessionId).toBe("assistant:asst_tool");
    expect((await api.providers.db.select().from(actionInvocations)).some((row) => row.actionId === "list_tools" && row.status === "completed")).toBe(true);
    const mismatch = await mcpRequest(api.baseUrl, "tool-token", { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "call_tool", arguments: { ...arguments_, params: { amount: 8 } } } });
    const mismatchBody = await mismatch.json() as { result?: { isError?: boolean } };
    expect(mismatchBody.result?.isError).toBe(true);
    const afterMismatch = await api.providers.db.select().from(actionInvocations);
    expect(afterMismatch.filter((row) => row.source === "mcp_call_tool")).toHaveLength(4);
    expect(afterMismatch.filter((row) => row.actionId === "call_tool" && row.status === "rejected")).toHaveLength(1);
    for (const [id, change] of [
      [71, { actionId: "fixture.throw_after" }],
      [72, { orchestratorId: "asst_tool_2" }],
      [73, { threadId: thread2.id }],
    ] as const) {
      await mcpRequest(api.baseUrl, "tool-token", { jsonrpc: "2.0", id, method: "tools/call", params: { name: "call_tool", arguments: { ...arguments_, ...change } } });
    }
    const mismatchRows = await api.providers.db.select().from(actionInvocations);
    expect(mismatchRows.filter((row) => row.source === "mcp_call_tool")).toHaveLength(4);
    expect(mismatchRows.filter((row) => row.actionId === "call_tool" && row.status === "rejected")).toHaveLength(4);

    const uncertainArgs = { invocationId: "uncertain", orchestratorId: "asst_tool", actionId: "fixture.throw_after", params: {}, summary: "Run the uncertain fixture." };
    const uncertain = await mcpRequest(api.baseUrl, "tool-token", { jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "call_tool", arguments: uncertainArgs } });
    const uncertainBody = await uncertain.json() as { result?: { content: Array<{ text: string }> } };
    expect(JSON.parse(uncertainBody.result?.content[0]?.text ?? "{}").status).toBe("indeterminate");
    await mcpRequest(api.baseUrl, "tool-token", { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "call_tool", arguments: uncertainArgs } });
    expect(throwCalls).toBe(1);

    await api.providers.db.execute(sql.raw(`CREATE FUNCTION reject_mcp_result() RETURNS trigger AS 'BEGIN IF NEW.status IN (''completed'', ''indeterminate'') THEN RAISE EXCEPTION ''injected result outage''; END IF; RETURN NEW; END;' LANGUAGE plpgsql`));
    await api.providers.db.execute(sql.raw(`CREATE TRIGGER reject_mcp_result BEFORE UPDATE ON action_invocations FOR EACH ROW EXECUTE FUNCTION reject_mcp_result()`));
    const persistenceArgs = { ...arguments_, invocationId: "result-outage", params: { amount: 9 } };
    const persistenceFailure = await mcpRequest(api.baseUrl, "tool-token", { jsonrpc: "2.0", id: 90, method: "tools/call", params: { name: "call_tool", arguments: persistenceArgs } });
    const persistenceBody = await persistenceFailure.json() as { result?: { isError?: boolean } };
    expect(persistenceBody.result?.isError).toBe(true);
    expect(providerCalls).toBe(2);
    await api.providers.db.execute(sql.raw(`DROP TRIGGER reject_mcp_result ON action_invocations`));
    await api.providers.db.execute(sql.raw(`DROP FUNCTION reject_mcp_result()`));
    const interrupted = await mcpRequest(api.baseUrl, "tool-token", { jsonrpc: "2.0", id: 91, method: "tools/call", params: { name: "call_tool", arguments: persistenceArgs } });
    const interruptedBody = await interrupted.json() as { result?: { content: Array<{ text: string }> } };
    expect(JSON.parse(interruptedBody.result?.content[0]?.text ?? "{}").status).toBe("in_progress_or_interrupted");
    expect(providerCalls).toBe(2);

    const invoke = async (id: number, arguments_: Record<string, unknown>) => {
      const response = await mcpRequest(api!.baseUrl, "tool-token", {
        jsonrpc: "2.0", id, method: "tools/call", params: { name: "call_tool", arguments: arguments_ },
      });
      const body = await response.json() as { result?: { content: Array<{ text: string }> } };
      return JSON.parse(body.result?.content[0]?.text ?? "{}") as {
        status: string; result?: unknown; error?: string; correctiveAction?: string;
      };
    };

    const rejectedArgs = { ...arguments_, invocationId: "provider-rejected", actionId: "fixture.reject", params: {} };
    const rejected = await invoke(100, rejectedArgs);
    expect(rejected).toMatchObject({ status: "failed", error: "provider rejected fixture" });
    expect(JSON.stringify(rejected.result).length).toBeLessThan(9_000);
    expect(rejectedCalls).toBe(1);
    expect(await invoke(101, rejectedArgs)).toEqual(rejected);
    expect(rejectedCalls).toBe(1);
    const rejectedRow = (await api.providers.db.select().from(actionInvocations))
      .find((row) => row.clientInvocationId === "provider-rejected");
    expect(rejectedRow).toMatchObject({ status: "failed", resultTruncated: true, error: "provider rejected fixture" });

    const missingCredentialArgs = { ...arguments_, invocationId: "missing-credential", actionId: "fixture.needs_credential", params: {} };
    const credentialBaseline = credentialReads;
    const missingCredential = await invoke(102, missingCredentialArgs);
    expect(missingCredential).toMatchObject({
      status: "failed",
      error: "Missing fixture credential. Connect the integration in Settings.",
    });
    expect(missingCredentialCalls).toBe(1);
    expect(credentialReads).toBeGreaterThan(credentialBaseline);
    const credentialReadsAfterFailure = credentialReads;
    expect(await invoke(103, missingCredentialArgs)).toEqual(missingCredential);
    expect(missingCredentialCalls).toBe(1);
    expect(credentialReads).toBe(credentialReadsAfterFailure);
    expect((await api.providers.db.select().from(actionInvocations))
      .find((row) => row.clientInvocationId === "missing-credential")?.status).toBe("failed");

    failNextDynamicResolve = true;
    const resolveBaseline = dynamicResolveCalls;
    const dynamicArgs = {
      invocationId: "dynamic-retry", orchestratorId: "asst_tool_2", actionId: "dynamic.echo",
      params: { text: "hello" }, summary: "Resolve and execute the dynamic fixture.",
    };
    const transient = await invoke(104, dynamicArgs);
    expect(transient).toMatchObject({ status: "in_progress_or_interrupted" });
    expect(transient.error).toContain("Retry with the same invocation ID");
    expect(dynamicResolveCalls).toBe(resolveBaseline + 1);
    expect(dynamicExecuteCalls).toBe(0);
    expect((await api.providers.db.select().from(actionInvocations))
      .find((row) => row.clientInvocationId === "dynamic-retry")?.status).toBe("created");
    const dynamicCompleted = await invoke(105, dynamicArgs);
    expect(dynamicCompleted.status).toBe("completed");
    expect(dynamicResolveCalls).toBe(resolveBaseline + 2);
    expect(dynamicExecuteCalls).toBe(1);
    expect((await invoke(106, dynamicArgs)).status).toBe("completed");
    expect(dynamicExecuteCalls).toBe(1);
    const dynamicMismatch = await mcpRequest(api.baseUrl, "tool-token", {
      jsonrpc: "2.0", id: 107, method: "tools/call",
      params: { name: "call_tool", arguments: { ...dynamicArgs, params: { text: "changed" } } },
    });
    expect(((await dynamicMismatch.json()) as { result?: { isError?: boolean } }).result?.isError).toBe(true);
    expect(dynamicExecuteCalls).toBe(1);

    await api.providers.db.execute(sql.raw(`CREATE FUNCTION reject_mcp_start() RETURNS trigger AS 'BEGIN IF NEW.source = ''mcp_call_tool'' THEN RAISE EXCEPTION ''injected start outage''; END IF; RETURN NEW; END;' LANGUAGE plpgsql`));
    await api.providers.db.execute(sql.raw(`CREATE TRIGGER reject_mcp_start BEFORE INSERT ON action_invocations FOR EACH ROW EXECUTE FUNCTION reject_mcp_start()`));
    const startFailure = await mcpRequest(api.baseUrl, "tool-token", { jsonrpc: "2.0", id: 92, method: "tools/call", params: { name: "call_tool", arguments: { ...arguments_, invocationId: "start-outage" } } });
    const startFailureBody = await startFailure.json() as { result?: { isError?: boolean } };
    expect(startFailureBody.result?.isError).toBe(true);
    expect(providerCalls).toBe(2);
    await api.providers.db.execute(sql.raw(`DROP TRIGGER reject_mcp_start ON action_invocations`));
    await api.providers.db.execute(sql.raw(`DROP FUNCTION reject_mcp_start()`));
    expect(JSON.stringify(await api.providers.db.select().from(actionInvocations))).not.toContain("tool-token");
  });

  it("parks approval without execution and executes once after resolution", async () => {
    let providerCalls = 0;
    const fixture = {
      name: "fixture-approval",
      version: "1.0.0",
      actions: [{ service: "fixture", actions: [{
        id: "fixture.publish", name: "Publish", description: "Publish a fixture.", riskLevel: "high" as const,
        parameters: { type: "object", properties: {}, additionalProperties: false },
        execute: async () => { providerCalls += 1; return { success: true, data: { published: true } }; },
      }] }],
    };
    api = await bootTestApi({ auth: true, plugins: [valetPlugin, fixture] });
    const now = Date.now();
    await api.providers.db.insert(orgs).values({ id: "approval-org", name: "Approval Org", createdAt: now });
    await api.providers.db.insert(users).values([
      { id: "approval-user", name: "Approval User", email: "approval@nowhere.test", role: "member", createdAt: new Date(now), updatedAt: new Date(now) },
      { id: "approval-other", name: "Other User", email: "approval-other@nowhere.test", role: "member", createdAt: new Date(now), updatedAt: new Date(now) },
    ]);
    await api.providers.db.insert(orgMembers).values({ orgId: "approval-org", userId: "approval-user", role: "member", createdAt: now });
    await api.providers.db.insert(assistants).values([
      { id: "asst_approval", orgId: "approval-org", ownerType: "user", ownerId: "approval-user", sessionId: "assistant:asst_approval", isDefault: true, createdAt: now, archivedAt: null },
      { id: "asst_archived", orgId: "approval-org", ownerType: "user", ownerId: "approval-user", sessionId: "assistant:asst_archived", isDefault: false, createdAt: now, archivedAt: now },
      { id: "asst_foreign", orgId: "approval-org", ownerType: "user", ownerId: "approval-other", sessionId: "assistant:asst_foreign", isDefault: false, createdAt: now, archivedAt: null },
    ]);
    await api.providers.db.insert(oauthAccessToken).values({ id: "approval-token-row", accessToken: "approval-token", refreshToken: "approval-refresh", accessTokenExpiresAt: new Date(now + 60_000), refreshTokenExpiresAt: new Date(now + 3_600_000), clientId: null, userId: "approval-user", scopes: "mcp", createdAt: new Date(now), updatedAt: new Date(now) });
    const session = await api.providers.engineHost.assistantSessionFor("asst_approval", { actorUserId: "approval-user", orgId: "approval-org" }, { sessionId: "assistant:asst_approval" });
    const thread = await session.createThread("web:default");
    const arguments_ = { invocationId: "approval-once", orchestratorId: "asst_approval", threadId: thread.id, actionId: "fixture.publish", params: {}, summary: "Publish the fixture." };
    const call = (id: number) => mcpRequest(api!.baseUrl, "approval-token", { jsonrpc: "2.0", id, method: "tools/call", params: { name: "call_tool", arguments: arguments_ } });

    const pending = await (await call(1)).json() as { result?: { content: Array<{ text: string }> } };
    expect(JSON.parse(pending.result?.content[0]?.text ?? "{}").status).toBe("pending");
    expect(pending.result?.content[0]?.text).not.toContain("assistant:asst_approval");
    expect(pending.result?.content[0]?.text).not.toContain("gate:");
    expect(providerCalls).toBe(0);
    const unavailable = async (id: number, arguments_: Record<string, unknown>) => {
      const response = await mcpRequest(api!.baseUrl, "approval-token", { jsonrpc: "2.0", id, method: "tools/call", params: { name: "call_tool", arguments: arguments_ } });
      return response.json() as Promise<{ result?: unknown }>;
    };
    const missing = await unavailable(20, { ...arguments_, invocationId: "missing", orchestratorId: "asst_missing" });
    const wrongThread = await unavailable(21, { ...arguments_, invocationId: "wrong-thread", threadId: "thread_foreign" });
    const archived = await unavailable(22, { ...arguments_, invocationId: "archived", orchestratorId: "asst_archived" });
    const foreign = await unavailable(23, { ...arguments_, invocationId: "foreign", orchestratorId: "asst_foreign" });
    expect(missing.result).toEqual(wrongThread.result);
    expect(missing.result).toEqual(archived.result);
    expect(missing.result).toEqual(foreign.result);
    const gates = await api.providers.engineStore.listDecisionGates("assistant:asst_approval", thread.id);
    expect(gates).toHaveLength(1);
    await session.resolveDecision(gates[0]!.id, { actionId: "approve", resolvedBy: "approval-user", resolvedAt: Date.now() });
    await call(2);
    await call(3);
    expect(providerCalls).toBe(1);

    const deniedArgs = { ...arguments_, invocationId: "approval-denied" };
    const deniedCall = (id: number) => mcpRequest(api!.baseUrl, "approval-token", { jsonrpc: "2.0", id, method: "tools/call", params: { name: "call_tool", arguments: deniedArgs } });
    await deniedCall(4);
    const deniedGate = (await api.providers.engineStore.listDecisionGates("assistant:asst_approval", thread.id)).find((gate) => gate.status === "pending");
    expect(deniedGate).toBeDefined();
    await session.resolveDecision(deniedGate!.id, { actionId: "deny", resolvedBy: "approval-user", resolvedAt: Date.now() });
    const denied = await (await deniedCall(5)).json() as { result?: { content: Array<{ text: string }> } };
    expect(JSON.parse(denied.result?.content[0]?.text ?? "{}").status).toBe("denied");
    await deniedCall(6);
    expect(providerCalls).toBe(1);

    const expiredArgs = { ...arguments_, invocationId: "approval-expired" };
    const expiredCall = (id: number) => mcpRequest(api!.baseUrl, "approval-token", { jsonrpc: "2.0", id, method: "tools/call", params: { name: "call_tool", arguments: expiredArgs } });
    await expiredCall(7);
    const expiringGate = (await api.providers.engineStore.listDecisionGates("assistant:asst_approval", thread.id)).find((gate) => gate.status === "pending");
    expect(expiringGate).toBeDefined();
    await api.providers.db.execute(sql`
      UPDATE engine_decision_gates SET expires_at = ${Date.now()} WHERE id = ${expiringGate!.id}
    `);
    const expired = await (await expiredCall(8)).json() as { result?: { content: Array<{ text: string }> } };
    const expiredEnvelope = JSON.parse(expired.result?.content[0]?.text ?? "{}") as {
      status: string; error?: string; correctiveAction?: string;
    };
    expect(expiredEnvelope).toMatchObject({
      status: "denied",
      error: "The approval expired before execution.",
      correctiveAction: "If you still need this action, submit it again with a new invocation ID.",
    });
    expect((await api.providers.engineStore.getDecisionGate("assistant:asst_approval", expiringGate!.id))?.status).toBe("expired");
    await expiredCall(9);
    expect(providerCalls).toBe(1);

    const rows = (await api.providers.db.select().from(actionInvocations)).filter((row) => row.source === "mcp_call_tool");
    expect(rows).toHaveLength(3);
    expect(rows.find((row) => row.clientInvocationId === "approval-once")?.status).toBe("completed");
    expect(rows.find((row) => row.clientInvocationId === "approval-denied")?.status).toBe("denied");
    expect(rows.find((row) => row.clientInvocationId === "approval-expired")?.status).toBe("denied");
    expect(JSON.stringify({ rows, gates })).not.toContain("approval-token");
  });
});
