import { describe, expect, it } from "vitest";
import { parseWorkflowGateKey, workflowGateClickAnswer, workflowGateKey } from "./workflow-gates.js";

describe("workflow step card keys", () => {
  it("round-trips a step, and holds no character the Slack button value splits on", () => {
    const gate = { runId: "wfrun_sch_1", nodeId: "post|x:y", iteration: 3, gateId: "approval:post:gate:1" };
    const key = workflowGateKey(gate);
    expect(key).not.toContain("|");
    expect(parseWorkflowGateKey(key)).toEqual(gate);
    expect(parseWorkflowGateKey(workflowGateKey({ runId: "r", nodeId: "n", iteration: 0 }))).toEqual({ runId: "r", nodeId: "n", iteration: 0 });
  });

  it("rejects a key that is not a workflow step's", () => {
    expect(parseWorkflowGateKey("gate-123")).toBeNull();
    expect(parseWorkflowGateKey("wfgate:%5B%22r%22%5D")).toBeNull();
    expect(parseWorkflowGateKey("wfgate:%E0%A4%A")).toBeNull();
  });
});

describe("workflow step click answers", () => {
  it("settles the card on a decision and keeps it when another person must answer", () => {
    expect(workflowGateClickAnswer("ok", true, "Ada")).toEqual({ settle: "✅ Approved once by Ada" });
    expect(workflowGateClickAnswer("ok", false, undefined)).toEqual({ settle: "❌ Denied" });
    expect(workflowGateClickAnswer("already_resolved", true, undefined).settle).toBeDefined();
    expect(workflowGateClickAnswer("not_approver", true, undefined)).toEqual({ reply: expect.stringContaining("Only that member") });
  });
});
