import { describe, expect, it } from "vitest";
import type { WorkflowPendingGate } from "@valet/api/wire";
import {
  findApprovalPrompt,
  findPendingApproval,
  jsonPreview,
  runNeedsApproval,
  statusByNodeId,
} from "./run-detail-helpers";

describe("statusByNodeId", () => {
  it("maps checkpoints + waitingOn to per-node statuses", () => {
    const { status } = statusByNodeId(
      {
        status: "parked",
        waitingOn: [{ kind: "signal", nodeId: "gate1", signalType: "approval:gate1" }],
      },
      [
        { nodeId: "t1", iteration: 0, status: "completed" },
        { nodeId: "s1", iteration: 0, status: "failed" },
        { nodeId: "w1", iteration: 0, status: "intent" },
        { nodeId: "sk1", iteration: 0, status: "skipped" },
      ],
    );
    expect(status).toEqual({
      t1: "succeeded",
      s1: "failed",
      w1: "running",
      sk1: "skipped",
      gate1: "waiting",
    });
  });

  it("aggregates multi-iteration nodes and emits a progress badge", () => {
    const { status, badges } = statusByNodeId({ status: "running" }, [
      { nodeId: "body", iteration: 0, status: "completed" },
      { nodeId: "body", iteration: 1, status: "completed" },
      { nodeId: "body", iteration: 2, status: "intent" },
    ]);
    expect(status.body).toBe("running");
    expect(badges.body).toBe("2/3");
  });

  it("any failed iteration marks the node failed", () => {
    const { status } = statusByNodeId({ status: "settled" }, [
      { nodeId: "body", iteration: 0, status: "completed" },
      { nodeId: "body", iteration: 1, status: "failed" },
    ]);
    expect(status.body).toBe("failed");
  });
});

describe("findPendingApproval", () => {
  it("finds an approval signal wait condition", () => {
    const waitingOn = [{ kind: "signal", nodeId: "deploy", signalType: "approval:deploy" }];
    expect(findPendingApproval(waitingOn)).toEqual({ nodeId: "deploy", signalType: "approval:deploy" });
  });

  it("ignores timer/submission waits and non-approval signals", () => {
    const waitingOn = [
      { kind: "timer", nodeId: "wait1", wakeAt: 123 },
      { kind: "signal", nodeId: "cancel-wait", signalType: "cancel" },
    ];
    expect(findPendingApproval(waitingOn)).toBeUndefined();
  });

  it("returns undefined for an empty waitingOn", () => {
    expect(findPendingApproval([])).toBeUndefined();
  });
});

describe("findApprovalPrompt", () => {
  const definition = {
    version: "dag/v1",
    nodes: [
      { id: "trigger", type: "trigger" },
      { id: "deploy", type: "approval", prompt: "Ship it?" },
    ],
    edges: [],
  };

  it("finds the prompt for a matching approval node", () => {
    expect(findApprovalPrompt(definition, "deploy")).toBe("Ship it?");
  });

  it("returns undefined for an unknown node id", () => {
    expect(findApprovalPrompt(definition, "nope")).toBeUndefined();
  });

  it("returns undefined for a malformed definition", () => {
    expect(findApprovalPrompt(null, "deploy")).toBeUndefined();
    expect(findApprovalPrompt({ nodes: "not-an-array" }, "deploy")).toBeUndefined();
  });
});

describe("runNeedsApproval", () => {
  const gate: WorkflowPendingGate = { nodeId: "deploy", kind: "approval" };

  it("returns true when status is parked and there is at least one pending gate", () => {
    expect(runNeedsApproval({ status: "parked" }, [gate])).toBe(true);
  });

  it("returns false when parked but no pending gates", () => {
    expect(runNeedsApproval({ status: "parked" }, [])).toBe(false);
  });

  it("returns false when parked but pendingGates is undefined", () => {
    expect(runNeedsApproval({ status: "parked" }, undefined)).toBe(false);
  });

  it("returns false when status is not parked even with gates", () => {
    expect(runNeedsApproval({ status: "running" }, [gate])).toBe(false);
    expect(runNeedsApproval({ status: "settled" }, [gate])).toBe(false);
  });
});

describe("jsonPreview", () => {
  it("returns empty string for undefined", () => {
    expect(jsonPreview(undefined)).toBe("");
  });

  it("pretty-prints small values in full", () => {
    expect(jsonPreview({ a: 1 })).toBe('{\n  "a": 1\n}');
  });

  it("truncates long values with an ellipsis", () => {
    const big = { text: "a".repeat(1000) };
    const preview = jsonPreview(big, 50);
    expect(preview.length).toBeLessThanOrEqual(51);
    expect(preview.endsWith("…")).toBe(true);
  });
});
