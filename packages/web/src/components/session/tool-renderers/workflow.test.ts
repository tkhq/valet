import { describe, expect, it } from "vitest";
import {
  attemptedDefinition,
  isWorkflowCallTool,
  latestFailures,
  parseLintErrors,
  workflowListFrom,
  workflowRefsFrom,
  workflowRefsFromArgs,
  workflowToolSuffix,
} from "./workflow";
import { pickRenderer } from "./index";

describe("isWorkflowCallTool", () => {
  it("matches call_tool with a workflows.* tool_id", () => {
    expect(isWorkflowCallTool("call_tool", { tool_id: "workflows.save_workflow" })).toBe(true);
    expect(isWorkflowCallTool("call_tool", { tool_id: "workflows.get_run" })).toBe(true);
  });

  it("rejects other call_tool ids and other tools", () => {
    expect(isWorkflowCallTool("call_tool", { tool_id: "github.create_issue" })).toBe(false);
    expect(isWorkflowCallTool("call_tool", {})).toBe(false);
    expect(isWorkflowCallTool("call_tool", undefined)).toBe(false);
    expect(isWorkflowCallTool("bash", { tool_id: "workflows.get_run" })).toBe(false);
  });
});

describe("pickRenderer routing", () => {
  it("routes workflows.* call_tool to the workflow renderer, others to fallback", () => {
    const wf = pickRenderer("call_tool", { tool_id: "workflows.start_run" });
    const other = pickRenderer("call_tool", { tool_id: "github.create_issue" });
    expect(wf).not.toBe(other);
    expect(wf.formatTarget({ tool_id: "workflows.start_run" })).toBe("start_run");
  });
});

describe("workflowRefsFrom", () => {
  it("pulls workflowId/runId out of a persisted call_tool result", () => {
    const data = { workflowId: "wf1", runId: "r1", status: "pending" };
    expect(workflowRefsFrom({ text: JSON.stringify(data) })).toEqual({
      workflowId: "wf1",
      runId: "r1",
    });
  });

  it("returns empty refs for failure text / missing / malformed results", () => {
    expect(workflowRefsFrom({ text: "workflows.get_run failed: run not found" })).toEqual({});
    expect(workflowRefsFrom(undefined)).toEqual({});
    expect(workflowRefsFrom({ text: '"just a string"' })).toEqual({});
  });
});

describe("workflowRefsFromArgs", () => {
  it("falls back to the call's own params", () => {
    expect(
      workflowRefsFromArgs({
        tool_id: "workflows.get_run",
        params: { run_id: "r9" },
      }),
    ).toEqual({ runId: "r9" });
    expect(
      workflowRefsFromArgs({
        tool_id: "workflows.save_workflow",
        params: { workflow_id: "wf9" },
      }),
    ).toEqual({ workflowId: "wf9" });
  });

  it("handles absent params", () => {
    expect(workflowRefsFromArgs({ tool_id: "workflows.list_workflows" })).toEqual({});
    expect(workflowRefsFromArgs(undefined)).toEqual({});
  });
});

describe("workflowListFrom", () => {
  it("parses a list_workflows result into rows", () => {
    const data = {
      workflows: [
        { workflowId: "wf1", name: "CI Triage", updatedAt: 1700000000000 },
        { workflowId: "wf2", name: "Probe" },
      ],
    };
    expect(workflowListFrom({ text: JSON.stringify(data) })).toEqual([
      { workflowId: "wf1", name: "CI Triage", updatedAt: 1700000000000 },
      { workflowId: "wf2", name: "Probe" },
    ]);
  });

  it("returns null for non-list results and failure text", () => {
    expect(workflowListFrom({ text: JSON.stringify({ workflowId: "wf1" }) })).toBeNull();
    expect(workflowListFrom({ text: "workflows.list_workflows failed: nope" })).toBeNull();
    expect(workflowListFrom(undefined)).toBeNull();
  });

  it("skips malformed entries", () => {
    const data = { workflows: [{ name: "no id" }, { workflowId: "wf3", name: "ok" }, 42] };
    expect(workflowListFrom({ text: JSON.stringify(data) })).toEqual([
      { workflowId: "wf3", name: "ok" },
    ]);
  });
});

describe("parseLintErrors", () => {
  it("extracts bullets from a formatLintErrors payload behind the failed: prefix", () => {
    const text =
      "workflows.save_workflow failed: workflow definition failed validation (fix these and retry):\n" +
      '- node "start": unknown field "description" on a "trigger" node\n' +
      '- node "fetch_prs": tool.service must be a non-empty string (the plugin service, e.g. "github")';
    expect(parseLintErrors(text)).toEqual([
      'node "start": unknown field "description" on a "trigger" node',
      'node "fetch_prs": tool.service must be a non-empty string (the plugin service, e.g. "github")',
    ]);
  });

  it("returns null for non-lint failures and successes", () => {
    expect(parseLintErrors("workflows.get_run failed: run not found: x")).toBeNull();
    expect(parseLintErrors(undefined)).toBeNull();
    expect(parseLintErrors('{"workflowId":"wf1"}')).toBeNull();
  });
});

describe("attemptedDefinition", () => {
  it("pulls params.definition from the call args", () => {
    const definition = { version: "dag/v1", nodes: [], edges: [] };
    expect(
      attemptedDefinition({ tool_id: "workflows.save_workflow", params: { definition } }),
    ).toEqual(definition);
  });

  it("returns null when absent", () => {
    expect(attemptedDefinition({ tool_id: "workflows.save_workflow", params: {} })).toBeNull();
    expect(attemptedDefinition(undefined)).toBeNull();
  });
});

describe("latestFailures", () => {
  it("keeps the newest failed checkpoint per node, skipping non-failures", () => {
    expect(
      latestFailures([
        { nodeId: "a", status: "failed", error: "old boom", createdAt: 1 },
        { nodeId: "a", status: "failed", error: "new boom", createdAt: 2 },
        { nodeId: "b", status: "completed", createdAt: 3 },
        { nodeId: "c", status: "failed", createdAt: 4 }, // no error text → skipped
      ]),
    ).toEqual([{ nodeId: "a", error: "new boom" }]);
  });

  it("is empty for a clean run", () => {
    expect(latestFailures([{ nodeId: "a", status: "completed", createdAt: 1 }])).toEqual([]);
  });
});

describe("workflowToolSuffix", () => {
  it("strips the workflows. prefix, which is how a caller tells a write from a read", () => {
    expect(workflowToolSuffix({ tool_id: "workflows.patch_workflow" })).toBe("patch_workflow");
    expect(workflowToolSuffix({ tool_id: "workflows.get_workflow" })).toBe("get_workflow");
  });

  it("passes an unprefixed id through, and reports nothing for a missing one", () => {
    expect(workflowToolSuffix({ tool_id: "github.create_issue" })).toBe("github.create_issue");
    expect(workflowToolSuffix({})).toBeUndefined();
    expect(workflowToolSuffix(null)).toBeUndefined();
  });
});
