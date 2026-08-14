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
import { workflowSchedules } from "../schema/index.js";
import type {
  CreateWorkflowResponse,
  CreateWorkflowScheduleResponse,
  ListWorkflowSchedulesResponse,
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

describe("GET /api/workflows?ownerType=&ownerId=", () => {
  const HALF_FILTER_ERROR = "Filter by owner with both ownerType and ownerId, or send neither.";

  /** A team-owned workflow, created the way a client creates one. */
  async function createTeamWorkflow(
    baseUrl: string,
    teamId: string,
    name: string,
  ): Promise<CreateWorkflowResponse> {
    const res = await fetch(`${baseUrl}/api/workflows`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, definition: VALID_DEFINITION, teamId }),
    });
    expect(res.status).toBe(201);
    return (await res.json()) as CreateWorkflowResponse;
  }

  it("returns the own-plus-teams union unchanged when neither param is given", async () => {
    api = await bootTestApi();
    const team = await createTeam(api.providers.db, { orgId: "local-org", name: "Platform", creatorUserId: "local-user" });
    await createWorkflow(api.baseUrl, "personal");
    await createTeamWorkflow(api.baseUrl, team.id, "team-owned");
    await fetch(`${api.baseUrl}/api/workflows`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-valet-test-user-id": "test-member" },
      body: JSON.stringify({ name: "someone-elses", definition: VALID_DEFINITION }),
    });

    const res = await fetch(`${api.baseUrl}/api/workflows`);
    expect(res.status).toBe(200);
    const { workflows } = (await res.json()) as ListWorkflowsResponse;
    expect(workflows.map((w) => w.name).sort()).toEqual(["personal", "team-owned"]);
  });

  it("narrows to one team the caller is on", async () => {
    api = await bootTestApi();
    const platform = await createTeam(api.providers.db, { orgId: "local-org", name: "Platform", creatorUserId: "local-user" });
    const growth = await createTeam(api.providers.db, { orgId: "local-org", name: "Growth", creatorUserId: "local-user" });
    await createWorkflow(api.baseUrl, "personal");
    await createTeamWorkflow(api.baseUrl, platform.id, "platform-wf");
    await createTeamWorkflow(api.baseUrl, growth.id, "growth-wf");

    const res = await fetch(`${api.baseUrl}/api/workflows?ownerType=team&ownerId=${platform.id}`);
    expect(res.status).toBe(200);
    const { workflows } = (await res.json()) as ListWorkflowsResponse;
    expect(workflows.map((w) => w.name)).toEqual(["platform-wf"]);
    expect(workflows.map((w) => w.ownerId)).toEqual([platform.id]);
  });

  it("narrows to the caller's own rows, dropping the teams", async () => {
    api = await bootTestApi();
    const team = await createTeam(api.providers.db, { orgId: "local-org", name: "Platform", creatorUserId: "local-user" });
    await createWorkflow(api.baseUrl, "personal");
    await createTeamWorkflow(api.baseUrl, team.id, "team-owned");

    const res = await fetch(`${api.baseUrl}/api/workflows?ownerType=user&ownerId=local-user`);
    expect(res.status).toBe(200);
    const { workflows } = (await res.json()) as ListWorkflowsResponse;
    expect(workflows.map((w) => w.name)).toEqual(["personal"]);
  });

  it("404s a team the caller is not on, and the error names neither the team nor its id", async () => {
    api = await bootTestApi();
    const team = await createTeam(api.providers.db, { orgId: "local-org", name: "Platform", creatorUserId: "local-user" });
    await createTeamWorkflow(api.baseUrl, team.id, "team-owned");

    const res = await fetch(`${api.baseUrl}/api/workflows?ownerType=team&ownerId=${team.id}`, {
      headers: { "x-valet-test-user-id": "test-member" },
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("owner not found");
    expect(body.error).not.toContain(team.id);
    expect(body.error).not.toContain("Platform");
  });

  it("answers an owner that does not exist exactly as it answers one the caller may not reach", async () => {
    api = await bootTestApi();
    const team = await createTeam(api.providers.db, { orgId: "local-org", name: "Platform", creatorUserId: "local-user" });
    const asOutsider = { "x-valet-test-user-id": "test-member" };

    const forbidden = await fetch(`${api.baseUrl}/api/workflows?ownerType=team&ownerId=${team.id}`, {
      headers: asOutsider,
    });
    const missing = await fetch(`${api.baseUrl}/api/workflows?ownerType=team&ownerId=team_nonexistent`, {
      headers: asOutsider,
    });

    expect(forbidden.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual(await forbidden.json());
  });

  it("404s another user's rows, org admin included", async () => {
    api = await bootTestApi();
    await fetch(`${api.baseUrl}/api/workflows`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-valet-test-user-id": "test-member" },
      body: JSON.stringify({ name: "someone-elses", definition: VALID_DEFINITION }),
    });

    // `local-user` administers the org. Org administration is not a read
    // path into a member's personal workflows.
    const res = await fetch(`${api.baseUrl}/api/workflows?ownerType=user&ownerId=test-member`);
    expect(res.status).toBe(404);
  });

  it("404s an org filter — nothing admits a caller to an org-owned workflow yet", async () => {
    api = await bootTestApi();
    const res = await fetch(`${api.baseUrl}/api/workflows?ownerType=org&ownerId=local-org`);
    expect(res.status).toBe(404);
  });

  it("400s a half-given filter, naming the fix", async () => {
    api = await bootTestApi();
    const team = await createTeam(api.providers.db, { orgId: "local-org", name: "Platform", creatorUserId: "local-user" });

    const typeOnly = await fetch(`${api.baseUrl}/api/workflows?ownerType=team`);
    expect(typeOnly.status).toBe(400);
    expect(((await typeOnly.json()) as { error: string }).error).toBe(HALF_FILTER_ERROR);

    const idOnly = await fetch(`${api.baseUrl}/api/workflows?ownerId=${team.id}`);
    expect(idOnly.status).toBe(400);
    expect(((await idOnly.json()) as { error: string }).error).toBe(HALF_FILTER_ERROR);
  });

  it("400s an ownerType outside the three an owner column holds", async () => {
    api = await bootTestApi();
    const res = await fetch(`${api.baseUrl}/api/workflows?ownerType=squad&ownerId=whatever`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("ownerType must be 'user', 'team' or 'org'.");
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

describe("GET/POST/DELETE /api/workflows/:id/schedules", () => {
  it("creates a schedule and lists it for that workflow only", async () => {
    api = await bootTestApi();
    const a = await createWorkflow(api.baseUrl, "with-schedule");
    const b = await createWorkflow(api.baseUrl, "without-schedule");

    const created = await fetch(`${api.baseUrl}/api/workflows/${a.id}/schedules`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "nightly", cron: "0 9 * * *" }),
    });
    expect(created.status).toBe(201);
    const schedule = (await created.json()) as CreateWorkflowScheduleResponse;
    expect(schedule.workflowId).toBe(a.id);
    expect(schedule.enabled).toBe(true);
    expect(schedule.timezone).toBe("UTC");
    expect(schedule.nextFireAt).toBeGreaterThan(Date.now());

    const listA = await fetch(`${api.baseUrl}/api/workflows/${a.id}/schedules`);
    const bodyA = (await listA.json()) as ListWorkflowSchedulesResponse;
    expect(bodyA.schedules.map((s) => s.scheduleId)).toEqual([schedule.scheduleId]);

    const listB = await fetch(`${api.baseUrl}/api/workflows/${b.id}/schedules`);
    const bodyB = (await listB.json()) as ListWorkflowSchedulesResponse;
    expect(bodyB.schedules).toEqual([]);
  });

  it("400s an invalid cron with the corrective error text", async () => {
    api = await bootTestApi();
    const created = await createWorkflow(api.baseUrl);
    const res = await fetch(`${api.baseUrl}/api/workflows/${created.id}/schedules`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "bad", cron: "every day at nine" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("cron");
  });

  it("404s schedule routes on another owner's workflow", async () => {
    api = await bootTestApi();
    const created = await createWorkflow(api.baseUrl);
    const asOther = { "x-valet-test-user-id": "test-member" };

    const list = await fetch(`${api.baseUrl}/api/workflows/${created.id}/schedules`, {
      headers: asOther,
    });
    expect(list.status).toBe(404);

    const post = await fetch(`${api.baseUrl}/api/workflows/${created.id}/schedules`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...asOther },
      body: JSON.stringify({ name: "sneaky", cron: "0 9 * * *" }),
    });
    expect(post.status).toBe(404);
  });

  it("DELETE removes only a schedule that belongs to that workflow", async () => {
    api = await bootTestApi();
    const a = await createWorkflow(api.baseUrl, "schedule-owner");
    const b = await createWorkflow(api.baseUrl, "other-workflow");

    const created = await fetch(`${api.baseUrl}/api/workflows/${a.id}/schedules`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "nightly", cron: "0 9 * * *" }),
    });
    const schedule = (await created.json()) as CreateWorkflowScheduleResponse;

    // Through the WRONG workflow's path: 404, row survives.
    const cross = await fetch(
      `${api.baseUrl}/api/workflows/${b.id}/schedules/${schedule.scheduleId}`,
      { method: "DELETE" },
    );
    expect(cross.status).toBe(404);

    const del = await fetch(
      `${api.baseUrl}/api/workflows/${a.id}/schedules/${schedule.scheduleId}`,
      { method: "DELETE" },
    );
    expect(del.status).toBe(200);
    const listA = await fetch(`${api.baseUrl}/api/workflows/${a.id}/schedules`);
    const bodyA = (await listA.json()) as ListWorkflowSchedulesResponse;
    expect(bodyA.schedules).toEqual([]);
  });

  it("400s a whitespace-only name and trims a valid one", async () => {
    api = await bootTestApi();
    const created = await createWorkflow(api.baseUrl);

    const blank = await fetch(`${api.baseUrl}/api/workflows/${created.id}/schedules`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "   ", cron: "0 9 * * *" }),
    });
    expect(blank.status).toBe(400);

    const padded = await fetch(`${api.baseUrl}/api/workflows/${created.id}/schedules`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "  nightly  ", cron: "0 9 * * *" }),
    });
    expect(padded.status).toBe(201);
    const schedule = (await padded.json()) as CreateWorkflowScheduleResponse;
    expect(schedule.name).toBe("nightly");
  });

  it("400s a non-object input (a schedule fires it into every run's trigger payload)", async () => {
    api = await bootTestApi();
    const created = await createWorkflow(api.baseUrl);

    for (const badInput of ["a string", 42, ["array"]]) {
      const res = await fetch(`${api.baseUrl}/api/workflows/${created.id}/schedules`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "nightly", cron: "0 9 * * *", input: badInput }),
      });
      expect(res.status).toBe(400);
    }

    const ok = await fetch(`${api.baseUrl}/api/workflows/${created.id}/schedules`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "nightly", cron: "0 9 * * *", input: { key: "value" } }),
    });
    expect(ok.status).toBe(201);
  });

  it("deleting the workflow deletes its schedules too", async () => {
    api = await bootTestApi();
    const created = await createWorkflow(api.baseUrl);
    await fetch(`${api.baseUrl}/api/workflows/${created.id}/schedules`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "nightly", cron: "0 9 * * *" }),
    });

    const del = await fetch(`${api.baseUrl}/api/workflows/${created.id}`, { method: "DELETE" });
    expect(del.status).toBe(200);

    // The workflow is gone, so the schedules route 404s — assert against
    // the store directly to prove the row itself was deleted, not just
    // made unreachable through the now-404ing management route.
    const rows = await api.providers.db
      .select()
      .from(workflowSchedules)
      .where(eq(workflowSchedules.workflowId, created.id));
    expect(rows).toEqual([]);
  });
});

