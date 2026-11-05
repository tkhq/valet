import type { KeyboardEvent } from "react";
import { BaseEdge, EdgeLabelRenderer, getSmoothStepPath, type Edge, type EdgeProps } from "@xyflow/react";

export interface FlowEdgeData extends Record<string, unknown> {
  fromOutput?: "true" | "false";
  when?: string;
  /** Keeps labels from sibling edges from sharing one point on the path. */
  labelOffsetY?: number;
  /** Selects this edge when its viewport-portal label is clicked. */
  onSelect?: (edgeId: string) => void;
}

interface EdgeWithLabelData {
  id: string;
  source: string;
  data: Pick<FlowEdgeData, "fromOutput" | "when">;
}

/**
 * Offset labels on edges that leave the same source. This is shared by the
 * editor canvas and the read-only preview so the run detail keeps the same
 * collision avoidance as the editor.
 */
export function edgeLabelOffsets(edges: readonly EdgeWithLabelData[]): Map<string, number> {
  const labeledBySource = new Map<string, string[]>();
  for (const edge of edges) {
    if (edge.data.when || edge.data.fromOutput) {
      labeledBySource.set(edge.source, [...(labeledBySource.get(edge.source) ?? []), edge.id]);
    }
  }

  return new Map(
    [...labeledBySource.values()].flatMap((ids) =>
      ids.map((id, index) => [id, (index - (ids.length - 1) / 2) * 22] as const),
    ),
  );
}

export type WorkflowFlowEdge = EdgeProps<Edge<FlowEdgeData, "workflow">>;

const CONDITION_LABEL_LIMIT = 44;

/**
 * Short label for the canvas. The full condition remains available to assistive
 * technology and as a native tooltip in `FlowEdge`.
 */
export function compactConditionLabel(condition: string, limit = CONDITION_LABEL_LIMIT): string {
  const normalized = condition.replace(/\s+/g, " ").trim();
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, Math.max(1, limit - 1)).trimEnd()}…`;
}

export function edgeLabelText(data: FlowEdgeData | undefined): string | undefined {
  const branch = data?.fromOutput === "true" ? "True" : data?.fromOutput === "false" ? "False" : undefined;
  const condition = data?.when ? compactConditionLabel(data.when) : undefined;
  if (branch && condition) return `${branch} · ${condition}`;
  return branch ?? condition;
}

export function edgeAccessibleLabel(data: FlowEdgeData | undefined): string | undefined {
  const branch = data?.fromOutput === "true" ? "True branch" : data?.fromOutput === "false" ? "False branch" : undefined;
  const condition = data?.when ? `Condition: ${data.when}` : undefined;
  if (branch && condition) return `${branch}. ${condition}`;
  return branch ?? condition;
}

/** A directional, orthogonal edge with a compact, offset label. */
export function FlowEdge({
  id,
  sourceX,
  sourceY,
  sourcePosition,
  targetX,
  targetY,
  targetPosition,
  markerEnd,
  style,
  data,
}: WorkflowFlowEdge) {
  const [path, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
    borderRadius: 12,
    offset: 24,
  });
  const label = edgeLabelText(data);
  const accessibleLabel = edgeAccessibleLabel(data);
  const interactive = data?.onSelect !== undefined;

  return (
    <>
      <BaseEdge path={path} markerEnd={markerEnd} style={style} />
      {label && accessibleLabel && (
        <EdgeLabelRenderer>
          <div
            className="workflow-edge-label nodrag nopan"
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY + (data?.labelOffsetY ?? 0)}px)` }}
            {...(interactive
              ? {
                  onClick: () => data.onSelect?.(id),
                  role: "button",
                  tabIndex: 0,
                  onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      data.onSelect?.(id);
                    }
                  },
                }
              : { role: "img" })}
            title={accessibleLabel}
            aria-label={accessibleLabel}
          >
            {label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}
