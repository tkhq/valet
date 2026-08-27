/**
 * GET /api/usage/breakdown + /api/usage/sessions — unified spend across all
 * Valet use cases (engine sessions, orchestrator, workflows, proxy), from the
 * single `cost_entries` definition.
 */
import { describe, it, expect, afterEach } from "vitest";
import { sql } from "drizzle-orm";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { agentSessions, llmProxyRequests } from "../schema/index.js";
import type { UsageBreakdownResponse, UsageSessionsResponse } from "../wire/types.js";

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
    // Totals cover all three.
    expect(body.totalCostUsd).toBeCloseTo(0.007, 6);
    expect(body.byModel.length).toBeGreaterThan(0);
    expect(body.byDay.length).toBeGreaterThan(0);
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
