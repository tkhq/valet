/**
 * Integration tests for the MCP tool broker: `search_tools`, `describe_tool`,
 * and `call_tool` over `/mcp`, backed by `/api/actions`.
 *
 * A demo plugin with three actions and real org policies proves that an
 * external call inherits the policy hierarchy (allow, deny,
 * require_approval), uses the caller's own credential without returning it,
 * honors idempotency keys without crossing users, and writes audit rows.
 */
import { Type } from "typebox";
import type { PluginAction, ValetPlugin } from "@valet/engine";
import { and, eq, like, lt } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { createPolicy } from "../policies/admin.js";
import { clearDiscoveryCache } from "../routes/actions.js";
import { actionInvocations, actionPolicies, oauthAccessToken, oauthApplication, orgMembers, orgs, teamMembers, teams, users } from "../schema/index.js";
import { shareCredential } from "../services/credential-shares.js";

let api: TestApi | undefined;

afterEach(async () => {
  await api?.cleanup();
  api = undefined;
});

const SECRET = "demo-secret-key-123";

function demoPlugin() {
  const calls: Record<string, number> = {};
  let releaseSlow: () => void = () => {};
  let slowStarted: () => void = () => {};
  const slowStartedP = new Promise<void>((resolve) => { slowStarted = resolve; });
  const slowGate = new Promise<void>((resolve) => { releaseSlow = resolve; });
  const extra: PluginAction[] = [
    {
      id: "demo.flaky", name: "Flaky", description: "Fails the first time.", riskLevel: "low", parameters: Type.Object({}),
      execute: async () => {
        calls["demo.flaky"] = (calls["demo.flaky"] ?? 0) + 1;
        return calls["demo.flaky"] === 1 ? { success: false, error: "temporary outage" } : { success: true, data: { ok: true } };
      },
    },
    {
      id: "demo.slow", name: "Slow", description: "Waits for the test.", riskLevel: "low", parameters: Type.Object({}),
      execute: async () => {
        calls["demo.slow"] = (calls["demo.slow"] ?? 0) + 1;
        slowStarted();
        await slowGate;
        return { success: true, data: { done: true } };
      },
    },
  ];
  const action = (id: string, name: string): PluginAction => ({
    id,
    name,
    description: `${name}: demo action for broker tests.`,
    riskLevel: "low",
    parameters: Type.Object({ text: Type.Optional(Type.String()) }),
    execute: async (args, ctx) => {
      calls[id] = (calls[id] ?? 0) + 1;
      const credential = await ctx.credentials.get();
      const echoed = typeof args === "object" && args !== null && "text" in args && typeof args.text === "string" ? args.text : null;
      return { success: true, data: { echoed, hasCredential: credential !== null, keyLength: credential?.accessToken.length ?? 0 } };
    },
  });
  const dyn = { discoveries: 0 };
  const dynamic: ValetPlugin = {
    name: "remote",
    version: "0.0.1",
    actions: [{
      service: "remote", actions: [],
      resolveActions: async () => {
        dyn.discoveries += 1;
        return [{ id: "remote.lookup", name: "Lookup", description: "A tool discovered at run time.", riskLevel: "low", parameters: Type.Object({}), execute: async () => ({ success: true, data: {} }) }];
      },
    }],
  };
  // A remote service that cannot list its tools without a credential.
  const locked: ValetPlugin = {
    name: "locked",
    version: "0.0.1",
    actions: [{
      service: "locked", actions: [],
      resolveActions: async ({ credentials }) => {
        if ((await credentials.get()) === null) throw new Error("locked: no credential connected. Connect Locked in Integrations.");
        return [{ id: "locked.read", name: "Read", description: "Needs a credential to list.", riskLevel: "low", parameters: Type.Object({}), execute: async () => ({ success: true, data: {} }) }];
      },
    }],
    credentials: [{ service: "locked", type: "api_key", configKeys: ["apiKey"], connectLabel: "Locked" }],
  };
  const plugin: ValetPlugin = {
    name: "demo",
    version: "0.0.1",
    actions: [{ service: "demo", actions: [action("demo.ping", "Ping"), action("demo.pong", "Pong"), action("demo.blocked", "Blocked"), action("demo.risky", "Risky"), ...extra] }],
    credentials: [{ service: "demo", type: "api_key", configKeys: ["apiKey"], connectLabel: "Demo" }],
  };
  return { plugin, dynamic, locked, dyn, calls, releaseSlow: () => releaseSlow(), slowStarted: slowStartedP };
}

