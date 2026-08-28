/**
 * `sec_*` runner ToolDefs — drives each tool's `execute()` against a real
 * in-process HTTP server (`bootTestApi`, the memory-tools test pattern) with
 * a hand-built `ToolContext`, proving the tools round-trip over the honest
 * HTTP seam. No ANTHROPIC_API_KEY and no model turn is ever required: the
 * engagement is driven through the service and the routes, and the one test
 * that spawns a real child asserts only durable rows.
 *
 * Also pins the host wiring: a `kind='security'` session build attaches the
 * runner tools, the engagement-runner skill, and the child read/send/status
 * seams — and deliberately NOT the childSpawner (dispatch goes through
 * sec_dispatch only, spec Decision 3).
 */
import { describe, it, expect, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type {
  Credential,
  CredentialProvider,
  DecisionGateRequest,
  DecisionResolution,
  MessageQuery,
  Sandbox,
  SessionEntry,
  ToolContext,
} from "@valet/engine";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { internalToken } from "../lib/internal-auth.js";
import { loadSessionMeta } from "./session-meta.js";
import { agentSessions, childWatches, securityCells, securityFiles } from "../schema/index.js";
import { createSecurityEngagementService } from "../services/security-engagements.js";
import type { CreateSessionResponse, GetSessionSecurityResponse } from "../wire/types.js";
import {
  buildSecurityRunnerTools,
  secCellCompleteTool,
  secCloseTool,
  secDispatchTool,
  secFsListTool,
  secFsReadTool,
  secStartTool,
  secStatusTool,
  ESTIMATED_TOKENS_PER_CELL,
} from "./security-tools.js";

const SHA = "ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12";
const REPO = { fullName: "acme/api", cloneUrl: "https://github.com/acme/api.git", ref: SHA };

const stubCredentials: CredentialProvider = {
  get: async (): Promise<Credential | null> => null,
  request: async (): Promise<Credential> => {
    throw new Error("not implemented in test stub");
  },
};

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  const sandbox: Partial<Sandbox> & { id: string } = { id: "sb-1" };
  return {
    userId: "local-user",
    orgId: "local-org",
    sessionId: "s1",
    threadId: "t1",
    credentials: stubCredentials,
    sandbox: sandbox as Sandbox,
    requestDecision: async (_gate: DecisionGateRequest): Promise<DecisionResolution> => {
      throw new Error("not implemented in test stub");
    },
    signal: new AbortController().signal,
    threadRead: async (_key: string, _opts?: MessageQuery): Promise<SessionEntry[]> => [],
    listThreads: async () => [],
    setModel: async ({ model }: { model: string }) => ({ fromModel: model, toModel: model }),
    ...overrides,
  };
}

let api: TestApi;

afterEach(async () => {
  await api?.cleanup();
});

