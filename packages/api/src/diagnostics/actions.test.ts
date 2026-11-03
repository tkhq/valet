import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PluginActionContext, PluginActionResult } from "@valet/engine";
import type { AppDb } from "../lib/drizzle.js";
import { freshTestPgDb } from "../test-helpers/pg-test-db.js";
import { agentSessions, externalCalls, orgMembers, orgs, tagKeys, tagLabels, tagSubjects, teamMembers, teams, users } from "../schema/index.js";
import { recordRequestTiming, resetRequestTimings } from "../observability/request-timings.js";
import { PgCredentialStore } from "../plugins/credential-store.js";
import { deriveSecretKey } from "../lib/secret-crypto.js";
import { diagnosticsActionPlugin } from "./actions.js";
import { seedRegistry } from "../tagging/registry.js";
import { sessionOutcomeDimension } from "../tagging/session-outcome.js";

const ORG = "diagnostics-org";

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

  beforeEach(async () => {
    const fresh = await freshTestPgDb();
    db = fresh.appDb;
    await db.insert(orgs).values({ id: ORG, name: "Diagnostics", createdAt: Date.now() });
    await db.insert(users).values([
      { id: "admin", email: "admin@example.test", name: "Admin", role: "admin" },
      { id: "member", email: "member@example.test", name: "Member", role: "member" },
    ]);
    await db.insert(orgMembers).values([{ orgId: ORG, userId: "admin", role: "admin" }, { orgId: ORG, userId: "member", role: "member" }]);
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
    const [failures, slow] = diagnosticsActionPlugin(db, () => ({ engineCredentials })).actions;
    if (!failures || !slow) throw new Error("Missing diagnostics actions");
    execute = { failures: (args, ctx) => failures.execute(args, ctx), slow: (args, ctx) => slow.execute(args, ctx) };
  });
  afterEach(() => resetRequestTimings());

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
