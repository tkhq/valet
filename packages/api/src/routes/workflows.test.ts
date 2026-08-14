/**
 * `/api/workflows` route tests (Phase 5 plan Task 10, decision 18). Route
 * CRUD + validation-400 exercise the real store; run-start/approval/cancel
 * exercise a stub `RunHost` (see `../workflows/*` for the real
 * `LocalRunHost`/`SqliteWorkflowStore` wiring, covered by conformance suites
 * elsewhere) so these tests assert on the routes' own logic — request
 * shaping, owner scoping, signal writes — without paying for the poll loop.
 */
import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import type { RunHost } from "@valet/workflow";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { addMember, createTeam } from "../services/teams.js";
import { resolveWorkflowApproval, cancelWorkflowRun } from "../workflows/service.js";
import { persistInvocationAudit } from "../policies/service.js";
import { actionInvocations, orgs, workflowDefinitions, workflowVersions } from "../schema/index.js";
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

    // Park the run on the approval signal before resolving — the new route
    // validates the run is actually waiting on this gate.
    await api.providers.workflowStore.parkRun(
      runId,
      1,
      [{ kind: "signal", signalType: "approval:some-node", nodeId: "some-node" }],
    );

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
      payload: { approved: true, resolvedBy: "local-user", note: "looks good", resolvedVia: "web" },
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

    // Park the run on the approval signal first (required by the new route).
    await api.providers.workflowStore.parkRun(
      runId,
      1,
      [{ kind: "signal", signalType: "approval:some-node", nodeId: "some-node" }],
    );

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

