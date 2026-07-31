import { describe, expect, it } from "vitest";
import { previewMode, summarizeDefinition } from "./preview";
import type { WorkflowDefinition, WorkflowNode } from "./editor-model";

describe("previewMode", () => {
  it("is 'empty' below 2 nodes", () => {
    expect(previewMode(0)).toBe("empty");
    expect(previewMode(1)).toBe("empty");
  });
  it("is 'canvas' for 2..8 nodes", () => {
    expect(previewMode(2)).toBe("canvas");
    expect(previewMode(8)).toBe("canvas");
  });
  it("is 'summary' above 8 nodes", () => {
    expect(previewMode(9)).toBe("summary");
  });
});

describe("summarizeDefinition", () => {
  const def = (nodes: WorkflowNode[]): WorkflowDefinition => ({
    version: "dag/v1",
    nodes,
    edges: [],
  });

  it("lists all types for short workflows", () => {
    expect(
      summarizeDefinition(
        def([
          { id: "t", type: "trigger" },
          { id: "s", type: "set", values: {} },
          { id: "z", type: "stop" },
        ]),
      ),
    ).toBe("3 nodes · trigger → set → stop");
  });

  it("elides the middle for long workflows", () => {
    expect(
      summarizeDefinition(
        def([
          { id: "t", type: "trigger" },
          { id: "s", type: "set", values: {} },
          { id: "i", type: "if", conditions: [] },
          { id: "l", type: "llm", model: "m", prompt: "p" },
          { id: "a", type: "approval", prompt: "ok?" },
          { id: "z", type: "stop" },
        ]),
      ),
    ).toBe("6 nodes · trigger → set → … → stop");
  });
});
