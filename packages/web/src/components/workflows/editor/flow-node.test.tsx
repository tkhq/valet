// @vitest-environment jsdom
/**
 * FlowNode (Task 9): renders inside a real `<ReactFlow>` (via
 * `ReactFlowProvider`) so its `Handle`s resolve their store context —
 * rendering the bare component would throw ("Handle must be used within
 * <ReactFlowProvider>"). Covers label/summary text, the amber error
 * badge, and handle counts (two labeled true/false handles for an `if`
 * node's `sourceOutputs`, one unlabeled handle for a node without them).
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { ReactFlow, ReactFlowProvider } from "@xyflow/react";
import { FlowNode, type FlowXyNode } from "./flow-node";

const nodeTypes = { workflow: FlowNode };

function renderNode(node: FlowXyNode) {
  return render(
    <ReactFlowProvider>
      <ReactFlow nodes={[node]} edges={[]} nodeTypes={nodeTypes} />
    </ReactFlowProvider>,
  );
}

describe("FlowNode", () => {
  it("renders the type label and summary", () => {
    renderNode({
      id: "n1",
      type: "workflow",
      position: { x: 0, y: 0 },
      data: { label: "Set values", summary: "2 values", nodeType: "set" },
    });
    expect(screen.getByText("Set values")).toBeTruthy();
    expect(screen.getByText("2 values")).toBeTruthy();
  });

  it("shows the amber error badge when hasError is true", () => {
    renderNode({
      id: "n1",
      type: "workflow",
      position: { x: 0, y: 0 },
      data: { label: "Set values", summary: "2 values", nodeType: "set", hasError: true },
    });
    expect(screen.getByTestId("node-error-badge")).toBeTruthy();
  });

  it("omits the error badge when hasError is false or unset", () => {
    renderNode({
      id: "n1",
      type: "workflow",
      position: { x: 0, y: 0 },
      data: { label: "Set values", summary: "2 values", nodeType: "set" },
    });
    expect(screen.queryByTestId("node-error-badge")).toBeNull();
  });

  it("renders two labeled true/false source handles for an if node", () => {
    renderNode({
      id: "n1",
      type: "workflow",
      position: { x: 0, y: 0 },
      data: {
        label: "If",
        summary: "1 condition",
        nodeType: "if",
        sourceOutputs: ["true", "false"],
      },
    });
    expect(screen.getByTestId("handle-source-true")).toBeTruthy();
    expect(screen.getByTestId("handle-source-false")).toBeTruthy();
    expect(screen.queryByTestId("handle-source")).toBeNull();
    expect(screen.getByText("true")).toBeTruthy();
    expect(screen.getByText("false")).toBeTruthy();
  });

  it("renders a single unlabeled source handle for a set node", () => {
    renderNode({
      id: "n1",
      type: "workflow",
      position: { x: 0, y: 0 },
      data: { label: "Set values", summary: "2 values", nodeType: "set" },
    });
    expect(screen.getByTestId("handle-source")).toBeTruthy();
    expect(screen.queryByTestId("handle-source-true")).toBeNull();
  });

  it("renders no source handle for a stop node", () => {
    renderNode({
      id: "n1",
      type: "workflow",
      position: { x: 0, y: 0 },
      data: { label: "Stop", summary: "success", nodeType: "stop" },
    });
    expect(screen.queryByTestId("handle-source")).toBeNull();
    expect(screen.queryByTestId("handle-source-true")).toBeNull();
  });

  it("renders no target handle for a trigger node", () => {
    renderNode({
      id: "trigger",
      type: "workflow",
      position: { x: 0, y: 0 },
      data: { label: "Trigger", summary: "…", nodeType: "trigger" },
    });
    expect(screen.queryByTestId("handle-target")).toBeNull();
  });
});
