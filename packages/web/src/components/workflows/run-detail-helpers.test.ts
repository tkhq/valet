import { describe, expect, it } from "vitest";
import { findApprovalPrompt, findPendingApproval, jsonPreview } from "./run-detail-helpers";

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
