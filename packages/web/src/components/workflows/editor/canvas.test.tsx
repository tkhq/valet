// @vitest-environment jsdom
/**
 * Canvas (Task 9): mounts a small definition's flow state without
 * crashing, renders every node's label, and reports node clicks via
 * `onSelectNode`. Drag/connect gestures are dogfood territory (plan
 * decision 12) — not unit-tested here.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import type { NodeChange, EdgeChange, Edge } from "@xyflow/react";
import { Canvas, routeNodeChanges, routeEdgeChanges } from "./canvas";
import { toFlow, type WorkflowDefinition } from "../editor-model";
import type { FlowXyNode } from "./flow-node";

const definition: WorkflowDefinition = {
  version: "dag/v1",
  nodes: [
    { id: "trigger", type: "trigger" },
    { id: "check", type: "if", conditions: [] },
    { id: "stop", type: "stop", outcome: "success" },
  ],
  edges: [
    { from: "trigger", to: "check" },
    { from: "check", to: "stop", fromOutput: "true", when: "approved" },
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

  it("renders an edge's when label in the canvas DOM", async () => {
    render(
      <Canvas
        flow={toFlow(definition)}
        onNodePositionChange={noop}
        onConnect={noop}
        onSelectNode={noop}
        onSelectEdge={noop}
      />,
    );
    // Edge rendering only happens once xyflow's ResizeObserver-driven node
    // measurement pass completes (see src/test/setup.ts); that fires on a
    // microtask, so the label shows up a tick after the initial render.
    await waitFor(() => expect(screen.getByText("approved")).toBeTruthy());
  });
});

describe("routeNodeChanges", () => {
  it("calls onRemoveNode for a remove change", () => {
    const onNodePositionChange = vi.fn();
    const onRemoveNode = vi.fn();
    const changes: NodeChange<FlowXyNode>[] = [{ type: "remove", id: "check" }];
    routeNodeChanges(changes, { onNodePositionChange, onRemoveNode });
    expect(onRemoveNode).toHaveBeenCalledWith("check");
    expect(onNodePositionChange).not.toHaveBeenCalled();
  });

  it("calls onNodePositionChange for a drag-end position change", () => {
    const onNodePositionChange = vi.fn();
    const onRemoveNode = vi.fn();
    const changes: NodeChange<FlowXyNode>[] = [
      { type: "position", id: "check", position: { x: 10, y: 20 }, dragging: false },
    ];
    routeNodeChanges(changes, { onNodePositionChange, onRemoveNode });
    expect(onNodePositionChange).toHaveBeenCalledWith("check", { x: 10, y: 20 });
    expect(onRemoveNode).not.toHaveBeenCalled();
  });

  it("does not call either callback for a selection change", () => {
    const onNodePositionChange = vi.fn();
    const onRemoveNode = vi.fn();
    const changes: NodeChange<FlowXyNode>[] = [{ type: "select", id: "check", selected: true }];
    routeNodeChanges(changes, { onNodePositionChange, onRemoveNode });
    expect(onNodePositionChange).not.toHaveBeenCalled();
    expect(onRemoveNode).not.toHaveBeenCalled();
  });

  it("does not call onNodePositionChange while dragging is still in progress", () => {
    const onNodePositionChange = vi.fn();
    const changes: NodeChange<FlowXyNode>[] = [
      { type: "position", id: "check", position: { x: 10, y: 20 }, dragging: true },
    ];
    routeNodeChanges(changes, { onNodePositionChange });
    expect(onNodePositionChange).not.toHaveBeenCalled();
  });
});

describe("routeEdgeChanges", () => {
  it("calls onRemoveEdge for a remove change", () => {
    const onRemoveEdge = vi.fn();
    const changes: EdgeChange<Edge>[] = [{ type: "remove", id: "edge-1" }];
    routeEdgeChanges(changes, { onRemoveEdge });
    expect(onRemoveEdge).toHaveBeenCalledWith("edge-1");
  });

  it("does not call onRemoveEdge for a selection change", () => {
    const onRemoveEdge = vi.fn();
    const changes: EdgeChange<Edge>[] = [{ type: "select", id: "edge-1", selected: true }];
    routeEdgeChanges(changes, { onRemoveEdge });
    expect(onRemoveEdge).not.toHaveBeenCalled();
  });
});
