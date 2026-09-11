import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { Type } from "typebox";
import type { PluginAction, ValetPlugin } from "@valet/engine";
import type {
  CreateWorkflowResponse,
  GetWorkflowRunResponse,
  ResolveWorkflowApprovalResponse,
  StartWorkflowRunResponse,
} from "../wire/types.js";
import { bootTestApi, type TestApi } from "./_setup.js";
import { actionInvocations, actionPolicies } from "../schema/index.js";
import { eq } from "drizzle-orm";

let api: TestApi | undefined;

afterEach(async () => {
  await api?.cleanup();
  api = undefined;
});

function fixturePlugin(): ValetPlugin {
  const send: PluginAction = {
    id: "fixture.send",
    name: "Send",
    description: "Send a fixture message.",
    riskLevel: "high",
    parameters: Type.Object({ channel: Type.String(), text: Type.String() }),
    execute: async (args) => ({ success: true, data: args }),
  };
  const remove: PluginAction = {
    id: "fixture.remove",
    name: "Remove",
    description: "Remove a fixture message.",
    riskLevel: "high",
    parameters: Type.Object({ channel: Type.String(), text: Type.String() }),
    execute: async (args) => ({ success: true, data: args }),
  };
  return { name: "approval-fixture", version: "1", actions: [{ service: "fixture", actions: [send, remove] }] };
}

function definition(action = "send", channel = "C1") {
  return {
    version: "dag/v1",
    nodes: [
      { id: "trigger", type: "trigger" },
      { id: "post", type: "tool", service: "fixture", action, params: { channel, text: "hello" } },
      { id: "done", type: "stop" },
    ],
    edges: [{ from: "trigger", to: "post" }, { from: "post", to: "done" }],
  };
}

async function createWorkflow(name: string, def = definition()): Promise<string> {
  const response = await fetch(`${api!.baseUrl}/api/workflows`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, definition: def }),
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as CreateWorkflowResponse).id;
}

async function start(workflowId: string): Promise<string> {
  const response = await fetch(`${api!.baseUrl}/api/workflows/${workflowId}/runs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as StartWorkflowRunResponse).runId;
}

async function waitFor(runId: string, status: "parked" | "settled"): Promise<GetWorkflowRunResponse> {
  const started = Date.now();
  for (;;) {
    const response = await fetch(`${api!.baseUrl}/api/workflows/runs/${runId}`);
    expect(response.status).toBe(200);
    const detail = (await response.json()) as GetWorkflowRunResponse;
    if (detail.run.status === status) return detail;
    if (Date.now() - started > 10_000) throw new Error(`run ${runId} did not become ${status}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function decide(runId: string, approved: boolean): Promise<void> {
  const response = await fetch(`${api!.baseUrl}/api/workflows/runs/${runId}/approvals/post`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ approved, scope: "workflow" }),
  });
  expect(response.status).toBe(200);
  expect((await response.json()) as ResolveWorkflowApprovalResponse).toEqual({ ok: true });
}

