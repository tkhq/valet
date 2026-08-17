/**
 * Custom xyflow node for the workflow canvas (plan decision 10, canvas
 * half). Renders a paper card: the type's mark and small-caps name on one
 * quiet line, the node's summary as the line the reader actually reads, a
 * moss ring when selected, an amber badge when the node is named in the
 * current validation result, and a status pill when a run overlay
 * (`preview.tsx`) supplies one.
 *
 * The card is a FIXED 220px wide. `LAYOUT_COLUMN_GAP` in `editor-model.ts`
 * places columns 260px apart, so one width for every node makes the graph
 * read as a grid with an even 40px channel between columns, instead of
 * ragged cards whose left edges line up and right edges do not.
 *
 * Hover lives in `styles/react-flow.css`, not in a Tailwind `hover:`
 * variant here. This component renders on the editor canvas AND inside the
 * read-only preview, and only CSS can tell them apart (xyflow marks a
 * draggable node with its own class). A card that lifts under the cursor
 * where nothing can be clicked promises an interaction that is not there.
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
import { cn } from "~/lib/cn";
import type { DagNodeType } from "../editor-model";
import { NODE_ICON } from "./node-icon";

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
  /**
   * Set for one render on a node the canvas has not drawn before, which
   * plays the arrival animation. `canvas.tsx` decides this; a node cannot
   * know its own history.
   */
  entering?: boolean;
}

/**
 * The card's border for a given run state.
 *
 * Colour is never the only carrier: every state also has its own glyph
 * (`RUN_STATUS_GLYPH`) inside a pill washed to match, and `skipped` goes
 * dashed and dim as well, so the states stay apart in greyscale and for a
 * reader who cannot separate red from green.
 */
function statusBorderClasses(status: NodeRunStatus | undefined): string {
  switch (status) {
    case "running":
      return "border-moss";
    case "succeeded":
      return "border-success-500";
    case "failed":
      return "border-danger-500";
    case "waiting":
      return "border-amber";
    case "skipped":
      return "border-dashed border-line opacity-60";
    default:
      return "border-line";
  }
}

/**
 * Card classes for run state and selection together.
 *
 * The two are SEPARATE cues. The earlier form answered the selection ring
 * first and stopped, so selecting a failed node hid the fact that it had
 * failed. Here the status paints the border and selection adds the ring, so
 * a node that is both shows both. Selection only reaches the border when
 * there is no state for it to overwrite.
 */
export function nodeShellClasses(status: NodeRunStatus | undefined, selected: boolean): string {
  const carriesState = status !== undefined && status !== "pending";
  return cn(
    statusBorderClasses(status),
    selected && "ring-2 ring-moss",
    selected && !carriesState && "border-moss",
  );
}

/** Pill ground and text per run state — the wash tokens, never an opacity
 * modifier on a raw token (see the trap note in `theme.css`). */
export const STATUS_PILL_CLASSES: Record<NodeRunStatus, string> = {
  pending: "bg-ink-wash text-muted",
  running: "bg-moss-wash text-moss",
  succeeded: "bg-success-wash text-success-600 dark:text-success-500",
  failed: "bg-danger-wash text-danger-600 dark:text-danger-500",
  skipped: "bg-ink-wash text-muted",
  waiting: "bg-warning-wash text-warning-fg",
};

/** Also reused outside the canvas (e.g. `CheckpointList`) so a node's
 * status glyph reads identically wherever it's shown. */
export const RUN_STATUS_GLYPH: Record<NodeRunStatus, string> = {
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
  const { label, summary, hasError, sourceOutputs, nodeType, runStatus, runBadge, entering } = data;
  const Icon = NODE_ICON[nodeType];

  return (
    <div
      // `data-status` is what the hover rule in `styles/react-flow.css`
      // reads to leave a state-carrying border alone: darkening the border
      // of a failed node under the cursor would drop the one cue that says
      // it failed.
      data-status={runStatus ?? "none"}
      className={cn(
        "flow-node-card w-[220px] rounded-md border bg-paper px-3 py-2 shadow-sm",
        nodeShellClasses(runStatus, !!selected),
        entering && "flow-node-enter",
      )}
    >
      {nodeType !== "trigger" && (
        <Handle type="target" position={Position.Left} id="target" data-testid="handle-target" />
      )}

      <div className="flex items-center gap-1.5">
        <Icon className="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden />
        <span className="truncate text-[10px] font-medium uppercase tracking-wide text-muted">
          {label}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-1">
          {runStatus && (
            <span
              data-testid="node-run-status"
              className={cn(
                "inline-flex items-center gap-1 rounded px-1 py-px text-[9px] font-medium leading-none",
                STATUS_PILL_CLASSES[runStatus],
              )}
              title={runBadge ? `${runStatus} (${runBadge})` : runStatus}
            >
              {/* Only the in-flight state moves, and it moves this 9px
                  glyph rather than the whole card. One pulsing card reads
                  well; thirty of them are a flicker. */}
              <span
                aria-hidden
                className={cn(runStatus === "running" && "animate-pulse motion-reduce:animate-none")}
              >
                {RUN_STATUS_GLYPH[runStatus]}
              </span>
              <span className="sr-only">{runStatus}</span>
              {runBadge}
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
        </span>
      </div>
      {/* Two lines, then an ellipsis, with the whole text on the title —
          one line cut a prompt off after a handful of words. `break-words`
          is for the summaries that are one long unbroken token (a URL, a
          path), which would otherwise run past the card's edge. */}
      <div className="mt-1 line-clamp-2 break-words text-sm leading-snug text-ink" title={summary}>
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
            {/* The word is an authoring affordance. A read-only surface
                hides it (`styles/react-flow.css`) and keeps the handle,
                because the handle is what an edge attaches to. */}
            <span className="flow-node-branch-label pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 whitespace-nowrap text-[9px] text-muted">
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