async function seedUser(testApi: TestApi, id: string): Promise<string> {
  const { db } = testApi.providers;
  const now = Date.now();
  await db.insert(orgs).values({ id: "broker-org", name: "Broker Org", createdAt: now }).onConflictDoNothing();
  await db.insert(users).values({ id, name: `User ${id}`, email: `${id}@nowhere.test`, role: "member", createdAt: new Date(now), updatedAt: new Date(now) });
  await db.insert(orgMembers).values({ orgId: "broker-org", userId: id, role: "member", createdAt: now });
  const token = `token-${id}`;
  await db.insert(oauthApplication).values({ id: `app-${id}`, name: "Claude Code", clientId: `client-${id}`, type: "public", createdAt: new Date(now), updatedAt: new Date(now) });
  await db.insert(oauthAccessToken).values({
    id: `oauth-${id}`, accessToken: token, refreshToken: `refresh-${id}`,
    accessTokenExpiresAt: new Date(now + 600_000), refreshTokenExpiresAt: new Date(now + 3_600_000),
    clientId: `client-${id}`, userId: id, scopes: "mcp", createdAt: new Date(now), updatedAt: new Date(now),
  });
  return token;
}

let rpcId = 0;
async function tool(baseUrl: string, token: string, name: string, args: Record<string, unknown>) {
  const res = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } }),
  });
  expect(res.status).toBe(200);
  const { result } = (await res.json()) as { result: { isError?: boolean; content: Array<{ text: string }> } };
  const text = result.content.map((c) => c.text).join("\n");
  return { isError: result.isError === true, text, data: result.isError ? {} : (JSON.parse(text) as Record<string, unknown>) };
}

async function setup() {
  const demo = demoPlugin();
  const testApi = await bootTestApi({ auth: true, plugins: [demo.plugin, demo.dynamic, demo.locked] });
  clearDiscoveryCache();
  api = testApi;
  const alice = await seedUser(testApi, "alice");
  const bob = await seedUser(testApi, "bob");
  await testApi.providers.engineCredentials.save({ type: "user", id: "alice" }, "demo", { type: "api_key", apiKey: SECRET });
  const now = Date.now();
  const scope = { orgId: "broker-org", type: "org" as const, id: "broker-org" };
  await createPolicy(testApi.providers.db, scope, { actionId: "demo.blocked", mode: "deny", managedBy: "test", now });
  await createPolicy(testApi.providers.db, scope, { actionId: "demo.risky", mode: "require_approval", managedBy: "test", now });
  return { testApi, demo, alice, bob };
}

