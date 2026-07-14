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
 * Edge "when" badges: xyflow's default (bezier) edge type accepts a plain
 * `label` prop and renders it centered on the path with its own pill
 * background — that already reads as a badge in the calm-companion
 * palette without a custom edge component, so there is no `flow-edge.tsx`
 * in this task. If the when-badge ever needs bespoke styling beyond what
 * `labelStyle`/`labelBgStyle` can express, that's the seam to add one.
 */
import { useEffect, useState } from "react";
import {
  Background,
  Controls,
  ReactFlow,
  applyEdgeChanges,
  applyNodeChanges,
  type Connection,
  type Edge,
  type EdgeChange,
  type NodeChange,
  type Viewport,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { FlowNode, type FlowNodeData, type FlowXyNode } from "./flow-node";
import type { ConnectParams, FlowPosition, FlowViewport, WorkflowFlowState } from "../editor-model";

const nodeTypes = { workflow: FlowNode };

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

function toXyNodes(flow: WorkflowFlowState, errorNodeIds: ReadonlySet<string>): FlowXyNode[] {
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
  const errors = errorNodeIds ?? EMPTY_ERROR_SET;
  const [nodes, setNodes] = useState<FlowXyNode[]>(() => toXyNodes(flow, errors));
  const [edges, setEdges] = useState<Edge[]>(() => toXyEdges(flow));

  // The model is the source of truth; whenever the parent hands us a new
  // snapshot (add/remove/duplicate/connect/patch), re-derive local state
  // from it. Position changes during an in-progress drag are local-only
  // until drag-end, so this doesn't fight the user's cursor.
  useEffect(() => {
    setNodes(toXyNodes(flow, errors));
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
      >
        <Background />
        <Controls />
      </ReactFlow>
    </div>
  );
}

const EMPTY_ERROR_SET: ReadonlySet<string> = new Set();
