import { describe, expect, it } from "vitest";
import { isWorkflowCallTool, workflowRefsFrom, workflowRefsFromArgs } from "./workflow";
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
