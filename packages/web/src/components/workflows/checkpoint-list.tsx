import { Link } from "@tanstack/react-router";
import { RUN_STATUS_GLYPH, type NodeRunStatus } from "./editor/flow-node";
import { jsonPreview } from "./run-detail-helpers";

export interface CheckpointLike {
  nodeId: string;
  iteration: number;
  status: string;
  error?: string | null;
  result?: unknown;
  /** The session a `session` node drove, when it started one. */
  sessionId?: string;
  /** The run a `workflow` node started, when it started one. */
  childRunId?: string;
}

/** Raw checkpoint status strings → the same `NodeRunStatus` vocabulary the
 * canvas uses, so a node reads the same way in both places. `"intent"` is
 * the store's write-ahead marker for a node that has started but not yet
 * settled — everything else not recognized falls back to `pending`. */
function toRunStatus(raw: string): NodeRunStatus {
  switch (raw) {
    case "completed":
      return "succeeded";
    case "failed":
      return "failed";
    case "skipped":
      return "skipped";
    case "intent":
      return "running";
    default:
      return "pending";
  }
}

const TEXT_COLOR: Record<NodeRunStatus, string> = {
  pending: "text-muted",
  running: "text-moss",
  succeeded: "text-moss",
  failed: "text-danger-500",
  skipped: "text-muted",
  waiting: "text-amber",
};

const LABEL: Record<NodeRunStatus, string> = {
  pending: "Pending",
  running: "Running",
  succeeded: "Completed",
  failed: "Failed",
  skipped: "Skipped",
  waiting: "Waiting",
};

/** The result body a policy-denied tool checkpoint carries. A denial is a
 * completed checkpoint, so the status alone cannot tell it from a success —
 * only the result body says the action never ran. */
function deniedResult(result: unknown): { resolvedBy?: string } | null {
  if (typeof result !== "object" || result === null) return null;
  if (!("policyDenied" in result) || result.policyDenied !== true) return null;
  const resolvedBy = "resolvedBy" in result ? result.resolvedBy : undefined;
  return { resolvedBy: typeof resolvedBy === "string" ? resolvedBy : undefined };
}

/**
 * A run's checkpoints as scannable status rows — same glyph/color language
 * as the canvas (`flow-node.tsx`'s `NodeRunStatus`), so "which node failed"
 * reads at a glance instead of requiring every row's text to be read.
 * Result JSON is collapsed by default and auto-open on failure, so a run
 * with many successful nodes doesn't bury the one that needs attention
 * under walls of JSON.
 */
export function CheckpointList({ checkpoints }: { checkpoints: CheckpointLike[] }) {
  if (checkpoints.length === 0) {
    return <p className="text-sm text-muted">No checkpoints yet.</p>;
  }
  return (
    <ul className="space-y-2">
      {checkpoints.map((cp) => (
        <CheckpointRow key={`${cp.nodeId}:${cp.iteration}`} checkpoint={cp} />
      ))}
    </ul>
  );
}

function CheckpointRow({ checkpoint }: { checkpoint: CheckpointLike }) {
  const status = toRunStatus(checkpoint.status);
  const denied = deniedResult(checkpoint.result);
  const hasBody = checkpoint.error != null || checkpoint.result !== undefined;

  return (
    <li className="rounded border border-line bg-paper p-3">
      <div className="flex items-center gap-2">
        <span className={`text-sm ${TEXT_COLOR[status]}`} aria-hidden>
          {RUN_STATUS_GLYPH[status]}
        </span>
        <span className="flex-1 truncate text-sm font-medium text-ink">{checkpoint.nodeId}</span>
        <span className={`text-xs ${TEXT_COLOR[status]}`}>{LABEL[status]}</span>
      </div>
      {/* The work the node started. On a failed node this is the only way
          to read what actually went wrong. */}
      {(checkpoint.sessionId || checkpoint.childRunId) && (
        <div className="mt-1 flex gap-3 pl-6 text-xs">
          {checkpoint.sessionId && (
            <Link
              to="/sessions/$sessionId"
              params={{ sessionId: checkpoint.sessionId }}
              className="text-muted hover:underline"
            >
              Open session
            </Link>
          )}
          {checkpoint.childRunId && (
            <Link
              to="/workflows/runs/$runId"
              params={{ runId: checkpoint.childRunId }}
              className="text-muted hover:underline"
            >
              Open child run
            </Link>
          )}
        </div>
      )}
      {checkpoint.error != null && (
        <div className="mt-1 pl-6 text-xs text-danger-500">{checkpoint.error}</div>
      )}
      {denied && (
        <div className="mt-1 pl-6 text-xs text-danger-500">
          Denied by {denied.resolvedBy ?? "policy"}
        </div>
      )}
      {/* A denial's result body is the denial record, not a tool result.
          The line above already states it, so showing the raw JSON too
          would report the same fact twice. */}
      {checkpoint.result !== undefined && hasBody && !denied && (
        <details className="mt-2 pl-6" open={status === "failed"}>
          <summary className="cursor-pointer text-xs text-muted hover:text-ink">Result</summary>
          <pre className="mt-1 overflow-x-auto rounded bg-[--bg] p-2 font-mono text-xs text-muted">
            {jsonPreview(checkpoint.result)}
          </pre>
        </details>
      )}
    </li>
  );
}
