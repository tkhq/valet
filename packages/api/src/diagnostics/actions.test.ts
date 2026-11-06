import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reportError, resetErrorReports, type PluginActionContext, type PluginActionResult } from "@valet/engine";
import type { AppDb } from "../lib/drizzle.js";
import { freshTestPgDb } from "../test-helpers/pg-test-db.js";
import { agentSessions, externalCalls, orgMembers, orgs, tagKeys, tagLabels, tagSubjects, teamMembers, teams, users } from "../schema/index.js";
import { recordRequestTiming, resetRequestTimings } from "../observability/request-timings.js";
import { PgCredentialStore } from "../plugins/credential-store.js";
import { deriveSecretKey } from "../lib/secret-crypto.js";
import { diagnosticsActionPlugin, type DiagnosticsInfra } from "./actions.js";
import type { PodHealthApi } from "./pod-health.js";
import { seedRegistry } from "../tagging/registry.js";
import { sessionOutcomeDimension } from "../tagging/session-outcome.js";

const ORG = "diagnostics-org";
const OTHER_ORG = "other-org";

function context(userId: string, overrides: Partial<PluginActionContext> = {}): PluginActionContext {
  return { userId, orgId: ORG, actionId: "diagnostics.list_tool_failures", service: "diagnostics", owner: { type: "user", id: userId }, ...overrides } as PluginActionContext;
}

function data(result: { data?: unknown }): Record<string, unknown> {
  return typeof result.data === "object" && result.data !== null ? result.data as Record<string, unknown> : {};
}

