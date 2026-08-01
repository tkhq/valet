import { describe, expect, it } from "vitest";
import { workflowsActionPlugin, ownerFromContext } from "./actions.js";
import type { PluginActionContext } from "@valet/engine";
import type { WorkflowServiceDeps } from "./service.js";

const noDeps = (): WorkflowServiceDeps => {
  throw new Error("deps not needed for this test");
};

function ctx(overrides?: Partial<PluginActionContext>): PluginActionContext {
  return {
    userId: "user1",
    orgId: "org1",
    actionId: "workflows.list_workflows",
    service: "workflows",
    ...overrides,
  } as PluginActionContext;
}

describe("workflowsActionPlugin", () => {
  it("exposes the five workflow actions with workflows.* ids", () => {
    const plugin = workflowsActionPlugin(noDeps);
    expect(plugin.service).toBe("workflows");
    expect(plugin.actions.map((a) => a.id).sort()).toEqual([
      "workflows.cancel_run",
      "workflows.create_trigger",
      "workflows.delete_trigger",
      "workflows.delete_workflow",
      "workflows.get_node_result",
      "workflows.get_run",
      "workflows.get_workflow",
      "workflows.list_event_types",
      "workflows.list_runs",
      "workflows.list_triggers",
      "workflows.list_workflows",
      "workflows.patch_workflow",
      "workflows.resolve_approval",
      "workflows.save_workflow",
      "workflows.start_run",
    ]);
  });

  it("marks reads low-risk and writes medium-risk", () => {
    const plugin = workflowsActionPlugin(noDeps);
    const byId = new Map(plugin.actions.map((a) => [a.id, a.riskLevel]));
    expect(byId.get("workflows.list_workflows")).toBe("low");
    expect(byId.get("workflows.get_workflow")).toBe("low");
    expect(byId.get("workflows.get_run")).toBe("low");
    expect(byId.get("workflows.save_workflow")).toBe("medium");
    expect(byId.get("workflows.start_run")).toBe("medium");
    expect(byId.get("workflows.delete_workflow")).toBe("medium");
    expect(byId.get("workflows.list_runs")).toBe("low");
    expect(byId.get("workflows.cancel_run")).toBe("medium");
    // High → the plugin catalog's default policy gates it behind a human
    // decision — the agent cannot silently approve its own gates.
    expect(byId.get("workflows.resolve_approval")).toBe("high");
  });
});

describe("ownerFromContext", () => {
  it("derives the owner from ctx.userId/orgId", () => {
    expect(ownerFromContext(ctx())).toEqual({ userId: "user1", orgId: "org1" });
  });

  it("returns null when the context has no user", () => {
    expect(ownerFromContext(ctx({ userId: undefined }))).toBeNull();
  });
});

describe("save_workflow validation", () => {
  it("rejects a non-dag definition with success:false instead of throwing", async () => {
    const plugin = workflowsActionPlugin(noDeps);
    const save = plugin.actions.find((a) => a.id === "workflows.save_workflow");
    if (!save) throw new Error("save_workflow action missing");
    const result = await save.execute({ definition: { nodes: "nope" } }, ctx());
    expect(result.success).toBe(false);
    expect(result.error).toContain("definition.nodes");
  });
});