async function createSecuritySession(baseUrl: string): Promise<CreateSessionResponse> {
  const res = await fetch(`${baseUrl}/api/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ workspace: `/tmp/valet-sec-tools-${randomUUID()}`, kind: "security", repo: REPO }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as CreateSessionResponse;
}

function toolCtx(a: TestApi, sessionId: string, overrides: Partial<ToolContext> = {}): ToolContext {
  return makeCtx({
    sessionId,
    config: { apiBaseUrl: a.baseUrl, internalToken: internalToken() },
    ...overrides,
  });
}

async function engagementOf(a: TestApi, sessionId: string): Promise<GetSessionSecurityResponse> {
  const res = await fetch(`${a.baseUrl}/api/sessions/${sessionId}/security`);
  expect(res.status).toBe(200);
  return (await res.json()) as GetSessionSecurityResponse;
}

describe("buildSecurityRunnerTools", () => {
  it("returns exactly the eleven runner sec_* tools", () => {
    expect(buildSecurityRunnerTools().map((t) => t.name)).toEqual([
      "sec_plan_set",
      "sec_start",
      "sec_status",
      "sec_dispatch",
      "sec_cell_complete",
      "sec_cell_fail",
      "sec_close",
      "sec_handoff",
      "sec_fs_read",
      "sec_fs_list",
      "sec_findings_list",
    ]);
  });

  it("answers [security_unavailable] without apiBaseUrl/internalToken", async () => {
    const result = await secStatusTool.execute({}, makeCtx());
    expect(result.text).toBe("[security_unavailable] security endpoint not configured");
  });
});

describe("host wiring for kind='security' sessions", () => {
  it("attaches sec_* tools + runner skill + child seams, and NO childSpawner", async () => {
    api = await bootTestApi();
    const created = await createSecuritySession(api.baseUrl);
    const rows = await api.providers.db
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.id, created.id))
      .limit(1);
    const session = await api.providers.engineHost.sessionFor(
      created.id,
      await loadSessionMeta(api.providers.db, rows[0]),
    );

    const toolNames = (session.options.tools ?? []).map((t) => t.name);
    expect(toolNames).toContain("sec_plan_set");
    expect(toolNames).toContain("sec_dispatch");
    expect(toolNames).toContain("sec_close");

    const skillNames = (session.options.skills ?? []).map((s) => s.name);
    expect(skillNames).toContain("security-engagement-runner");

    // Child steering seams present; spawner absent → the generic task tool
    // answers unavailable and dispatch flows through sec_dispatch only.
    expect(typeof session.options.toolConfig?.childReader).toBe("function");
    expect(typeof session.options.toolConfig?.childSender).toBe("function");
    expect(typeof session.options.toolConfig?.childStatusReader).toBe("function");
    expect(session.options.toolConfig?.childSpawner).toBeUndefined();
    // The host's own loopback base URL (bootTestApi binds localhost and the
    // host 127.0.0.1 — same server, so assert the port).
    expect(String(session.options.toolConfig?.apiBaseUrl)).toContain(new URL(api.baseUrl).port);
    expect(typeof session.options.toolConfig?.internalToken).toBe("string");

    // The runner is an ordinary hub session — engine purpose interactive.
    const data = await api.providers.engineStore.getSession(created.id);
    expect(data?.purpose ?? "interactive").toBe("interactive");
  });

  it("leaves kind='code' sessions untouched", async () => {
    api = await bootTestApi();
    const res = await fetch(`${api.baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspace: `/tmp/valet-sec-tools-${randomUUID()}` }),
    });
    const created = (await res.json()) as CreateSessionResponse;
    const rows = await api.providers.db
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.id, created.id))
      .limit(1);
    const session = await api.providers.engineHost.sessionFor(
      created.id,
      await loadSessionMeta(api.providers.db, rows[0]),
    );
    expect((session.options.tools ?? []).map((t) => t.name)).not.toContain("sec_plan_set");
    expect((session.options.skills ?? []).map((s) => s.name)).not.toContain("security-engagement-runner");
  });
});

describe("sec_start approval gate", () => {
  it("denied gate → no start; the gate body names repo, SHA, cells, personas, and the estimate", async () => {
    api = await bootTestApi();
    const created = await createSecuritySession(api.baseUrl);

    let captured: DecisionGateRequest | undefined;
    const result = await secStartTool.execute(
      {},
      toolCtx(api, created.id, {
        requestDecision: async (gate) => {
          captured = gate;
          return { actionId: "deny", resolvedBy: "local-user", resolvedAt: Date.now() };
        },
      }),
    );

    expect(result.text).toBe("Engagement start was not approved.");
    expect(captured?.type).toBe("approval");
    expect(captured?.title).toContain("acme/api");
    expect(captured?.body).toContain(`Pinned commit: ${SHA}`);
    expect(captured?.body).toContain("Cells (5):");
    expect(captured?.body).toContain("01 01-recon [code-review]");
    expect(captured?.body).toContain("Personas: code-review");
    expect(captured?.body).toContain("Rough estimate: 5 cells × ~500k tokens");
    expect(captured?.body).toContain((5 * ESTIMATED_TOKENS_PER_CELL).toLocaleString("en-US"));

    // Denied means NOTHING started: still planning, no cells.
    const engagement = await engagementOf(api, created.id);
    expect(engagement.engagement.status).toBe("planning");
    expect(engagement.cells).toEqual([]);
  });

  it("approved gate → cells materialize at the pinned SHA", async () => {
    api = await bootTestApi();
    const created = await createSecuritySession(api.baseUrl);

    const result = await secStartTool.execute(
      {},
      toolCtx(api, created.id, {
        requestDecision: async () => ({
          actionId: "approve",
          resolvedBy: "local-user",
          resolvedAt: Date.now(),
        }),
      }),
    );

    expect(result.text).toContain(`engagement started on acme/api at ${SHA} (5 cells)`);
    const engagement = await engagementOf(api, created.id);
    expect(engagement.engagement.status).toBe("running");
    expect(engagement.engagement.repoRef).toBe(SHA);
    expect(engagement.cells).toHaveLength(5);
    expect(engagement.cells[0].dir).toBe("01-recon");
  });
});

