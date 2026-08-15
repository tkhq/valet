/**
 * `/api/workflows/{triggers,schedules,event-triggers,trigger-catalog,runs}`
 * route tests (spec 2026-08-15). Real Hono app via `bootTestApi` with the
 * github plugin; rows seeded directly through `providers.db`; cross-org cases
 * seed rows under a second org id (stub auth pins the caller to `local-org`).
 */
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import githubPlugin from "@valet/plugin-github/plugin";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { eventSubscriptions, workflowDefinitions, workflowRuns, workflowSchedules } from "../schema/index.js";
import type {
  CreateWorkflowEventTriggerRequest,
  CreateWorkflowScheduleRequest,
  GetWorkflowTriggerCatalogResponse,
  ListAllWorkflowRunsResponse,
  ListWorkflowTriggersResponse,
  StartWorkflowRunResponse,
  WorkflowEventTriggerResponse,
  WorkflowScheduleResponse,
} from "../wire/types.js";

let api: TestApi | undefined;

afterEach(async () => {
  await api?.cleanup();
  api = undefined;
});

async function boot(): Promise<TestApi> {
  api = await bootTestApi({ plugins: [githubPlugin] });
  return api;
}

const VALID_CRON = "0 9 * * 1-5";

/** Creates a workflow definition row via the API and returns its id. */
async function createWorkflow(baseUrl: string, name = "test-wf"): Promise<string> {
  const res = await fetch(`${baseUrl}/api/workflows`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name,
      definition: {
        version: "dag/v1",
        nodes: [
          { id: "trigger", type: "trigger" },
          { id: "stop", type: "stop" },
        ],
        edges: [{ from: "trigger", to: "stop" }],
      },
    }),
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { id: string };
  return body.id;
}

/** Seeds a schedule row directly (bypassing route validation). */
async function seedScheduleRow(
  a: TestApi,
  id: string,
  orgId: string,
  workflowId: string | null = null,
): Promise<void> {
  const now = Date.now();
  await a.providers.db.insert(workflowSchedules).values({
    id,
    orgId,
    ownerType: "user",
    ownerId: "someone",
    targetKind: workflowId ? "workflow" : "orchestrator",
    workflowId,
    prompt: workflowId ? null : "hello",
    name: `seeded ${id}`,
    cron: VALID_CRON,
    timezone: "UTC",
    enabled: true,
    nextFireAt: now + 1000,
    lastFiredAt: null,
    createdBy: "someone",
    createdAt: now,
    updatedAt: now,
  });
}

/** Seeds an event subscription row with a workflow target. */
async function seedEventTriggerRow(
  a: TestApi,
  id: string,
  orgId: string,
  workflowId: string,
): Promise<void> {
  const now = Date.now();
  await a.providers.db.insert(eventSubscriptions).values({
    id,
    orgId,
    ownerType: "user",
    ownerId: "someone",
    name: `seeded trigger ${id}`,
    eventKeys: ["github.pull_request.opened"],
    filters: [],
    target: { kind: "workflow", workflowId },
    enabled: true,
    createdBy: "someone",
    createdAt: now,
    updatedAt: now,
  });
}

// ── 1. POST /api/workflows/schedules — orchestrator target ────────────────

describe("POST /api/workflows/schedules", () => {
  it("201s an orchestrator-target schedule with nextFireAt > now", async () => {
    const a = await boot();
    const before = Date.now();
    const res = await fetch(`${a.baseUrl}/api/workflows/schedules`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "daily standup",
        cron: VALID_CRON,
        target: { kind: "orchestrator", prompt: "Run the daily report" },
      } satisfies CreateWorkflowScheduleRequest),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as WorkflowScheduleResponse;
    expect(body.schedule.targetKind).toBe("orchestrator");
    expect(body.schedule.nextFireAt).toBeGreaterThan(before);
    expect(body.schedule.scheduleId).toBeTruthy();
  });

  // ── 2. Bad cron → 400 with "5-field" + example ────────────────────────

  it("400s a bad cron expression and names the 5-field requirement and an example", async () => {
    const a = await boot();
    const res = await fetch(`${a.baseUrl}/api/workflows/schedules`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "bad",
        cron: "bad",
        target: { kind: "orchestrator", prompt: "hello" },
      } satisfies CreateWorkflowScheduleRequest),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("5-field");
    expect(body.error).toContain("0 9");
  });

  // ── 3. Exactly-one-of workflowId+prompt ───────────────────────────────

  it("400s when neither workflowId nor prompt is provided (service message passes through)", async () => {
    const a = await boot();
    // Send a raw object that bypasses the union constraint at the type level
    const res = await fetch(`${a.baseUrl}/api/workflows/schedules`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "both",
        cron: VALID_CRON,
        target: { kind: "workflow", workflowId: "" },
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    // The service's exactly-one-of validation: workflow_id "" is treated as
    // absent (falsy), and no prompt was given — so service returns the
    // exactly-one-of error.
    expect(body.error).toContain("exactly one of");
  });
});

