/**
 * Read-only workflow DAG preview (spec:
 * docs/specs/2026-07-31-workflow-chat-rendering-design.md). Shared by the
 * chat tool renderer and the run detail page. Non-interactive by design —
 * every gesture (pan/zoom/drag/connect) is disabled; the surrounding surface
 * provides an "Open" link into the real editor for interaction.
 */
import { useMemo } from "react";
import { Background, BackgroundVariant, ReactFlow, type Edge, type Node } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { toFlow, type WorkflowDefinition } from "./editor-model";
import { FlowNode, type NodeRunStatus } from "./editor/flow-node";

export type { NodeRunStatus };

const nodeTypes = { workflow: FlowNode };

/**
 * How the preview renders for a given node count: below 2 nodes there is
 * nothing meaningful to draw; above 8 a fit-to-view canvas at card height
 * would be an unreadable postage stamp, so it degrades to a summary strip.
 */
export function previewMode(nodeCount: number): "empty" | "canvas" | "summary" {
  if (nodeCount < 2) return "empty";
  return nodeCount <= 8 ? "canvas" : "summary";
}

/** One-line shape summary for the >8-node degraded mode. */
export function summarizeDefinition(definition: WorkflowDefinition): string {
  const n = definition.nodes.length;
  const types = definition.nodes.map((node) => node.type);
  const path =
    types.length <= 4
      ? types.join(" → ")
      : `${types[0]} → ${types[1]} → … → ${types[types.length - 1]}`;
  return `${n} nodes · ${path}`;
}

export interface WorkflowPreviewProps {
  definition: WorkflowDefinition;
  statusByNodeId?: Record<string, NodeRunStatus>;
  /** Trailing per-node badge text, e.g. foreach progress "3/12". */
  badgeByNodeId?: Record<string, string>;
  height?: number;
}

export function WorkflowPreview({
  definition,
  statusByNodeId,
  badgeByNodeId,
  height = 240,
}: WorkflowPreviewProps) {
  const mode = previewMode(definition.nodes.length);

  const flow = useMemo(() => {
    if (mode !== "canvas") return null;
    const state = toFlow(definition);
    const nodes: Node[] = state.nodes.map((n) => {
      // Preview mode strips the labeled `true`/`false` source handles from
      // if/approval nodes — the badge overhang looks bad at card scale and
      // the branch structure is already visible from the edges. The full
      // editor keeps them; open it for authoring.
      const { sourceOutputs, ...restData } = n.data;
      void sourceOutputs;
      return {
        ...n,
        draggable: false,
        connectable: false,
        selectable: false,
        data: {
          ...restData,
          ...(statusByNodeId?.[n.id] ? { runStatus: statusByNodeId[n.id] } : {}),
          ...(badgeByNodeId?.[n.id] ? { runBadge: badgeByNodeId[n.id] } : {}),
        },
      };
    });
    const edges: Edge[] = state.edges.map((e) => ({
      ...e,
      ...(e.data.when ? { label: e.data.when } : {}),
      animated: statusByNodeId?.[e.target] === "running",
    }));
    return { nodes, edges };
  }, [definition, mode, statusByNodeId, badgeByNodeId]);

  if (mode === "empty") {
    return (
      <div
        className="flex items-center justify-center rounded-md border border-line bg-paper text-sm text-muted"
        style={{ height }}
        data-testid="workflow-preview-empty"
      >
        No steps yet — ask the assistant to add actions.
      </div>
    );
  }

  if (mode === "summary" || !flow) {
    return (
      <div
        className="flex items-center rounded-md border border-line bg-paper px-3 text-sm text-muted"
        style={{ height: 44 }}
        data-testid="workflow-preview-summary"
      >
        {summarizeDefinition(definition)}
      </div>
    );
  }

  return (
    <div
      className="overflow-hidden rounded-md border border-line bg-[--bg]"
      style={{ height }}
      data-testid="workflow-preview-canvas"
    >
      <ReactFlow
        nodes={flow.nodes}
        edges={flow.edges}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.08, minZoom: 0.4, maxZoom: 0.95 }}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        panOnDrag={false}
        zoomOnScroll={false}
        zoomOnPinch={false}
        zoomOnDoubleClick={false}
        preventScrolling={false}
        edgesFocusable={false}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={12} size={1} color="var(--line)" />
      </ReactFlow>
    </div>
  );
}
