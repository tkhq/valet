/**
 * The composed xyflow canvas surface (plan decision 10, canvas half).
 *
 * Deliberately "dumb": it owns no workflow state. The parent (`editor.tsx`)
 * owns the `WorkflowDefinition` via the editor-model's pure functions and
 * passes down its current `toFlow()` snapshot plus an `errorNodeIds` set derived
 * from `validate()`. Local xyflow node/edge arrays exist only so dragging
 * feels smooth (xyflow needs to own the array identity during a drag
 * gesture); every drag-end and connect immediately calls back up into the
 * model via the provided callbacks, and the next render's `flow` prop is
 * the new source of truth.
 *
 * NOTHING ON THIS CANVAS ANIMATES ON ITS OWN. The editor is handed a
 * definition, never a run, so it cannot know which step is in flight and
 * has no honest reason to draw motion. Direction is carried at rest by an
 * arrowhead on every edge. The dashed travelling edge belongs to the run
 * overlay (`preview.tsx`, which marks edges into a running node
 * `animated`), where there is real work to point at. The one motion here
 * answers an input: a node the canvas has not drawn before arrives instead
 * of appearing, which is how an assistant edit shows what it changed.
 *
 * Edge "when" badges: xyflow's default (bezier) edge type accepts a plain
 * `label` prop and renders it centered on the path with its own pill
 * background — that already reads as a badge in the token palette without
 * a custom edge component, so there is no `flow-edge.tsx` in this task. If
 * the when-badge ever needs bespoke styling beyond what
 * `labelStyle`/`labelBgStyle` can express, that's the seam to add one.
 */
import { useEffect, useRef, useState } from "react";
import {
  Background,
  Controls,
  MarkerType,
  ReactFlow,
  applyEdgeChanges,
  applyNodeChanges,
  type Connection,
  type Edge,
  type EdgeChange,
  type EdgeMarker,
  type NodeChange,
  type Viewport,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { FlowNode, type FlowNodeData, type FlowXyNode } from "./flow-node";
import type { ConnectParams, FlowPosition, FlowViewport, WorkflowFlowState } from "../editor-model";

const nodeTypes = { workflow: FlowNode };

/**
 * The arrowhead that makes a directed graph readable without tracing it.
 * Size is deliberately left out: `markerUnits` defaults to `strokeWidth`,
 * so the head keeps its proportion to the line and grows with it when an
 * edge is hovered or selected.
 */
const ARROW_END: EdgeMarker = { type: MarkerType.ArrowClosed };

export interface CanvasProps {
  flow: WorkflowFlowState;
  errorNodeIds?: ReadonlySet<string>;
  onNodePositionChange: (nodeId: string, position: FlowPosition) => void;
  onConnect: (params: ConnectParams) => void;
  onSelectNode: (nodeId: string | null) => void;
  onSelectEdge: (edgeId: string | null) => void;
  onViewportChange?: (viewport: FlowViewport) => void;
  onRemoveNode?: (nodeId: string) => void;
  onRemoveEdge?: (edgeId: string) => void;
}

/**
 * Pure change-routing so remove/position/selection semantics are testable
 * without going through xyflow's onNodesChange prop plumbing (jsdom can't
 * cleanly fire real drag/delete gestures). `setNodes` is left to the caller
 * so xyflow keeps owning array identity during a drag; this function only
 * decides which callbacks a given batch of changes should trigger.
 */
export function routeNodeChanges(
  changes: NodeChange<FlowXyNode>[],
  callbacks: {
    onNodePositionChange: (nodeId: string, position: FlowPosition) => void;
    onRemoveNode?: (nodeId: string) => void;
  },
): void {
  for (const change of changes) {
    if (change.type === "position" && change.position && change.dragging === false) {
      callbacks.onNodePositionChange(change.id, change.position);
    } else if (change.type === "remove") {
      callbacks.onRemoveNode?.(change.id);
    }
  }
}

export function routeEdgeChanges(changes: EdgeChange<Edge>[], callbacks: { onRemoveEdge?: (edgeId: string) => void }): void {
  for (const change of changes) {
    if (change.type === "remove") {
      callbacks.onRemoveEdge?.(change.id);
    }
  }
}

/**
 * Which nodes in `flow` were not in the previous snapshot. Pure, and
 * separate from the ref that remembers the previous ids, so the "what just
 * arrived" rule can be read and tested without a canvas.
 */
export function enteringNodeIds(
  flow: WorkflowFlowState,
  previousIds: ReadonlySet<string>,
): Set<string> {
  const entering = new Set<string>();
  for (const node of flow.nodes) {
    if (!previousIds.has(node.id)) entering.add(node.id);
  }
  return entering;
}

function toXyNodes(
  flow: WorkflowFlowState,
  errorNodeIds: ReadonlySet<string>,
  entering: ReadonlySet<string>,
): FlowXyNode[] {
  return flow.nodes.map((node) => ({
    id: node.id,
    type: "workflow",
    position: node.position,
    deletable: node.deletable,
    data: {
      label: node.data.label,
      summary: node.data.summary,
      nodeType: node.data.nodeType,
      hasError: errorNodeIds.has(node.id),
      sourceOutputs: node.data.sourceOutputs,
      ...(entering.has(node.id) ? { entering: true } : {}),
    } satisfies FlowNodeData,
  }));
}

function toXyEdges(flow: WorkflowFlowState): Edge[] {
  return flow.edges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    sourceHandle: edge.sourceHandle,
    label: edge.data.when,
    labelStyle: { fill: "var(--ink)", fontSize: 11 },
    labelBgStyle: { fill: "var(--paper)", stroke: "var(--line)" },
    labelBgPadding: [4, 2],
    labelBgBorderRadius: 4,
    markerEnd: ARROW_END,
  }));
}

