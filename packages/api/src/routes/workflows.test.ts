/**
 * `/api/workflows` route tests (Phase 5 plan Task 10, decision 18). Route
 * CRUD + validation-400 exercise the real store; run-start/approval/cancel
 * exercise a stub `RunHost` (see `../workflows/*` for the real
 * `LocalRunHost`/`SqliteWorkflowStore` wiring, covered by conformance suites
 * elsewhere) so these tests assert on the routes' own logic — request
 * shaping, owner scoping, signal writes — without paying for the poll loop.
 */
import { describe, it, expect, afterEach } from "vitest";
import type { RunHost } from "@valet/workflow";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { addMember, createTeam } from "../services/teams.js";
import type {
  CreateWorkflowResponse,
  DeleteWorkflowWebhookResponse,
  GetWorkflowRunResponse,
  ListWorkflowRunsResponse,
  ListWorkflowsResponse,
  StartWorkflowRunResponse,
  WorkflowWebhookResponse,
} from "../wire/types.js";

let api: TestApi | undefined;

afterEach(async () => {
  await api?.cleanup();
  api = undefined;
});

const VALID_DEFINITION = {
  version: "dag/v1",
  nodes: [
    { id: "trigger", type: "trigger" },
    { id: "stop", type: "stop" },
  ],
  edges: [{ from: "trigger", to: "stop" }],
};

/** A `RunHost` stub that records every call instead of driving anything. */
class StubRunHost implements RunHost {
  started: Array<{ runId: string; owner?: { ownerType: string; ownerId: string } }> = [];
  woken: string[] = [];
  terminated: string[] = [];

  async start(
    runId: string,
    _params: unknown,
    _definition: unknown,
    owner?: { ownerType: string; ownerId: string },
  ): Promise<void> {
    this.started.push({ runId, owner });
  }
  async wake(runId: string): Promise<void> {
    this.woken.push(runId);
  }
  async scheduleWake(): Promise<void> {}
  async terminate(runId: string): Promise<void> {
    this.terminated.push(runId);
  }
  startHost(): void {}
  async stopHost(): Promise<void> {}
}

async function createWorkflow(baseUrl: string, name = "test-workflow"): Promise<CreateWorkflowResponse> {
  const res = await fetch(`${baseUrl}/api/workflows`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, definition: VALID_DEFINITION }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as CreateWorkflowResponse;
}

describe("POST /api/workflows", () => {
  it("creates a definition and validates it", async () => {
    api = await bootTestApi();
    const created = await createWorkflow(api.baseUrl);
    expect(created.name).toBe("test-workflow");
    expect(created.definition).toEqual(VALID_DEFINITION);
    expect(created.id).toMatch(/^wf_/);
  });

  it("400s on an invalid definition with an errors array", async () => {
    api = await bootTestApi();
    const res = await fetch(`${api.baseUrl}/api/workflows`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "bad", definition: { version: "dag/v1", nodes: [], edges: [] } }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; errors: string[] };
    expect(Array.isArray(body.errors)).toBe(true);
    expect(body.errors.length).toBeGreaterThan(0);
  });

  it("400s when definition is missing nodes/edges arrays", async () => {
    api = await bootTestApi();
    const res = await fetch(`${api.baseUrl}/api/workflows`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "bad", definition: { version: "dag/v1" } }),
    });
    expect(res.status).toBe(400);
  });
});

describe("GET /api/workflows + /:id", () => {
  it("lists only the caller's own definitions", async () => {
    api = await bootTestApi();
    await createWorkflow(api.baseUrl, "mine");
    await fetch(`${api.baseUrl}/api/workflows`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-valet-test-user-id": "test-member" },
      body: JSON.stringify({ name: "someone-elses", definition: VALID_DEFINITION }),
    });

    const res = await fetch(`${api.baseUrl}/api/workflows`);
    const { workflows } = (await res.json()) as ListWorkflowsResponse;
    expect(workflows.map((w) => w.name)).toEqual(["mine"]);
  });

  it("404s fetching another owner's definition by id", async () => {
    api = await bootTestApi();
    const created = await createWorkflow(api.baseUrl);

    const res = await fetch(`${api.baseUrl}/api/workflows/${created.id}`, {
      headers: { "x-valet-test-user-id": "test-member" },
    });
    expect(res.status).toBe(404);
  });
});