describe("MCP tool broker", () => {
  it("resolves the described policy for specific params", async () => {
    const { testApi, alice } = await setup();
    await createPolicy(testApi.providers.db, { orgId: "broker-org", type: "org", id: "broker-org" },
      { actionId: "demo.ping", mode: "deny", paramMatchers: [{ path: "text", op: "eq", value: "secret" }], managedBy: "test", now: Date.now() });
    const general = await tool(testApi.baseUrl, alice, "describe_tool", { tool_id: "demo.ping" });
    expect(general.data).toMatchObject({ policy: "allow", policy_for: expect.stringContaining("any params") });
    const specific = await tool(testApi.baseUrl, alice, "describe_tool", { tool_id: "demo.ping", params: { text: "secret" } });
    expect(specific.data).toMatchObject({ policy: "deny", policy_for: "these params" });
    const blocked = await tool(testApi.baseUrl, alice, "call_tool", { tool_id: "demo.ping", params: { text: "secret" } });
    expect(blocked.data).toMatchObject({ status: "failed" });
  });

  it("discovers a remote service once per caller within the cache window", async () => {
    const { testApi, demo, alice, bob } = await setup();
    await tool(testApi.baseUrl, alice, "search_tools", { query: "lookup" });
    const again = await tool(testApi.baseUrl, alice, "search_tools", { query: "lookup" });
    expect(again.data.tools).toEqual([expect.objectContaining({ tool_id: "remote.lookup" })]);
    expect(demo.dyn.discoveries).toBe(1);
    await tool(testApi.baseUrl, bob, "search_tools", { query: "lookup" });
    expect(demo.dyn.discoveries).toBe(2);
  });

  it("searches the catalog and describes a tool with the policy that applies", async () => {
    const { testApi, alice } = await setup();
    const found = await tool(testApi.baseUrl, alice, "search_tools", { query: "ping" });
    expect(found.data.tools).toEqual([expect.objectContaining({ tool_id: "demo.ping", service: "demo", risk_level: "low" })]);
    const byService = await tool(testApi.baseUrl, alice, "search_tools", { service: "demo" });
    expect((byService.data.tools as Array<{ tool_id: string }>).map((t) => t.tool_id).sort()).toEqual(["demo.blocked", "demo.flaky", "demo.ping", "demo.pong", "demo.risky", "demo.slow"]);

    const ping = await tool(testApi.baseUrl, alice, "describe_tool", { tool_id: "demo.ping" });
    expect(ping.data).toMatchObject({ tool_id: "demo.ping", policy: "allow", parameters: expect.objectContaining({ type: "object" }) });
    expect((await tool(testApi.baseUrl, alice, "describe_tool", { tool_id: "demo.blocked" })).data.policy).toBe("deny");
    expect((await tool(testApi.baseUrl, alice, "describe_tool", { tool_id: "demo.risky" })).data.policy).toBe("require_approval");

    const unknown = await tool(testApi.baseUrl, alice, "describe_tool", { tool_id: "demo.nope" });
    expect(unknown.isError).toBe(true);
    expect(unknown.text).toContain("Use search_tools");
  });

  it("runs an allowed tool with the caller's own credential and never returns the secret", async () => {
    const { testApi, demo, alice, bob } = await setup();
    const mine = await tool(testApi.baseUrl, alice, "call_tool", { tool_id: "demo.ping", params: { text: "hi" } });
    expect(mine.data).toEqual({ tool_id: "demo.ping", status: "completed", result: { echoed: "hi", hasCredential: true, keyLength: SECRET.length } });
    expect(mine.text).not.toContain(SECRET);

    // Bob has no demo credential. Alice's must never be used for him.
    const his = await tool(testApi.baseUrl, bob, "call_tool", { tool_id: "demo.ping", params: {} });
    expect(his.data).toMatchObject({ status: "completed", result: { hasCredential: false } });
    expect(demo.calls["demo.ping"]).toBe(2);
  });

  it("inherits deny and require_approval policies without running the action", async () => {
    const { testApi, demo, alice } = await setup();
    const blocked = await tool(testApi.baseUrl, alice, "call_tool", { tool_id: "demo.blocked" });
    expect(blocked.data).toMatchObject({ status: "failed", error: expect.stringContaining("blocked by org policy") });
    const risky = await tool(testApi.baseUrl, alice, "call_tool", { tool_id: "demo.risky" });
    expect(risky.data).toMatchObject({ status: "approval_required", next_step: expect.stringContaining("start_thread") });
    expect(demo.calls["demo.blocked"]).toBeUndefined();
    expect(demo.calls["demo.risky"]).toBeUndefined();

    const audit = await testApi.providers.db.select().from(actionInvocations).where(like(actionInvocations.invocationId, "pol:ext:%"));
    // Each row names the caller: MCP and the OAuth client the token belongs to.
    expect(audit.map((row) => [row.actionId, row.status, row.userId, row.caller]).sort()).toEqual([
      ["demo.blocked", "denied", "alice", "mcp:client-alice"],
      ["demo.risky", "pending", "alice", "mcp:client-alice"],
    ]);
  });

  it("returns the first result for a repeated idempotency key, scoped to one caller", async () => {
    const { testApi, demo, alice, bob } = await setup();
    const first = await tool(testApi.baseUrl, alice, "call_tool", { tool_id: "demo.ping", params: { text: "once" }, idempotency_key: "k1" });
    const again = await tool(testApi.baseUrl, alice, "call_tool", { tool_id: "demo.ping", params: { text: "once" }, idempotency_key: "k1" });
    expect(again.data).toEqual(first.data);
    expect(demo.calls["demo.ping"]).toBe(1);

    // The same key from another person runs separately and sees no stored result.
    const other = await tool(testApi.baseUrl, bob, "call_tool", { tool_id: "demo.ping", params: { text: "bob" }, idempotency_key: "k1" });
    expect(other.data).toMatchObject({ result: { echoed: "bob", hasCredential: false } });
    expect(demo.calls["demo.ping"]).toBe(2);

    const allowed = await testApi.providers.db.select().from(actionInvocations).where(like(actionInvocations.invocationId, "pol:ext:%"));
    expect(allowed.filter((row) => row.status === "completed").map((row) => row.userId).sort()).toEqual(["alice", "bob"]);
  });

  it("runs a reused key again for another tool or other params", async () => {
    const { testApi, demo, alice } = await setup();
    await tool(testApi.baseUrl, alice, "call_tool", { tool_id: "demo.ping", params: { text: "a" }, idempotency_key: "shared" });
    const otherTool = await tool(testApi.baseUrl, alice, "call_tool", { tool_id: "demo.pong", params: { text: "a" }, idempotency_key: "shared" });
    expect(otherTool.data).toMatchObject({ tool_id: "demo.pong", status: "completed" });
    expect(demo.calls["demo.pong"]).toBe(1);
    const otherParams = await tool(testApi.baseUrl, alice, "call_tool", { tool_id: "demo.ping", params: { text: "b" }, idempotency_key: "shared" });
    expect(otherParams.data).toMatchObject({ result: { echoed: "b" } });
    expect(demo.calls["demo.ping"]).toBe(2);
  });

  it("records each retry attempt in its own audit row after a policy change", async () => {
    const { testApi, demo, alice } = await setup();
    const denied = await tool(testApi.baseUrl, alice, "call_tool", { tool_id: "demo.blocked", idempotency_key: "audit-1" });
    expect(denied.data).toMatchObject({ status: "failed" });
    // An admin lifts the deny policy; the caller retries with the same key.
    await testApi.providers.db.delete(actionPolicies).where(eq(actionPolicies.actionId, "demo.blocked"));
    const retried = await tool(testApi.baseUrl, alice, "call_tool", { tool_id: "demo.blocked", idempotency_key: "audit-1" });
    expect(retried.data).toMatchObject({ status: "completed" });
    expect(demo.calls["demo.blocked"]).toBe(1);
    const rows = await testApi.providers.db.select().from(actionInvocations).where(like(actionInvocations.invocationId, "pol:ext:%"));
    const attempts = rows.filter((row) => row.actionId === "demo.blocked").map((row) => [row.resolvedMode, row.status]).sort();
    expect(attempts).toEqual([["allow", "completed"], ["deny", "denied"]]);
  });

  it("does not keep a failure, so a retry with the same key runs again", async () => {
    const { testApi, demo, alice } = await setup();
    const failed = await tool(testApi.baseUrl, alice, "call_tool", { tool_id: "demo.flaky", idempotency_key: "retry-1" });
    expect(failed.data).toMatchObject({ status: "failed", error: "temporary outage" });
    const retried = await tool(testApi.baseUrl, alice, "call_tool", { tool_id: "demo.flaky", idempotency_key: "retry-1" });
    expect(retried.data).toMatchObject({ status: "completed", result: { ok: true } });
    expect(demo.calls["demo.flaky"]).toBe(2);
  });

  it("takes over an abandoned claim once, and holds it against a retry during the run", async () => {
    const { testApi, demo, alice } = await setup();
    const db = testApi.providers.db;
    const { createHash } = await import("node:crypto");
    const digest = createHash("sha256").update(JSON.stringify({})).digest("hex").slice(0, 24);
    const claimId = `claim:ext:alice:user:alice:demo.slow:${digest}:stale-1`;
    // A crash left a claim older than the takeover window.
    await db.insert(actionInvocations).values({ invocationId: claimId, result: { claim: true }, createdAt: Date.now() - 60 * 60_000 });

    const first = tool(testApi.baseUrl, alice, "call_tool", { tool_id: "demo.slow", idempotency_key: "stale-1" });
    await demo.slowStarted;
    const retry = await tool(testApi.baseUrl, alice, "call_tool", { tool_id: "demo.slow", idempotency_key: "stale-1" });
    expect(retry.data).toMatchObject({ status: "in_progress" });
    demo.releaseSlow();
    expect((await first).data).toMatchObject({ status: "completed" });
    expect(demo.calls["demo.slow"]).toBe(1);
  });

  it("lets only one of two simultaneous takeovers of a stale claim succeed", async () => {
    const { testApi } = await setup();
    const db = testApi.providers.db;
    await db.insert(actionInvocations).values({ invocationId: "claim:race", result: { claim: true }, createdAt: 1 });
    // Both retries saw the same stale claim and compute the same cutoff.
    const now = Date.now();
    const takeover = () => db.update(actionInvocations).set({ createdAt: now })
      .where(and(eq(actionInvocations.invocationId, "claim:race"), lt(actionInvocations.createdAt, now - 15 * 60_000)))
      .returning({ id: actionInvocations.invocationId });
    const results = await Promise.all([takeover(), takeover()]);
    expect(results.map((r) => r.length).sort()).toEqual([0, 1]);
  });

  it("answers a duplicate with in_progress while the first call runs, and never runs it twice", async () => {
    const { testApi, demo, alice } = await setup();
    const firstCall = tool(testApi.baseUrl, alice, "call_tool", { tool_id: "demo.slow", idempotency_key: "slow-1" });
    await demo.slowStarted;
    const duplicate = await tool(testApi.baseUrl, alice, "call_tool", { tool_id: "demo.slow", idempotency_key: "slow-1" });
    expect(duplicate.data).toMatchObject({ status: "in_progress" });
    demo.releaseSlow();
    expect((await firstCall).data).toMatchObject({ status: "completed", result: { done: true } });
    const after = await tool(testApi.baseUrl, alice, "call_tool", { tool_id: "demo.slow", idempotency_key: "slow-1" });
    expect(after.data).toMatchObject({ status: "completed", result: { done: true } });
    expect(demo.calls["demo.slow"]).toBe(1);
  });

  it("caps a large call_tool result and says how to get the rest", async () => {
    const { testApi, alice } = await setup();
    const res = await fetch(`${testApi.baseUrl}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${alice}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name: "call_tool", arguments: { tool_id: "demo.ping", params: { text: "x".repeat(60_000) } } } }),
    });
    const { result } = (await res.json()) as { result: { content: Array<{ text: string }>; structuredContent: Record<string, unknown> } };
    const structured = result.structuredContent;
    expect(JSON.stringify(structured).length).toBeLessThanOrEqual(24_000);
    expect(structured).toMatchObject({ tool_id: "demo.ping", status: "completed", truncated: true, note: expect.stringContaining("narrower params") });
    expect(typeof structured.result).toBe("string");
    expect(String(structured.result)).toMatch(/^\{"echoed":"xxx/);
    expect(JSON.parse(result.content[0].text)).toEqual(structured);
  });

  describe("audit rows for calls that return before the policy check", () => {
    /** Alice and Bob share one team. Alice holds demo and locked credentials. */
    async function teamSetup(opts: { aliceShares: string[] }) {
      const base = await setup();
      const { db, engineCredentials } = base.testApi.providers;
      await db.insert(teams).values({ id: "team-1", orgId: "broker-org", name: "Team", createdAt: 1 });
      await db.insert(teamMembers).values([{ teamId: "team-1", userId: "alice", role: "member" }, { teamId: "team-1", userId: "bob", role: "member" }]);
      await engineCredentials.save({ type: "user", id: "alice" }, "locked", { type: "api_key", apiKey: SECRET });
      for (const service of opts.aliceShares) await shareCredential(db, { teamId: "team-1", service, userId: "alice", createdAt: 1 });
      return base;
    }
    const auditRows = (api: TestApi) => api.providers.db.select().from(actionInvocations).where(like(actionInvocations.invocationId, "pol:ext:%"));

    it("a team call that needs a member's shared account writes a pending row", async () => {
      const { testApi, demo, bob } = await teamSetup({ aliceShares: ["demo"] });
      const res = await tool(testApi.baseUrl, bob, "call_tool", { tool_id: "demo.ping", workspace: "team-1" });
      expect(res.data).toMatchObject({ status: "approval_required", approver: { userId: "alice" } });
      expect(demo.calls["demo.ping"]).toBeUndefined();
      const rows = await auditRows(testApi);
      expect(rows.map((r) => [r.actionId, r.status, r.resolvedMode, r.userId, r.caller])).toEqual([
        ["demo.ping", "pending", "require_approval", "bob", "mcp:client-bob"],
      ]);
    });

    it("a team call with no credential writes an error row", async () => {
      const { testApi, bob } = await teamSetup({ aliceShares: [] });
      const res = await tool(testApi.baseUrl, bob, "call_tool", { tool_id: "demo.ping", workspace: "team-1" });
      expect(res.data).toMatchObject({ status: "failed", error: expect.stringContaining("This team has no demo credential") });
      const rows = await auditRows(testApi);
      expect(rows.map((r) => [r.actionId, r.status, r.userId, r.caller])).toEqual([["demo.ping", "error", "bob", "mcp:client-bob"]]);
      expect(rows[0].error).toContain("This team has no demo credential");
    });

    it("a team call to a service that only a member's shared account can list writes a pending row", async () => {
      const { testApi, bob } = await teamSetup({ aliceShares: ["locked"] });
      const res = await tool(testApi.baseUrl, bob, "call_tool", { tool_id: "locked.read", workspace: "team-1", params: { q: "x" } });
      expect(res.data).toMatchObject({ status: "approval_required", approver: { userId: "alice" } });
      const rows = await auditRows(testApi);
      expect(rows.map((r) => [r.service, r.actionId, r.status, r.resolvedMode, r.userId, r.caller, r.params])).toEqual([
        ["locked", "locked.read", "pending", "require_approval", "bob", "mcp:client-bob", { q: "x" }],
      ]);
    });

    it("a call to a service that cannot list its tools writes an error row", async () => {
      const { testApi, bob } = await setup();
      const res = await tool(testApi.baseUrl, bob, "call_tool", { tool_id: "locked.read" });
      expect(res.isError).toBe(true);
      const rows = await auditRows(testApi);
      expect(rows.map((r) => [r.actionId, r.status, r.error, r.userId, r.caller])).toEqual([
        ["locked.read", "error", "locked: no credential connected. Connect Locked in Integrations.", "bob", "mcp:client-bob"],
      ]);
    });
  });
});
