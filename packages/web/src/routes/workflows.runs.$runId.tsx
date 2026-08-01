import { createFileRoute, Link } from "@tanstack/react-router";
import type { WorkflowRunDetail } from "@valet/api/wire";
import { useCancelRun, useRunDetail } from "~/api/workflows";
import { ApprovalCard } from "~/components/workflows/approval-card";
import {
  findApprovalPrompt,
  findPendingApproval,
  jsonPreview,
  statusByNodeId,
} from "~/components/workflows/run-detail-helpers";
import { isWorkflowDefinitionShape } from "~/components/workflows/editor-model";
import { WorkflowPreview } from "~/components/workflows/preview";
import { Badge, Button, Spinner } from "~/components/primitives";

/**
 * `/workflows/runs/$runId` — status header, checkpoint list, pending-
 * approval card, Cancel button (plan decision 19). Polls every 5s via
 * `useRunDetail` (stops once `run.status === 'settled'`).
 */
export const Route = createFileRoute("/workflows/runs/$runId")({
  component: RunDetailPage,
});

const OUTCOME_VARIANT = {
  completed: "success",
  failed: "danger",
  cancelled: "neutral",
} as const;

function RunDetailPage() {
  const { runId } = Route.useParams();
  const { data, isLoading, error } = useRunDetail(runId);
  const cancelRun = useCancelRun(runId);

  if (isLoading) {
    return (
      <div className="flex-1 flex items-center gap-2 p-6 text-sm text-muted">
        <Spinner size={14} /> Loading run…
      </div>
    );
  }
  if (error || !data) {
    return <div className="flex-1 p-6 text-sm text-danger-500">Failed to load run.</div>;
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="px-6 py-4 border-b border-line">
        <Link to="/workflows" className="text-xs text-muted hover:text-ink">
          ← Workflows
        </Link>
      </div>
      <RunDetailBody
        runId={runId}
        data={data}
        onCancel={() => cancelRun.mutate()}
        cancelPending={cancelRun.isPending}
      />
    </div>
  );
}

export interface RunDetailBodyProps {
  runId: string;
  data: WorkflowRunDetail;
  onCancel: () => void;
  cancelPending: boolean;
}

/**
 * Props-driven body (status bar + approval card + checkpoint list), split
 * out from `RunDetailPage` so it's testable without router/query wiring —
 * the router `<Link>` above is the only thing that needs real router
 * context, and it's kept out of this component.
 */
export function RunDetailBody({ runId, data, onCancel, cancelPending }: RunDetailBodyProps) {
  const { run, checkpoints } = data;
  const pending = run.status === "parked" ? findPendingApproval(run.waitingOn) : undefined;
  const prompt = pending ? findApprovalPrompt(run.definition, pending.nodeId) : undefined;
  const nonTerminal = run.status !== "settled";
  const nodeStatuses = statusByNodeId(run, checkpoints);

  return (
    <>
      <div className="flex items-center justify-between px-6 py-4 border-b border-line">
        <h1 className="text-lg font-semibold tracking-tight text-ink font-display">
          {run.runId}
        </h1>
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted">{run.status}</span>
          {run.outcome && <Badge variant={OUTCOME_VARIANT[run.outcome]}>{run.outcome}</Badge>}
          {nonTerminal && (
            <Button size="sm" variant="danger" onClick={onCancel} disabled={cancelPending}>
              Cancel run
            </Button>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-6 space-y-4">
        {isWorkflowDefinitionShape(run.definition) && (
          <WorkflowPreview
            definition={run.definition}
            statusByNodeId={nodeStatuses.status}
            badgeByNodeId={nodeStatuses.badges}
            height={320}
          />
        )}

        {pending && <ApprovalCard runId={runId} nodeId={pending.nodeId} prompt={prompt} />}

        <ul className="space-y-2">
          {checkpoints.map((cp) => (
            <li
              key={`${cp.nodeId}:${cp.iteration}`}
              className="rounded border border-line bg-paper p-3"
            >
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-ink">{cp.nodeId}</span>
                <span className="text-xs text-muted">{cp.status}</span>
              </div>
              {cp.error && <div className="mt-1 text-xs text-danger-500">{cp.error}</div>}
              {cp.result !== undefined && (
                <pre className="mt-2 overflow-x-auto rounded bg-[--bg] p-2 font-mono text-xs text-muted">
                  {jsonPreview(cp.result)}
                </pre>
              )}
            </li>
          ))}
          {checkpoints.length === 0 && <li className="text-sm text-muted">No checkpoints yet.</li>}
        </ul>
      </div>
    </>
  );
}