describe("team-owned workflows", () => {
  it("creates a team-owned workflow when the caller is a member", async () => {
    api = await bootTestApi();
    const team = await createTeam(api.providers.db, { orgId: "local-org", name: "Platform", creatorUserId: "local-user" });

    const res = await fetch(`${api.baseUrl}/api/workflows`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "team-wf", definition: VALID_DEFINITION, teamId: team.id }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as CreateWorkflowResponse;
    expect(body.ownerType).toBe("team");
    expect(body.ownerId).toBe(team.id);
  });

  it("404s creating a workflow under a team the caller isn't a member of", async () => {
    api = await bootTestApi();
    const team = await createTeam(api.providers.db, { orgId: "local-org", name: "Platform", creatorUserId: "test-member" });

    const res = await fetch(`${api.baseUrl}/api/workflows`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "team-wf", definition: VALID_DEFINITION, teamId: team.id }),
    });
    expect(res.status).toBe(404);
  });

  it("404s creating a workflow under an unknown teamId", async () => {
    api = await bootTestApi();
    const res = await fetch(`${api.baseUrl}/api/workflows`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "team-wf", definition: VALID_DEFINITION, teamId: "team_nonexistent" }),
    });
    expect(res.status).toBe(404);
  });

  it("lists a team-owned workflow to every team member, not just its creator", async () => {
    api = await bootTestApi();
    const team = await createTeam(api.providers.db, { orgId: "local-org", name: "Platform", creatorUserId: "local-user" });
    await addMember(api.providers.db, { teamId: team.id, userId: "test-member", role: "member" });
    await fetch(`${api.baseUrl}/api/workflows`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "team-wf", definition: VALID_DEFINITION, teamId: team.id }),
    });

    const res = await fetch(`${api.baseUrl}/api/workflows`, {
      headers: { "x-valet-test-user-id": "test-member" },
    });
    const { workflows } = (await res.json()) as ListWorkflowsResponse;
    expect(workflows.map((w) => w.name)).toEqual(["team-wf"]);
  });

  it("404s listing/fetching a team-owned workflow for a non-member in the SAME org", async () => {
    api = await bootTestApi();
    const team = await createTeam(api.providers.db, { orgId: "local-org", name: "Platform", creatorUserId: "local-user" });
    const created = await fetch(`${api.baseUrl}/api/workflows`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "team-wf", definition: VALID_DEFINITION, teamId: team.id }),
    }).then((r) => r.json() as Promise<CreateWorkflowResponse>);

    const listRes = await fetch(`${api.baseUrl}/api/workflows`, {
      headers: { "x-valet-test-user-id": "test-member" },
    });
    const { workflows } = (await listRes.json()) as ListWorkflowsResponse;
    expect(workflows).toEqual([]);

    const getRes = await fetch(`${api.baseUrl}/api/workflows/${created.id}`, {
      headers: { "x-valet-test-user-id": "test-member" },
    });
    expect(getRes.status).toBe(404);
  });

  it("404s for a member who has since left the team — membership is re-checked live, not cached", async () => {
    const { removeMember } = await import("../services/teams.js");
    api = await bootTestApi();
    const team = await createTeam(api.providers.db, { orgId: "local-org", name: "Platform", creatorUserId: "local-user" });
    await addMember(api.providers.db, { teamId: team.id, userId: "test-member", role: "member" });
    const created = await fetch(`${api.baseUrl}/api/workflows`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "team-wf", definition: VALID_DEFINITION, teamId: team.id }),
    }).then((r) => r.json() as Promise<CreateWorkflowResponse>);

    await removeMember(api.providers.db, { teamId: team.id, userId: "test-member" });

    const res = await fetch(`${api.baseUrl}/api/workflows/${created.id}`, {
      headers: { "x-valet-test-user-id": "test-member" },
    });
    expect(res.status).toBe(404);
  });

  it("creating a workflow with teamId: null falls through to a personal workflow instead of 404ing", async () => {
    api = await bootTestApi();
    const res = await fetch(`${api.baseUrl}/api/workflows`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "personal-wf", definition: VALID_DEFINITION, teamId: null }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as CreateWorkflowResponse;
    expect(body.ownerType).toBe("user");
    expect(body.ownerId).toBe("local-user");
  });

  it("409s deleting a team that still owns a workflow", async () => {
    api = await bootTestApi();
    const team = await createTeam(api.providers.db, { orgId: "local-org", name: "Platform", creatorUserId: "local-user" });
    await fetch(`${api.baseUrl}/api/workflows`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "team-wf", definition: VALID_DEFINITION, teamId: team.id }),
    });

    const res = await fetch(`${api.baseUrl}/api/teams/${team.id}`, { method: "DELETE" });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; code?: string };
    expect(body.code).toBe("team_owns_workflows");
  });
});

