import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import type { ValetPlugin } from "@valet/engine";
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
