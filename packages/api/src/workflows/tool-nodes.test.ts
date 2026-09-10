/**
 * Tool-node collection and the closure a gate must judge (TKAI-443).
 */
import { describe, expect, it } from "vitest";
import type { WorkflowDefinition } from "@valet/workflow";
import { toolNodeClosure, toolNodesOf, workflowCallsOf } from "./tool-nodes.js";

function toolNode(id: string, service: string) {
  return { id, type: "tool" as const, service, action: "do", params: {} };
}

/** Parent that calls `calleeId` and holds no tool node of its own. */
function callerDefinition(calleeId: string): WorkflowDefinition {
  return {
    version: "dag/v1",
    nodes: [
      { id: "start", type: "trigger" },
      { id: "call", type: "workflow", workflowId: calleeId },
    ],
    edges: [{ from: "start", to: "call" }],
  };
}

function calleeDefinition(service: string): WorkflowDefinition {
  return {
    version: "dag/v1",
    nodes: [
      { id: "start", type: "trigger" },
      toolNode("step", service),
    ],
    edges: [{ from: "start", to: "step" }],
  };
}

describe("workflowCallsOf", () => {
  it("finds a top-level call and one inside a foreach body", () => {
    const definition: WorkflowDefinition = {
      version: "dag/v1",
      nodes: [
        { id: "start", type: "trigger" },
        { id: "call", type: "workflow", workflowId: "wf_a" },
        {
          id: "loop",
          type: "foreach",
          items: "{{trigger.data.items}}",
          body: { id: "each", type: "workflow", workflowId: "wf_b" },
        },
      ],
      edges: [{ from: "start", to: "call" }],
    };

    expect(workflowCallsOf(definition).map((node) => node.workflowId)).toEqual(["wf_a", "wf_b"]);
  });
});

describe("toolNodeClosure", () => {
  it("includes the tool nodes of a called workflow", async () => {
    const closure = await toolNodeClosure(callerDefinition("wf_callee"), async (id) =>
      id === "wf_callee" ? calleeDefinition("linear") : null,
    );

    expect(closure.nodes.map((node) => node.service)).toEqual(["linear"]);
    expect(closure.unresolved).toEqual([]);
  });

  it("includes the tool nodes of a workflow called from a foreach body", async () => {
    const definition: WorkflowDefinition = {
      version: "dag/v1",
      nodes: [
        { id: "start", type: "trigger" },
        {
          id: "loop",
          type: "foreach",
          items: "{{trigger.data.items}}",
          body: { id: "each", type: "workflow", workflowId: "wf_callee" },
        },
      ],
      edges: [{ from: "start", to: "loop" }],
    };

    const closure = await toolNodeClosure(definition, async () => calleeDefinition("slack"));

    expect(closure.nodes.map((node) => node.service)).toEqual(["slack"]);
  });

  it("keeps the parent's own tool nodes ahead of the callee's", async () => {
    const definition: WorkflowDefinition = {
      version: "dag/v1",
      nodes: [
        { id: "start", type: "trigger" },
        toolNode("mine", "gmail"),
        { id: "call", type: "workflow", workflowId: "wf_callee" },
      ],
      edges: [{ from: "start", to: "mine" }],
    };

    const closure = await toolNodeClosure(definition, async () => calleeDefinition("linear"));

    expect(closure.nodes.map((node) => node.service)).toEqual(["gmail", "linear"]);
  });

  it("reports a callee the resolver cannot read", async () => {
    const closure = await toolNodeClosure(callerDefinition("wf_gone"), async () => null);

    expect(closure.nodes).toEqual([]);
    expect(closure.unresolved).toEqual(["wf_gone"]);
  });

  // Depth is 1 by construction today, but the walk must terminate whatever
  // the definitions hold: a self-call would otherwise resolve forever.
  it("terminates on a cycle and reads each definition once", async () => {
    const seen: string[] = [];
    const closure = await toolNodeClosure(callerDefinition("wf_self"), async (id) => {
      seen.push(id);
      return {
        version: "dag/v1",
        nodes: [
          { id: "start", type: "trigger" },
          toolNode("step", "linear"),
          { id: "again", type: "workflow", workflowId: "wf_self" },
        ],
        edges: [{ from: "start", to: "step" }],
      };
    });

    expect(seen).toEqual(["wf_self"]);
    expect(closure.nodes.map((node) => node.service)).toEqual(["linear"]);
  });

  it("leaves toolNodesOf pure: it never sees past a call node", () => {
    expect(toolNodesOf(callerDefinition("wf_callee"))).toEqual([]);
  });
});