describe("PUT /api/workflows/:id", () => {
  it("updates name and definition", async () => {
    api = await bootTestApi();
    const created = await createWorkflow(api.baseUrl);

    const res = await fetch(`${api.baseUrl}/api/workflows/${created.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "renamed" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as CreateWorkflowResponse;
    expect(body.name).toBe("renamed");
    expect(body.definition).toEqual(VALID_DEFINITION);
  });

  it("400s replacing with an invalid definition", async () => {
    api = await bootTestApi();
    const created = await createWorkflow(api.baseUrl);

    const res = await fetch(`${api.baseUrl}/api/workflows/${created.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ definition: { version: "dag/v1", nodes: [], edges: [] } }),
    });
    expect(res.status).toBe(400);
  });
});

describe("POST /api/workflows/:id/runs", () => {
  it("starts a run against the stub host with an owner + definition snapshot", async () => {
    const stub = new StubRunHost();
    api = await bootTestApi({ workflowRunHost: stub });
    const created = await createWorkflow(api.baseUrl);

    const res = await fetch(`${api.baseUrl}/api/workflows/${created.id}/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: { foo: "bar" } }),
    });
    expect(res.status).toBe(201);
    const { runId } = (await res.json()) as StartWorkflowRunResponse;
    expect(runId).toMatch(/^wfrun_/);

    expect(stub.started).toHaveLength(1);
    expect(stub.started[0].runId).toBe(runId);
    expect(stub.started[0].owner).toEqual({ ownerType: "user", ownerId: "local-user" });
  });

  it("404s starting a run against another owner's workflow", async () => {
    const stub = new StubRunHost();
    api = await bootTestApi({ workflowRunHost: stub });
    const created = await createWorkflow(api.baseUrl);

    const res = await fetch(`${api.baseUrl}/api/workflows/${created.id}/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-valet-test-user-id": "test-member" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(404);
    expect(stub.started).toHaveLength(0);
  });
});

describe("GET /api/workflows/runs/:runId + approvals + cancel", () => {
  it("reads back a run started through the real workflow store, drives approve + cancel via the stub host", async () => {
    const stub = new StubRunHost();
    api = await bootTestApi({ workflowRunHost: stub });
    const created = await createWorkflow(api.baseUrl);

    const startRes = await fetch(`${api.baseUrl}/api/workflows/${created.id}/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const { runId } = (await startRes.json()) as StartWorkflowRunResponse;

    // The stub records `start()` but never actually calls `store.createRun` —
    // Task 10's route handler is responsible for that via the real host in
    // production; here we assert the route asked the host to start, and
    // separately exercise approval/cancel against a run the route itself
    // creates through the store when the host is real. Since this test
    // targets route logic, seed the run directly through the store the
    // route reads from.
    await api.providers.workflowStore.createRun(
      runId,
      { workflowId: created.id, definitionVersionId: "v1" },
      created.definition,
      "v1",
      { ownerType: "user", ownerId: "local-user" },
    );

    const getRes = await fetch(`${api.baseUrl}/api/workflows/runs/${runId}`);
    expect(getRes.status).toBe(200);
    const detail = (await getRes.json()) as GetWorkflowRunResponse;
    expect(detail.run.runId).toBe(runId);
    expect(detail.run.workflowId).toBe(created.id);
    expect(detail.checkpoints).toEqual([]);
    expect(detail.signals).toEqual([]);

    const approveRes = await fetch(`${api.baseUrl}/api/workflows/runs/${runId}/approvals/some-node`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ approved: true, note: "looks good" }),
    });
    expect(approveRes.status).toBe(200);
    expect(await approveRes.json()).toEqual({ ok: true });
    expect(stub.woken).toContain(runId);

    const signals = await api.providers.workflowStore.listSignals(runId);
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      signalId: "approval:some-node:resolution",
      signalType: "approval:some-node",
      payload: { approved: true, resolvedBy: "local-user", note: "looks good" },
    });

    const cancelRes = await fetch(`${api.baseUrl}/api/workflows/runs/${runId}/cancel`, { method: "POST" });
    expect(cancelRes.status).toBe(200);
    expect(await cancelRes.json()).toEqual({ ok: true });
    expect(stub.terminated).toContain(runId);
  });

  it("404s reading another owner's run", async () => {
    const stub = new StubRunHost();
    api = await bootTestApi({ workflowRunHost: stub });
    const created = await createWorkflow(api.baseUrl);
    const runId = "wfrun_cross_owner";
    await api.providers.workflowStore.createRun(
      runId,
      { workflowId: created.id, definitionVersionId: "v1" },
      created.definition,
      "v1",
      { ownerType: "user", ownerId: "test-member" },
    );

    const res = await fetch(`${api.baseUrl}/api/workflows/runs/${runId}`);
    expect(res.status).toBe(404);
  });

  it("a team member manages a run started against a team-owned workflow (get/approve/cancel), matching a schedule/trigger fire's owner shape", async () => {
    const stub = new StubRunHost();
    api = await bootTestApi({ workflowRunHost: stub });
    const team = await createTeam(api.providers.db, { orgId: "local-org", name: "Platform", creatorUserId: "local-user" });
    await addMember(api.providers.db, { teamId: team.id, userId: "test-member", role: "member" });
    const created = await fetch(`${api.baseUrl}/api/workflows`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "team-wf", definition: VALID_DEFINITION, teamId: team.id }),
    }).then((r) => r.json() as Promise<CreateWorkflowResponse>);

    const runId = "wfrun_team_owned";
    // Mirrors what scheduler.ts / events/dispatcher.ts pass to
    // workflowRunHost.start: the fired run's owner is the WORKFLOW's own
    // owner, copied verbatim — not the schedule/trigger creator.
    await api.providers.workflowStore.createRun(
      runId,
      { workflowId: created.id, definitionVersionId: "v1" },
      VALID_DEFINITION,
      "v1",
      { ownerType: "team", ownerId: team.id },
    );

    const memberHeaders = { "x-valet-test-user-id": "test-member" };
    const getRes = await fetch(`${api.baseUrl}/api/workflows/runs/${runId}`, { headers: memberHeaders });
    expect(getRes.status).toBe(200);

    const approveRes = await fetch(`${api.baseUrl}/api/workflows/runs/${runId}/approvals/some-node`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...memberHeaders },
      body: JSON.stringify({ approved: true }),
    });
    expect(approveRes.status).toBe(200);
    expect(stub.woken).toContain(runId);

    const cancelRes = await fetch(`${api.baseUrl}/api/workflows/runs/${runId}/cancel`, {
      method: "POST",
      headers: memberHeaders,
    });
    expect(cancelRes.status).toBe(200);
    expect(stub.terminated).toContain(runId);
  });

  it("404s a team-owned run for a non-member in the SAME org", async () => {
    const stub = new StubRunHost();
    api = await bootTestApi({ workflowRunHost: stub });
    const team = await createTeam(api.providers.db, { orgId: "local-org", name: "Platform", creatorUserId: "local-user" });
    const runId = "wfrun_team_outsider";
    await api.providers.workflowStore.createRun(
      runId,
      { workflowId: "wf_whatever", definitionVersionId: "v1" },
      VALID_DEFINITION,
      "v1",
      { ownerType: "team", ownerId: team.id },
    );

    const res = await fetch(`${api.baseUrl}/api/workflows/runs/${runId}`, {
      headers: { "x-valet-test-user-id": "test-member" },
    });
    expect(res.status).toBe(404);
  });
});

describe("GET /api/workflows/:id/runs", () => {
  it("lists runs for an owned workflow", async () => {
    const stub = new StubRunHost();
    api = await bootTestApi({ workflowRunHost: stub });
    const created = await createWorkflow(api.baseUrl);
    const runId = "wfrun_list_test";
    await api.providers.workflowStore.createRun(
      runId,
      { workflowId: created.id, definitionVersionId: "v1" },
      created.definition,
      "v1",
      { ownerType: "user", ownerId: "local-user" },
    );

    const res = await fetch(`${api.baseUrl}/api/workflows/${created.id}/runs`);
    expect(res.status).toBe(200);
    const { runs } = (await res.json()) as ListWorkflowRunsResponse;
    expect(runs.map((r) => r.runId)).toEqual([runId]);
  });

  it("pages by cursor and rejects a limit outside the accepted range", async () => {
    const stub = new StubRunHost();
    api = await bootTestApi({ workflowRunHost: stub });
    const created = await createWorkflow(api.baseUrl);
    for (const runId of ["wfrun_page_a", "wfrun_page_b", "wfrun_page_c"]) {
      await api.providers.workflowStore.createRun(
        runId,
        { workflowId: created.id, definitionVersionId: "v1" },
        created.definition,
        "v1",
        { ownerType: "user", ownerId: "local-user" },
      );
    }

    const first = await fetch(`${api.baseUrl}/api/workflows/${created.id}/runs?limit=2`);
    const firstPage = (await first.json()) as ListWorkflowRunsResponse;
    expect(firstPage.runs).toHaveLength(2);
    expect(firstPage.nextCursor).toBeDefined();

    const second = await fetch(
      `${api.baseUrl}/api/workflows/${created.id}/runs?limit=2&cursor=${encodeURIComponent(firstPage.nextCursor ?? "")}`,
    );
    const secondPage = (await second.json()) as ListWorkflowRunsResponse;
    expect(secondPage.runs).toHaveLength(1);
    expect(secondPage.nextCursor).toBeUndefined();

    const seen = [...firstPage.runs, ...secondPage.runs].map((r) => r.runId);
    expect(new Set(seen).size).toBe(3);

    const bad = await fetch(`${api.baseUrl}/api/workflows/${created.id}/runs?limit=0`);
    expect(bad.status).toBe(400);
    const badCursor = await fetch(`${api.baseUrl}/api/workflows/${created.id}/runs?cursor=nonsense`);
    expect(badCursor.status).toBe(400);
  });
});

describe("run detail checkpoint links", () => {
  it("surfaces a failed session node's sessionId and a workflow node's childRunId", async () => {
    api = await bootTestApi({ workflowRunHost: new StubRunHost() });
    const created = await createWorkflow(api.baseUrl);
    const runId = "wfrun_links";
    await api.providers.workflowStore.createRun(
      runId,
      { workflowId: created.id, definitionVersionId: "v1" },
      created.definition,
      "v1",
      { ownerType: "user", ownerId: "local-user" },
    );
    const claimed = await api.providers.workflowStore.claimRun(runId, "test-owner", 30_000);
    if (!claimed) throw new Error("expected claim to succeed");
    await api.providers.workflowStore.completeCheckpoint(runId, "ask", 0, claimed.attempt, {
      runId,
      nodeId: "ask",
      iteration: 0,
      status: "failed",
      error: "session failed",
      // What `submission-node.ts` and `workflow-call.ts` actually persist.
      effects: { sessionId: "s_abc", receipt: { threadId: "t1", queueItemId: "q1" }, repairAttempted: false },
      attempt: claimed.attempt,
      createdAt: Date.now(),
    });
    await api.providers.workflowStore.completeCheckpoint(runId, "sub", 0, claimed.attempt, {
      runId,
      nodeId: "sub",
      iteration: 0,
      status: "completed",
      effects: { childRunId: "wfrun_sub_child" },
      attempt: claimed.attempt,
      createdAt: Date.now(),
    });

    const res = await fetch(`${api.baseUrl}/api/workflows/runs/${runId}`);
    expect(res.status).toBe(200);
    const detail = (await res.json()) as GetWorkflowRunResponse;
    const ask = detail.checkpoints.find((cp) => cp.nodeId === "ask");
    const sub = detail.checkpoints.find((cp) => cp.nodeId === "sub");
    expect(ask?.sessionId).toBe("s_abc");
    expect(sub?.childRunId).toBe("wfrun_sub_child");
    // The rest of the effects bag stays off the wire.
    expect(JSON.stringify(detail.checkpoints)).not.toContain("repairAttempted");
  });
});

describe("DELETE /api/workflows/:id with a run in flight", () => {
  it("409s while a run is not settled, then deletes once it settles", async () => {
    api = await bootTestApi({ workflowRunHost: new StubRunHost() });
    const created = await createWorkflow(api.baseUrl);
    const runId = "wfrun_active";
    await api.providers.workflowStore.createRun(
      runId,
      { workflowId: created.id, definitionVersionId: "v1" },
      created.definition,
      "v1",
      { ownerType: "user", ownerId: "local-user" },
    );

    const blocked = await fetch(`${api.baseUrl}/api/workflows/${created.id}`, { method: "DELETE" });
    expect(blocked.status).toBe(409);

    await api.providers.workflowStore.settleRun(runId, "completed");
    const deleted = await fetch(`${api.baseUrl}/api/workflows/${created.id}`, { method: "DELETE" });
    expect(deleted.status).toBe(200);
  });
});

describe("GET /api/workflows/runs", () => {
  /** Seeds one run, returning its id. */
  async function seedRun(
    testApi: TestApi,
    workflowId: string,
    runId: string,
    params: Record<string, unknown> = {},
  ): Promise<string> {
    await testApi.providers.workflowStore.createRun(
      runId,
      { workflowId, definitionVersionId: "v1", ...params },
      VALID_DEFINITION,
      "v1",
      { ownerType: "user", ownerId: "local-user" },
    );
    return runId;
  }

  it("resolves to the cross-workflow list, not to GET /:id with id='runs'", async () => {
    api = await bootTestApi({ workflowRunHost: new StubRunHost() });
    const res = await fetch(`${api.baseUrl}/api/workflows/runs`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListWorkflowRunsResponse;
    expect(body.runs).toEqual([]);
  });

  it("lists runs across every workflow the caller owns", async () => {
    api = await bootTestApi({ workflowRunHost: new StubRunHost() });
    const first = await createWorkflow(api.baseUrl, "wf-one");
    const second = await createWorkflow(api.baseUrl, "wf-two");
    await seedRun(api, first.id, "wfrun_cross_a");
    await seedRun(api, second.id, "wfrun_cross_b");

    const res = await fetch(`${api.baseUrl}/api/workflows/runs`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListWorkflowRunsResponse;
    expect(new Set(body.runs.map((r) => r.runId))).toEqual(
      new Set(["wfrun_cross_a", "wfrun_cross_b"]),
    );
  });

  it("returns a batch parent's children in one query via parentRunId", async () => {
    api = await bootTestApi({ workflowRunHost: new StubRunHost() });
    const created = await createWorkflow(api.baseUrl);
    await seedRun(api, created.id, "wfrun_batch_parent");
    await seedRun(api, created.id, "wfrun_batch_child_1", {
      parentRunId: "wfrun_batch_parent",
      parentNodeId: "fanout",
      parentIteration: 0,
    });
    await seedRun(api, created.id, "wfrun_batch_child_2", {
      parentRunId: "wfrun_batch_parent",
      parentNodeId: "fanout",
      parentIteration: 1,
    });

    const res = await fetch(`${api.baseUrl}/api/workflows/runs?parentRunId=wfrun_batch_parent`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListWorkflowRunsResponse;
    expect(new Set(body.runs.map((r) => r.runId))).toEqual(
      new Set(["wfrun_batch_child_1", "wfrun_batch_child_2"]),
    );
    expect(body.runs.every((r) => r.parentRunId === "wfrun_batch_parent")).toBe(true);
    expect(body.runs.map((r) => r.parentNodeId)).toEqual(["fanout", "fanout"]);
  });

  it("filters by status and rejects an unknown one", async () => {
    api = await bootTestApi({ workflowRunHost: new StubRunHost() });
    const created = await createWorkflow(api.baseUrl);
    await seedRun(api, created.id, "wfrun_status_pending");
    await seedRun(api, created.id, "wfrun_status_settled");
    await api.providers.workflowStore.settleRun("wfrun_status_settled", "completed");

    const res = await fetch(`${api.baseUrl}/api/workflows/runs?status=settled`);
    const body = (await res.json()) as ListWorkflowRunsResponse;
    expect(body.runs.map((r) => r.runId)).toEqual(["wfrun_status_settled"]);
    expect(body.runs[0].outcome).toBe("completed");

    const bad = await fetch(`${api.baseUrl}/api/workflows/runs?status=nope`);
    expect(bad.status).toBe(400);
  });

  it("404s a workflowId the caller cannot read, and hides its runs from an unfiltered list", async () => {
    api = await bootTestApi({ workflowRunHost: new StubRunHost() });
    const created = await createWorkflow(api.baseUrl);
    await seedRun(api, created.id, "wfrun_private");
    const headers = { "x-valet-test-user-id": "test-member" };

    const filtered = await fetch(
      `${api.baseUrl}/api/workflows/runs?workflowId=${created.id}`,
      { headers },
    );
    expect(filtered.status).toBe(404);

    const unfiltered = await fetch(`${api.baseUrl}/api/workflows/runs`, { headers });
    expect(unfiltered.status).toBe(200);
    const body = (await unfiltered.json()) as ListWorkflowRunsResponse;
    expect(body.runs).toEqual([]);
  });

  // `created_at` is an integer column. A value it cannot hold must answer 400
  // with the corrective action, never a 500 carrying a driver syntax error.
  it("400s a since or cursor value the run store cannot hold", async () => {
    api = await bootTestApi({ workflowRunHost: new StubRunHost() });
    const created = await createWorkflow(api.baseUrl);
    await seedRun(api, created.id, "wfrun_bounds");

    for (const query of ["since=1.5", "since=1e30", "since=-1", "cursor=1.5%3Awfrun_bounds"]) {
      const res = await fetch(`${api.baseUrl}/api/workflows/runs?${query}`);
      expect([query, res.status]).toEqual([query, 400]);
      const body = (await res.json()) as { error: string };
      expect(body.error).toMatch(/millisecond timestamp|nextCursor/);
    }

    const ok = await fetch(`${api.baseUrl}/api/workflows/runs?since=0`);
    expect(ok.status).toBe(200);
  });
});

describe("POST/GET/DELETE /api/workflows/:id/webhook", () => {
  it("mints a hookId, then reads it back via GET", async () => {
    api = await bootTestApi();
    const created = await createWorkflow(api.baseUrl);

    const minted = await fetch(`${api.baseUrl}/api/workflows/${created.id}/webhook`, { method: "POST" });
    expect(minted.status).toBe(200);
    const mintedBody = (await minted.json()) as WorkflowWebhookResponse;
    expect(mintedBody.workflowId).toBe(created.id);
    expect(mintedBody.hookId).toMatch(/^[0-9a-f]{64}$/);

    const fetched = await fetch(`${api.baseUrl}/api/workflows/${created.id}/webhook`);
    expect(fetched.status).toBe(200);
    const fetchedBody = (await fetched.json()) as WorkflowWebhookResponse;
    expect(fetchedBody.hookId).toBe(mintedBody.hookId);
  });

  it("GET 404s when the workflow has no webhook yet", async () => {
    api = await bootTestApi();
    const created = await createWorkflow(api.baseUrl);

    const res = await fetch(`${api.baseUrl}/api/workflows/${created.id}/webhook`);
    expect(res.status).toBe(404);
  });

  it("POST/GET/DELETE all 404 against another owner's workflow", async () => {
    api = await bootTestApi();
    const created = await createWorkflow(api.baseUrl);
    const headers = { "x-valet-test-user-id": "test-member" };

    const post = await fetch(`${api.baseUrl}/api/workflows/${created.id}/webhook`, { method: "POST", headers });
    expect(post.status).toBe(404);

    const get = await fetch(`${api.baseUrl}/api/workflows/${created.id}/webhook`, { headers });
    expect(get.status).toBe(404);

    const del = await fetch(`${api.baseUrl}/api/workflows/${created.id}/webhook`, { method: "DELETE", headers });
    expect(del.status).toBe(404);
  });

  it("rotating changes the hookId", async () => {
    api = await bootTestApi();
    const created = await createWorkflow(api.baseUrl);

    const first = await fetch(`${api.baseUrl}/api/workflows/${created.id}/webhook`, { method: "POST" });
    const firstBody = (await first.json()) as WorkflowWebhookResponse;
    const second = await fetch(`${api.baseUrl}/api/workflows/${created.id}/webhook`, { method: "POST" });
    const secondBody = (await second.json()) as WorkflowWebhookResponse;
    expect(secondBody.hookId).not.toBe(firstBody.hookId);
  });

  it("DELETE removes an existing hook and returns deleted:true", async () => {
    api = await bootTestApi();
    const created = await createWorkflow(api.baseUrl);
    await fetch(`${api.baseUrl}/api/workflows/${created.id}/webhook`, { method: "POST" });

    const res = await fetch(`${api.baseUrl}/api/workflows/${created.id}/webhook`, { method: "DELETE" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as DeleteWorkflowWebhookResponse;
    expect(body.deleted).toBe(true);

    const afterDelete = await fetch(`${api.baseUrl}/api/workflows/${created.id}/webhook`);
    expect(afterDelete.status).toBe(404);
  });

  it("DELETE on an owned workflow with no hook returns deleted:false (not a 404 — the workflow itself is fine)", async () => {
    api = await bootTestApi();
    const created = await createWorkflow(api.baseUrl);

    const res = await fetch(`${api.baseUrl}/api/workflows/${created.id}/webhook`, { method: "DELETE" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as DeleteWorkflowWebhookResponse;
    expect(body.deleted).toBe(false);
  });
});
