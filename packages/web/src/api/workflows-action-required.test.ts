import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import type { ListWorkflowActionRequiredResponse } from "@valet/api/wire";
import { invalidateWorkflowApprovalState, qkWorkflows, removeResolvedWorkflowAction } from "./workflows";

describe("workflow approval query state", () => {
  it("refreshes the focused run, pending count, and run lists", () => {
    const invalidateQueries = vi.fn();
    invalidateWorkflowApprovalState({ invalidateQueries }, "wfrun_1");
    expect(invalidateQueries.mock.calls.map(([arg]) => arg.queryKey)).toEqual([
      qkWorkflows.run("wfrun_1"),
      qkWorkflows.actionRequired(),
      qkWorkflows.allRuns(),
    ]);
  });

  it("removes the resolved gate from the pending count before the next poll", () => {
    let current: ListWorkflowActionRequiredResponse = {
      count: 2,
      items: [
        {
          id: "r:n:0",
          runId: "r",
          workflowId: "w",
          workflowName: "W",
          runCreatedAt: 1,
          owner: { type: "user", id: "u" },
          trigger: { type: "manual" },
          gate: { nodeId: "n", kind: "approval" },
        },
        {
          id: "r:m:0",
          runId: "r",
          workflowId: "w",
          workflowName: "W",
          runCreatedAt: 1,
          owner: { type: "user", id: "u" },
          trigger: { type: "manual" },
          gate: { nodeId: "m", kind: "approval" },
        },
      ],
    };
    const qc = new QueryClient();
    qc.setQueryData(qkWorkflows.actionRequired(), current);
    const invalidateQueries = vi.spyOn(qc, "invalidateQueries");

    removeResolvedWorkflowAction(qc, "r", "n", undefined);
    current = qc.getQueryData(qkWorkflows.actionRequired())!;

    expect(current.count).toBe(1);
    expect(current.items[0].gate.nodeId).toBe("m");
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: qkWorkflows.actionRequired(),
      refetchType: "none",
    });
  });
});