describe("workflow tool approval persistence", () => {
  it("reuses an approved unchanged action on a later run", async () => {
    api = await bootTestApi({ plugins: [fixturePlugin()] });
    const workflowId = await createWorkflow("remember approval");

    const first = await start(workflowId);
    await waitFor(first, "parked");
    await decide(first, true);
    expect((await waitFor(first, "settled")).run.outcome).toBe("completed");

    const second = await start(workflowId);
    const secondResult = await waitFor(second, "settled");
    expect(secondResult.run.outcome).toBe("completed");
    expect(secondResult.pendingGates).toEqual([]);

    const audit = await api.providers.db
      .select({ approvalId: actionInvocations.matchedWorkflowApprovalId })
      .from(actionInvocations)
      .where(eq(actionInvocations.workflowExecutionId, second));
    expect(audit[0]?.approvalId).toMatch(/[0-9a-f-]{36}/);

    const listed = await fetch(`${api.baseUrl}/api/workflows/${workflowId}/tool-approvals`);
    expect(listed.status).toBe(200);
    const approvals = (await listed.json()) as { approvals: { id: string }[] };
    expect(approvals.approvals).toHaveLength(1);
    expect(approvals.approvals[0]?.id).toBe(audit[0]?.approvalId);

    const revoked = await fetch(
      `${api.baseUrl}/api/workflows/${workflowId}/tool-approvals/${approvals.approvals[0]!.id}`,
      { method: "DELETE" },
    );
    expect(revoked.status).toBe(200);
    const third = await start(workflowId);
    expect((await waitFor(third, "parked")).pendingGates[0]).toMatchObject({ nodeId: "post" });
  });

  it("returns typed guidance without consuming a non-reusable gate", async () => {
    api = await bootTestApi({ plugins: [fixturePlugin()] });
    const large = definition();
    (large.nodes[1] as { params: { text: string } }).params.text = "x".repeat(9_000);
    const workflowId = await createWorkflow("non reusable", large);
    const runId = await start(workflowId);
    await waitFor(runId, "parked");
    const response = await fetch(`${api.baseUrl}/api/workflows/runs/${runId}/approvals/post`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ approved: true, scope: "workflow" }),
    });
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      code: "workflow_approval_not_reusable",
      error: "This gate cannot be remembered. Approve it once or for this run.",
    });
    expect((await waitFor(runId, "parked")).pendingGates[0]).toMatchObject({ nodeId: "post" });
  });

  it.each([
    ["changed parameters", definition("send", "C2")],
    ["changed action", definition("remove", "C1")],
  ])("requires approval for %s", async (_label, changedDefinition) => {
    api = await bootTestApi({ plugins: [fixturePlugin()] });
    const workflowId = await createWorkflow("changed definition");
    const first = await start(workflowId);
    await waitFor(first, "parked");
    await decide(first, true);
    await waitFor(first, "settled");

    const update = await fetch(`${api.baseUrl}/api/workflows/${workflowId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ definition: changedDefinition }),
    });
    expect(update.status).toBe(200);

    const second = await start(workflowId);
    expect((await waitFor(second, "parked")).pendingGates[0]).toMatchObject({ nodeId: "post" });
  });

  it.each(["require_approval", "deny"] as const)(
    "requires fresh enforcement after a policy change to %s",
    async (mode) => {
      api = await bootTestApi({ plugins: [fixturePlugin()] });
      const workflowId = await createWorkflow("policy revision");
      const first = await start(workflowId);
      await waitFor(first, "parked");
      await decide(first, true);
      await waitFor(first, "settled");

      const now = Date.now();
      await api.providers.db.insert(actionPolicies).values({
        id: randomUUID(),
        orgId: "local-org",
        principalType: "org",
        principalId: "local-org",
        actionId: "fixture.send",
        mode,
        paramMatchers: [],
        appliesIn: "workflow",
        origin: "admin",
        createdAt: now,
        updatedAt: now,
      });

      const second = await start(workflowId);
      if (mode === "require_approval") {
        expect((await waitFor(second, "parked")).pendingGates[0]).toMatchObject({ nodeId: "post" });
      } else {
        const result = await waitFor(second, "settled");
        expect(result.run.outcome).toBe("failed");
        expect(result.pendingGates).toEqual([]);
      }
    },
  );

  it("isolates approvals by workflow and does not turn a denial into approval", async () => {
    api = await bootTestApi({ plugins: [fixturePlugin()] });
    const approvedWorkflow = await createWorkflow("approved workflow");
    const unrelatedWorkflow = await createWorkflow("unrelated workflow");

    const approvedRun = await start(approvedWorkflow);
    await waitFor(approvedRun, "parked");
    await decide(approvedRun, true);
    await waitFor(approvedRun, "settled");

    const unrelatedRun = await start(unrelatedWorkflow);
    await waitFor(unrelatedRun, "parked");
    await decide(unrelatedRun, false);
    expect((await waitFor(unrelatedRun, "settled")).run.outcome).toBe("failed");

    const laterUnrelatedRun = await start(unrelatedWorkflow);
    expect((await waitFor(laterUnrelatedRun, "parked")).pendingGates[0]).toMatchObject({ nodeId: "post" });
  });
});
