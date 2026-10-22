import { Engine, InMemoryEventStream, InMemorySessionStore, VirtualSandboxProvider, pluginCatalogTools, type ActionPlugin, type ValetPlugin } from "@valet/engine";
import { Type } from "typebox";
import { fauxToolCall } from "@valet/engine/test-helpers";
import { buildPolicyResolver } from "../policies/service.js";
import { createPolicy } from "../policies/admin.js";
import { fauxAssistantMessage, fauxToolCall as rawToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { actionInvocations, externalCalls, teams, teamMembers } from "../schema/index.js";
import { externalUsageRetention, hostedToolUsageSink, recordExternalCall } from "../services/external-usage.js";
import { InstanceClient } from "../cli/client.js";
import { withCliInvocation } from "../cli/telemetry.js";
import type { ExternalUsageResponse } from "../wire/types.js";

let api: TestApi | undefined;
afterEach(async () => { await api?.cleanup(); api = undefined; vi.restoreAllMocks(); vi.unstubAllEnvs(); });
async function seed(target: TestApi, id: string, overrides: Partial<typeof externalCalls.$inferInsert> = {}) {
  await target.providers.db.insert(externalCalls).values({ id, orgId: "local-org", userId: "local-user", surface: "mcp", name: "list_threads",
    clientName: "Claude Code", clientVersion: "1", ownerType: "user", ownerId: "local-user", outcome: "ok", durationMs: 12,
    intent: "Find a thread to continue the task.", createdAt: Date.now() - 1000, ...overrides });
}
async function read(target: TestApi, query = "", userId?: string) {
  return fetch(`${target.baseUrl}/api/usage/external?window=7d${query}`, { headers: userId ? { "x-valet-test-user-id": userId } : {} });
}

describe("external tool usage", () => {
  it("scopes personal aggregates, search, pagination, and surfaces without foreign-org rows", async () => {
    api = await bootTestApi();
    await seed(api, "one");
    await seed(api, "two", { surface: "hosted", outcome: "error", intent: "Find the release note.", createdAt: Date.now() - 500 });
    await seed(api, "member", { userId: "test-member" });
    await seed(api, "foreign", { orgId: "foreign" });
    const data = await (await read(api, "&limit=1")).json() as ExternalUsageResponse;
    expect(data.daily.reduce((sum, day) => sum + day.calls, 0)).toBe(2);
    expect(data.tools).toEqual(expect.arrayContaining([expect.objectContaining({ surface: "hosted", calls: 1, errorRate: 1, uniqueUsers: 1 })]));
    expect(data.hasMore).toBe(true);
    expect(data.recent).toHaveLength(1);
    expect(data.recent[0]?.id).toBe("two");
    const searched = await (await read(api, "&q=release&surface=hosted")).json() as ExternalUsageResponse;
    expect(searched.recent.map(row => row.id)).toEqual(["two"]);
    const second = await (await read(api, "&offset=1&limit=1")).json() as ExternalUsageResponse;
    expect(second.recent.map(row => row.id)).toEqual(["one"]);
    expect((await read(api, "&offset=-1")).status).toBe(400);
    expect((await read(api, "&surface=other")).status).toBe(400);
  });

  it("uses the existing org gate and team detail permissions", async () => {
    api = await bootTestApi();
    const db = api.providers.db;
    expect((await read(api, "&scope=org")).status).toBe(403);
    await db.execute(sql`UPDATE orgs SET features = features || '{"organizations": true}'::jsonb`);
    expect((await read(api, "&scope=org", "test-member")).status).toBe(403);
    expect((await read(api, "&scope=org")).status).toBe(200);
    await db.insert(teams).values({ id: "team", name: "Team", orgId: "local-org", createdAt: Date.now() });
    await db.insert(teamMembers).values([
      { teamId: "team", userId: "local-user", role: "admin" },
      { teamId: "team", userId: "test-member", role: "member" },
    ]);
    await seed(api, "team-call", { ownerType: "team", ownerId: "team" });
    await seed(api, "personal-call");
    const member = await (await read(api, "&scope=team&teamId=team&q=Find", "test-member")).json() as ExternalUsageResponse;
    expect(member.detailsVisible).toBe(false);
    expect(member.recent).toEqual([]);
    expect(member.hasMore).toBe(false);
    expect(member.daily.reduce((sum, row) => sum + row.calls, 0)).toBe(1);
    const admin = await (await read(api, "&scope=team&teamId=team")).json() as ExternalUsageResponse;
    expect(admin.recent.map(row => row.id)).toEqual(["team-call"]);
    expect((await read(api, "&scope=team&teamId=team", "test-admin")).status).toBe(404);
    expect((await read(api, "&scope=team")).status).toBe(400);
  });

  it("tags CLI rows and deduplicates every request of one command invocation", async () => {
    api = await bootTestApi();
    const client = new InstanceClient({ url: api.baseUrl });
    await withCliInvocation("threads", ["list", "--json"], async () => {
      await client.me();
      await client.listWorkspaceThreads();
    });
    await vi.waitFor(async () => {
      const rows = await api!.providers.db.select().from(externalCalls);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ surface: "cli", name: "threads list", clientVersion: "0.0.1", outcome: "ok", intent: null });
      expect(rows[0]?.durationMs).toBeGreaterThanOrEqual(0);
    });
  });

  it("records hosted calls through a real session, including invalid intent but excluding sandbox primitives", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
    const faux = registerFauxProvider({ api: "anthropic-messages", provider: "anthropic" });
    try {
      faux.setResponses([
        fauxAssistantMessage([rawToolCall("list_threads", {})], { stopReason: "toolUse" }),
        fauxAssistantMessage([rawToolCall("list_threads", { intent: "Find the active conversation to continue the task." })], { stopReason: "toolUse" }),
        fauxAssistantMessage([rawToolCall("bash", { command: "pwd" })], { stopReason: "toolUse" }),
        fauxAssistantMessage("Done"),
      ]);
      api = await bootTestApi();
      const created = await fetch(`${api.baseUrl}/api/threads`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      expect(created.status).toBe(201);
      const thread = await created.json() as { id: string; sessionId: string };
      const sent = await fetch(`${api.baseUrl}/api/threads/${thread.id}/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "Check the current thread." }) });
      expect(sent.status).toBe(202);
      const receipt = await sent.json() as { messageId: string };
      const session = api.providers.engineHost.liveSession(thread.sessionId);
      expect(session).toBeDefined();
      const outcome = await session?.thread(thread.id).awaitResult(receipt.messageId);
      expect(outcome?.outcome).toBe("completed");
      await vi.waitFor(async () => {
        const rows = await api!.providers.db.select().from(externalCalls);
        expect(rows).toHaveLength(2);
        expect(rows.map(row => row.outcome).sort()).toEqual(["error", "ok"]);
        expect(rows.every(row => row.surface === "hosted" && row.name === "list_threads" && row.threadId === thread.id)).toBe(true);
      });
    } finally { faux.unregister(); }
  });

  it("stores hosted facts and never propagates or logs recording errors", async () => {
    api = await bootTestApi();
    const sink = hostedToolUsageSink(api.providers.db, "reviewer");
    sink({ id: "hosted-one", orgId: "local-org", userId: "local-user", sessionId: "session", threadId: "thread",
      ownerType: "user", ownerId: "local-user", name: "mem_write", intent: "Save the preference for future tasks.", outcome: "ok", errorCode: null, durationMs: 7, createdAt: Date.now() });
    await vi.waitFor(async () => {
      const [row] = await api!.providers.db.select().from(externalCalls).where(eq(externalCalls.id, "hosted-one"));
      expect(row).toMatchObject({ surface: "hosted", name: "mem_write", persona: "reviewer", durationMs: 7 });
      expect(row).not.toHaveProperty("arguments");
      expect(row).not.toHaveProperty("result");
    });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(api.providers.db, "insert").mockImplementation(() => { throw new Error("secret payload must not be logged"); });
    await expect(recordExternalCall(api.providers.db, { id: "bad", orgId: "local-org", userId: "local-user", ownerType: "user", ownerId: "local-user", surface: "cli", name: "status", outcome: "error", durationMs: 1, createdAt: Date.now() })).resolves.toBeUndefined();
    expect(warning.mock.calls).toEqual([["External usage telemetry failed. Check database availability."]]);
  });
});

it("keeps matcher inputs and audit params clean through hosted broker and pinned calls", async () => {
  api = await bootTestApi();
  const db = api.providers.db;
  const seen: Record<string, unknown>[] = [];
  const actions: ActionPlugin = { service: "demo", defaultApprovalMode: "allow", actions: [{
    id: "echo", name: "Echo", description: "Echo a value", riskLevel: "low", parameters: Type.Object({ value: Type.Number() }),
    execute: async args => { if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Expected action arguments."); seen.push({ ...args }); return { success: true, data: {} }; },
  }] };
  const plugin: ValetPlugin = { name: "demo", version: "1", actions: [actions] };
  await createPolicy(db, { orgId: "local-org", type: "org", id: "local-org" }, { actionId: "demo.echo", mode: "deny", paramMatchers: [{ path: "value", op: "eq", value: 2 }], managedBy: "test", now: Date.now() });
  const faux = registerFauxProvider({ provider: "hosted-policy-intent" });
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("call_tool", { tool_id: "echo", params: { value: 1 }, summary: "Read one to check the connection." })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxToolCall("demo__echo", { value: 1, summary: "Read one through the pinned action." })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxToolCall("call_tool", { tool_id: "demo.echo", params: { value: 2 }, summary: "Check whether the policy refuses two." })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxToolCall("demo__echo", { value: 2, summary: "Check the same policy through the pin." })], { stopReason: "toolUse" }),
    fauxAssistantMessage("done"),
  ]);
  const engine = new Engine({ providers: { store: new InMemorySessionStore(), stream: new InMemoryEventStream(), sandboxProvider: new VirtualSandboxProvider() } });
  const session = await engine.createSession({ userId: "local-user", orgId: "local-org", workspace: "/", sandbox: {}, model: faux.getModel(),
    tools: pluginCatalogTools({ plugins: [actions], pins: [{ actionId: "demo.echo" }] }),
    policyResolver: buildPolicyResolver({ db, actionPluginByService: new Map([["demo", { plugin, actionPlugin: actions }]]) }),
    recordToolUsage: hostedToolUsageSink(db),
  });
  try {
    const receipt = await session.prompt("Check the policy through both tool routes.");
    await session.thread(receipt.threadId).awaitResult(receipt.queueItemId);
    expect(seen).toEqual([{ value: 1 }, { value: 1 }]);
    await vi.waitFor(async () => {
      const audit = await db.select().from(actionInvocations);
      expect(audit).toHaveLength(4);
      expect(audit.every(row => !JSON.stringify(row.params).includes("intent") && !JSON.stringify(row.params).includes("summary"))).toBe(true);
      const facts = await db.select().from(externalCalls);
      expect(facts).toHaveLength(4);
      expect(facts.every(row => row.name === "demo.echo" && row.intent !== null)).toBe(true);
      expect(facts.filter(row => row.outcome === "denied")).toHaveLength(2);
    });
  } finally { await session.destroy(); faux.unregister(); }
});

it("does not await a hanging hosted insert", async () => {
  api = await bootTestApi();
  const db = api.providers.db;
  const insert = db.insert.bind(db);
  let started = false;
  vi.spyOn(db, "insert").mockImplementation((...args) => {
    const builder = insert(...args);
    if (args[0] === externalCalls) {
      const values = builder.values.bind(builder);
      vi.spyOn(builder, "values").mockImplementation((...rows) => {
        const query = values(...rows);
        vi.spyOn(query, "execute").mockImplementation(() => { started = true; return new Promise(() => {}); });
        return query;
      });
    }
    return builder;
  });
  const sink = hostedToolUsageSink(db);
  const faux = registerFauxProvider({ provider: "hanging-telemetry" });
  faux.setResponses([fauxAssistantMessage([fauxToolCall("list_threads", {})], { stopReason: "toolUse" }), fauxAssistantMessage("done")]);
  const engine = new Engine({ providers: { store: new InMemorySessionStore(), stream: new InMemoryEventStream(), sandboxProvider: new VirtualSandboxProvider() } });
  const session = await engine.createSession({ userId: "local-user", orgId: "local-org", workspace: "/", sandbox: {}, model: faux.getModel(), recordToolUsage: sink });
  try {
    const receipt = await session.prompt("List threads.");
    expect((await session.thread(receipt.threadId).awaitResult(receipt.queueItemId)).outcome).toBe("completed");
    expect(started).toBe(true);
  } finally { await session.destroy(); faux.unregister(); }
});

it("keeps late CLI requests and reused invocation ids isolated by user", async () => {
  api = await bootTestApi();
  const db = api.providers.db;
  await recordExternalCall(db, { id: "ordered", orgId: "local-org", userId: "local-user", surface: "cli", name: "threads list", ownerType: "user", ownerId: "local-user", outcome: "error", durationMs: 10, createdAt: 100 });
  await recordExternalCall(db, { id: "ordered", orgId: "local-org", userId: "local-user", surface: "cli", name: "threads list", ownerType: "user", ownerId: "local-user", outcome: "ok", durationMs: 20, createdAt: 50 });
  expect((await db.select().from(externalCalls).where(eq(externalCalls.id, "ordered")))[0]).toMatchObject({ createdAt: 50, durationMs: 60, outcome: "error" });
  const headers = { "x-valet-cli-invocation": "11111111-1111-4111-8111-111111111111", "x-valet-cli-command": "threads list" };
  await fetch(`${api.baseUrl}/api/me`, { headers });
  await fetch(`${api.baseUrl}/api/me`, { headers: { ...headers, "x-valet-test-user-id": "test-member" } });
  await vi.waitFor(async () => {
    const rows = (await db.select().from(externalCalls)).filter(row => row.id.startsWith("cli:"));
    expect(rows).toHaveLength(2);
    expect(rows.map(row => row.userId).sort()).toEqual(["local-user", "test-member"]);
  });
});

it("keeps health public with bad credentials and records no health usage", async () => {
  api = await bootTestApi({ auth: true });
  const response = await fetch(`${api.baseUrl}/api/health`, { headers: { Authorization: "Bearer invalid", "x-valet-cli-invocation": "11111111-1111-4111-8111-111111111111", "x-valet-cli-command": "status" } });
  expect(response.status).toBe(200);
  expect(await api.providers.db.select().from(externalCalls)).toEqual([]);
});

it("nulls old intent text while retaining counts and hides personal rows in the org feed", async () => {
  api = await bootTestApi(); const db = api.providers.db;
  await db.execute(sql`UPDATE orgs SET features = features || '{"organizations": true}'::jsonb`);
  await seed(api, "old", { createdAt: Date.now() - 91 * 86400000 });
  await seed(api, "personal");
  await seed(api, "team", { ownerType: "team", ownerId: "team", userId: null });
  await externalUsageRetention(db)();
  expect((await db.select().from(externalCalls).where(eq(externalCalls.id, "old")))[0]?.intent).toBeNull();
  const org = await (await read(api, "&scope=org")).json() as ExternalUsageResponse;
  expect(org.daily.reduce((sum, day) => sum + day.calls, 0)).toBe(2);
  expect(org.recent.map(row => row.id)).toEqual(["team"]);
  expect(org.tools[0]?.uniqueUsers).toBe(1);
});

it("attributes a CLI invoke body to its admitted team after personal discovery requests", async () => {
  const plugin: ValetPlugin = { name: "demo", version: "1", actions: [{ service: "demo", actions: [{
    id: "demo.ping", name: "Ping", description: "Check the team connection", riskLevel: "low", parameters: Type.Object({}),
    execute: async () => ({ success: true, data: { ok: true } }),
  }] }] };
  api = await bootTestApi({ plugins: [plugin] });
  const db = api.providers.db;
  await db.insert(teams).values({ id: "team", name: "Team", orgId: "local-org", createdAt: Date.now() });
  await db.insert(teamMembers).values({ teamId: "team", userId: "local-user", role: "admin" });
  await api.providers.engineCredentials.save({ type: "team", id: "team" }, "demo", { type: "api_key", apiKey: "fixture-only" });
  const client = new InstanceClient({ url: api.baseUrl });
  await withCliInvocation("tools", ["call", "demo.ping"], async () => {
    await client.me();
    expect((await client.callTool("demo.ping", { workspace: "team", params: {} })).status).toBe("completed");
    await client.me();
  });
  await vi.waitFor(async () => {
    const rows = (await db.select().from(externalCalls)).filter(row => row.surface === "cli");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ ownerType: "team", ownerId: "team", outcome: "ok" });
  });
  await createPolicy(db, { orgId: "local-org", type: "org", id: "local-org" }, { actionId: "demo.ping", mode: "deny", managedBy: "test", now: Date.now() });
  await withCliInvocation("tools", ["call", "demo.ping"], async () => {
    expect(await client.callTool("demo.ping", { workspace: "team", params: {} })).toMatchObject({ status: "failed", errorCode: "policy_denied" });
  });
  await vi.waitFor(async () => expect((await db.select().from(externalCalls)).filter(row => row.surface === "cli" && row.outcome === "denied")).toHaveLength(1));
});

it("does not disclose team thread intents to an admin outside their audience", async () => {
  api = await bootTestApi(); const db = api.providers.db;
  await db.execute(sql`UPDATE orgs SET features = features || '{"organizations": true}'::jsonb`);
  await db.insert(teams).values({ id: "team", name: "Team", orgId: "local-org", createdAt: Date.now() });
  await db.insert(teamMembers).values({ teamId: "team", userId: "local-user", role: "admin" });
  await db.execute(sql`INSERT INTO engine_threads (id, session_id, key, status, queue_mode, created_at, updated_at) VALUES
    ('private', 'session', 'app-assistant:test-member', 'idle', 'steer', 1, 1),
    ('shared', 'session', 'web:default', 'idle', 'steer', 1, 1),
    ('slack-private', 'session', 'slack:CUNKNOWNPRIVATE:1', 'idle', 'steer', 1, 1)`);
  await seed(api, "private-call", { surface: "hosted", ownerType: "team", ownerId: "team", sessionId: "session", threadId: "private", userId: "test-member", intent: "Confidential layoff investigation.", createdAt: Date.now() });
  await seed(api, "shared-call", { surface: "hosted", ownerType: "team", ownerId: "team", sessionId: "session", threadId: "shared", userId: "test-member" });
  await seed(api, "slack-call", { surface: "hosted", ownerType: "team", ownerId: "team", sessionId: "session", threadId: "slack-private", userId: "test-member" });
  for (const scope of ["&scope=org", "&scope=team&teamId=team"]) {
    const data = await (await read(api, scope)).json() as ExternalUsageResponse;
    expect(data.daily.reduce((sum, day) => sum + day.calls, 0)).toBe(3);
    expect(data.recent.map(row => row.id)).toEqual(["shared-call"]);
    const hidden = await (await read(api, `${scope}&q=layoff&limit=1`)).json() as ExternalUsageResponse;
    expect(hidden.recent).toEqual([]);
    expect(hidden.hasMore).toBe(false);
    const first = await (await read(api, `${scope}&limit=1`)).json() as ExternalUsageResponse;
    expect(first.recent.map(row => row.id)).toEqual(["shared-call"]);
    expect(first.hasMore).toBe(false);
    const next = await (await read(api, `${scope}&offset=1&limit=1`)).json() as ExternalUsageResponse;
    expect(next.recent).toEqual([]);
    expect(next.hasMore).toBe(false);
  }
});

it("counts execution errors separately from policy denial and pending approval", async () => {
  api = await bootTestApi();
  for (const outcome of ["ok", "error", "denied", "pending-approval"] as const) await seed(api, outcome, { outcome });
  const data = await (await read(api)).json() as ExternalUsageResponse;
  expect(data.tools[0]).toMatchObject({ calls: 4, errorRate: .25 });
});