describe("tool route auth", () => {
  it("403s a cross-engagement acting session on mutations", async () => {
    api = await bootTestApi();
    const a = await createSecuritySession(api.baseUrl);
    const b = await createSecuritySession(api.baseUrl);

    const res = await fetch(`${api.baseUrl}/api/sessions/${a.id}/security/plan`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-valet-internal": internalToken(),
        "x-valet-session-id": b.id,
      },
      body: JSON.stringify({ plan: "cells: []" }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("does not own this engagement");
  });

  it("401s an internal-token call with no acting session header", async () => {
    api = await bootTestApi();
    const a = await createSecuritySession(api.baseUrl);
    const res = await fetch(`${api.baseUrl}/api/sessions/${a.id}/security/close`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-valet-internal": internalToken() },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("x-valet-session-id");
  });
});

describe("sec_dispatch", () => {
  it("dispatches the first pending cell through the real children.ts spawner and stamps the child id", async () => {
    api = await bootTestApi();
    const created = await createSecuritySession(api.baseUrl);
    const { db } = api.providers;
    const service = createSecurityEngagementService({ db });
    const found = await service.getEngagementBySession(created.id);
    await service.startEngagement(found!.engagement.id, { resolvedSha: SHA });

    // The spawner authorizes against the parent's ENGINE session row —
    // build the runner (the same first-touch every web caller performs)
    // and pause it so nothing claims a doomed no-key turn.
    const sessionRows = await db.select().from(agentSessions).where(eq(agentSessions.id, created.id)).limit(1);
    const runner = await api.providers.engineHost.sessionFor(
      created.id,
      await loadSessionMeta(db, sessionRows[0]),
    );
    await runner.pause();

    const result = await secDispatchTool.execute({}, toolCtx(api, created.id, { threadId: "t-runner" }));
    expect(result.text).toContain("dispatched cell 01-recon");
    expect(result.text).toContain("child.settled signal");

    const cells = await db
      .select()
      .from(securityCells)
      .where(eq(securityCells.engagementId, found!.engagement.id));
    const recon = cells.find((c) => c.ordinal === 1);
    expect(recon?.status).toBe("running");
    expect(recon?.attempts).toBe(1);
    expect(recon?.childSessionId).toBeTruthy();
    expect(result.text).toContain(recon!.childSessionId!);

    // The spawner (not a bypass) created the durable watch edge, armed for
    // settlement back onto the dispatching thread.
    const watches = await db
      .select()
      .from(childWatches)
      .where(eq(childWatches.childSessionId, recon!.childSessionId!));
    expect(watches).toHaveLength(1);
    expect(watches[0].parentSessionId).toBe(created.id);
    expect(watches[0].parentThreadId).toBe("t-runner");
    expect(watches[0].settled).toBe(false);

    // Stop the child's queued turn before cleanup — this test asserts the
    // durable rows only, and an unattended turn must never reach a model.
    await api.providers.engineHost.liveSession(recon!.childSessionId!)?.abort();
  });
});

describe("sec_cell_complete", () => {
  it("relays the server's exit-condition violation verbatim", async () => {
    api = await bootTestApi();
    const created = await createSecuritySession(api.baseUrl);
    const { db } = api.providers;
    const service = createSecurityEngagementService({ db });
    const found = await service.getEngagementBySession(created.id);
    const engagementId = found!.engagement.id;
    await service.startEngagement(engagementId, { resolvedSha: SHA });

    // Claim cell 1 with a fake spawn — no engine child needed to rule on
    // the exit condition.
    const { cell } = await service.dispatchCell(engagementId, {
      spawn: async () => ({ childSessionId: "child-viol" }),
    });

    const now = Date.now();
    await db.insert(childWatches).values({
      childSessionId: "child-viol",
      queueItemId: "qi-viol",
      parentSessionId: created.id,
      parentThreadId: "t-runner",
      actorUserId: "local-user",
      orgId: "local-org",
      settled: true,
      createdAt: now,
    });
    await db.insert(securityFiles).values({
      id: `file_${randomUUID()}`,
      engagementId,
      cellId: cell.id,
      path: "/cells/01-recon/state.yml",
      revision: 1,
      content: ["protocol_version: 1", "status: done", "checklist: { pending: 0, done: 4 }", "queue: { pending: 2, done: 9 }"].join(
        "\n",
      ),
      createdAt: now,
    });

    const result = await secCellCompleteTool.execute({ cell_id: cell.id }, toolCtx(api, created.id));
    expect(result.text).toContain("outcome: violation");
    // Verbatim server ruling — the runner steers the persona with it.
    expect(result.text).toContain("status is done but queue.pending is 2, not 0");

    const rows = await db.select().from(securityCells).where(eq(securityCells.id, cell.id)).limit(1);
    expect(rows[0].status).toBe("running");
  });

  it("refuses while the child watch is unsettled, naming the wait", async () => {
    api = await bootTestApi();
    const created = await createSecuritySession(api.baseUrl);
    const { db } = api.providers;
    const service = createSecurityEngagementService({ db });
    const found = await service.getEngagementBySession(created.id);
    await service.startEngagement(found!.engagement.id, { resolvedSha: SHA });
    const { cell } = await service.dispatchCell(found!.engagement.id, {
      spawn: async () => ({ childSessionId: "child-live" }),
    });
    await db.insert(childWatches).values({
      childSessionId: "child-live",
      queueItemId: "qi-live",
      parentSessionId: created.id,
      parentThreadId: "t-runner",
      actorUserId: "local-user",
      orgId: "local-org",
      settled: false,
      createdAt: Date.now(),
    });

    const result = await secCellCompleteTool.execute({ cell_id: cell.id }, toolCtx(api, created.id));
    expect(result.text).toContain("[security_error]");
    expect(result.text).toContain("has not settled");
  });
});

describe("sec_status", () => {
  it("reports cells, finding counts, and a gone child", async () => {
    api = await bootTestApi();
    const created = await createSecuritySession(api.baseUrl);
    const { db } = api.providers;
    const service = createSecurityEngagementService({ db });
    const found = await service.getEngagementBySession(created.id);
    await service.startEngagement(found!.engagement.id, { resolvedSha: SHA });
    await service.dispatchCell(found!.engagement.id, {
      spawn: async () => ({ childSessionId: "child-ghost" }),
    });
    // No child_watches row and no agent_sessions row: the child is gone.

    const result = await secStatusTool.execute({}, toolCtx(api, created.id));
    expect(result.text).toContain(`on acme/api@${SHA} — running`);
    expect(result.text).toContain("01-recon [code-review] running");
    expect(result.text).toContain("critical 0");
    expect(result.text).toContain("CHILD GONE");
  });
});

describe("sec_close", () => {
  it("returns the manifest JSON verbatim as the tool result", async () => {
    api = await bootTestApi();
    const created = await createSecuritySession(api.baseUrl);
    const { db } = api.providers;
    const service = createSecurityEngagementService({ db });
    const found = await service.getEngagementBySession(created.id);
    const engagementId = found!.engagement.id;
    await service.startEngagement(engagementId, { resolvedSha: SHA });
    // Test-only shortcut: rows straight to completed — the transition rules
    // themselves are the service suite's job.
    await db
      .update(securityCells)
      .set({ status: "completed" })
      .where(eq(securityCells.engagementId, engagementId));

    const result = await secCloseTool.execute({}, toolCtx(api, created.id));
    const manifest: unknown = JSON.parse(result.text);
    expect(manifest).toMatchObject({
      engagementId,
      status: "completed",
      repoFullName: "acme/api",
      repoRef: SHA,
    });
    expect((manifest as { cells: unknown[] }).cells).toHaveLength(5);
  });
});

describe("sec_fs_read / sec_fs_list", () => {
  it("reads the virtual mounts and lists the tree", async () => {
    api = await bootTestApi();
    const created = await createSecuritySession(api.baseUrl);

    const plan = await secFsReadTool.execute({ path: "/plan.yml" }, toolCtx(api, created.id));
    expect(plan.text).toContain("code-review");

    const listing = await secFsListTool.execute({}, toolCtx(api, created.id));
    expect(listing.text).toContain("/plan.yml");
    expect(listing.text).toContain("/protocol.md");

    const missing = await secFsReadTool.execute({ path: "/cells/nope/state.yml" }, toolCtx(api, created.id));
    expect(missing.text).toContain("[security_error]");
    expect(missing.text).toContain("sec_fs_list");
  });
});