describe("diagnosticsActionPlugin", () => {
  let db: AppDb;
  type Run = (args: Record<string, never>, ctx: PluginActionContext) => Promise<PluginActionResult>;
  let execute: { failures: Run; slow: Run };
  let plugin: (infra?: DiagnosticsInfra) => (id: string) => Run;

  beforeEach(async () => {
    const fresh = await freshTestPgDb();
    db = fresh.appDb;
    await db.insert(orgs).values([{ id: ORG, name: "Diagnostics", createdAt: Date.now() }, { id: OTHER_ORG, name: "Other", createdAt: Date.now() }]);
    // "admin" is a deployment operator (users.role) and an org admin; "org-admin" is an org admin only.
    await db.insert(users).values([
      { id: "admin", email: "admin@example.test", name: "Admin", role: "admin" },
      { id: "org-admin", email: "org-admin@example.test", name: "Org Admin", role: "member" },
      { id: "member", email: "member@example.test", name: "Member", role: "member" },
      { id: "other-admin", email: "other-admin@example.test", name: "Other Admin", role: "member" },
    ]);
    await db.insert(orgMembers).values([
      { orgId: ORG, userId: "admin", role: "admin" }, { orgId: ORG, userId: "org-admin", role: "admin" },
      { orgId: ORG, userId: "member", role: "member" }, { orgId: OTHER_ORG, userId: "other-admin", role: "admin" },
    ]);
    const now = Date.now();
    await fresh.pgdb.query(`INSERT INTO engine_entries (id, session_id, thread_id, entry_type, role, parts, created_at)
      VALUES ('entry-1', 's-admin', 't-admin', 'message', 'assistant', $1, $2)`, [JSON.stringify([{ type: "tool_call", callId: "call-1", toolName: "call_tool",
        status: "completed", args: { tool_id: "google_calendar.list_events" },
        result: { content: [{ type: "text", text: "unknown tool_id: \"google_calendar.list_events\". Use list_tools to find available actions." }] } }]), now]);
    const call = { orgId: ORG, surface: "hosted" as const, ownerType: "user" as const, durationMs: 5, createdAt: now };
    await db.insert(externalCalls).values([
      { ...call, id: "s-admin:call-1", userId: "admin", ownerId: "admin", sessionId: "s-admin", threadId: "t-admin", name: "google_calendar.list_events", outcome: "error", errorCode: "unknown" },
      { ...call, id: "s-admin:call-2", userId: "admin", ownerId: "admin", sessionId: "s-admin", threadId: "t-admin", name: "calendar.list_events", outcome: "ok" },
      { ...call, id: "s-member:call-3", userId: "member", ownerId: "member", sessionId: "s-member", threadId: "t-member", name: "github.read_repo_file", outcome: "error", errorCode: "action_failed" },
    ]);
    const engineCredentials = new PgCredentialStore(fresh.pgdb, deriveSecretKey("test-key"));
    plugin = (infra) => (id) => {
      const found = diagnosticsActionPlugin(db, () => ({ engineCredentials }), infra).actions.find((candidate) => candidate.id === id);
      if (!found) throw new Error(`Missing ${id}`);
      return (args, ctx) => found.execute(args, ctx);
    };
    const [failures, slow] = diagnosticsActionPlugin(db, () => ({ engineCredentials })).actions;
    if (!failures || !slow) throw new Error("Missing diagnostics actions");
    execute = { failures: (args, ctx) => failures.execute(args, ctx), slow: (args, ctx) => slow.execute(args, ctx) };
  });
  afterEach(() => {
    resetRequestTimings();
    resetErrorReports();
  });

  it("gives an admin the organization's failures and error text only from their own conversations", async () => {
    const result = await execute.failures({}, context("admin"));
    expect(result.success).toBe(true);
    const body = data(result);
    expect(body.scope).toBe("organization");
    expect(body.tools).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "google_calendar.list_events", errors: 1, errorCodes: [{ code: "unknown", calls: 1 }] }),
      expect.objectContaining({ name: "github.read_repo_file", errors: 1, errorCodes: [{ code: "action_failed", calls: 1 }] }),
    ]));
    expect(body.samples).toEqual([expect.objectContaining({
      tool: "google_calendar.list_events", errorCode: "unknown", requestedToolId: "google_calendar.list_events",
      message: expect.stringContaining("unknown tool_id"),
    })]);
  });

  it("limits a member to their own calls", async () => {
    const body = data(await execute.failures({}, context("member")));
    expect(body.scope).toBe("you");
    expect(body.tools).toEqual([expect.objectContaining({ name: "github.read_repo_file", errors: 1 })]);
  });

  it("leaves error text out of a conversation other people read", async () => {
    const body = data(await execute.failures({}, context("admin", { owner: { type: "team", id: "team-1" } })));
    expect(body.scope).toBe("you");
    expect(body.samples).toEqual([]);
    expect(body.note).toContain("private conversation");
  });

  it("shows route timings to admins only", async () => {
    recordRequestTiming("GET /api/sessions/:id/threads", { at: Date.now(), ms: 900, status: 200, orgId: ORG });
    recordRequestTiming("GET /api/sessions/:id/threads", { at: Date.now(), ms: 100, status: 200, orgId: ORG });
    recordRequestTiming("GET /api/sessions/:id/threads", { at: Date.now(), ms: 5_000, status: 200, orgId: "another-org" });
    expect((await execute.slow({}, context("member"))).success).toBe(false);
    const body = data(await execute.slow({}, context("admin")));
    expect(body.routes).toEqual([expect.objectContaining({ route: "GET /api/sessions/:id/threads", count: 2, maxMs: 900 })]);
  });

  it("shows 5xx routes and error paths to admins only", async () => {
    recordRequestTiming("POST /api/sessions/:id/messages", { at: Date.now(), ms: 30_000, status: 503, orgId: ORG });
    recordRequestTiming("POST /api/sessions/:id/messages", { at: Date.now(), ms: 40, status: 200, orgId: ORG });
    recordRequestTiming("GET /api/me", { at: Date.now(), ms: 5, status: 500, orgId: "another-org" });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    reportError({ area: "channels", reason: "outbound_delivery", provider: "slack" }, "[channels] outbound delivery failed", new Error("boom"));
    errors.mockRestore();
    const run = plugin()("diagnostics.list_server_errors");
    expect((await run({}, context("member"))).success).toBe(false);
    const body = data(await run({}, context("admin")));
    expect(body.routes).toEqual([{ route: "POST /api/sessions/:id/messages", requests: 2, serverErrors: 1, byStatus: { "503": 1 }, lastAt: expect.any(Number) }]);
    expect(body.errorPaths).toEqual([expect.objectContaining({ area: "channels", reason: "outbound_delivery", provider: "slack", count: 1 })]);
  });

  it("does not show an Org A admin Org B's routes or the deployment's error paths", async () => {
    recordRequestTiming("POST /api/sessions/:id/messages", { at: Date.now(), ms: 20, status: 503, orgId: ORG });
    recordRequestTiming("GET /api/workflows", { at: Date.now(), ms: 20, status: 500, orgId: OTHER_ORG });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    reportError({ area: "workflows", reason: "schedule_fire" }, `workflow scheduler: fire failed for ${OTHER_ORG}-schedule`, new Error("x"));
    errors.mockRestore();
    const run = plugin()("diagnostics.list_server_errors");
    const orgA = data(await run({}, context("org-admin")));
    expect(orgA.routes).toEqual([expect.objectContaining({ route: "POST /api/sessions/:id/messages", serverErrors: 1 })]);
    expect(orgA.errorPaths).toBeUndefined();
    expect(orgA.errorPathsOmitted).toContain("deployment operator");
    const orgB = data(await run({}, context("other-admin", { orgId: OTHER_ORG })));
    expect(orgB.routes).toEqual([expect.objectContaining({ route: "GET /api/workflows", serverErrors: 1 })]);
    expect(orgB.errorPaths).toBeUndefined();
    expect(data(await run({}, context("admin"))).errorPaths).toEqual([expect.objectContaining({ area: "workflows", reason: "schedule_fire" })]);
  });

  it("gives an operator no deployment-wide numbers in a conversation other people read", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    reportError({ area: "plugins", reason: "credential_refresh", provider: "github" }, "credential refresh failed for github", new Error("x"));
    errors.mockRestore();
    const api: PodHealthApi = {
      listPods: async () => [{ name: "sandbox-1", node: "node-a", containers: [{ name: "sandbox", ready: true, restarts: 1, state: "running" }] }],
      listPodWarnings: async () => [],
    };
    const errorsRun = plugin()("diagnostics.list_server_errors");
    const podsRun = plugin({ sandboxBackend: "kubernetes", podHealth: () => ({ api, apiNamespace: "valet", sandboxNamespace: "valet-sandboxes" }) })("diagnostics.list_pod_restarts");
    const sharedContexts: Array<Partial<PluginActionContext>> = [
      { origin: { channelType: "slack", threadKey: "slack:C1:1.2" } },
      { sharedTranscript: true },
      { owner: { type: "team", id: "team-1" } },
    ];
    for (const shared of sharedContexts) {
      const errorBody = data(await errorsRun({}, context("admin", shared)));
      expect(errorBody.errorPaths).toBeUndefined();
      expect(errorBody.errorPathsOmitted).toContain("private conversation");
      const podBody = data(await podsRun({}, context("admin", shared)));
      expect(podBody.sandboxes).toEqual({ namespace: "valet-sandboxes", omitted: expect.stringContaining("private conversation") });
    }
    expect(data(await errorsRun({}, context("admin"))).errorPaths).toEqual([expect.objectContaining({ reason: "credential_refresh" })]);
  });

  it("reads this process's memory and event loop for admins only", async () => {
    const run = plugin({ sandboxBackend: "docker" })("diagnostics.process_health");
    expect((await run({}, context("member"))).error).toContain("organization admins");
    const body = data(await run({}, context("admin")));
    expect(body.pid).toBe(process.pid);
    expect(body.sandboxBackend).toBe("docker");
    expect(body.memory).toEqual(expect.objectContaining({ rssBytes: expect.any(Number), heapLimitBytes: expect.any(Number) }));
  });

  it("names the backend when pods do not exist", async () => {
    const result = await plugin({ sandboxBackend: "docker" })("diagnostics.list_pod_restarts")({}, context("admin"));
    expect(result).toEqual({ success: false, error: expect.stringContaining("runs the docker backend") });
  });

  it("reads pod restarts and names the RBAC the API namespace needs", async () => {
    const forbidden = Object.assign(new Error("pods is forbidden"), { code: 403 });
    const api: PodHealthApi = {
      listPods: async (namespace) => {
        if (namespace === "valet") throw forbidden;
        return [{ name: "sandbox-1", node: "node-a", containers: [{ name: "sandbox", ready: true, restarts: 2, state: "running", lastTermination: { reason: "OOMKilled", exitCode: 137 } }] }];
      },
      listPodWarnings: async () => [],
    };
    const run = plugin({ sandboxBackend: "kubernetes", podHealth: () => ({ api, apiNamespace: "valet", sandboxNamespace: "valet-sandboxes" }) })("diagnostics.list_pod_restarts");
    expect((await run({}, context("member"))).success).toBe(false);
    const body = data(await run({}, context("admin")));
    expect(body.api).toEqual({ namespace: "valet", error: "forbidden", requiredRbac: expect.stringContaining('resources ["pods"], verbs ["get", "list"]') });
    expect(body.sandboxes).toEqual(expect.objectContaining({ namespace: "valet-sandboxes", pods: 1, restarts: 2, oomKilledPods: 1 }));
    const orgAdmin = data(await run({}, context("org-admin")));
    expect(orgAdmin.api).toEqual(expect.objectContaining({ error: "forbidden" }));
    expect(orgAdmin.sandboxes).toEqual({ namespace: "valet-sandboxes", omitted: expect.stringContaining("deployment operator") });
  });

  it("turns a kubernetes client that cannot start into a corrective error", async () => {
    const run = plugin({ sandboxBackend: "kubernetes", podHealth: () => { throw new Error("VALET_KUBE_CONTEXT is required."); } })("diagnostics.list_pod_restarts");
    expect(await run({}, context("admin"))).toEqual({ success: false, error: expect.stringContaining("Check the API's kubeconfig") });
  });
});

