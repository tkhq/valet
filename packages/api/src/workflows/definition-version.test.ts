import { describe, expect, it } from "vitest";
import { sameWorkflowSteps } from "./definition-version.js";

describe("sameWorkflowSteps", () => {
  const steps = { version: "dag/v1", nodes: [{ id: "a", type: "orchestrator", prompt: "Check" }], edges: [] };

  it("treats a legacy re-save of the same steps as unchanged", () => {
    expect(sameWorkflowSteps({ ...steps, assistantId: "asst_retired" }, steps)).toBe(true);
    expect(sameWorkflowSteps({ ...steps, nodes: [{ id: "a", type: "thread", prompt: "Check" }] }, steps)).toBe(true);
  });

  it("treats a moved node on the map as unchanged", () => {
    const moved = { ...steps, ui: { nodes: { a: { position: { x: 400, y: 80 } } } } };
    expect(sameWorkflowSteps(moved, steps)).toBe(true);
  });

  it("ignores the key order a jsonb read-back produces", () => {
    expect(sameWorkflowSteps({ edges: [], nodes: steps.nodes, version: "dag/v1" }, steps)).toBe(true);
  });

  it("sees a real step change", () => {
    expect(sameWorkflowSteps({ ...steps, nodes: [{ id: "a", type: "orchestrator", prompt: "Ship" }] }, steps)).toBe(false);
  });
});
