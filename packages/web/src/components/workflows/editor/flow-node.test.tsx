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
import { FlowNode, nodeShellClasses, type FlowXyNode } from "./flow-node";

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

  it("shows the amber gate badge when the action needs approval", () => {
    renderNode({
      id: "n1",
      type: "workflow",
      position: { x: 0, y: 0 },
      data: { label: "Tool", summary: "widgets.deploy", nodeType: "tool", gate: "require_approval" },
    });
    expect(screen.getByTestId("node-gate-badge")).toBeTruthy();
    expect(screen.queryByTestId("node-deny-badge")).toBeNull();
  });

  it("shows the danger deny badge when an org policy blocks the action", () => {
    renderNode({
      id: "n1",
      type: "workflow",
      position: { x: 0, y: 0 },
      data: { label: "Tool", summary: "widgets.deploy", nodeType: "tool", gate: "deny" },
    });
    expect(screen.getByTestId("node-deny-badge")).toBeTruthy();
    expect(screen.queryByTestId("node-gate-badge")).toBeNull();
  });

  it("draws no gate badge without a prediction", () => {
    renderNode({
      id: "n1",
      type: "workflow",
      position: { x: 0, y: 0 },
      data: { label: "Tool", summary: "widgets.list", nodeType: "tool" },
    });
    expect(screen.queryByTestId("node-gate-badge")).toBeNull();
    expect(screen.queryByTestId("node-deny-badge")).toBeNull();
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

  it("carries the node type's mark, which the palette shows on the same type", () => {
    const { container } = renderNode({
      id: "n1",
      type: "workflow",
      position: { x: 0, y: 0 },
      data: { label: "If", summary: "1 condition", nodeType: "if" },
    });
    expect(container.querySelector(".lucide-split")).toBeTruthy();
  });

  it("keeps the whole summary reachable when the card clamps it", () => {
    const summary = "a prompt long enough that two lines cannot hold all of it, and then some";
    renderNode({
      id: "n1",
      type: "workflow",
      position: { x: 0, y: 0 },
      data: { label: "LLM", summary, nodeType: "llm" },
    });
    const line = screen.getByTitle(summary);
    expect(line.className).toContain("line-clamp-2");
    expect(line.textContent).toBe(summary);
  });

  it("shows a run state as a washed pill with its own glyph", () => {
    renderNode({
      id: "n1",
      type: "workflow",
      position: { x: 0, y: 0 },
      data: { label: "Tool", summary: "slack.post", nodeType: "tool", runStatus: "failed" },
    });
    const pill = screen.getByTestId("node-run-status");
    expect(pill.className).toContain("bg-danger-wash");
    expect(pill.textContent).toContain("✕");
    expect(pill.textContent).toContain("failed");
  });

  it("moves only the in-flight glyph, and holds it still under reduced motion", () => {
    const { container } = renderNode({
      id: "n1",
      type: "workflow",
      position: { x: 0, y: 0 },
      data: { label: "Tool", summary: "slack.post", nodeType: "tool", runStatus: "running" },
    });
    const moving = container.querySelector(".animate-pulse");
    expect(moving).toBeTruthy();
    expect(moving?.className).toContain("motion-reduce:animate-none");
    // The card itself must not pulse: thirty of those is a flicker.
    expect(container.querySelector(".flow-node-card")?.className).not.toContain("animate-pulse");
  });

  it("publishes the run state as data-status, which the hover rule reads", () => {
    const { container } = renderNode({
      id: "n1",
      type: "workflow",
      position: { x: 0, y: 0 },
      data: { label: "Tool", summary: "slack.post", nodeType: "tool", runStatus: "failed" },
    });
    expect(container.querySelector(".flow-node-card")?.getAttribute("data-status")).toBe("failed");
  });

  it("plays the arrival animation only for a node the canvas marked entering", () => {
    const data = { label: "Set values", summary: "2 values", nodeType: "set" } as const;
    const settled = renderNode({ id: "n1", type: "workflow", position: { x: 0, y: 0 }, data });
    expect(settled.container.querySelector(".flow-node-enter")).toBeNull();

    const arriving = renderNode({
      id: "n2",
      type: "workflow",
      position: { x: 0, y: 0 },
      data: { ...data, entering: true },
    });
    expect(arriving.container.querySelector(".flow-node-enter")).toBeTruthy();
  });
});

describe("nodeShellClasses", () => {
  it("keeps a failed node's border when it is also selected", () => {
    const classes = nodeShellClasses("failed", true);
    expect(classes).toContain("border-danger-500");
    expect(classes).toContain("ring-moss");
    expect(classes).not.toContain("border-moss");
  });

  it("lets selection paint the border when there is no run state to hide", () => {
    const classes = nodeShellClasses(undefined, true);
    expect(classes).toContain("border-moss");
    expect(classes).toContain("ring-2");
  });

  it("separates skipped from the rest without relying on colour", () => {
    const classes = nodeShellClasses("skipped", false);
    expect(classes).toContain("border-dashed");
    expect(classes).toContain("opacity-60");
  });

  it("leaves an unselected node with no run state on the hairline", () => {
    expect(nodeShellClasses(undefined, false)).toBe("border-line");
  });
});
