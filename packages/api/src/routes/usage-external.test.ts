import { fauxAssistantMessage, fauxToolCall as rawToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { externalCalls, teams, teamMembers } from "../schema/index.js";
import { hostedToolUsageSink, recordExternalCall } from "../services/external-usage.js";
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
