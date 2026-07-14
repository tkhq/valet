// @vitest-environment jsdom
/**
 * Canvas (Task 9): mounts a small definition's flow state without
 * crashing, renders every node's label, and reports node clicks via
 * `onSelectNode`. Drag/connect gestures are dogfood territory (plan
 * decision 12) — not unit-tested here.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { Canvas } from "./canvas";
import { toFlow, type WorkflowDefinition } from "../editor-model";

const definition: WorkflowDefinition = {
  version: "dag/v1",
  nodes: [
    { id: "trigger", type: "trigger" },
    { id: "check", type: "if", conditions: [] },
    { id: "stop", type: "stop", outcome: "success" },
  ],
  edges: [
    { from: "trigger", to: "check" },
    { from: "check", to: "stop", fromOutput: "true" },
  ],
  ui: {
    nodes: {
      trigger: { position: { x: 0, y: 0 } },
      check: { position: { x: 260, y: 0 } },
      stop: { position: { x: 520, y: 0 } },
    },
  },
};

function noop() {}

describe("Canvas", () => {
  it("mounts and renders every node's label without crashing", () => {
    render(
      <Canvas
        flow={toFlow(definition)}
        onNodePositionChange={noop}
        onConnect={noop}
        onSelectNode={noop}
        onSelectEdge={noop}
      />,
    );
    expect(screen.getByText("Trigger")).toBeTruthy();
    expect(screen.getByText("If")).toBeTruthy();
    expect(screen.getByText("Stop")).toBeTruthy();
  });

  it("fires onSelectNode with the clicked node's id", async () => {
    const onSelectNode = vi.fn();
    render(
      <Canvas
        flow={toFlow(definition)}
        onNodePositionChange={noop}
        onConnect={noop}
        onSelectNode={onSelectNode}
        onSelectEdge={noop}
      />,
    );
    screen.getByText("If").click();
    expect(onSelectNode).toHaveBeenCalledWith("check");
  });
});
