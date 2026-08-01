import { describe, expect, it } from "vitest";
import { canvasHeight, previewMode, summarizeDefinition } from "./preview";
import type { WorkflowDefinition, WorkflowNode } from "./editor-model";

describe("previewMode", () => {
  it("is 'empty' below 2 nodes", () => {
    expect(previewMode(0)).toBe("empty");
    expect(previewMode(1)).toBe("empty");
  });
  it("is 'canvas' from 2 up to 40 nodes", () => {
    expect(previewMode(2)).toBe("canvas");
    expect(previewMode(8)).toBe("canvas");
    expect(previewMode(18)).toBe("canvas");
    expect(previewMode(40)).toBe("canvas");
  });
  it("is 'summary' above 40 nodes", () => {
    expect(previewMode(41)).toBe("summary");
  });
});

describe("canvasHeight", () => {
  it("keeps the baseline for small workflows", () => {
    expect(canvasHeight(2)).toBe(240);
    expect(canvasHeight(8)).toBe(240);
  });
  it("scales up for medium workflows", () => {
    expect(canvasHeight(12)).toBe(320);
    expect(canvasHeight(20)).toBe(400);
  });
  it("caps at 480 for large workflows", () => {
    expect(canvasHeight(40)).toBe(480);
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