// ── 4. GET /api/workflows/triggers — both kinds present ──────────────────

describe("GET /api/workflows/triggers", () => {
  it("returns both schedule and event-trigger items with correct kind discriminants", async () => {
    const a = await boot();
    const wfId = await createWorkflow(a.baseUrl, "wf_1");
    await seedScheduleRow(a, "sched_1", "local-org");
    await seedEventTriggerRow(a, "trig_1", "local-org", wfId);

    const res = await fetch(`${a.baseUrl}/api/workflows/triggers`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListWorkflowTriggersResponse;

    const schedule = body.triggers.find((t) => t.kind === "schedule");
    const event = body.triggers.find((t) => t.kind === "event");
    expect(schedule).toBeDefined();
    expect(event).toBeDefined();
    expect(schedule!.detail).toHaveProperty("cron", VALID_CRON);
    expect(event!.workflowId).toBe(wfId);
  });

  // ── 5. ?workflowId filter ─────────────────────────────────────────────

  it("filters by workflowId — orchestrator-target schedule (no workflowId) is excluded", async () => {
    const a = await boot();
    const wfId = await createWorkflow(a.baseUrl, "wf_filtered");
    await seedScheduleRow(a, "sched_orch", "local-org"); // orchestrator, no workflowId
    await seedEventTriggerRow(a, "trig_wf", "local-org", wfId);

    const res = await fetch(`${a.baseUrl}/api/workflows/triggers?workflowId=${wfId}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListWorkflowTriggersResponse;

    const ids = body.triggers.map((t) => t.id);
    expect(ids).toContain("trig_wf");
    expect(ids).not.toContain("sched_orch");
  });
});

// ── 6. PATCH /api/workflows/schedules/:id ────────────────────────────────

describe("PATCH /api/workflows/schedules/:id", () => {
  it("200s with enabled: false; 404s on unknown id", async () => {
    const a = await boot();
    await seedScheduleRow(a, "sched_patch", "local-org");

    const res = await fetch(`${a.baseUrl}/api/workflows/schedules/sched_patch`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as WorkflowScheduleResponse;
    expect(body.schedule.enabled).toBe(false);

    const notFound = await fetch(`${a.baseUrl}/api/workflows/schedules/sched_no_exist`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    expect(notFound.status).toBe(404);
  });
});

// ── 7. DELETE /api/workflows/schedules/:id ───────────────────────────────

describe("DELETE /api/workflows/schedules/:id", () => {
  it("200s first delete then 404s second delete", async () => {
    const a = await boot();
    await seedScheduleRow(a, "sched_del", "local-org");

    const first = await fetch(`${a.baseUrl}/api/workflows/schedules/sched_del`, { method: "DELETE" });
    expect(first.status).toBe(200);
    const body = (await first.json()) as { ok: boolean };
    expect(body.ok).toBe(true);

    const second = await fetch(`${a.baseUrl}/api/workflows/schedules/sched_del`, { method: "DELETE" });
    expect(second.status).toBe(404);
  });
});

// ── 8. POST /api/workflows/schedules/:id/run ─────────────────────────────

describe("POST /api/workflows/schedules/:id/run", () => {
  it("200s and creates a workflow_runs row whose id starts with wfrun_sch_", async () => {
    const a = await boot();
    const wfId = await createWorkflow(a.baseUrl, "wf_for_fire");
    await seedScheduleRow(a, "sched_fire", "local-org", wfId);

    const res = await fetch(`${a.baseUrl}/api/workflows/schedules/sched_fire/run`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);

    const runRows = await a.providers.db
      .select({ id: workflowRuns.id })
      .from(workflowRuns)
      .where(eq(workflowRuns.workflowId, wfId));
    expect(runRows.length).toBeGreaterThan(0);
    expect(runRows[0]!.id).toMatch(/^wfrun_sch_/);
  });
});

// ── 9. POST/PATCH/DELETE /api/workflows/event-triggers round trip + 400 ──

describe("event-trigger CRUD", () => {
  it("round-trips create/patch/delete and 400s a bogus event key on create", async () => {
    const a = await boot();
    const wfId = await createWorkflow(a.baseUrl, "wf_evt");

    // Create
    const createRes = await fetch(`${a.baseUrl}/api/workflows/event-triggers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workflowId: wfId,
        name: "on PR open",
        eventKeys: ["github.pull_request.opened"],
        filters: [],
      } satisfies CreateWorkflowEventTriggerRequest),
    });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as WorkflowEventTriggerResponse;
    expect(created.trigger.triggerId).toBeTruthy();
    expect(created.trigger.workflowId).toBe(wfId);

    // Patch
    const patchRes = await fetch(`${a.baseUrl}/api/workflows/event-triggers/${created.trigger.triggerId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    expect(patchRes.status).toBe(200);
    const patched = (await patchRes.json()) as WorkflowEventTriggerResponse;
    expect(patched.trigger.enabled).toBe(false);

    // Delete
    const deleteRes = await fetch(`${a.baseUrl}/api/workflows/event-triggers/${created.trigger.triggerId}`, {
      method: "DELETE",
    });
    expect(deleteRes.status).toBe(200);

    // 400 on bogus event key
    const badRes = await fetch(`${a.baseUrl}/api/workflows/event-triggers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workflowId: wfId,
        name: "bogus",
        eventKeys: ["github.does.not.exist"],
        filters: [],
      } satisfies CreateWorkflowEventTriggerRequest),
    });
    expect(badRes.status).toBe(400);
    const badBody = (await badRes.json()) as { error: string };
    expect(badBody.error).toContain("github.does.not.exist");
  });
});