describe("diagnostics.list_thread_outcomes", () => {
  const HOUR = 3_600_000;
  let db: AppDb;
  let run: (args: Record<string, unknown>, ctx: PluginActionContext) => Promise<PluginActionResult>;

  beforeEach(async () => {
    const fresh = await freshTestPgDb();
    db = fresh.appDb;
    const now = Date.now();
    await db.insert(orgs).values({ id: ORG, name: "Diagnostics", createdAt: now });
    await db.insert(users).values([
      { id: "admin", email: "admin@example.test", name: "Ada Admin", role: "admin" },
      { id: "member", email: "member@example.test", name: "Max Member", role: "member" },
    ]);
    await db.insert(orgMembers).values([{ orgId: ORG, userId: "admin", role: "admin" }, { orgId: ORG, userId: "member", role: "member" }]);
    await db.insert(teams).values([{ id: "team-1", orgId: ORG, name: "Platform", createdAt: now }, { id: "team-2", orgId: ORG, name: "Sales", createdAt: now }]);
    await db.insert(teamMembers).values([
      { teamId: "team-1", userId: "admin", role: "member" }, { teamId: "team-1", userId: "member", role: "member" },
      { teamId: "team-2", userId: "member", role: "member" },
    ]);
    const session = { orgId: ORG, workspace: "test", createdAt: now, updatedAt: now };
    await db.insert(agentSessions).values([
      { ...session, id: "s-admin", userId: "admin", ownerType: "user", ownerId: "admin" },
      { ...session, id: "s-member", userId: "member", ownerType: "user", ownerId: "member" },
      { ...session, id: "s-team", userId: "member", ownerType: "team", ownerId: "team-1" },
      { ...session, id: "s-sales", userId: "member", ownerType: "team", ownerId: "team-2" },
      { ...session, id: "wf:run:step", userId: "admin", ownerType: "user", ownerId: "admin" },
    ]);
    // [session, thread, key, title, first request, outcome, hours ago]
    const threads: Array<[string, string, string, string | null, string | null, string, number]> = [
      ["s-admin", "t-admin", "web:default", "Book the design sync", "Book a meeting with the design team on Thursday.", "failed", 1],
      ["s-admin", "t-done", "web:other", null, "Summarize the doc.", "completed", 2],
      ["s-admin", "t-old", "web:old", null, "An old request.", "failed", 72],
      ["s-member", "t-member", "web:default", "Member plans", "A private member request.", "abandoned", 2],
      ["s-team", "t-team", "web:default", "Release notes", "Draft the release notes.", "partial", 3],
      ["s-team", "t-private", "app-assistant:member:1", "Private ask", "A private team request.", "failed", 4],
      ["s-sales", "t-sales", "web:default", "Pipeline", "Update the pipeline.", "blocked_on_human", 5],
      ["wf:run:step", "t-wf", "workflow:run:admin", null, "Workflow step.", "failed", 1],
    ];
    await seedRegistry(db, ORG, sessionOutcomeDimension);
    for (const [sessionId, threadId, key, title, request, outcome, hoursAgo] of threads) {
      await fresh.pgdb.query(`INSERT INTO engine_threads (id, session_id, key, status, queue_mode, metadata, created_at, updated_at)
        VALUES ($1, $2, $3, 'active', 'followup', $4, $5, $5)`, [threadId, sessionId, key, title ? JSON.stringify({ title }) : null, now]);
      if (request) {
        await fresh.pgdb.query(`INSERT INTO engine_entries (id, session_id, thread_id, entry_type, role, content, created_at)
          VALUES ($1, $2, $3, 'message', 'user', $4, $5)`, [`${threadId}-user`, sessionId, threadId, request, now - hoursAgo * HOUR]);
      }
      const subjectId = `${sessionId}:${threadId}`;
      await db.insert(tagSubjects).values({ sessionId, threadId, orgId: ORG, dimension: "session_outcome", subjectType: "session_thread", subjectId, inputHash: "h" });
      await db.insert(tagLabels).values({ orgId: ORG, subjectType: "session_thread", subjectId, dimension: "session_outcome", key: outcome,
        mode: "single", confidence: 0.9, model: "test", inputHash: "h", classifiedAt: now - hoursAgo * HOUR });
    }
    await db.insert(tagKeys).values({ orgId: ORG, dimension: "tool_intent", key: "scheduling", label: "Scheduling", definition: "Find or book meetings.",
      origin: "seed", status: "active", createdAt: now, updatedAt: now });
    const call = { orgId: ORG, surface: "hosted" as const, durationMs: 5, userId: "admin", ownerType: "user" as const, ownerId: "admin", sessionId: "s-admin", threadId: "t-admin" };
    await db.insert(externalCalls).values([
      { ...call, id: "s-admin:c1", name: "google_calendar.list_events", outcome: "error", errorCode: "unknown", createdAt: now - HOUR },
      { ...call, id: "s-admin:c2", name: "google_calendar.list_events", outcome: "error", errorCode: "unknown", createdAt: now - HOUR },
      { ...call, id: "s-admin:c3", name: "calendar.list_events", outcome: "ok", createdAt: now - HOUR },
      { ...call, id: "s-admin:c4", name: "calendar.list_events", outcome: "error", errorCode: "action_failed", createdAt: now - 72 * HOUR },
      { ...call, id: "s-member:c5", userId: "member", ownerId: "member", sessionId: "s-member", threadId: "t-member",
        name: "github.read_repo_file", outcome: "error", errorCode: "action_failed", createdAt: now - 2 * HOUR },
    ]);
    for (const id of ["s-admin:c1", "s-admin:c2", "s-admin:c3"]) {
      await db.insert(tagLabels).values({ orgId: ORG, subjectType: "external_call", subjectId: id, dimension: "tool_intent", key: "scheduling",
        mode: "single", confidence: 0.9, model: "test", inputHash: "h", classifiedAt: now });
    }
    const engineCredentials = new PgCredentialStore(fresh.pgdb, deriveSecretKey("test-key"));
    const outcomes = diagnosticsActionPlugin(db, () => ({ engineCredentials, publicUrl: "https://valet.test/" })).actions
      .find((candidate) => candidate.id === "diagnostics.list_thread_outcomes");
    if (!outcomes) throw new Error("Missing diagnostics.list_thread_outcomes");
    run = (args, ctx) => outcomes.execute(args, ctx);
  });

  function threadIds(body: Record<string, unknown>): string[] {
    return Array.isArray(body.threads) ? body.threads.map((row: { threadId: string }) => row.threadId) : [];
  }

  it("gives an admin every friction thread in the organization, with text only from threads they can open", async () => {
    const result = await run({}, context("admin"));
    expect(result.success).toBe(true);
    const body = data(result);
    expect(body.scope).toBe("organization");
    expect(body.outcomes).toEqual(expect.arrayContaining([
      { key: "failed", label: "Failed", threads: 2 }, { key: "completed", label: "Completed", threads: 1 },
      { key: "partial", label: "Partial", threads: 1 }, { key: "abandoned", label: "Abandoned", threads: 1 },
    ]));
    // Completed, older than the window, and workflow-step threads stay out.
    expect(threadIds(body)).toEqual(["t-admin", "t-member", "t-team", "t-private", "t-sales"]);
    expect(body.threads).toEqual(expect.arrayContaining([
      expect.objectContaining({
        threadId: "t-admin", link: "https://valet.test/threads/t-admin", outcome: "failed", workspace: "personal",
        person: { kind: "user", id: "admin", name: "Ada Admin" }, intent: { key: "scheduling", label: "Scheduling" },
        toolCalls: 3, toolErrors: 2, errorCodes: [{ tool: "google_calendar.list_events", code: "unknown", calls: 2 }],
        canOpen: true, title: "Book the design sync", excerpt: "Book a meeting with the design team on Thursday.",
      }),
      expect.objectContaining({ threadId: "t-team", workspace: "team", canOpen: true, title: "Release notes", excerpt: "Draft the release notes." }),
    ]));
    // Another member's personal thread, a private thread in a shared team,
    // and a team the admin is not in: no title, no excerpt.
    for (const hidden of ["t-member", "t-private", "t-sales"]) {
      const row = (body.threads as Array<Record<string, unknown>>).find((candidate) => candidate.threadId === hidden);
      expect(row).toMatchObject({ canOpen: false });
      expect(row).not.toHaveProperty("title");
      expect(row).not.toHaveProperty("excerpt");
    }
    expect(body.groups).toEqual(expect.arrayContaining([expect.objectContaining({
      person: { kind: "user", id: "admin", name: "Ada Admin" }, intent: { key: "scheduling", label: "Scheduling" },
      threads: 1, outcomes: { failed: 1 }, toolErrors: 2, links: ["https://valet.test/threads/t-admin"],
    })]));
    expect(body.note).toBe("");
    expect(JSON.stringify(body)).not.toMatch(/private (member|team) request|Member plans|Private ask|Pipeline/);
  });

  it("refuses members and conversations other people read", async () => {
    const member = await run({}, context("member"));
    expect(member).toMatchObject({ success: false, error: expect.stringContaining("organization admins") });
    const shared = await run({}, context("admin", { origin: { channelType: "slack", threadKey: "slack:C1:1" } }));
    expect(shared).toMatchObject({ success: false, error: expect.stringContaining("private conversation") });
  });

  it("limits a team workflow run to its team's threads", async () => {
    const body = data(await run({}, context("team:team-1", { owner: { type: "team", id: "team-1" } })));
    expect(body.scope).toBe("team");
    expect(threadIds(body)).toEqual(["t-team", "t-private"]);
    expect(body.threads).toEqual([
      expect.objectContaining({ threadId: "t-team", canOpen: true, excerpt: "Draft the release notes." }),
      expect.objectContaining({ threadId: "t-private", canOpen: false }),
    ]);
    expect(JSON.stringify(body)).not.toContain("Private ask");
  });

  it("filters by outcome, window and limit", async () => {
    expect(threadIds(data(await run({ outcomes: ["completed"] }, context("admin"))))).toEqual(["t-done"]);
    expect(threadIds(data(await run({ hours: 96, outcomes: ["failed"] }, context("admin"))))).toEqual(["t-admin", "t-private", "t-old"]);
    const limited = data(await run({ limit: 1 }, context("admin")));
    expect(threadIds(limited)).toEqual(["t-admin"]);
    expect(limited.truncated).toBe(true);
  });

  it("says how to turn outcome labels on when none were written", async () => {
    await db.delete(tagLabels);
    const body = data(await run({}, context("admin")));
    expect(body.outcomes).toEqual([]);
    expect(body.threads).toEqual([]);
    expect(body.note).toContain("Settings > Models");
  });
});