export function Canvas({
  flow,
  errorNodeIds,
  onNodePositionChange,
  onConnect,
  onSelectNode,
  onSelectEdge,
  onViewportChange,
  onRemoveNode,
  onRemoveEdge,
}: CanvasProps) {
  const errors = errorNodeIds ?? EMPTY_IDS;
  // The ids this canvas has already drawn. It stays null until the first
  // snapshot is processed, and that snapshot treats itself as already
  // drawn: opening a workflow animates nothing, and only what arrives
  // afterwards comes in. The set is rebuilt per snapshot rather than added
  // to, so a node that is removed and later restored arrives again.
  const drawnIds = useRef<ReadonlySet<string> | null>(null);
  const [nodes, setNodes] = useState<FlowXyNode[]>(() => toXyNodes(flow, errors, EMPTY_IDS));
  const [edges, setEdges] = useState<Edge[]>(() => toXyEdges(flow));

  // The model is the source of truth; whenever the parent hands us a new
  // snapshot (add/remove/duplicate/connect/patch), re-derive local state
  // from it. Position changes during an in-progress drag are local-only
  // until drag-end, so this doesn't fight the user's cursor.
  useEffect(() => {
    const drawn = new Set(flow.nodes.map((node) => node.id));
    const entering = enteringNodeIds(flow, drawnIds.current ?? drawn);
    drawnIds.current = drawn;
    setNodes(toXyNodes(flow, errors, entering));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flow]);

  useEffect(() => {
    setEdges(toXyEdges(flow));
  }, [flow]);

  function handleNodesChange(changes: NodeChange<FlowXyNode>[]) {
    setNodes((current) => applyNodeChanges(changes, current));
    routeNodeChanges(changes, { onNodePositionChange, onRemoveNode });
  }

  function handleEdgesChange(changes: EdgeChange<Edge>[]) {
    setEdges((current) => applyEdgeChanges(changes, current));
    routeEdgeChanges(changes, { onRemoveEdge });
  }

  function handleConnect(connection: Connection) {
    onConnect({
      source: connection.source,
      target: connection.target,
      sourceHandle: connection.sourceHandle === "true" || connection.sourceHandle === "false" ? connection.sourceHandle : undefined,
    });
  }

  function handleMoveEnd(_event: unknown, viewport: Viewport) {
    onViewportChange?.(viewport);
  }

  return (
    <div className="h-full w-full" data-testid="workflow-canvas">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={handleNodesChange}
        onEdgesChange={handleEdgesChange}
        onConnect={handleConnect}
        onNodeClick={(_event, node) => onSelectNode(node.id)}
        onEdgeClick={(_event, edge) => onSelectEdge(edge.id)}
        onPaneClick={() => {
          onSelectNode(null);
          onSelectEdge(null);
        }}
        onMoveEnd={handleMoveEnd}
        defaultViewport={flow.viewport}
        fitView={!flow.viewport}
        // Arrowheads carry an inline fill, which outranks the stylesheet,
        // so the library's hardcoded light grey would survive into dark
        // mode. Naming the token here is the only place that colour can be
        // set once for every marker on the canvas.
        defaultMarkerColor="var(--muted)"
        // The other two canvases already hide it; this one is the surface a
        // person spends real time in, so the library's badge sat on the
        // workflow they were building.
        proOptions={{ hideAttribution: true }}
      >
        <Background />
        <Controls />
      </ReactFlow>
    </div>
  );
}

/** Stands in for both "no node has a validation error" and "nothing is
 * arriving", which are the same empty set of node ids. */
const EMPTY_IDS: ReadonlySet<string> = new Set();
