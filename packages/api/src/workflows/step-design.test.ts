import { afterEach, describe, expect, it } from "vitest";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import type { CreateWorkflowResponse, WorkflowNodePermissionWire, WorkflowStepCheckResponse } from "../wire/types.js";
import { heldActionWarning, stepDesignWarnings } from "./step-design.js";

const ASKING = "Send the people lead a DM that the project is ready for approval, then create the Linear project.";

const held: WorkflowNodePermissionWire = {
  nodeId: "run", service: "linear", action: "save_project", actionId: "linear.save_project", mode: "require_approval", agentStep: true,
};

describe("stepDesignWarnings", () => {
  it("reports an asking agent step, a foreach body under the foreach id, and a listed action policy holds", () => {
    const definition = {
      version: "dag/v1",
      nodes: [
        { id: "trigger", type: "trigger" },
        { id: "run", type: "session", mode: "start", prompt: ASKING },
        { id: "each", type: "foreach", items: "{{trigger.data.rows}}", body: { type: "orchestrator", prompt: "Ask the row owner for approval." } },
        { id: "post", type: "tool", service: "linear", action: "save_project", params: {} },
      ],
      edges: [],
    };
    const warnings = stepDesignWarnings(definition, [held, { ...held, nodeId: "post", agentStep: undefined }]);
    expect([...warnings.keys()].sort()).toEqual(["each", "run"]);
    expect(warnings.get("run")).toHaveLength(2);
    expect(warnings.get("run")?.join(" ")).toContain("linear.save_project");
    expect(warnings.get("each")?.join(" ")).toContain("tool step");
  });

  it("says nothing for an allowed action, a tool step's own gate, or a step that does not ask", () => {
    expect(heldActionWarning({ ...held, mode: "allow" })).toBeUndefined();
    expect(heldActionWarning({ ...held, agentStep: undefined })).toBeUndefined();
    const quiet = { nodes: [{ id: "finish", type: "session", prompt: "The project exists. Do not ask anyone for approval." }] };
    expect(stepDesignWarnings(quiet, []).size).toBe(0);
  });
});

describe("GET /api/workflows/step-check", () => {
  let api: TestApi | undefined;
  afterEach(async () => {
    await api?.cleanup();
    api = undefined;
  });

  async function createWorkflow(baseUrl: string, name: string, prompt: string): Promise<CreateWorkflowResponse> {
    const res = await fetch(`${baseUrl}/api/workflows`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name,
        definition: {
          version: "dag/v1",
          nodes: [{ id: "trigger", type: "trigger" }, { id: "run", type: "session", mode: "start", prompt }],
          edges: [{ from: "trigger", to: "run" }],
        },
      }),
    });
    expect(res.status).toBe(201);
    return (await res.json()) as CreateWorkflowResponse;
  }

  it("lists the organization's workflows that expect an approval a run cannot deliver, for an organization admin only", async () => {
    api = await bootTestApi();
    const asking = await createWorkflow(api.baseUrl, "New hire setup", ASKING);
    await createWorkflow(api.baseUrl, "Weekly digest", "Summarize this week's merged pull requests in three bullets.");

    const res = await fetch(`${api.baseUrl}/api/workflows/step-check`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as WorkflowStepCheckResponse;
    expect(body.scanned).toBe(2);
    expect(body.workflows).toEqual([
      expect.objectContaining({ workflowId: asking.id, name: "New hire setup", steps: [expect.objectContaining({ nodeId: "run" })] }),
    ]);

    const member = await fetch(`${api.baseUrl}/api/workflows/step-check`, { headers: { "x-valet-test-user-id": "test-member" } });
    expect(member.status).toBe(403);
  });
});