// ── 10. GET /api/workflows/trigger-catalog ────────────────────────────────

describe("GET /api/workflows/trigger-catalog", () => {
  it("200s with a github service entry", async () => {
    const a = await boot();
    const res = await fetch(`${a.baseUrl}/api/workflows/trigger-catalog`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as GetWorkflowTriggerCatalogResponse;
    const github = body.catalog.find((s) => s.service === "github");
    expect(github).toBeDefined();
    expect(github!.entries.length).toBeGreaterThan(0);
  });
});

// ── 11. GET /api/workflows/runs — route precedence + workflowName ─────────

describe("GET /api/workflows/runs", () => {
  it("200s with empty runs on a fresh org (not swallowed by workflowsRouter GET /:id)", async () => {
    const a = await boot();
    const res = await fetch(`${a.baseUrl}/api/workflows/runs`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListAllWorkflowRunsResponse;
    expect(body.runs).toEqual([]);
  });

  it("returns runs with workflowName after a run is started", async () => {
    const a = await boot();
    const wfId = await createWorkflow(a.baseUrl, "named-workflow");

    const startRes = await fetch(`${a.baseUrl}/api/workflows/${wfId}/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: {} }),
    });
    expect(startRes.status).toBe(201);
    const started = (await startRes.json()) as StartWorkflowRunResponse;
    expect(started.runId).toBeTruthy();

    const runsRes = await fetch(`${a.baseUrl}/api/workflows/runs`);
    expect(runsRes.status).toBe(200);
    const body = (await runsRes.json()) as ListAllWorkflowRunsResponse;
    expect(body.runs.length).toBeGreaterThan(0);
    expect(body.runs[0]!.workflowName).toBe("named-workflow");
  });
});

// ── 12. Cross-org invisibility ────────────────────────────────────────────

describe("cross-org invisibility", () => {
  it("schedule in other org is excluded from GET /triggers and 404s on PATCH/DELETE", async () => {
    const a = await boot();
    await seedScheduleRow(a, "sched_other", "org_other");

    // GET /triggers must not include the other org's schedule
    const getRes = await fetch(`${a.baseUrl}/api/workflows/triggers`);
    expect(getRes.status).toBe(200);
    const body = (await getRes.json()) as ListWorkflowTriggersResponse;
    expect(body.triggers.map((t) => t.id)).not.toContain("sched_other");

    // PATCH → 404
    const patchRes = await fetch(`${a.baseUrl}/api/workflows/schedules/sched_other`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    expect(patchRes.status).toBe(404);

    // DELETE → 404
    const deleteRes = await fetch(`${a.baseUrl}/api/workflows/schedules/sched_other`, {
      method: "DELETE",
    });
    expect(deleteRes.status).toBe(404);
  });

  it("event-trigger in other org is excluded from GET /triggers and 404s on PATCH/DELETE", async () => {
    const a = await boot();
    const wfId = await createWorkflow(a.baseUrl, "wf_other_evt");
    await seedEventTriggerRow(a, "trig_other", "org_other", wfId);

    // GET /triggers must not include the other org's event-trigger
    const getRes = await fetch(`${a.baseUrl}/api/workflows/triggers`);
    expect(getRes.status).toBe(200);
    const body = (await getRes.json()) as ListWorkflowTriggersResponse;
    expect(body.triggers.map((t) => t.id)).not.toContain("trig_other");

    // PATCH → 404
    const patchRes = await fetch(`${a.baseUrl}/api/workflows/event-triggers/trig_other`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    expect(patchRes.status).toBe(404);

    // DELETE → 404
    const deleteRes = await fetch(`${a.baseUrl}/api/workflows/event-triggers/trig_other`, {
      method: "DELETE",
    });
    expect(deleteRes.status).toBe(404);
  });
});
