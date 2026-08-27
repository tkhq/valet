/**
 * GET /api/usage/breakdown + /api/usage/sessions — unified spend across all
 * Valet use cases (engine sessions, orchestrator, workflows, proxy), from the
 * single `cost_entries` definition.
 */
import { describe, it, expect, afterEach } from "vitest";
import { sql } from "drizzle-orm";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { agentSessions, llmProxyRequests } from "../schema/index.js";
import type { UsageBreakdownResponse, UsageDrillResponse, UsageSessionsResponse } from "../wire/types.js";

let api: TestApi | undefined;
afterEach(async () => {
  await api?.cleanup();
  api = undefined;
});

const USAGE = JSON.stringify({ input: 100, output: 20, cacheRead: 0, cacheWrite: 0, total: 120 });
const COST = JSON.stringify({ input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 });

async function seedEngineEntry(api: TestApi, id: string, sessionId: string, now: number): Promise<void> {
  await api.providers.db.execute(sql`
    INSERT INTO engine_entries (id, session_id, thread_id, entry_type, role, model, usage, cost, created_at)
    VALUES (${id}, ${sessionId}, 'th', 'message', 'assistant', 'claude', ${USAGE}::text, ${COST}::text, ${now})
  `);
}

describe("GET /api/usage/breakdown", () => {
  it("breaks the caller's spend down by use case (session, orchestrator, proxy)", async () => {
    api = await bootTestApi();
    const now = Date.now();
    const db = api.providers.db;
    // Two agent sessions owned by local-user: one interactive, one orchestrator.
    await db.insert(agentSessions).values([
      { id: "sess-chat", userId: "local-user", orgId: "local-org", workspace: "/w", status: "active", ownerType: "user", ownerId: "local-user", createdAt: now, updatedAt: now, title: "My chat" },
      { id: "orchestrator:local-user", userId: "local-user", orgId: "local-org", workspace: "/w", status: "active", ownerType: "user", ownerId: "local-user", createdAt: now, updatedAt: now, title: null },
    ]);
    await seedEngineEntry(api, "e-chat", "sess-chat", now);
    await seedEngineEntry(api, "e-orch", "orchestrator:local-user", now);
    // A proxy row (external harness).
    await db.insert(llmProxyRequests).values({
      id: "p-1", createdAt: now, orgId: "local-org", userId: "local-user", apiKeyId: "k",
      providerKind: "anthropic", model: "claude", harness: "claude-code", endpoint: "/v1/messages",
      stream: false, statusCode: 200, requestBody: "{}", inputTokens: 50, outputTokens: 10, totalTokens: 60, costUsd: 0.001,
    });

    const res = await fetch(`${api.baseUrl}/api/usage/breakdown?window=30d`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as UsageBreakdownResponse;

    const byUseCase = Object.fromEntries(body.byUseCase.map((b) => [b.useCase, b]));
    expect(byUseCase.session?.turns).toBe(1);
    expect(byUseCase.orchestrator?.turns).toBe(1);
    expect(byUseCase.proxy?.turns).toBe(1);
    expect(byUseCase.session?.costUsd).toBeCloseTo(0.003, 6);
    expect(byUseCase.proxy?.costUsd).toBeCloseTo(0.001, 6);
    // Token-type split is present per bucket (cache visibility).
    expect(byUseCase.session?.inputTokens).toBe(100);
    expect(byUseCase.session?.outputTokens).toBe(20);
    expect(byUseCase.proxy?.inputTokens).toBe(50);
    // Totals cover all three, with the token-type split + scope.
    expect(body.scope).toBe("me");
    expect(body.totalCostUsd).toBeCloseTo(0.007, 6);
    expect(body.totalInputTokens).toBe(250);
    expect(body.unpricedTurns).toBe(0);
    expect(body.byUser).toBeUndefined(); // me scope
    expect(body.byModel.length).toBeGreaterThan(0);
    expect(body.byDay.length).toBeGreaterThan(0);
  });

  it("scope=org is admin-only: member 403s, admin gets org-wide + byUser", async () => {
    api = await bootTestApi();
    const now = Date.now();
    const db = api.providers.db;
    // Turn the organizations feature on so scope=org is available.
    await db.execute(sql`UPDATE orgs SET features = features || '{"organizations": true}'::jsonb`);
    // Two users' spend.
    await db.insert(agentSessions).values([
      { id: "s-a", userId: "local-user", orgId: "local-org", workspace: "/w", status: "active", ownerType: "user", ownerId: "local-user", createdAt: now, updatedAt: now, title: "A" },
      { id: "s-b", userId: "test-member", orgId: "local-org", workspace: "/w", status: "active", ownerType: "user", ownerId: "test-member", createdAt: now, updatedAt: now, title: "B" },
    ]);
    await seedEngineEntry(api, "e-a", "s-a", now);
    await seedEngineEntry(api, "e-b", "s-b", now);

    // A non-admin member cannot see org usage.
    const memberRes = await fetch(`${api.baseUrl}/api/usage/breakdown?scope=org`, { headers: { "x-valet-test-user-id": "test-member" } });
    expect(memberRes.status).toBe(403);

    // The admin (local-user) sees the whole org + a byUser breakdown.
    const adminRes = await fetch(`${api.baseUrl}/api/usage/breakdown?scope=org`);
    expect(adminRes.status).toBe(200);
    const body = (await adminRes.json()) as UsageBreakdownResponse;
    expect(body.scope).toBe("org");
    expect(body.byUser?.length).toBe(2); // both users
    expect(body.totalCostUsd).toBeCloseTo(0.006, 6); // both sessions
  });
});

describe("GET /api/usage/sessions", () => {
  it("lists per-session spend and marks child sessions from child_watches", async () => {
    api = await bootTestApi();
    const now = Date.now();
    const db = api.providers.db;
    await db.insert(agentSessions).values([
      { id: "orchestrator:local-user", userId: "local-user", orgId: "local-org", workspace: "/w", status: "active", ownerType: "user", ownerId: "local-user", createdAt: now, updatedAt: now, title: null },
      { id: "sess-child", userId: "local-user", orgId: "local-org", workspace: "/w", status: "active", ownerType: "user", ownerId: "local-user", createdAt: now, updatedAt: now, title: "Child task" },
    ]);
    await seedEngineEntry(api, "e-orch2", "orchestrator:local-user", now);
    await seedEngineEntry(api, "e-child", "sess-child", now);
    // Mark sess-child as a child of the orchestrator.
    await db.execute(sql`
      INSERT INTO child_watches (child_session_id, queue_item_id, parent_session_id, parent_thread_id, actor_user_id, org_id, settled, created_at)
      VALUES ('sess-child', 'q1', 'orchestrator:local-user', 'th', 'local-user', 'local-org', false, ${now})
    `);

    const res = await fetch(`${api.baseUrl}/api/usage/sessions?window=30d`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as UsageSessionsResponse;
    const bySession = Object.fromEntries(body.sessions.map((s) => [s.sessionId, s]));

    expect(bySession["orchestrator:local-user"]?.useCase).toBe("orchestrator");
    expect(bySession["orchestrator:local-user"]?.isChild).toBe(false);
    expect(bySession["sess-child"]?.isChild).toBe(true);
    expect(bySession["sess-child"]?.parentSessionId).toBe("orchestrator:local-user");
    expect(bySession["sess-child"]?.title).toBe("Child task");
  });
});

describe("GET /api/usage/items — symmetric drill-down", () => {
  it("drills workflow → runs and proxy → harness", async () => {
    api = await bootTestApi();
    const now = Date.now();
    const db = api.providers.db;
    // A workflow run owned by local-user.
    await db.execute(sql`INSERT INTO workflow_definitions (id, org_id, owner_type, owner_id, name, definition, created_at, updated_at) VALUES ('wf-x','local-org','user','local-user','Nightly review','{}'::jsonb,${now},${now})`);
    await db.execute(sql`INSERT INTO workflow_runs (id, workflow_id, definition_version_id, definition, params, owner_type, owner_id, created_at, updated_at) VALUES ('run-x','wf-x','v1','{}'::jsonb,'{}'::jsonb,'user','local-user',${now},${now})`);
    await seedEngineEntry(api, "e-wfx", "wf:run-x:node-a", now);
    // A proxy row (codex harness).
    await db.insert(llmProxyRequests).values({
      id: "p-cx", createdAt: now, orgId: "local-org", userId: "local-user", apiKeyId: "k",
      providerKind: "openai", model: "gpt-5", harness: "codex", endpoint: "/v1/responses",
      stream: true, statusCode: 200, requestBody: "{}", inputTokens: 30, outputTokens: 5, totalTokens: 35, costUsd: 0.002,
    });

    const wf = (await (await fetch(`${api.baseUrl}/api/usage/items?useCase=workflow`)).json()) as UsageDrillResponse;
    expect(wf.items.map((i) => i.label)).toContain("Nightly review");
    expect(wf.items[0].id).toBe("run-x");

    const px = (await (await fetch(`${api.baseUrl}/api/usage/items?useCase=proxy`)).json()) as UsageDrillResponse;
    expect(px.items.map((i) => i.label)).toContain("codex");
    expect(px.items.find((i) => i.label === "codex")?.costUsd).toBeCloseTo(0.002, 6);
  });
});

describe("GET /api/usage/export.csv", () => {
  it("exports the caller's rows as CSV with a header and an attachment", async () => {
    api = await bootTestApi();
    const now = Date.now();
    await api.providers.db.insert(agentSessions).values({ id: "s-csv", userId: "local-user", orgId: "local-org", workspace: "/w", status: "active", ownerType: "user", ownerId: "local-user", createdAt: now, updatedAt: now, title: "CSV" });
    await seedEngineEntry(api, "e-csv", "s-csv", now);

    const res = await fetch(`${api.baseUrl}/api/usage/export.csv?window=30d`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(res.headers.get("content-disposition")).toContain("valet-usage-me-30d.csv");
    const text = await res.text();
    const [header, ...rows] = text.trim().split("\n");
    expect(header).toContain("timestamp,use_case,model");
    expect(header).toContain("cost_usd,priced");
    expect(rows.some((r) => r.includes("session"))).toBe(true);
  });
});
