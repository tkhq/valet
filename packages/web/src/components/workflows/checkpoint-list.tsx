import { useState } from "react";
import { StepLogs } from "./step-logs";
import { Link } from "@tanstack/react-router";
import { RUN_STATUS_GLYPH, type NodeRunStatus } from "./editor/flow-node";
import { formatRunOutput } from "./run-detail-helpers";

export interface CheckpointLike {
  nodeId: string;
  iteration: number;
  status: string;
  error?: string | null;
  result?: unknown;
  sessionId?: string;
  childRunId?: string;
  threadId?: string;
  queueItemId?: string;
}

function toRunStatus(raw: string): NodeRunStatus {
  switch (raw) {
    case "completed": return "succeeded";
    case "failed": return "failed";
    case "skipped": return "skipped";
    case "intent": return "running";
    default: return "pending";
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

/** A completed checkpoint can record a denied action. */
function deniedResult(result: unknown): { resolvedBy?: string } | null {
  if (typeof result !== "object" || result === null) return null;
  if (!("policyDenied" in result) || result.policyDenied !== true) return null;
  const resolvedBy = "resolvedBy" in result ? result.resolvedBy : undefined;
  return { resolvedBy: typeof resolvedBy === "string" ? resolvedBy : undefined };
}

/** Compact step rows. Expand once for complete output and agent logs. */
export function CheckpointList({
  checkpoints,
  promotedNodeId,
  nodeStatuses,
  nodeOrder = [],
}: {
  checkpoints: CheckpointLike[];
  /** Keep output collapsed when the result panel already shows it. */
  promotedNodeId?: string;
  nodeStatuses?: Record<string, NodeRunStatus>;
  nodeOrder?: string[];
}) {
  if (checkpoints.length === 0) {
    return <p className="text-sm text-muted">No steps have started yet.</p>;
  }
  const order = new Map(nodeOrder.map((id, index) => [id, index]));
  return (
    <ol className="overflow-hidden rounded-lg border border-line divide-y divide-line">
      {[...checkpoints].sort((a, b) =>
        (order.get(a.nodeId) ?? nodeOrder.length) - (order.get(b.nodeId) ?? nodeOrder.length) ||
        a.nodeId.localeCompare(b.nodeId) || a.iteration - b.iteration,
      ).map((cp, index) => (
        <CheckpointRow
          key={`${cp.nodeId}:${cp.iteration}`}
          checkpoint={cp}
          number={(order.get(cp.nodeId) ?? index) + 1}
          promoted={cp.nodeId === promotedNodeId}
          waiting={cp.status === "intent" && nodeStatuses?.[cp.nodeId] === "waiting"}
        />
      ))}
    </ol>
  );
}

function CheckpointRow({ checkpoint, number, promoted, waiting }: {
  checkpoint: CheckpointLike;
  number: number;
  promoted: boolean;
  waiting: boolean;
}) {
  const [showLogs, setShowLogs] = useState(false);
  const status = waiting ? "waiting" : toRunStatus(checkpoint.status);
  const denied = deniedResult(checkpoint.result);
  const output = formatRunOutput(checkpoint.result);
  const open = (status === "failed" && !promoted) || status === "running" || waiting || Boolean(denied);

  return (
    <li className="min-w-0 bg-paper">
      <details className="group" open={open}>
        <summary className="flex min-h-11 cursor-pointer list-none items-center gap-3 px-4 py-3 hover:bg-neutral-100 dark:hover:bg-neutral-800 [&::-webkit-details-marker]:hidden">
          <span className="text-muted transition-transform group-open:rotate-90" aria-hidden>›</span>
          <span className="w-5 shrink-0 text-xs text-muted tabular-nums" aria-hidden>{number}</span>
          <span className={`shrink-0 text-sm ${TEXT_COLOR[status]}`} aria-hidden>{RUN_STATUS_GLYPH[status]}</span>
          <span className="min-w-0 flex-1 break-words text-sm font-medium text-ink">{checkpoint.nodeId}</span>
          {checkpoint.iteration > 0 && <span className="shrink-0 text-xs text-muted">Iteration {checkpoint.iteration + 1}</span>}
          <span className={`shrink-0 text-xs ${TEXT_COLOR[status]}`}>{denied ? "Denied" : LABEL[status]}</span>
        </summary>
        <div className="min-w-0 space-y-3 border-t border-line px-4 py-3 sm:pl-16">
          {(checkpoint.threadId || checkpoint.sessionId || checkpoint.childRunId) && (
            <div className="flex flex-wrap gap-x-4 text-xs">
              {checkpoint.sessionId && checkpoint.threadId && checkpoint.queueItemId ? (
                <button type="button" aria-expanded={showLogs} onClick={() => setShowLogs(!showLogs)} className="inline-flex min-h-11 items-center text-accent hover:underline sm:min-h-0">
                  {showLogs ? "Hide agent logs" : "View agent logs"}
                </button>
              ) : (checkpoint.sessionId || checkpoint.threadId) && (
                <span className="text-muted">Scoped agent logs were not recorded for this step.</span>
              )}
              {checkpoint.childRunId && (
                <Link to="/workflows/runs/$runId" params={{ runId: checkpoint.childRunId }} className="inline-flex min-h-11 items-center text-accent hover:underline sm:min-h-0">
                  Open child run
                </Link>
              )}
            </div>
          )}
          {showLogs && checkpoint.sessionId && checkpoint.threadId && checkpoint.queueItemId && (
            <StepLogs key={`${checkpoint.sessionId}:${checkpoint.threadId}:${checkpoint.queueItemId}`}
              sessionId={checkpoint.sessionId} threadId={checkpoint.threadId} queueItemId={checkpoint.queueItemId}
              active={status === "running" || waiting} />
          )}
          {denied ? (
            <p className="break-words text-xs text-danger-500">Denied by {denied.resolvedBy ?? "policy"}</p>
          ) : output ? (
            <>
              <h3 className="text-xs font-medium text-muted">Result</h3>
              <pre className="max-h-96 overflow-auto rounded bg-[--bg] p-3 font-mono text-xs text-ink">{output.text}</pre>
            </>
          ) : (
            <p className="text-xs text-muted">{status === "running" || waiting ? "This step has not produced output yet." : "No output recorded for this step."}</p>
          )}
        </div>
      </details>
      {checkpoint.error != null && <p className="break-words px-4 pb-3 text-xs text-danger-500 sm:pl-16">{checkpoint.error}</p>}
    </li>
  );
}
