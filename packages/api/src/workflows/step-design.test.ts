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

describe("stepDesignWarnings: what a run reads and runs as", () => {
  const steps = (...nodes: Record<string, unknown>[]) => ({ version: "dag/v1", nodes: [{ id: "trigger", type: "trigger" }, ...nodes], edges: [] });

  it("warns when a step reads a trigger field that a schedule sends under trigger.data.input", () => {
    const definition = steps(
      { id: "refresh", type: "session", mode: "start", prompt: "If {{trigger.data.push}} is true, save the report." },
      { id: "each", type: "foreach", items: "{{trigger.data.input.rows}}", body: { type: "tool", service: "slack", action: "post_message", params: { channel: "{{trigger.data.channel}}" } } },
    );
    const warnings = stepDesignWarnings(definition, [], { schedules: ["Nightly refresh"] });
    expect([...warnings.keys()].sort()).toEqual(["each", "refresh"]);
    expect(warnings.get("refresh")?.join(" ")).toContain("{{trigger.data.input.push || trigger.data.push}}");
    expect(warnings.get("refresh")?.join(" ")).toContain('"Nightly refresh"');
    expect(warnings.get("each")?.join(" ")).toContain("trigger.data.input.channel");
  });

  it("gives a condition's read the bare expression, and says || skips false, 0, and an empty string", () => {
    const definition = {
      version: "dag/v1",
      nodes: [
        { id: "trigger", type: "trigger" },
        { id: "gate", type: "if", conditions: [{ left: "trigger.data.dryRun", dataType: "boolean", operation: "false" }] },
        { id: "publish", type: "session", mode: "start", prompt: "Publish the report." },
      ],
      edges: [{ from: "trigger", to: "gate" }, { from: "gate", to: "publish", when: "trigger.data.limit > 0" }],
    };
    const warnings = stepDesignWarnings(definition, [], { schedules: ["Nightly"] });
    const gate = warnings.get("gate") ?? [];
    expect(gate).toHaveLength(2);
    expect(gate.join(" ")).not.toContain("{{");
    expect(gate.join(" ")).toContain("write trigger.data.input.dryRun || trigger.data.dryRun with no braces in a condition");
    expect(gate.join(" ")).toContain("write trigger.data.input.limit || trigger.data.limit with no braces in a condition");
    expect(gate.join(" ")).toContain("false, 0, or an empty string");
    expect(gate.join(" ")).toContain("read trigger.data.input.limit alone");
  });

  it("stays quiet with no schedule, a read that covers both paths, or a field the schedule sets itself", () => {
    const read = (prompt: string) => steps({ id: "refresh", type: "session", mode: "start", prompt });
    expect(stepDesignWarnings(read("If {{trigger.data.push}} is true, save the report."), []).size).toBe(0);
    expect(stepDesignWarnings(read("Push: {{trigger.data.input.push || trigger.data.push}}"), [], { schedules: ["Nightly"] }).size).toBe(0);
    expect(stepDesignWarnings(read("{{trigger.data.scheduleName}} fired at {{trigger.data.cron}} with {{trigger.data.input}}"), [], { schedules: ["Nightly"] }).size).toBe(0);
  });

  it("warns when a run stops on an action that has no saved permission and no known risk", () => {
    const tool: WorkflowNodePermissionWire = { nodeId: "create_project", service: "linear", action: "save_project", actionId: null, mode: "unknown" };
    const agent: WorkflowNodePermissionWire = { nodeId: "finish", service: "linear", action: "save_milestone", actionId: "linear.save_milestone", mode: "unknown", agentStep: true };
    const warnings = stepDesignWarnings(steps(), [tool, agent, { ...tool, nodeId: "allowed_tool", granted: true }, { ...agent, nodeId: "allowed_agent", granted: true }]);
    expect([...warnings.keys()].sort()).toEqual(["create_project", "finish"]);
    expect(warnings.get("create_project")?.join(" ")).toContain("Allow for this workflow");
    expect(warnings.get("finish")?.join(" ")).toContain("linear.save_milestone");
    expect(warnings.get("finish")?.join(" ")).toContain("Review permissions");
  });

  it("warns when an agent step of a team or organization workflow pushes git commits", () => {
    const definition = steps({ id: "refresh", type: "session", mode: "start", prompt: "Commit and push data/dashboard.json to main." });
    expect(stepDesignWarnings(definition, [], { ownerType: "team" }).get("refresh")?.join(" ")).toContain("Valet Agent <agent@valet.local>");
    expect(stepDesignWarnings(definition, [], { ownerType: "org" }).get("refresh")?.join(" ")).toContain("Vercel");
    expect(stepDesignWarnings(definition, [], { ownerType: "user" }).size).toBe(0);
    expect(stepDesignWarnings(definition, []).size).toBe(0);
  });
});

describe("stepDesignWarnings: steps that make the output drift", () => {
  it("reports an agent step that builds a foreach list and a model step that rewrites a draft", () => {
    const definition = {
      version: "dag/v1",
      nodes: [
        { id: "trigger", type: "trigger" },
        { id: "inventory", type: "session", mode: "start", prompt: "List the merged PRs.", toolScope: { actions: ["github.search_issues"] } },
        { id: "qualify", type: "foreach", items: "{{nodes.inventory.result.output.prs}}", body: { type: "llm", prompt: "{{item.title}}" } },
        { id: "assemble", type: "llm", prompt: "Write the report from {{nodes.qualify.result.items}}." },
        { id: "revise", type: "llm", prompt: "Verify and revise {{nodes.assemble.result.output}}." },
        { id: "post", type: "tool", service: "slack", action: "send_message", params: { text: "{{nodes.revise.result.output.text}}" } },
      ],
      edges: [],
    };
    const warnings = stepDesignWarnings(definition, []);
    expect([...warnings.keys()].sort()).toEqual(["inventory", "revise"]);
    expect(warnings.get("inventory")?.join(" ")).toContain("tool step");
    expect(warnings.get("revise")?.join(" ")).toContain('"assemble"');
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
