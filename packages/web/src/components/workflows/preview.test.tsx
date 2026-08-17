// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { WorkflowPreview, canvasHeight, previewMode, summarizeDefinition } from "./preview";
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

describe("WorkflowPreview", () => {
  const branching: WorkflowDefinition = {
    version: "dag/v1",
    nodes: [
      { id: "trigger", type: "trigger" },
      { id: "check", type: "if", conditions: [] },
      { id: "yes", type: "stop", outcome: "success" },
      { id: "no", type: "stop", outcome: "failure" },
    ],
    edges: [
      { from: "trigger", to: "check" },
      { from: "check", to: "yes", fromOutput: "true" },
      { from: "check", to: "no", fromOutput: "false" },
    ],
    ui: {
      nodes: {
        trigger: { position: { x: 0, y: 0 } },
        check: { position: { x: 260, y: 0 } },
        yes: { position: { x: 520, y: 0 } },
        no: { position: { x: 520, y: 120 } },
      },
    },
  };

  it("draws every branch out of an if node", async () => {
    // An edge attaches to a handle by id. Stripping `sourceOutputs` here
    // used to remove the `true`/`false` handles, and xyflow then dropped
    // both branch edges — a run page showed a graph that had lost the
    // shape of its own decision.
    const { container } = render(<WorkflowPreview definition={branching} />);
    await waitFor(() => expect(container.querySelectorAll(".react-flow__edge").length).toBe(3));
    expect(screen.getByTestId("handle-source-true")).toBeTruthy();
    expect(screen.getByTestId("handle-source-false")).toBeTruthy();
  });
});
