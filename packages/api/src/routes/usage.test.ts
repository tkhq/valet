/**
 * GET /api/usage/breakdown + /api/usage/sessions — unified spend across all
 * Valet use cases (engine sessions, orchestrator, workflows, proxy), from the
 * single `cost_entries` definition.
 */
import { describe, it, expect, afterEach } from "vitest";
import { sql } from "drizzle-orm";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { createUsageTurnExportStream, getUsageBreakdown } from "../services/usage.js";
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
import type { DailyAgentActivityResponse, UsageBreakdownResponse, UsageDrillResponse, UsageOutcomesResponse, UsageSessionsResponse, UsageToolEfficiencyResponse } from "../wire/types.js";

let api: TestApi | undefined;
afterEach(async () => {
  await api?.cleanup();
  api = undefined;
});

const USAGE = JSON.stringify({ input: 100, output: 20, cacheRead: 0, cacheWrite: 0, total: 120 });
const COST = JSON.stringify({ input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 });

async function seedEngineEntry(api: TestApi, id: string, sessionId: string, now: number, queueItemId: string | null = null): Promise<void> {
  await api.providers.db.execute(sql`
    INSERT INTO engine_entries (id, session_id, thread_id, entry_type, role, model, queue_item_id, usage, cost, created_at)
    VALUES (${id}, ${sessionId}, 'th', 'message', 'assistant', 'claude', ${queueItemId}, ${USAGE}::text, ${COST}::text, ${now})
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

    const adminRes = await fetch(`${api.baseUrl}/api/usage/export.csv?window=30d&scope=team&teamId=team-x&granularity=turn`);
    expect(adminRes.status).toBe(200);
    expect(adminRes.headers.get("content-disposition")).toContain("valet-usage-team-team-x-30d-turn.csv");
    const adminText = await adminRes.text();
    expect(adminText).toContain("s-team");
    expect(adminText).not.toContain("s-mine");
    expect(adminText).toContain("local-user");
    expect(adminText).toContain("Local Dev");
    expect(adminText).toContain("local@dev");

    const memberRes = await fetch(`${api.baseUrl}/api/usage/export.csv?window=30d&scope=team&teamId=team-x&granularity=turn`, {
      headers: { "x-valet-test-user-id": "test-member" },
    });
    const memberText = await memberRes.text();
    expect(memberText).toContain("s-team");
    // Per-member attribution follows byUser's admin gate; a plain member's
    // CSV must not carry stable or human member identity.
    expect(memberText).not.toContain("local-user");
    expect(memberText).not.toContain("Local Dev");
    expect(memberText).not.toContain("local@dev");
  });
});

describe("GET /api/usage/tool-efficiency", () => {
  it("separates settled model-directed calls from workflow tool actions and scopes both", async () => {
    api = await bootTestApi();
    const now = Date.now();
    const db = api.providers.db;
    await db.execute(sql`UPDATE orgs SET features = features || '{"organizations": true}'::jsonb`);
    await db.insert(teams).values({ id: "team-1", orgId: "local-org", name: "Tools team", createdAt: now });
    await db.insert(teamMembers).values({ teamId: "team-1", userId: "local-user", role: "member" });
    await db.insert(agentSessions).values([
      { id: "s-tools", userId: "local-user", orgId: "local-org", workspace: "/w", status: "active", ownerType: "user", ownerId: "local-user", createdAt: now, updatedAt: now },
      { id: "s-other", userId: "test-member", orgId: "local-org", workspace: "/w", status: "active", ownerType: "user", ownerId: "test-member", createdAt: now, updatedAt: now },
    ]);
    await db.execute(sql`INSERT INTO workflow_definitions (id, org_id, owner_type, owner_id, name, definition, created_at, updated_at) VALUES ('wf-tools','local-org','user','local-user','Tools','{}'::jsonb,${now},${now})`);
    await db.execute(sql`INSERT INTO workflow_runs (id, workflow_id, definition_version_id, definition, params, owner_type, owner_id, created_at, updated_at) VALUES ('run-tools','wf-tools','v1','{}'::jsonb,'{}'::jsonb,'user','local-user',${now},${now})`);
    await db.execute(sql`INSERT INTO workflow_runs (id, workflow_id, definition_version_id, definition, params, owner_type, owner_id, created_at, updated_at) VALUES ('run-team','wf-tools','v1','{}'::jsonb,'{}'::jsonb,'team','team-1',${now},${now})`);
    const parts = JSON.stringify([
      { type: "tool_call", callId: "c1", toolName: "bash", status: "completed" },
      { type: "tool_call", callId: "c2", toolName: "call_tool", status: "error" },
      { type: "tool_call", callId: "c3", toolName: "bash", status: "running" },
    ]);
    await db.execute(sql`INSERT INTO engine_entries (id, session_id, thread_id, entry_type, role, parts, created_at) VALUES
      ('e-tools','s-tools','th','message','assistant',${parts},${now}),
      ('e-wf-tools','wf:run-tools:node','th','message','assistant',${parts},${now}),
      ('e-team-tools','wf:run-team:node','th','message','assistant',${parts},${now}),
      ('e-other-tools','s-other','th','message','assistant',${parts},${now}),
      ('e-user-tools','s-tools','th','message','user',${parts},${now})`);
    await db.execute(sql`INSERT INTO action_invocations (invocation_id, created_at, org_id, workflow_execution_id, service, action_id, status, duration_ms)
      VALUES ('a-tool',${now},'local-org','run-tools','slack','slack.send_message','completed',10),
             ('a-team',${now},'local-org','run-team','slack','slack.send_message','completed',10),
             ('a-failed',${now},'local-org','run-tools','slack','slack.send_message','error',5),
             ('a-invalid',${now},'local-org','run-tools','slack','slack.send_message','error',NULL),
             ('a-denied',${now},'local-org','run-tools','slack','slack.send_message','denied',NULL),
             ('a-session',${now},'local-org',NULL,'slack','slack.send_message','completed',10)`);
    await db.execute(sql`INSERT INTO action_invocations (invocation_id, created_at, started_at, org_id, workflow_execution_id, service, action_id, status, duration_ms)
      VALUES ('a-approved-late',${now - 8 * 86_400_000},${now},'local-org','run-tools','slack','slack.send_message','completed',10)`);

    const mine = (await (await fetch(`${api.baseUrl}/api/usage/tool-efficiency?window=7d`)).json()) as UsageToolEfficiencyResponse;
    expect(mine.byUseCase.find((r) => r.useCase === "session")).toMatchObject({ modelDirectedCalls: 2, modelFreeActions: 0 });
    expect(mine.byUseCase.find((r) => r.useCase === "workflow")).toMatchObject({ modelDirectedCalls: 2, modelFreeActions: 3 });

    const forbidden = await fetch(`${api.baseUrl}/api/usage/tool-efficiency?window=7d&scope=org`, { headers: { "x-valet-test-user-id": "test-member" } });
    expect(forbidden.status).toBe(403);

    const org = (await (await fetch(`${api.baseUrl}/api/usage/tool-efficiency?window=7d&scope=org`)).json()) as UsageToolEfficiencyResponse;
    expect(org.byUseCase.find((r) => r.useCase === "session")?.modelDirectedCalls).toBe(4);
    expect(org.byUseCase.find((r) => r.useCase === "workflow")?.modelFreeActions).toBe(4);
    const team = (await (await fetch(`${api.baseUrl}/api/usage/tool-efficiency?scope=team&teamId=team-1&window=7d`)).json()) as UsageToolEfficiencyResponse;
    expect(team.scope).toBe("team");
    expect(team.byUseCase.find((r) => r.useCase === "workflow")).toMatchObject({ modelDirectedCalls: 2, modelFreeActions: 1 });
    const missingTeam = await fetch(`${api.baseUrl}/api/usage/tool-efficiency?scope=team`);
    expect(missingTeam.status).toBe(400);
  });
});

describe("GET /api/usage/outcomes", () => {
  it("counts confirmed actions and allocates parent model cost once", async () => {
    api = await bootTestApi();
    const db = api.providers.db;
    const now = Date.now();
    await db.insert(agentSessions).values([
      { id: "outcome-session", userId: "local-user", orgId: "local-org", workspace: "/w", status: "active", ownerType: "user", ownerId: "local-user", createdAt: now, updatedAt: now },
      { id: "idle-session", userId: "local-user", orgId: "local-org", workspace: "/w", status: "active", ownerType: "user", ownerId: "local-user", createdAt: now, updatedAt: now },
    ]);
    await seedEngineEntry(api, "cost-a", "outcome-session", now);
    await seedEngineEntry(api, "cost-b", "outcome-session", now);
    await seedEngineEntry(api, "cost-idle", "idle-session", now);
    await db.execute(sql`INSERT INTO workflow_definitions (id, org_id, owner_type, owner_id, name, definition, created_at, updated_at)
      VALUES ('outcome-wf','local-org','user','local-user','Report','{}'::jsonb,${now},${now})`);
    await db.execute(sql`INSERT INTO workflow_runs (id, workflow_id, definition_version_id, definition, params, owner_type, owner_id, created_at, updated_at)
      VALUES ('outcome-run','outcome-wf','v1','{}'::jsonb,'{}'::jsonb,'user','local-user',${now},${now})`);
    await seedEngineEntry(api, "cost-wf", "wf:outcome-run:node", now);
    const prPart = JSON.stringify([{ type: "tool_call", callId: "pr", toolName: "bash", status: "completed",
      args: { command: "gh pr create --fill" },
      result: { details: { outcome: { kind: "pull_request_created", url: "https://github.com/acme/repo/pull/1" } } } }]);
    await db.execute(sql`INSERT INTO engine_entries (id, session_id, thread_id, entry_type, role, parts, created_at)
      VALUES ('outcome-pr','outcome-session','th','message','assistant',${prPart},${now})`);
    const success = JSON.stringify({ success: true, data: { id: 1 } });
    const slack = JSON.stringify({ success: true, data: { channel: "C123", ts: "1.2" } });
    const failure = JSON.stringify({ success: false, error: "denied" });
    await db.execute(sql`INSERT INTO action_invocations
      (invocation_id, created_at, org_id, session_id, workflow_execution_id, service, action_id, params, result, status, duration_ms)
      VALUES ('review-ok',${now},'local-org','outcome-session',NULL,'github','github.create_review','{"event":"APPROVE"}'::jsonb,${success}::jsonb,'completed',10),
        ('review-pending',${now},'local-org','outcome-session',NULL,'github','github.create_review','{}'::jsonb,${success}::jsonb,'completed',10),
        ('pr-failed',${now},'local-org','outcome-session',NULL,'github','github.create_pull_request','{}'::jsonb,${failure}::jsonb,'completed',10),
        ('slack-ok',${now},'local-org',NULL,'outcome-run','slack','slack.send_message','{}'::jsonb,${slack}::jsonb,'completed',10)`);

    const response = await fetch(`${api.baseUrl}/api/usage/outcomes?window=7d`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as UsageOutcomesResponse;
    expect(body.byOutcome.find((row) => row.kind === "pull_request_created")).toMatchObject({ count: 1, estimatedCostUsd: 0.003 });
    expect(body.byOutcome.find((row) => row.kind === "review_submitted")).toMatchObject({ count: 1, estimatedCostUsd: 0.003 });
    expect(body.byOutcome.find((row) => row.kind === "slack_message_sent")).toMatchObject({ count: 1, estimatedCostUsd: 0.003 });
    expect(body.byOutcome.find((row) => row.kind === "slack_dm_sent")?.count).toBe(0);
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
  function aggregateTotals(csv: string) {
    const [headerLine, ...lines] = csv.trim().split("\n");
    const headers = headerLine.split(",");
    const index = (name: string) => headers.indexOf(name);
    const sum = (name: string) => lines.reduce((total, line) => total + Number(line.split(",")[index(name)]), 0);
    return {
      turns: sum("turns"), unpricedTurns: sum("unpriced_turns"),
      inputTokens: sum("input_tokens"), outputTokens: sum("output_tokens"),
      cacheReadTokens: sum("cache_read_tokens"), cacheWriteTokens: sum("cache_write_tokens"),
      totalTokens: sum("total_tokens"), costUsd: sum("cost_usd"),
    };
  }

  it("defaults to daily aggregates, supports hourly UTC buckets, and rejects invalid granularity", async () => {
    api = await bootTestApi();
    const db = api.providers.db;
    const today = new Date().toISOString().slice(0, 10);
    const midnight = Date.parse(`${today}T00:00:00.000Z`);
    const previousDay = new Date(midnight - 86_400_000).toISOString().slice(0, 10);
    await db.insert(agentSessions).values({
      id: "aggregate-boundary", userId: "local-user", orgId: "local-org", workspace: "/w",
      status: "active", ownerType: "user", ownerId: "local-user", createdAt: midnight - 1, updatedAt: midnight,
    });
    await seedEngineEntry(api, "aggregate-before-day", "aggregate-boundary", midnight - 1);
    await seedEngineEntry(api, "aggregate-before-hour", "aggregate-boundary", midnight + 3_599_999);
    await seedEngineEntry(api, "aggregate-at-hour", "aggregate-boundary", midnight + 3_600_000);
    await db.insert(llmProxyRequests).values({
      id: "aggregate-provider", createdAt: midnight + 3_600_000, orgId: "local-org", userId: "local-user",
      apiKeyId: "provider", providerKind: "anthropic", model: "proxy-model", endpoint: "/v1/messages",
      stream: false, statusCode: 200, requestBody: "{}", totalTokens: 1,
    });

    const daily = await fetch(`${api.baseUrl}/api/usage/export.csv?start=${previousDay}&end=${today}`);
    expect(daily.status).toBe(200);
    expect(daily.headers.get("content-disposition")).toContain("-day.csv");
    const dailyLines = (await daily.text()).trim().split("\n");
    expect(dailyLines[0]).toContain("bucket_start");
    expect(dailyLines).toHaveLength(4);
    expect(dailyLines.some((line) => line.startsWith(new Date(midnight - 86_400_000).toISOString()))).toBe(true);
    expect(dailyLines.some((line) => line.startsWith(new Date(midnight).toISOString()))).toBe(true);
    expect(dailyLines.some((line) => line.includes(",proxy,anthropic,proxy-model,"))).toBe(true);

    const hourly = await fetch(`${api.baseUrl}/api/usage/export.csv?start=${previousDay}&end=${today}&granularity=hour`);
    const hourLines = (await hourly.text()).trim().split("\n");
    expect(hourLines).toHaveLength(5);
    expect(hourLines.some((line) => line.startsWith(new Date(midnight).toISOString()))).toBe(true);
    expect(hourLines.some((line) => line.startsWith(new Date(midnight + 3_600_000).toISOString()))).toBe(true);

    const invalid = await fetch(`${api.baseUrl}/api/usage/export.csv?granularity=week`);
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ error: {
      code: "invalid_granularity", message: "Choose granularity day, hour, or turn.",
    } });
  });

  it("reconciles aggregate totals with breakdown for me, org, and team scopes, including unpriced turns", async () => {
    api = await bootTestApi();
    const db = api.providers.db;
    const now = Date.now();
    await db.execute(sql`UPDATE orgs SET features = features || '{"organizations": true}'::jsonb`);
    await db.insert(teams).values({ id: "aggregate-team", orgId: "local-org", name: "Aggregate", createdAt: now });
    await db.insert(teamMembers).values({ teamId: "aggregate-team", userId: "local-user", role: "admin" });
    await db.insert(agentSessions).values([
      { id: "aggregate-me", userId: "local-user", orgId: "local-org", workspace: "/w", status: "active", ownerType: "user", ownerId: "local-user", createdAt: now, updatedAt: now },
      { id: "aggregate-team-session", userId: "local-user", orgId: "local-org", workspace: "/w", status: "active", ownerType: "team", ownerId: "aggregate-team", createdAt: now, updatedAt: now },
      { id: "aggregate-other", userId: "test-member", orgId: "local-org", workspace: "/w", status: "active", ownerType: "user", ownerId: "test-member", createdAt: now, updatedAt: now },
    ]);
    await seedEngineEntry(api, "aggregate-me-entry", "aggregate-me", now);
    await seedEngineEntry(api, "aggregate-team-entry", "aggregate-team-session", now);
    await seedEngineEntry(api, "aggregate-other-entry", "aggregate-other", now);
    await db.execute(sql`UPDATE engine_entries SET cost = NULL WHERE id = 'aggregate-team-entry'`);

    for (const suffix of ["", "&scope=org", "&scope=team&teamId=aggregate-team"]) {
      const breakdown = await (await fetch(`${api.baseUrl}/api/usage/breakdown?window=30d${suffix}`)).json() as UsageBreakdownResponse;
      const csv = await (await fetch(`${api.baseUrl}/api/usage/export.csv?window=30d${suffix}`)).text();
      expect(aggregateTotals(csv)).toEqual({
        turns: breakdown.totalTurns, unpricedTurns: breakdown.unpricedTurns,
        inputTokens: breakdown.totalInputTokens, outputTokens: breakdown.totalOutputTokens,
        cacheReadTokens: breakdown.totalCacheReadTokens, cacheWriteTokens: breakdown.totalCacheWriteTokens,
        totalTokens: breakdown.totalTokens, costUsd: breakdown.totalCostUsd,
      });
    }
  });

  it("removes user identity from a plain member aggregate group and neutralizes formulas", async () => {
    api = await bootTestApi();
    const db = api.providers.db;
    const now = Date.now();
    await db.insert(teams).values({ id: "private-team", orgId: "local-org", name: "Private", createdAt: now });
    await db.insert(teamMembers).values([
      { teamId: "private-team", userId: "local-user", role: "member" },
      { teamId: "private-team", userId: "test-member", role: "member" },
    ]);
    await db.insert(agentSessions).values([
      { id: "private-a", userId: "local-user", orgId: "local-org", workspace: "/w", status: "active", ownerType: "team", ownerId: "private-team", createdAt: now, updatedAt: now },
      { id: "private-b", userId: "test-member", orgId: "local-org", workspace: "/w", status: "active", ownerType: "team", ownerId: "private-team", createdAt: now, updatedAt: now },
    ]);
    await seedEngineEntry(api, "private-entry-a", "private-a", now);
    await seedEngineEntry(api, "private-entry-b", "private-b", now);
    await db.execute(sql`UPDATE engine_entries SET model = '=formula' WHERE id IN ('private-entry-a', 'private-entry-b')`);

    const headers = { "x-valet-test-user-id": "test-member" };
    const aggregate = await (await fetch(
      `${api.baseUrl}/api/usage/export.csv?scope=team&teamId=private-team`, { headers },
    )).text();
    const lines = aggregate.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("\"'=formula\"");
    expect(lines[1]).not.toContain("local-user");
    expect(lines[1]).not.toContain("test-member");
    expect(lines[1]).toContain(",2,0,200,40,0,0,240,0.006");

    const turn = await (await fetch(
      `${api.baseUrl}/api/usage/export.csv?scope=team&teamId=private-team&granularity=turn`, { headers },
    )).text();
    expect(turn).toContain("\"'=formula\"");
    expect(turn).not.toContain("local-user");
    expect(turn).not.toContain("test-member");
  });

  it("errors the itemized stream instead of closing cleanly when a batch query fails", async () => {
    api = await bootTestApi();
    const db = api.providers.db;
    const stream = createUsageTurnExportStream(db, {
      windowMs: 30 * 24 * 60 * 60 * 1000,
      scope: { scope: "me", orgId: "local-org", userId: "local-user" },
    });
    const originalExecute = db.execute.bind(db);
    db.execute = () => originalExecute(sql`SELECT * FROM injected_usage_export_failure`);
    const reader = stream.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("timestamp");
    await expect(reader.read()).rejects.toThrow("injected_usage_export_failure");
    db.execute = originalExecute;
  });

  it("exports the caller's rows as CSV with a header and an attachment", async () => {
    api = await bootTestApi();
    const now = Date.now();
    await api.providers.db.insert(agentSessions).values({ id: "s-csv", userId: "local-user", orgId: "local-org", workspace: "/w", status: "active", ownerType: "user", ownerId: "local-user", createdAt: now, updatedAt: now, title: "CSV" });
    const formulaModels = ["=1+1", "+SUM(A1)", "-2+3", "@cmd", "\tformula", "\rformula"];
    for (const [index, model] of formulaModels.entries()) {
      const entryId = `e-csv-${index}`;
      await seedEngineEntry(api, entryId, "s-csv", now + index);
      await api.providers.db.execute(sql`UPDATE engine_entries SET model = ${model} WHERE id = ${entryId}`);
    }

    const res = await fetch(`${api.baseUrl}/api/usage/export.csv?window=30d&granularity=turn`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(res.headers.get("content-disposition")).toContain("valet-usage-me-30d-turn.csv");
    const text = await res.text();
    const [header, ...rows] = text.trim().split("\n");
    expect(header).toContain("timestamp,use_case,model");
    expect(header).toContain("cost_usd,priced");
    expect(rows.some((r) => r.includes("session"))).toBe(true);
    for (const model of formulaModels) expect(text).toContain(`,"'${model}",`);
  });

  it("adds current identity and durable work context without dropping or multiplying rows", async () => {
    api = await bootTestApi();
    const now = Date.now();
    const db = api.providers.db;
    await db.execute(sql`UPDATE orgs SET features = features || '{"organizations": true}'::jsonb`);
    await db.execute(sql`UPDATE "user" SET name = '=Finance', email = '+finance@example.com' WHERE id = 'local-user'`);
    await db.insert(agentSessions).values([
      { id: "s-context", userId: "local-user", orgId: "local-org", workspace: "/w", status: "active", ownerType: "user", ownerId: "local-user", createdAt: now, updatedAt: now },
      { id: "s-deleted", userId: "deleted-user", orgId: "local-org", workspace: "/w", status: "active", ownerType: "user", ownerId: "deleted-user", createdAt: now, updatedAt: now },
    ]);
    await db.execute(sql`
      INSERT INTO engine_queue_items (id, session_id, thread_id, status, content, channel,
        attempt_count, max_attempts, timeout_at, created_at, updated_at)
      VALUES ('q-context', 's-context', 'th', 'settled', 'prompt',
              ${JSON.stringify({ channelType: "=slack", channelId: "\tC123" })},
              1, 1, ${now}, ${now - 1}, ${now})
    `);
    await seedEngineEntry(api, "e-context", "s-context", now, "q-context");
    await seedEngineEntry(api, "e-deleted", "s-deleted", now - 1);
    await db.execute(sql`
      INSERT INTO session_repos (session_id, full_name, clone_url, position)
      VALUES ('s-context', '@acme/primary', 'https://example.test/primary', 0),
             ('s-context', 'acme/secondary', 'https://example.test/secondary', 1)
    `);
    await db.insert(llmProxyRequests).values({
      id: "p-shared", createdAt: now - 2, orgId: "local-org", userId: null, teamId: "team-shared", apiKeyId: "shared",
      providerKind: "openai", model: "gpt", endpoint: "/v1/responses", stream: false, statusCode: 200,
      requestBody: "{}", inputTokens: 10, outputTokens: 2, totalTokens: 12, costUsd: 0.01,
    });

    const res = await fetch(`${api.baseUrl}/api/usage/export.csv?scope=org&window=30d&granularity=turn`);
    expect(res.status).toBe(200);
    const lines = (await res.text()).trim().split("\n");
    expect(lines[0]).toBe("timestamp,use_case,model,session_id,workflow_run_id,user_id,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,total_tokens,cost_usd,priced,employee_name,employee_email,repository,channel_type,channel_id");
    expect(lines).toHaveLength(4);
    expect(lines.filter((line) => line.includes("s-context"))).toHaveLength(1);
    const context = lines.find((line) => line.includes("s-context"));
    expect(context).toContain("local-user");
    expect(context).toContain("\"'=Finance\"");
    expect(context).toContain("\"'+finance@example.com\"");
    expect(context).toContain("\"'@acme/primary;acme/secondary\"");
    expect(context).toContain("\"'=slack\"");
    expect(context).toContain("\"'\tC123\"");
    const deleted = lines.find((line) => line.includes("s-deleted"));
    expect(deleted).toContain("deleted-user,100,20,0,0,120,0.003,true,,,,,");
    const shared = lines.find((line) => line.includes("p-shared") || line.includes(",proxy,"));
    expect(shared).toBeDefined();
    expect(shared).toContain(",proxy,gpt,,,,10,2,0,0,12,0.01,true,,,,,");
  });

  it("streams every row over 100,000 without gaps or duplicates at tied timestamps", async () => {
    api = await bootTestApi();
    const now = Date.now();
    await api.providers.db.insert(agentSessions).values({
      id: "s-csv-overflow", userId: "local-user", orgId: "local-org", workspace: "/w",
      status: "active", ownerType: "user", ownerId: "local-user", createdAt: now, updatedAt: now,
    });
    await api.providers.db.execute(sql`
      INSERT INTO engine_entries (id, session_id, thread_id, entry_type, role, model, usage, cost, created_at)
      SELECT 'e-csv-overflow-' || lpad(i::text, 6, '0'), 's-csv-overflow', 'th',
             'message', 'assistant', 'model-' || lpad(i::text, 6, '0'),
             ${USAGE}::text, ${COST}::text, ${now}
      FROM generate_series(1, 100001) AS i
    `);

    const res = await fetch(`${api.baseUrl}/api/usage/export.csv?window=30d&granularity=turn`);
    expect(res.status).toBe(200);
    const lines = (await res.text()).trim().split("\n");
    expect(lines).toHaveLength(100002);
    const models = lines.slice(1).map((line) => line.split(",")[2]);
    expect(new Set(models).size).toBe(100001);
    expect(models[0]).toBe("model-100001");
    expect(models.at(-1)).toBe("model-000001");
  }, 60_000);
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
  // Anchored to the current UTC day, not to a calendar date. Two tests below
  // pass `now` explicitly and are indifferent to where this sits. The third
  // drives the live route, which measures its window from the server's own
  // clock, so a fixed date walks out of that window and the test starts
  // failing on a day nobody changed anything. It was pinned to 2026-09-10 and
  // began failing exactly seven days later, against a seven-day window.
  const midnightUtc = new Date();
  const today = Date.UTC(
    midnightUtc.getUTCFullYear(),
    midnightUtc.getUTCMonth(),
    midnightUtc.getUTCDate(),
  );
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
    expect(week.dailyAgentWindow).toEqual({ days: 7, sinceMs: today - 6 * DAY, untilMs: now + 1, timezone: "UTC" });
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

  it("counts rolling-window unique agents across days and actors with strict scope and time bounds", async () => {
    api = await bootTestApi();
    await seedActivity(api);
    const db = api.providers.db;
    const since = now - 7 * DAY;
    for (const id of ["orchestrator:activity", "at-start", "at-end", "too-old", "future-only", "no-entries"]) {
      await db.insert(agentSessions).values({ id, orgId: "local-org", userId: "local-user", ownerType: "team", ownerId: "activity-team", workspace: "/w", createdAt: since, updatedAt: now });
    }
    for (const [id, at] of [["orchestrator:activity", today], ["at-start", since], ["at-end", now], ["too-old", since - 1], ["future-only", now + 1]] as const) {
      await seedEngineEntry(api, `headline-${id}`, id, at);
    }
    await db.insert(llmProxyRequests).values({ id: "headline-proxy", createdAt: now, orgId: "local-org", teamId: "activity-team", userId: "local-user", apiKeyId: "k", providerKind: "anthropic", model: "claude", endpoint: "/v1/messages", stream: false, statusCode: 200, requestBody: "{}", totalTokens: 100 });
    const scope = { scope: "team", orgId: "local-org", teamId: "activity-team", byMember: true } as const;
    const admin = await getUsageBreakdown(db, { scope, windowMs: 7 * DAY, now });
    // Five existing unique agents (including two workflow nodes), an
    // orchestrator, and the two inclusive boundary sessions. Not agent-days.
    expect(admin.activeAgents).toBe(8);
    const member = await getUsageBreakdown(db, { scope: { ...scope, byMember: false }, windowMs: 7 * DAY, now });
    expect(member.activeAgents).toBe(8);
    expect(member.byUser).toBeUndefined();
    expect(member.dailyAgentWindow).toBeUndefined();
    const org = await getUsageBreakdown(db, { scope: { scope: "org", orgId: "local-org" }, windowMs: 7 * DAY, now });
    expect(org.activeAgents).toBe(10); // plus the other team and personal session, never the foreign org
    const personal = await getUsageBreakdown(db, { scope: { scope: "me", orgId: "local-org", userId: "test-member" }, windowMs: 7 * DAY, now });
    expect(personal.activeAgents).toBe(2); // existing personal usage attribution, not prompt-author counts
    const empty = await getUsageBreakdown(db, { scope, windowMs: DAY, now: since - 20 * DAY });
    expect(empty.activeAgents).toBe(0);
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
    expect(memberBody.activeAgents).toBe(body.activeAgents);
    expect(memberBody.activeAgents).toBeGreaterThan(0);
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

describe("GET /api/usage custom periods", () => {
  it("uses one inclusive UTC date range for personal, org, team, and CSV reads", async () => {
    api = await bootTestApi();
    const db = api.providers.db;
    const today = new Date().toISOString().slice(0, 10);
    const startMs = Date.parse(`${today}T00:00:00.000Z`);
    await db.execute(sql`UPDATE orgs SET features = features || '{"organizations": true}'::jsonb`);
    await db.insert(teams).values({ id: "period-team", orgId: "local-org", name: "Period", createdAt: startMs });
    await db.insert(teamMembers).values({ teamId: "period-team", userId: "local-user", role: "admin" });
    await db.insert(agentSessions).values([
      { id: "period-personal", userId: "local-user", orgId: "local-org", workspace: "/w", status: "active", ownerType: "user", ownerId: "local-user", createdAt: startMs, updatedAt: startMs, title: "Personal" },
      { id: "period-team-session", userId: "local-user", orgId: "local-org", workspace: "/w", status: "active", ownerType: "team", ownerId: "period-team", createdAt: startMs, updatedAt: startMs, title: "Team" },
    ]);
    await seedEngineEntry(api, "period-in-personal", "period-personal", startMs);
    await seedEngineEntry(api, "period-in-team", "period-team-session", startMs + 1);
    await seedEngineEntry(api, "period-end-exclusive", "period-personal", startMs + 86_400_000);

    const dates = `start=${today}&end=${today}`;
    const personal = await (await fetch(`${api.baseUrl}/api/usage/breakdown?${dates}`)).json() as UsageBreakdownResponse;
    const org = await (await fetch(`${api.baseUrl}/api/usage/breakdown?${dates}&scope=org`)).json() as UsageBreakdownResponse;
    const team = await (await fetch(`${api.baseUrl}/api/usage/breakdown?${dates}&scope=team&teamId=period-team`)).json() as UsageBreakdownResponse;
    expect(personal.totalTurns).toBe(2);
    expect(org.totalTurns).toBe(2);
    expect(team.totalTurns).toBe(1);

    const csv = await (await fetch(`${api.baseUrl}/api/usage/export.csv?${dates}&granularity=turn`)).text();
    expect(csv).toContain("period-personal");
    expect(csv.match(/period-personal/g)).toHaveLength(1);
  });

  it("returns typed errors for invalid ranges", async () => {
    api = await bootTestApi();
    const res = await fetch(`${api.baseUrl}/api/usage/breakdown?start=2024-02-02&end=2024-02-01`);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: { code: "reversed_range", message: "Choose an end date on or after the start date." },
    });
  });
});
