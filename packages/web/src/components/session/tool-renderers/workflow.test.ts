import { describe, expect, it } from "vitest";
import {
  attemptedDefinition,
  isWorkflowCallTool,
  latestFailures,
  parseLintReport,
  workflowListFrom,
  workflowParams,
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

describe("pinned workflow tools", () => {
  // A pinned action is the SAME action reached by a different route. If the
  // client followed only the call_tool shape, a pinned patch would save and
  // the editor would show nothing — the failure the pin exists to fix.
  it("claims a pinned direct tool, whose args carry no tool_id", () => {
    expect(isWorkflowCallTool("workflows__patch_workflow", { workflow_id: "wf1" })).toBe(true);
    expect(isWorkflowCallTool("workflows__get_workflow", { workflow_id: "wf1" })).toBe(true);
  });

  it("reads the action out of the pinned tool's own name", () => {
    expect(workflowToolSuffix({ workflow_id: "wf1" }, "workflows__patch_workflow")).toBe(
      "patch_workflow",
    );
  });

  it("treats the pinned call's args as the parameters", () => {
    expect(workflowRefsFromArgs({ workflow_id: "wf9" }, "workflows__patch_workflow")).toEqual({
      workflowId: "wf9",
    });
    expect(workflowRefsFromArgs({ run_id: "r9" }, "workflows__get_run")).toEqual({ runId: "r9" });
    expect(workflowParams({ workflow_id: "wf9" }, "workflows__patch_workflow")).toEqual({
      workflow_id: "wf9",
    });
  });

  it("finds an attempted definition in a pinned call's flat args", () => {
    const definition = { version: "dag/v1", nodes: [], edges: [] };
    expect(attemptedDefinition({ definition }, "workflows__save_workflow")).toEqual(definition);
  });

  it("routes a pinned call to the workflow renderer, not the fallback", () => {
    const pinned = pickRenderer("workflows__patch_workflow", { workflow_id: "wf1" });
    const other = pickRenderer("github__create_issue", { owner: "o" });
    expect(pinned).not.toBe(other);
    expect(pinned.formatTarget({ workflow_id: "wf1" }, "workflows__patch_workflow")).toBe(
      "patch_workflow",
    );
  });
});

describe("pickRenderer routing", () => {
  it("routes workflows.* call_tool to the workflow renderer, others to fallback", () => {
    const wf = pickRenderer("call_tool", { tool_id: "workflows.start_run" });
    const other = pickRenderer("call_tool", { tool_id: "github.create_issue" });
    expect(wf).not.toBe(other);
    expect(wf.formatTarget({ tool_id: "workflows.start_run" }, "call_tool")).toBe("start_run");
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
      workflowRefsFromArgs(
        {
          tool_id: "workflows.get_run",
          params: { run_id: "r9" },
        },
        "call_tool",
      ),
    ).toEqual({ runId: "r9" });
    expect(
      workflowRefsFromArgs(
        {
          tool_id: "workflows.save_workflow",
          params: { workflow_id: "wf9" },
        },
        "call_tool",
      ),
    ).toEqual({ workflowId: "wf9" });
  });

  it("handles absent params", () => {
    expect(workflowRefsFromArgs({ tool_id: "workflows.list_workflows" }, "call_tool")).toEqual({});
    expect(workflowRefsFromArgs(undefined, "call_tool")).toEqual({});
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

describe("parseLintReport", () => {
  it("extracts bullets from a formatLintErrors payload behind the failed: prefix", () => {
    const text =
      "workflows.save_workflow failed: workflow definition failed validation (fix these and retry):\n" +
      '- node "start": unknown field "description" on a "trigger" node\n' +
      '- node "fetch_prs": tool.service must be a non-empty string (the plugin service, e.g. "github")';
    expect(parseLintReport(text)).toEqual([
      { kind: "error", text: 'node "start": unknown field "description" on a "trigger" node' },
      {
        kind: "error",
        text: 'node "fetch_prs": tool.service must be a non-empty string (the plugin service, e.g. "github")',
      },
    ]);
  });

  /**
   * `formatEditLintErrors` (packages/api/src/workflows/actions.ts) writes a
   * sentence between the bullets to say which errors the workflow already
   * held. That sentence is not a validator message. Counting it would tell
   * the author to fix one more thing than the validator found, and showing
   * it as a bullet would put api prose inside the validator's own list.
   */
  it("marks the api's own sentence as a note, not as a validator message", () => {
    const text =
      "workflows.patch_workflow failed: workflow definition failed validation (fix these and retry):\n" +
      '- node "note": values.n references unknown node "ghost"\n' +
      "\n" +
      "The workflow already held the error(s) below before this edit, so this edit did not cause them. " +
      "Fix them in the same call, or open the workflow in the editor and correct them first.\n" +
      '- node "build": values.to reads "trigger.email", but a trigger payload carries only ' +
      "type, triggerId, timestamp, data, metadata";

    const lines = parseLintReport(text);
    expect(lines?.filter((line) => line.kind === "error").map((line) => line.text)).toEqual([
      'node "note": values.n references unknown node "ghost"',
      'node "build": values.to reads "trigger.email", but a trigger payload carries only ' +
        "type, triggerId, timestamp, data, metadata",
    ]);
    expect(lines?.filter((line) => line.kind === "note")).toHaveLength(1);
    // The note keeps its place, so "the error(s) below" still points at the
    // errors that follow it.
    expect(lines?.map((line) => line.kind)).toEqual(["error", "note", "error"]);
  });

  it("marks the cap continuation as a note so it is not counted as an issue", () => {
    const text =
      "workflow definition failed validation (fix these and retry):\n" +
      "- node \"a\": id must match /^[A-Za-z0-9_-]+$/\n" +
      "… and 4 more";
    const lines = parseLintReport(text);
    expect(lines?.filter((line) => line.kind === "error")).toHaveLength(1);
    expect(lines?.filter((line) => line.kind === "note").map((line) => line.text)).toEqual([
      "… and 4 more",
    ]);
  });

  it("returns null for non-lint failures and successes", () => {
    expect(parseLintReport("workflows.get_run failed: run not found: x")).toBeNull();
    expect(parseLintReport(undefined)).toBeNull();
    expect(parseLintReport('{"workflowId":"wf1"}')).toBeNull();
  });
});

describe("attemptedDefinition", () => {
  it("pulls params.definition from the call args", () => {
    const definition = { version: "dag/v1", nodes: [], edges: [] };
    expect(
      attemptedDefinition({ tool_id: "workflows.save_workflow", params: { definition } }, "call_tool"),
    ).toEqual(definition);
  });

  it("returns null when absent", () => {
    expect(attemptedDefinition({ tool_id: "workflows.save_workflow", params: {} }, "call_tool")).toBeNull();
    expect(attemptedDefinition(undefined, "call_tool")).toBeNull();
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
    expect(workflowToolSuffix({ tool_id: "workflows.patch_workflow" }, "call_tool")).toBe("patch_workflow");
    expect(workflowToolSuffix({ tool_id: "workflows.get_workflow" }, "call_tool")).toBe("get_workflow");
  });

  it("passes an unprefixed id through, and reports nothing for a missing one", () => {
    expect(workflowToolSuffix({ tool_id: "github.create_issue" }, "call_tool")).toBe("github.create_issue");
    expect(workflowToolSuffix({}, "call_tool")).toBeUndefined();
    expect(workflowToolSuffix(null, "call_tool")).toBeUndefined();
  });
});
