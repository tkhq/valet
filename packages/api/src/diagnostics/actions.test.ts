import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PluginActionContext, PluginActionResult } from "@valet/engine";
import type { AppDb } from "../lib/drizzle.js";
import { freshTestPgDb } from "../test-helpers/pg-test-db.js";
import { externalCalls, orgMembers, orgs, users } from "../schema/index.js";
import { recordRequestTiming, resetRequestTimings } from "../observability/request-timings.js";
import { PgCredentialStore } from "../plugins/credential-store.js";
import { deriveSecretKey } from "../lib/secret-crypto.js";
import { diagnosticsActionPlugin } from "./actions.js";

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
