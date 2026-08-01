/**
 * Custom xyflow node for the workflow canvas (plan decision 10, canvas
 * half). Renders a calm-companion "paper card": a small-caps type label, the
 * node's summary line, a moss ring when selected, and an amber badge when
 * the node is named in the current validation result.
 *
 * Handle shape mirrors `editor-model.ts`'s `WorkflowFlowNodeData`:
 *   - target handle (left) on every node except `trigger` (single root,
 *     never has incoming edges — `connect()` rejects them anyway, but we
 *     don't render a handle to invite the gesture).
 *   - source handle(s) (right): `if`/`approval` nodes carry
 *     `data.sourceOutputs: ['true', 'false']` and render two labeled
 *     handles whose `id` becomes the edge's `sourceHandle` (mapped to
 *     `fromOutput` by `flowEdgeToWorkflowEdge`); every other node except
 *     `stop` renders one unlabeled source handle; `stop` renders none.
 */
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import type { DagNodeType } from "../editor-model";

export type NodeRunStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "skipped"
  | "waiting";

export interface FlowNodeData extends Record<string, unknown> {
  label: string;
  summary: string;
  hasError?: boolean;
  sourceOutputs?: Array<"true" | "false">;
  nodeType: DagNodeType;
  /** Per-node run state, set only by run-overlay surfaces (preview/run detail). */
  runStatus?: NodeRunStatus;
  /** Small trailing badge, e.g. foreach progress "3/12". */
  runBadge?: string;
}

/** Border/ring classes per run status; statuses are also encoded by the badge
 * dot below so color is never the only signal. */
export function runStatusClasses(status: NodeRunStatus | undefined, selected: boolean): string {
  if (selected) return "border-moss ring-2 ring-moss";
  switch (status) {
    case "running":
      return "border-moss ring-2 ring-moss animate-pulse";
    case "succeeded":
      return "border-moss";
    case "failed":
      return "border-danger-500 ring-1 ring-danger-500";
    case "waiting":
      return "border-amber ring-2 ring-amber";
    case "skipped":
      return "border-line opacity-40";
    default:
      return "border-line";
  }
}

const RUN_STATUS_GLYPH: Record<NodeRunStatus, string> = {
  pending: "○",
  running: "◐",
  succeeded: "✓",
  failed: "✕",
  skipped: "⊘",
  waiting: "⏸",
};

/** The xyflow `Node<data, type>` shape this component is registered under (`nodeTypes.workflow`). */
export type FlowXyNode = Node<FlowNodeData, "workflow">;

export function FlowNode({ data, selected }: NodeProps<FlowXyNode>) {
  const { label, summary, hasError, sourceOutputs, nodeType, runStatus, runBadge } = data;

  return (
    <div
      className={`min-w-[180px] max-w-[240px] rounded-md border bg-paper px-3 py-2 shadow-sm ${runStatusClasses(
        runStatus,
        !!selected,
      )}`}
    >
      {nodeType !== "trigger" && (
        <Handle type="target" position={Position.Left} id="target" data-testid="handle-target" />
      )}

      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] font-medium uppercase tracking-wide text-muted">{label}</span>
        {runStatus && (
          <span
            data-testid="node-run-status"
            className="inline-flex items-center gap-1 text-[9px] font-medium text-muted"
            title={runBadge ? `${runStatus} (${runBadge})` : runStatus}
          >
            {RUN_STATUS_GLYPH[runStatus]}
            {runBadge ?? ""}
          </span>
        )}
        {hasError && (
          <span
            data-testid="node-error-badge"
            className="inline-flex h-4 items-center rounded-full bg-amber px-1.5 text-[9px] font-medium text-paper"
            title="This node has a validation error"
          >
            !
          </span>
        )}
      </div>
      <div className="mt-1 truncate text-sm text-ink" title={summary}>
        {summary}
      </div>

      {sourceOutputs ? (
        sourceOutputs.map((output, index) => (
          <Handle
            key={output}
            type="source"
            position={Position.Right}
            id={output}
            data-testid={`handle-source-${output}`}
            style={{ top: `${35 + index * 30}%` }}
          >
            <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 whitespace-nowrap text-[9px] text-muted">
              {output}
            </span>
          </Handle>
        ))
      ) : nodeType !== "stop" ? (
        <Handle type="source" position={Position.Right} id="source" data-testid="handle-source" />
      ) : null}
    </div>
  );
}
