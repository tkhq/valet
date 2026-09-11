/**
 * GET /api/usage/breakdown + /api/usage/sessions — unified spend across all
 * Valet use cases (engine sessions, orchestrator, workflows, proxy), from the
 * single `cost_entries` definition.
 */
import { describe, it, expect, afterEach } from "vitest";
import { sql } from "drizzle-orm";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { getUsageBreakdown } from "../services/usage.js";
import {
  agentSessions,
  assistants,
  childWatches,
  workflowDefinitions,
  llmProxyRequests,
  skillContextAttributions,
  skillInvocations,
  teams,
  teamMembers,
} from "../schema/index.js";
import type { DailyAgentActivityResponse, UsageBreakdownResponse, UsageDrillResponse, UsageSessionsResponse } from "../wire/types.js";

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

  it("aggregates skill adoption, actorless use, revisions, and carried tokens", async () => {
    api = await bootTestApi();
    const now = Date.now();
    const db = api.providers.db;
    await db.insert(agentSessions).values({
      id: "skill-session", userId: "local-user", orgId: "local-org", workspace: "/w",
      status: "active", ownerType: "user", ownerId: "local-user",
      createdAt: now, updatedAt: now, title: "Skills",
    });
    await db.insert(skillInvocations).values([
      {
        id: "ski-1", createdAt: now, orgId: "local-org", sessionId: "skill-session",
        threadId: "th", invokerUserId: "local-user", invocationEntryId: null,
        path: "slash_context", skillKey: "stored:skill-1", skillName: "review",
        storedSkillId: "skill-1", pluginName: null, origin: "local", contentSha: "sha-a",
        injectedCharacters: 40, estimatedBodyTokens: 10,
      },
      {
        id: "ski-2", createdAt: now + 1, orgId: "local-org", sessionId: "skill-session",
        threadId: "th", invokerUserId: null, invocationEntryId: null,
        path: "model_tool", skillKey: "stored:skill-1", skillName: "review",
        storedSkillId: "skill-1", pluginName: null, origin: "local", contentSha: "sha-b",
        injectedCharacters: 80, estimatedBodyTokens: 20,
      },
      {
        id: "ski-old", createdAt: now - 31 * 24 * 60 * 60 * 1000,
        orgId: "local-org", sessionId: "skill-session", threadId: "th",
        invokerUserId: "old-user", invocationEntryId: null, path: "slash_prompt",
        skillKey: "stored:skill-1", skillName: "review", storedSkillId: "skill-1",
        pluginName: null, origin: "local", contentSha: "sha-old",
        injectedCharacters: 20, estimatedBodyTokens: 5,
      },
    ]);
    await db.insert(skillContextAttributions).values([
      { skillInvocationId: "ski-1", llmRequestId: "req-1", sessionId: "skill-session", threadId: "th", createdAt: now, estimatedSkillTokens: 10 },
      { skillInvocationId: "ski-1", llmRequestId: "req-2", sessionId: "skill-session", threadId: "th", createdAt: now, estimatedSkillTokens: 10 },
      { skillInvocationId: "ski-2", llmRequestId: "req-2", sessionId: "skill-session", threadId: "th", createdAt: now, estimatedSkillTokens: 20 },
      { skillInvocationId: "ski-old", llmRequestId: "req-3", sessionId: "skill-session", threadId: "th", createdAt: now, estimatedSkillTokens: 5 },
    ]);

    const res = await fetch(api.baseUrl + "/api/usage/breakdown?window=30d");
    const body = (await res.json()) as UsageBreakdownResponse;
    expect(res.status).toBe(200);
    expect(body.skillBreakdown).toEqual([
      {
        skillKey: "stored:skill-1", name: "review", origin: "local",
        invocations: 2, uniqueInvokers: 1, unassignedInvocations: 1,
        attributedContextTokens: 45, carryingCalls: 3,
      },
    ]);
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

describe("GET /api/usage — scope=team", () => {
  /** A team with `local-user` as its one member, plus one team-owned and one
   * personal session, each with one billable turn. */
  async function seedTeamSpend(api: TestApi, now: number): Promise<void> {
    const db = api.providers.db;
    await db.insert(teams).values({ id: "team-x", orgId: "local-org", name: "Platform", createdAt: now });
    await db.insert(teamMembers).values({ teamId: "team-x", userId: "local-user", role: "member" });
    await db.insert(agentSessions).values([
      { id: "s-team", userId: "local-user", orgId: "local-org", workspace: "/w", status: "active", ownerType: "team", ownerId: "team-x", createdAt: now, updatedAt: now, title: "Team chat" },
      { id: "s-mine", userId: "local-user", orgId: "local-org", workspace: "/w", status: "active", ownerType: "user", ownerId: "local-user", createdAt: now, updatedAt: now, title: "My chat" },
    ]);
    await seedEngineEntry(api, "e-team", "s-team", now);
    await seedEngineEntry(api, "e-mine", "s-mine", now);
    await db.insert(skillInvocations).values([
      {
        id: "ski-team", createdAt: now, orgId: "local-org", sessionId: "s-team",
        threadId: "th", invokerUserId: "local-user", invocationEntryId: null,
        path: "slash_context", skillKey: "plugin:github:github", skillName: "github",
        storedSkillId: null, pluginName: "github", origin: "plugin", contentSha: "sha-team",
        injectedCharacters: 40, estimatedBodyTokens: 10,
      },
      {
        id: "ski-mine", createdAt: now, orgId: "local-org", sessionId: "s-mine",
        threadId: "th", invokerUserId: "local-user", invocationEntryId: null,
        path: "slash_context", skillKey: "stored:mine", skillName: "mine",
        storedSkillId: "mine", pluginName: null, origin: "local", contentSha: "sha-mine",
        injectedCharacters: 40, estimatedBodyTokens: 10,
      },
    ]);
  }

  it("breakdown covers the team's owned spend only; non-member 404s; missing teamId 400s", async () => {
    api = await bootTestApi();
    const now = Date.now();
    await seedTeamSpend(api, now);

    const res = await fetch(`${api.baseUrl}/api/usage/breakdown?scope=team&teamId=team-x`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as UsageBreakdownResponse;
    expect(body.scope).toBe("team");
    expect(body.totalTurns).toBe(1); // s-team only, not s-mine
    expect(body.totalCostUsd).toBeCloseTo(0.003, 6);
    expect(body.skillBreakdown.map((row) => row.skillKey)).toEqual(["plugin:github:github"]);

    // A non-member gets 404, not 403 — a team you are not on must be
    // indistinguishable from one that does not exist (the sessions/teams
    // routes' existence-hiding convention).
    const nonMember = await fetch(`${api.baseUrl}/api/usage/breakdown?scope=team&teamId=team-x`, { headers: { "x-valet-test-user-id": "test-member" } });
    expect(nonMember.status).toBe(404);

    // scope=team without a teamId is a request error, not a permission error.
    const missing = await fetch(`${api.baseUrl}/api/usage/breakdown?scope=team`);
    expect(missing.status).toBe(400);
  });

  it("answers a foreign org's teamId and an unknown teamId with the same 404", async () => {
    api = await bootTestApi();
    const now = Date.now();
    const db = api.providers.db;
    // A team in ANOTHER org that (pathologically) lists local-user as a
    // member — the org-ownership check must refuse it before membership.
    await db.execute(sql`INSERT INTO orgs (id, name, created_at) VALUES ('other-org', 'Other', ${now})`);
    await db.insert(teams).values({ id: "team-foreign", orgId: "other-org", name: "Foreign", createdAt: now });
    await db.insert(teamMembers).values({ teamId: "team-foreign", userId: "local-user", role: "member" });

    const foreign = await fetch(`${api.baseUrl}/api/usage/breakdown?scope=team&teamId=team-foreign`);
    expect(foreign.status).toBe(404);

    const unknown = await fetch(`${api.baseUrl}/api/usage/breakdown?scope=team&teamId=no-such-team`);
    expect(unknown.status).toBe(404);

    // Same body for both — the response must not reveal which case it was.
    expect(await foreign.json()).toEqual(await unknown.json());
  });

  it("drill-down includes team proxy spend without personal, other-team, or foreign-org rows", async () => {
    api = await bootTestApi();
    const now = Date.now();
    await seedTeamSpend(api, now);
    // A personal proxy row — must NOT leak into the team scope.
    await api.providers.db.insert(llmProxyRequests).values({
      id: "p-t", createdAt: now, orgId: "local-org", userId: "local-user", apiKeyId: "k",
      providerKind: "anthropic", model: "claude", harness: "claude-code", endpoint: "/v1/messages",
      stream: false, statusCode: 200, requestBody: "{}", inputTokens: 50, outputTokens: 10, totalTokens: 60, costUsd: 0.001,
    });

    const proxyBase = {
      createdAt: now, userId: null, apiKeyId: "shared", providerKind: "openai" as const,
      model: "gpt-4o-mini", endpoint: "/v1/responses", stream: false, statusCode: 200,
      requestBody: "{}", inputTokens: 100, outputTokens: 20, totalTokens: 120, costUsd: 0.5,
    };
    await api.providers.db.insert(llmProxyRequests).values([
      { ...proxyBase, id: "team-proxy", orgId: "local-org", teamId: "team-x", harness: "codex" },
      { ...proxyBase, id: "other-team-proxy", orgId: "local-org", teamId: "team-y", harness: "other-team" },
      { ...proxyBase, id: "foreign-proxy", orgId: "other-org", teamId: "team-x", harness: "foreign-org" },
    ]);
    const sess = (await (await fetch(`${api.baseUrl}/api/usage/items?useCase=session&scope=team&teamId=team-x`)).json()) as UsageDrillResponse;
    expect(sess.items.map((i) => i.sessionId)).toEqual(["s-team"]);

    const px = (await (await fetch(`${api.baseUrl}/api/usage/items?useCase=proxy&scope=team&teamId=team-x`)).json()) as UsageDrillResponse;
    expect(px.items).toEqual([expect.objectContaining({ id: "codex", turns: 1, totalTokens: 120, costUsd: 0.5 })]);
    const rejected = await fetch(`${api.baseUrl}/api/usage/items?useCase=proxy&scope=team&teamId=team-x`, {
      headers: { "x-valet-test-user-id": "test-member" },
    });
    expect(rejected.status).toBe(404);
  });

  it("CSV export carries the team's rows only, names the team in the filename, and withholds user_id from a plain member", async () => {
    api = await bootTestApi();
    const now = Date.now();
    await seedTeamSpend(api, now);
    // local-user is an org admin in the stub, so THEIR export keeps
    // attribution (byMember). The withhold arm needs a plain member.
    await api.providers.db
      .insert(teamMembers)
      .values({ teamId: "team-x", userId: "test-member", role: "member" });

    const adminRes = await fetch(`${api.baseUrl}/api/usage/export.csv?window=30d&scope=team&teamId=team-x`);
    expect(adminRes.status).toBe(200);
    expect(adminRes.headers.get("content-disposition")).toContain("valet-usage-team-team-x-30d.csv");
    const adminText = await adminRes.text();
    expect(adminText).toContain("s-team");
    expect(adminText).not.toContain("s-mine");
    expect(adminText).toContain("local-user");

    const memberRes = await fetch(`${api.baseUrl}/api/usage/export.csv?window=30d&scope=team&teamId=team-x`, {
      headers: { "x-valet-test-user-id": "test-member" },
    });
    const memberText = await memberRes.text();
    expect(memberText).toContain("s-team");
    // Per-member attribution follows byUser's admin gate; a plain member's
    // CSV must not carry it.
    expect(memberText).not.toContain("local-user");
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

describe("GET /api/usage/summary", () => {
  it("returns the caller's day/week/month windows from cost_entries", async () => {
    api = await bootTestApi();
    const now = Date.now();
    await api.providers.db.insert(agentSessions).values({ id: "s-sum", userId: "local-user", orgId: "local-org", workspace: "/w", status: "active", ownerType: "user", ownerId: "local-user", createdAt: now, updatedAt: now, title: "Sum" });
    await seedEngineEntry(api, "e-sum", "s-sum", now);
    const res = await fetch(`${api.baseUrl}/api/usage/summary`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { me: { day: { costUsd: number; totalTokens: number } } };
    expect(body.me.day.costUsd).toBeCloseTo(0.003, 6);
    expect(body.me.day.totalTokens).toBe(120);
  });
});

describe("GET /api/usage/daily-agents", () => {
  it("counts distinct active sessions per UTC day and team, including children", async () => {
    api = await bootTestApi();
    const db = api.providers.db;
    const day = Math.floor(Date.now() / 86_400_000) * 86_400_000;
    const yesterday = day - 86_400_000;
    await db.execute(sql`UPDATE orgs SET features = features || '{"organizations": true}'::jsonb`);
    await db.insert(teams).values([
      { id: "activity-a", orgId: "local-org", name: "Activity A", createdAt: day },
      { id: "activity-b", orgId: "local-org", name: "Activity B", createdAt: day },
    ]);
    await db.insert(teamMembers).values({ teamId: "activity-a", userId: "local-user", role: "member" });
    await db.insert(agentSessions).values([
      ...["assistant:activity", "activity-child", "activity-idle"].map((id) => ({
        id, userId: "local-user", orgId: "local-org", workspace: "/w", status: "active" as const,
        ownerType: "team" as const, ownerId: "activity-a", createdAt: yesterday, updatedAt: day,
      })),
      { id: "activity-other", userId: "local-user", orgId: "local-org", workspace: "/w", status: "active", ownerType: "team", ownerId: "activity-b", createdAt: yesterday, updatedAt: day },
      { id: "orchestrator:activity", userId: "local-user", orgId: "local-org", workspace: "/w", status: "active", ownerType: "user", ownerId: "local-user", createdAt: yesterday, updatedAt: day },
      { id: "activity-foreign", userId: "local-user", orgId: "other-org", workspace: "/w", status: "active", ownerType: "user", ownerId: "local-user", createdAt: yesterday, updatedAt: day },
    ]);
    await db.insert(assistants).values({ id: "activity", orgId: "local-org", ownerType: "team", ownerId: "activity-a", sessionId: "assistant:activity", createdAt: yesterday });
    await db.insert(childWatches).values({ childSessionId: "activity-child", queueItemId: "activity-q", parentSessionId: "assistant:activity", parentThreadId: "th", actorUserId: "local-user", orgId: "local-org", createdAt: yesterday });
    for (const [id, session, at] of [
      ["activity-1", "assistant:activity", yesterday],
      ["activity-2", "assistant:activity", day - 1],
      ["activity-3", "assistant:activity", day],
      ["activity-4", "activity-child", day],
      ["activity-5", "activity-child", day],
      ["activity-6", "activity-other", day],
      ["activity-7", "orchestrator:activity", day],
      ["activity-8", "activity-foreign", day],
    ] satisfies Array<[string, string, number]>) await seedEngineEntry(api, id, session, at);
    // Unpriced usage still counts; a zero-token assistant message does not.
    await db.execute(sql`UPDATE engine_entries SET cost = NULL WHERE id = 'activity-4'`);
    await seedEngineEntry(api, "activity-zero", "activity-idle", day);
    await db.execute(sql`UPDATE engine_entries SET usage = '{"total":0}' WHERE id = 'activity-zero'`);
    await db.insert(workflowDefinitions).values({ id: "activity-workflow", orgId: "local-org", ownerType: "team", ownerId: "activity-a", name: "Activity workflow", definition: {}, createdAt: day, updatedAt: day });
    await api.providers.workflowStore.createRun("activity-run", { workflowId: "activity-workflow", definitionVersionId: "v1" },
      { version: "dag/v1", nodes: [], edges: [] }, "v1", { ownerType: "team", ownerId: "activity-a" });
    await seedEngineEntry(api, "activity-wf1", "wf:activity-run:node", day);
    await seedEngineEntry(api, "activity-wf2", "wf:activity-run:node", day);
    await seedEngineEntry(api, "activity-wf3", "wf:activity-run:node:1", day);
    const res = await fetch(`${api.baseUrl}/api/usage/daily-agents?scope=org&window=7d`);
    expect(res.status).toBe(200);
    const body = await res.json() as DailyAgentActivityResponse;
    expect(body.timezone).toBe("UTC");
    expect(body.days).toEqual([
      { dayMs: yesterday, teamId: "activity-a", teamName: "Activity A", kind: "assistant", activeAgents: 1 },
      { dayMs: day, teamId: null, teamName: null, kind: "assistant", activeAgents: 1 },
      { dayMs: day, teamId: "activity-a", teamName: "Activity A", kind: "assistant", activeAgents: 1 },
      { dayMs: day, teamId: "activity-a", teamName: "Activity A", kind: "child", activeAgents: 1 },
      { dayMs: day, teamId: "activity-a", teamName: "Activity A", kind: "workflow", activeAgents: 2 },
      { dayMs: day, teamId: "activity-b", teamName: "Activity B", kind: "session", activeAgents: 1 },
    ]);
    const teamRes = await fetch(`${api.baseUrl}/api/usage/daily-agents?scope=team&teamId=activity-a&window=24h`);
    const teamBody = await teamRes.json() as DailyAgentActivityResponse;
    expect(teamBody.days).toEqual(body.days.filter((r) => r.dayMs === day && r.teamId === "activity-a"));
    expect((await fetch(`${api.baseUrl}/api/usage/daily-agents?scope=team&teamId=activity-b`)).status).toBe(404);
    expect((await fetch(`${api.baseUrl}/api/usage/daily-agents?scope=org`, { headers: { "x-valet-test-user-id": "test-member" } })).status).toBe(403);
  });
});

// Member activity deliberately differs from billing attribution for shared agents.
describe("GET /api/usage/breakdown — team daily active agents", () => {
  const DAY = 86_400_000;
  const today = Date.UTC(2026, 8, 10);
  const now = today + 12 * 60 * 60 * 1000;

  async function seedActivity(testApi: TestApi) {
    const db = testApi.providers.db;
    await db.insert(teams).values([
      { id: "activity-team", orgId: "local-org", name: "Activity", createdAt: today },
      { id: "activity-other-team", orgId: "local-org", name: "Other", createdAt: today },
    ]);
    await db.insert(teamMembers).values([
      { teamId: "activity-team", userId: "local-user", role: "admin" },
      { teamId: "activity-team", userId: "test-member", role: "member" },
    ]);
    await db.insert(agentSessions).values([
      ...["activity-assistant", "activity-child", "activity-idle", "activity-legacy"].map((id) => ({
        id, userId: "local-user", orgId: "local-org", workspace: "/w", status: "active" as const,
        ownerType: "team" as const, ownerId: "activity-team", createdAt: today - 10 * DAY, updatedAt: today,
      })),
      { id: "activity-other", userId: "test-member", orgId: "local-org", workspace: "/w", status: "active", ownerType: "team", ownerId: "activity-other-team", createdAt: today, updatedAt: today },
      { id: "activity-personal", userId: "test-member", orgId: "local-org", workspace: "/w", status: "active", ownerType: "user", ownerId: "test-member", createdAt: today, updatedAt: today },
      { id: "activity-foreign", userId: "test-member", orgId: "other-org", workspace: "/w", status: "active", ownerType: "team", ownerId: "activity-team", createdAt: today, updatedAt: today },
    ]);
    await db.insert(assistants).values({ id: "activity", orgId: "local-org", ownerType: "team", ownerId: "activity-team", sessionId: "activity-assistant", createdAt: today });
    await db.insert(childWatches).values({ childSessionId: "activity-child", queueItemId: "child-q", parentSessionId: "activity-assistant", parentThreadId: "th", actorUserId: "test-member", orgId: "local-org", createdAt: today });
    await db.insert(workflowDefinitions).values({ id: "activity-wf", orgId: "local-org", ownerType: "team", ownerId: "activity-team", name: "Workflow", definition: {}, createdAt: today, updatedAt: today });
    await testApi.providers.workflowStore.createRun("activity-run", { workflowId: "activity-wf", definitionVersionId: "v1" },
      { version: "dag/v1", nodes: [], edges: [] }, "v1", { ownerType: "team", ownerId: "activity-team" });

    async function entry(id: string, session: string, at: number, actor?: string, thread = "th") {
      await seedEngineEntry(testApi, id, session, at);
      await db.execute(sql`UPDATE engine_entries SET thread_id = ${thread} WHERE id = ${id}`);
      if (actor) {
        const queueId = `q-${id}`;
        await db.execute(sql`
          INSERT INTO engine_queue_items (id, session_id, thread_id, status, content, author,
            attempt_count, max_attempts, timeout_at, created_at, updated_at)
          VALUES (${queueId}, ${session}, ${thread}, 'settled', 'prompt', ${JSON.stringify({ id: actor })}, 1, 1, ${now}, ${at}, ${at})
        `);
        await db.execute(sql`UPDATE engine_entries SET queue_item_id = ${queueId} WHERE id = ${id}`);
      }
    }
    await entry("a-first", "activity-assistant", today - 6 * DAY, "test-member");
    await entry("a-too-old", "activity-assistant", today - 6 * DAY - 1, "test-member");
    await entry("a-yesterday", "activity-assistant", today - 1, "test-member");
    await entry("a-today", "activity-assistant", today, "test-member");
    await entry("a-repeat-thread", "activity-assistant", today + 1, "test-member", "other-thread");
    await entry("a-second-member", "activity-assistant", today + 2, "local-user");
    await entry("a-unattributed", "activity-assistant", today + 3);
    await entry("a-future", "activity-assistant", now + 1, "future-actor");
    await entry("child-1", "activity-child", today);
    await entry("child-2", "activity-child", today + 1);
    await entry("wf-1", "wf:activity-run:node", today);
    await entry("wf-2", "wf:activity-run:node", today + 1);
    await entry("wf-iteration", "wf:activity-run:node:1", today);
    await entry("legacy", "activity-legacy", today);
    await entry("idle", "activity-idle", today);
    await db.execute(sql`UPDATE engine_entries SET usage = '{"total":0}' WHERE id = 'idle'`);
    await db.execute(sql`UPDATE engine_entries SET cost = NULL WHERE id IN ('child-1', 'child-2')`);
    for (const session of ["activity-other", "activity-personal", "activity-foreign"]) await entry(session, session, today, "test-member");
    await db.insert(llmProxyRequests).values({ id: "activity-proxy", createdAt: today, orgId: "local-org", userId: "test-member", apiKeyId: "k", providerKind: "anthropic", model: "claude", endpoint: "/v1/messages", stream: false, statusCode: 200, requestBody: "{}", totalTokens: 100 });
  }

  it("deduplicates session-days, attributes shared assistants to prompt actors, and includes children and workflow iterations", async () => {
    api = await bootTestApi();
    await seedActivity(api);
    const scope = { scope: "team", orgId: "local-org", teamId: "activity-team", byMember: true } as const;
    const week = await getUsageBreakdown(api.providers.db, { scope, windowMs: 7 * DAY, now });
    expect(week.dailyAgentWindow).toEqual({ days: 7, sinceMs: today - 6 * DAY, untilMs: now, timezone: "UTC" });
    const members = new Map(week.byUser?.map((r) => [r.userId, r]));
    // Assistant on three days plus the child today; not turns or range uniques.
    expect(members.get("test-member")?.avgDailyActiveAgents).toBeCloseTo(4 / 7);
    expect(members.get("test-member")?.turns).toBe(0); // actor differs from billed user
    expect(members.get("local-user")?.avgDailyActiveAgents).toBeCloseTo(2 / 7);
    expect(members.get("shared")?.avgDailyActiveAgents).toBeCloseTo(3 / 7);
    expect(members.has("future-actor")).toBe(false);
    expect(members.size).toBe(3);
    const day = await getUsageBreakdown(api.providers.db, { scope, windowMs: DAY, now });
    expect(day.byUser?.find((r) => r.userId === "test-member")?.avgDailyActiveAgents).toBe(2);
    const midnight = await getUsageBreakdown(api.providers.db, { scope, windowMs: DAY, now: today });
    expect(midnight.dailyAgentWindow?.sinceMs).toBe(today);
    expect(midnight.byUser?.find((r) => r.userId === "test-member")?.avgDailyActiveAgents).toBe(2);
    const empty = await getUsageBreakdown(api.providers.db, { scope, windowMs: DAY, now: today - 20 * DAY });
    expect(empty.byUser?.every((r) => r.avgDailyActiveAgents === 0)).toBe(true);
  });

  it("returns the metric only to team administrators and enforces team/org isolation", async () => {
    api = await bootTestApi();
    await seedActivity(api);
    const url = `${api.baseUrl}/api/usage/breakdown?scope=team&teamId=activity-team&window=7d`;
    const admin = await fetch(url);
    expect(admin.status).toBe(200);
    // Route responses use the same wire contract as the other tests in this file.
    const body = await admin.json() as UsageBreakdownResponse;
    expect(body.dailyAgentWindow?.days).toBe(7);
    expect(body.byUser?.every((r) => typeof r.avgDailyActiveAgents === "number")).toBe(true);
    const member = await fetch(url, { headers: { "x-valet-test-user-id": "test-member" } });
    expect(member.status).toBe(200);
    const memberBody = await member.json() as UsageBreakdownResponse;
    expect(memberBody.byUser).toBeUndefined();
    expect(memberBody.dailyAgentWindow).toBeUndefined();
    expect((await fetch(url.replace("activity-team", "activity-other-team"))).status).toBe(404);
    await api.providers.db.insert(teams).values({ id: "activity-foreign-team", orgId: "other-org", name: "Foreign", createdAt: today });
    await api.providers.db.insert(teamMembers).values({ teamId: "activity-foreign-team", userId: "local-user", role: "admin" });
    expect((await fetch(url.replace("activity-team", "activity-foreign-team"))).status).toBe(404);
    const personal = await (await fetch(`${api.baseUrl}/api/usage/breakdown?scope=me`)).json() as UsageBreakdownResponse;
    expect(personal.dailyAgentWindow).toBeUndefined();
  });
});