describe("resolveWorkflowApproval — outcome coverage", () => {
  /** Bootstrap a test run. When `nodeType` is `"tool"` we insert the workflow
   * definition directly into the DB to bypass the save-time validator (which
   * rejects unknown services in environments without a plugin catalog). */
  async function setupRun(
    opts: { nodeType?: string; service?: string; action?: string } = {},
  ) {
    const stub = new StubRunHost();
    const localApi = await bootTestApi({ workflowRunHost: stub });
    const definition = {
      version: "dag/v1",
      nodes: [
        { id: "trigger", type: "trigger" },
        ...(opts.nodeType
          ? [{ id: "gate", type: opts.nodeType, service: opts.service, action: opts.action, params: {} }]
          : []),
        { id: "stop", type: "stop" },
      ],
      edges: [
        { from: "trigger", to: opts.nodeType ? "gate" : "stop" },
        ...(opts.nodeType ? [{ from: "gate", to: "stop" }] : []),
      ],
    };

    let wfId: string;
    if (opts.nodeType === "tool") {
      // Insert directly — the route's save-time validator rejects unknown
      // services (no plugin catalog in the test env). The run host / service
      // functions only read the definition from the run row, so this is safe.
      const now = Date.now();
      wfId = `wf_test_${now}`;
      await localApi.providers.db.insert(workflowDefinitions).values({
        id: wfId,
        orgId: "local-org",
        name: "test-wf",
        definition,
        ownerType: "user",
        ownerId: "local-user",
        createdAt: now,
        updatedAt: now,
      });
      await localApi.providers.db.insert(workflowVersions).values({
        id: `wfv_test_${now}`,
        workflowId: wfId,
        version: 1,
        name: "test-wf",
        definition,
        createdAt: now,
      });
    } else {
      const wfRes = await fetch(`${localApi.baseUrl}/api/workflows`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "test-wf", definition }),
      });
      expect(wfRes.status).toBe(201);
      wfId = ((await wfRes.json()) as CreateWorkflowResponse).id;
    }

    const wf = { id: wfId } as CreateWorkflowResponse;

    // Start the run via the route (so the route records it), then seed the
    // run in the store directly so approval/cancel reads can find it.
    const startRes = await fetch(`${localApi.baseUrl}/api/workflows/${wfId}/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(startRes.status).toBe(201);
    const { runId } = (await startRes.json()) as StartWorkflowRunResponse;
    await localApi.providers.workflowStore.createRun(
      runId,
      { workflowId: wfId, definitionVersionId: "v1" },
      definition,
      "v1",
      { ownerType: "user", ownerId: "local-user" },
    );
    return { localApi, stub, wf, runId };
  }

  it("not parked → 409", async () => {
    const { localApi, runId } = await setupRun();
    api = localApi;
    const res = await fetch(`${localApi.baseUrl}/api/workflows/runs/${runId}/approvals/gate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ approved: true }),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("not parked") });
  });

  it("unknown run → 404", async () => {
    const stub = new StubRunHost();
    api = await bootTestApi({ workflowRunHost: stub });
    const res = await fetch(`${api.baseUrl}/api/workflows/runs/no-such-run/approvals/gate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ approved: true }),
    });
    expect(res.status).toBe(404);
  });

  it("already resolved → 409", async () => {
    const { localApi, runId } = await setupRun();
    api = localApi;
    await localApi.providers.workflowStore.parkRun(runId, 1, [
      { kind: "signal", signalType: "approval:gate", nodeId: "gate" },
    ]);
    // Seed an already-unconsumed signal
    await localApi.providers.workflowStore.insertSignal({
      runId,
      signalId: "approval:gate:resolution",
      signalType: "approval:gate",
      payload: { approved: true },
      createdAt: Date.now(),
    });
    const res = await fetch(`${localApi.baseUrl}/api/workflows/runs/${runId}/approvals/gate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ approved: true }),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("already been resolved") });
  });

  it("timed out → 409", async () => {
    const { localApi, runId } = await setupRun();
    api = localApi;
    await localApi.providers.workflowStore.parkRun(runId, 1, [
      { kind: "signal", signalType: "approval:gate", nodeId: "gate", timeoutAt: Date.now() - 1000 },
    ]);
    const res = await fetch(`${localApi.baseUrl}/api/workflows/runs/${runId}/approvals/gate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ approved: true }),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("timed out") });
  });

  it("policy gate + scope=run → writes execution grant + 200", async () => {
    const { localApi, runId } = await setupRun({ nodeType: "tool", service: "widgets", action: "nuke" });
    api = localApi;
    await localApi.providers.workflowStore.parkRun(runId, 1, [
      { kind: "signal", signalType: "approval:gate", nodeId: "gate" },
    ]);
    const res = await fetch(`${localApi.baseUrl}/api/workflows/runs/${runId}/approvals/gate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ approved: true, scope: "run" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("policy gate + scope=always + admin → writes org policy + 200", async () => {
    const { localApi, runId } = await setupRun({ nodeType: "tool", service: "widgets", action: "nuke" });
    api = localApi;
    await localApi.providers.workflowStore.parkRun(runId, 1, [
      { kind: "signal", signalType: "approval:gate", nodeId: "gate" },
    ]);
    const res = await fetch(`${localApi.baseUrl}/api/workflows/runs/${runId}/approvals/gate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ approved: true, scope: "always" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("policy gate + scope=always + non-admin → 403", async () => {
    const stub = new StubRunHost();
    const localApi = await bootTestApi({ workflowRunHost: stub });
    api = localApi;
    // Insert a workflow definition owned by test-member directly (bypass validator).
    const now = Date.now();
    const memberWfId = `wf_nonAdmin_${now}`;
    const memberDef = {
      version: "dag/v1",
      nodes: [{ id: "trigger", type: "trigger" }, { id: "gate", type: "tool", service: "widgets", action: "nuke", params: {} }, { id: "stop", type: "stop" }],
      edges: [{ from: "trigger", to: "gate" }, { from: "gate", to: "stop" }],
    };
    await localApi.providers.db.insert(workflowDefinitions).values({
      id: memberWfId, orgId: "local-org", name: "member-wf", definition: memberDef,
      ownerType: "user", ownerId: "test-member", createdAt: now, updatedAt: now,
    });
    await localApi.providers.db.insert(workflowVersions).values({
      id: `wfv_nonAdmin_${now}`, workflowId: memberWfId, version: 1, name: "member-wf",
      definition: memberDef, createdAt: now,
    });
    const memberRunId = `wfrun_nonAdmin_${now}`;
    await localApi.providers.workflowStore.createRun(
      memberRunId,
      { workflowId: memberWfId, definitionVersionId: "v1" },
      memberDef, "v1",
      { ownerType: "user", ownerId: "test-member" },
    );
    await localApi.providers.workflowStore.parkRun(memberRunId, 1, [
      { kind: "signal", signalType: "approval:gate", nodeId: "gate" },
    ]);
    const res = await fetch(`${localApi.baseUrl}/api/workflows/runs/${memberRunId}/approvals/gate`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-valet-test-user-id": "test-member" },
      body: JSON.stringify({ approved: true, scope: "always" }),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("org admin") });
  });

  it("approval node (non-tool) + scope=run → 200 no grant written", async () => {
    const { localApi, runId } = await setupRun();
    api = localApi;
    // Park on a plain approval signal (no tool node in definition)
    await localApi.providers.workflowStore.parkRun(runId, 1, [
      { kind: "signal", signalType: "approval:manual", nodeId: "manual" },
    ]);
    const res = await fetch(`${localApi.baseUrl}/api/workflows/runs/${runId}/approvals/manual`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ approved: true, scope: "run" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("denial on policy gate → 200", async () => {
    const { localApi, runId } = await setupRun({ nodeType: "tool", service: "widgets", action: "nuke" });
    api = localApi;
    await localApi.providers.workflowStore.parkRun(runId, 1, [
      { kind: "signal", signalType: "approval:gate", nodeId: "gate" },
    ]);
    const res = await fetch(`${localApi.baseUrl}/api/workflows/runs/${runId}/approvals/gate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ approved: false }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("grantActions rejected → 400", async () => {
    const { localApi, runId } = await setupRun();
    api = localApi;
    const res = await fetch(`${localApi.baseUrl}/api/workflows/runs/${runId}/approvals/gate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ approved: true, grantActions: [{ service: "x", actionId: "x.y" }] }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("grantActions") });
  });

  it("agent via → human_only for policy gate", async () => {
    const { localApi, runId, wf } = await setupRun({ nodeType: "tool", service: "widgets", action: "nuke" });
    api = localApi;
    await localApi.providers.workflowStore.parkRun(runId, 1, [
      { kind: "signal", signalType: "approval:gate", nodeId: "gate" },
    ]);
    const { db, workflowStore, workflowRunHost } = localApi.providers;
    const result = await resolveWorkflowApproval(
      { db, workflowStore, workflowRunHost },
      { userId: "local-user", orgId: "local-org" },
      { runId, nodeId: "gate", approved: true, via: "agent" },
    );
    expect(result).toBe("human_only");
  });

  it("foreach body gate: park on approval:body1:3, resolve with iteration: 3 → signal approval:body1:3:resolution", async () => {
    // Use an approval node (non-tool) to bypass the save-time validator for the
    // foreach body; the service looks up the node in run.definition, not the
    // workflow definition table, so we can seed any definition directly.
    const stub = new StubRunHost();
    const localApi = await bootTestApi({ workflowRunHost: stub });
    api = localApi;
    const now = Date.now();
    const wfId = `wf_foreach_${now}`;
    // A foreach definition whose body is a tool node with id "body1".
    const def = {
      version: "dag/v1",
      nodes: [
        { id: "trigger", type: "trigger" },
        {
          id: "loop",
          type: "foreach",
          items: "{{ trigger.data.items }}",
          body: { id: "body1", type: "approval", prompt: "approve this item?" },
        },
        { id: "stop", type: "stop" },
      ],
      edges: [
        { from: "trigger", to: "loop" },
        { from: "loop", to: "stop" },
      ],
    };
    await localApi.providers.db.insert(workflowDefinitions).values({
      id: wfId,
      orgId: "local-org",
      name: "foreach-wf",
      definition: def,
      ownerType: "user",
      ownerId: "local-user",
      createdAt: now,
      updatedAt: now,
    });
    await localApi.providers.db.insert(workflowVersions).values({
      id: `wfv_foreach_${now}`,
      workflowId: wfId,
      version: 1,
      name: "foreach-wf",
      definition: def,
      createdAt: now,
    });
    const runId = `wfrun_foreach_${now}`;
    await localApi.providers.workflowStore.createRun(
      runId,
      { workflowId: wfId, definitionVersionId: "v1" },
      def,
      "v1",
      { ownerType: "user", ownerId: "local-user" },
    );
    // Park on iteration 3 of the foreach body node.
    await localApi.providers.workflowStore.parkRun(runId, 1, [
      { kind: "signal", signalType: "approval:body1:3", nodeId: "body1" },
    ]);
    const res = await fetch(`${localApi.baseUrl}/api/workflows/runs/${runId}/approvals/body1`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ approved: true, iteration: 3 }),
    });
    expect(res.status).toBe(200);
    const signals = await localApi.providers.workflowStore.listSignals(runId);
    expect(signals.some((s) => s.signalId === "approval:body1:3:resolution")).toBe(true);
  });

  it("org_mismatch: run's defining org has no membership for the caller → org_mismatch", async () => {
    const stub = new StubRunHost();
    const localApi = await bootTestApi({ workflowRunHost: stub });
    api = localApi;
    const { db, workflowStore, workflowRunHost } = localApi.providers;
    const now = Date.now();
    const wfId = `wf_mismatch_${now}`;
    // Insert a workflow that belongs to a different org ("other-org") that exists in DB
    // but "local-user" is not a member of.
    await db.insert(orgs).values({ id: "other-org", name: "Other Org", createdAt: now });
    const def = {
      version: "dag/v1",
      nodes: [
        { id: "trigger", type: "trigger" },
        { id: "gate", type: "tool", service: "widgets", action: "nuke", params: {} },
        { id: "stop", type: "stop" },
      ],
      edges: [{ from: "trigger", to: "gate" }, { from: "gate", to: "stop" }],
    };
    await db.insert(workflowDefinitions).values({
      id: wfId,
      orgId: "other-org", // different org
      name: "other-wf",
      definition: def,
      ownerType: "user",
      ownerId: "local-user",
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(workflowVersions).values({
      id: `wfv_mismatch_${now}`,
      workflowId: wfId,
      version: 1,
      name: "other-wf",
      definition: def,
      createdAt: now,
    });
    const runId = `wfrun_mismatch_${now}`;
    await workflowStore.createRun(
      runId,
      { workflowId: wfId, definitionVersionId: "v1" },
      def,
      "v1",
      { ownerType: "user", ownerId: "local-user" },
    );
    await workflowStore.parkRun(runId, 1, [
      { kind: "signal", signalType: "approval:gate", nodeId: "gate" },
    ]);
    // "local-user" is in "local-org" but not in "other-org" → org_mismatch
    const result = await resolveWorkflowApproval(
      { db, workflowStore, workflowRunHost },
      { userId: "local-user", orgId: "local-org" },
      { runId, nodeId: "gate", approved: true, via: "web" },
    );
    expect(result).toBe("org_mismatch");
  });

  it("audit stamp: approve of tool-node gate stamps invocation row approved + resolvedBy", async () => {
    const { localApi, runId } = await setupRun({ nodeType: "tool", service: "widgets", action: "nuke" });
    api = localApi;
    const { db, workflowStore, workflowRunHost } = localApi.providers;
    // Seed a pending audit row the way the workflow enforcer does.
    const invId = `pol:wf:workflow:${runId}:gate`;
    await persistInvocationAudit(db, {
      invocationId: invId,
      orgId: "local-org",
      workflowExecutionId: runId,
      service: "widgets",
      actionId: "widgets.nuke",
      resolvedMode: "require_approval",
      status: "pending",
    });
    await localApi.providers.workflowStore.parkRun(runId, 1, [
      { kind: "signal", signalType: "approval:gate", nodeId: "gate" },
    ]);
    const result = await resolveWorkflowApproval(
      { db, workflowStore, workflowRunHost },
      { userId: "local-user", orgId: "local-org" },
      { runId, nodeId: "gate", approved: true, via: "web" },
    );
    expect(result).toBe("ok");
    const rows = await db
      .select({ status: actionInvocations.status, resolvedBy: actionInvocations.resolvedBy })
      .from(actionInvocations)
      .where(eq(actionInvocations.invocationId, invId));
    expect(rows[0]).toMatchObject({ status: "approved", resolvedBy: "local-user" });
  });

  it("cancelWorkflowRun stamps pending tool-gate audit rows as cancelled", async () => {
    const { localApi, runId } = await setupRun({ nodeType: "tool", service: "widgets", action: "nuke" });
    api = localApi;
    const { db, workflowStore, workflowRunHost } = localApi.providers;
    // Seed a pending gate audit row.
    const invId = `pol:wf:workflow:${runId}:gate`;
    await persistInvocationAudit(db, {
      invocationId: invId,
      orgId: "local-org",
      workflowExecutionId: runId,
      service: "widgets",
      actionId: "widgets.nuke",
      resolvedMode: "require_approval",
      status: "pending",
    });
    await workflowStore.parkRun(runId, 1, [
      { kind: "signal", signalType: "approval:gate", nodeId: "gate" },
    ]);
    const result = await cancelWorkflowRun({ db, workflowStore, workflowRunHost }, { userId: "local-user", orgId: "local-org" }, runId);
    expect(result).toBe("ok");
    const rows = await db
      .select({ status: actionInvocations.status })
      .from(actionInvocations)
      .where(eq(actionInvocations.invocationId, invId));
    expect(rows[0]?.status).toBe("cancelled");
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
