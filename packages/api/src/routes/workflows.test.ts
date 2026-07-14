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
import type {
  CreateWorkflowResponse,
  GetWorkflowRunResponse,
  ListWorkflowRunsResponse,
  ListWorkflowsResponse,
  StartWorkflowRunResponse,
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
