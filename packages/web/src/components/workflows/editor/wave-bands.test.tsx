// @vitest-environment jsdom
/**
 * Feature 5, presentation half: the wave bands the canvas draws behind a
 * group of steps, and the concurrency badges on the card.
 *
 * `waveBands` is exercised as a pure function because the geometry is the
 * part that can be wrong in a way a smoke render would not show. The two
 * render tests only prove the band and the badges reach the DOM.
 */
import { describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { ReactFlow, ReactFlowProvider } from "@xyflow/react";
import { Canvas, waveBands } from "./canvas";
import {
  FlowNode,
  NODE_CARD_MAX_HEIGHT,
  NODE_CARD_WIDTH,
  concurrencyCues,
  type FlowXyNode,
} from "./flow-node";
import {
  analyzeConcurrency,
  toFlow,
  type ConcurrencyModel,
  type WorkflowDefinition,
} from "../editor-model";

/** trigger fans out to two steps, which then join on one. */
const fanOut: WorkflowDefinition = {
  version: "dag/v1",
  nodes: [
    { id: "trigger", type: "trigger" },
    { id: "left", type: "set", values: {} },
    { id: "right", type: "set", values: {} },
    { id: "join", type: "stop", outcome: "success" },
  ],
  edges: [
    { from: "trigger", to: "left" },
    { from: "trigger", to: "right" },
    { from: "left", to: "join" },
    { from: "right", to: "join" },
  ],
  ui: {
    nodes: {
      trigger: { position: { x: 0, y: 0 } },
      left: { position: { x: 260, y: 0 } },
      right: { position: { x: 260, y: 120 } },
      join: { position: { x: 520, y: 60 } },
    },
  },
};

const straightLine: WorkflowDefinition = {
  version: "dag/v1",
  nodes: [
    { id: "trigger", type: "trigger" },
    { id: "stop", type: "stop", outcome: "success" },
  ],
  edges: [{ from: "trigger", to: "stop" }],
  ui: {
    nodes: {
      trigger: { position: { x: 0, y: 0 } },
      stop: { position: { x: 260, y: 0 } },
    },
  },
};

function noop() {}

function bandsFor(definition: WorkflowDefinition) {
  const flow = toFlow(definition);
  return waveBands(flow, analyzeConcurrency(flow));
}

describe("waveBands", () => {
  it("draws no band for a graph with nothing running in parallel", () => {
    expect(bandsFor(straightLine)).toEqual([]);
  });

  it("boxes the group's own cards, padded", () => {
    const bands = bandsFor(fanOut);
    expect(bands).toHaveLength(1);

    const band = bands[0]!;
    expect(band.wave).toBe(2);
    expect(band.count).toBe(2);
    // left and right sit at x 260, y 0 and y 120.
    expect(band.x).toBeLessThan(260);
    expect(band.y).toBeLessThan(0);
    expect(band.width).toBeGreaterThan(NODE_CARD_WIDTH);
    expect(band.height).toBeGreaterThan(120 + NODE_CARD_MAX_HEIGHT);
  });

  it("moves with the cards it describes", () => {
    const dragged: WorkflowDefinition = {
      ...fanOut,
      ui: {
        nodes: {
          ...fanOut.ui?.nodes,
          right: { position: { x: 260, y: 400 } },
        },
      },
    };

    expect(bandsFor(dragged)[0]!.height).toBeGreaterThan(bandsFor(fanOut)[0]!.height);
  });

  it("skips a group whose nodes have no position", () => {
    const flow = toFlow(fanOut);
    const model: ConcurrencyModel = {
      byNode: {},
      groups: [{ id: "wave-9-0", wave: 9, nodeIds: ["gone", "also-gone"] }],
    };
    expect(waveBands(flow, model)).toEqual([]);
  });
});

describe("concurrencyCues", () => {
  it("answers nothing when the node has no concurrency to report", () => {
    expect(concurrencyCues(undefined)).toEqual([]);
    expect(
      concurrencyCues({ wave: 1, parallelOut: 1, exclusiveOut: 1, fanIn: 1 }),
    ).toEqual([]);
  });

  it("names the join, the branch and the parallel start, in that order", () => {
    const cues = concurrencyCues({ wave: 2, parallelOut: 3, exclusiveOut: 2, fanIn: 2 });
    expect(cues.map((cue) => cue.key)).toEqual(["join", "branch", "parallel"]);
    expect(cues.map((cue) => cue.count)).toEqual([2, 2, 3]);
  });

  it("carries a sentence, not just a number, on every cue", () => {
    for (const cue of concurrencyCues({ wave: 1, parallelOut: 3, exclusiveOut: 2, fanIn: 2 })) {
      expect(cue.label.length).toBeGreaterThan(10);
      expect(cue.label).toContain(String(cue.count));
    }
  });
});

const nodeTypes = { workflow: FlowNode };

function renderNode(node: FlowXyNode) {
  return render(
    <ReactFlowProvider>
      <ReactFlow nodes={[node]} edges={[]} nodeTypes={nodeTypes} />
    </ReactFlowProvider>,
  );
}

describe("FlowNode concurrency row", () => {
  it("draws no row for a node with one edge in and one out", () => {
    renderNode({
      id: "n1",
      type: "workflow",
      position: { x: 0, y: 0 },
      data: {
        label: "Set values",
        summary: "2 values",
        nodeType: "set",
        parallel: { wave: 2, parallelOut: 1, exclusiveOut: 1, fanIn: 1 },
      },
    });
    expect(screen.queryByTestId("node-parallelism")).toBeNull();
  });

  it("badges a fan-out, a fan-in and a branch count", () => {
    renderNode({
      id: "n1",
      type: "workflow",
      position: { x: 0, y: 0 },
      data: {
        label: "If",
        summary: "1 condition",
        nodeType: "if",
        parallel: { wave: 3, parallelOut: 2, exclusiveOut: 2, fanIn: 3 },
      },
    });
    expect(screen.getByTestId("node-parallelism")).toBeTruthy();
    expect(screen.getByTestId("node-cue-join").textContent).toContain("3");
    expect(screen.getByTestId("node-cue-branch").textContent).toContain("2");
    expect(screen.getByTestId("node-cue-parallel").textContent).toContain("2");
  });

  it("puts the node's wave on the card for the reader's tooling", () => {
    const { container } = renderNode({
      id: "n1",
      type: "workflow",
      position: { x: 0, y: 0 },
      data: {
        label: "Set values",
        summary: "2 values",
        nodeType: "set",
        parallel: { wave: 4, parallelOut: 0, exclusiveOut: 0, fanIn: 2 },
      },
    });
    expect(container.querySelector('.flow-node-card[data-wave="4"]')).toBeTruthy();
  });
});

describe("Canvas wave bands", () => {
  it("draws a band over the steps that start together", async () => {
    render(
      <Canvas
        flow={toFlow(fanOut)}
        onNodePositionChange={noop}
        onConnect={noop}
        onSelectNode={noop}
        onSelectEdge={noop}
      />,
    );

    await waitFor(() => expect(screen.getAllByTestId("wave-band")).toHaveLength(1));
    expect(screen.getByTestId("wave-band").textContent).toContain("Wave 2");
    expect(screen.getByTestId("wave-band").textContent).toContain("2 steps ready at once");
  });

  it("draws no band on a graph that is one step after another", async () => {
    render(
      <Canvas
        flow={toFlow(straightLine)}
        onNodePositionChange={noop}
        onConnect={noop}
        onSelectNode={noop}
        onSelectEdge={noop}
      />,
    );

    await waitFor(() => expect(screen.getByText("Trigger")).toBeTruthy());
    expect(screen.queryByTestId("wave-band")).toBeNull();
  });

  it("marks the joining node's fan-in on its card", async () => {
    render(
      <Canvas
        flow={toFlow(fanOut)}
        onNodePositionChange={noop}
        onConnect={noop}
        onSelectNode={noop}
        onSelectEdge={noop}
      />,
    );

    await waitFor(() => expect(screen.getByTestId("node-cue-join")).toBeTruthy());
    expect(screen.getByTestId("node-cue-parallel").textContent).toContain("2");
  });
});
