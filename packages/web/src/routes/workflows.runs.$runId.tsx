import { createFileRoute, Link } from "@tanstack/react-router";
import type { WorkflowRunDetail } from "@valet/api/wire";
import { useCancelRun, useRunDetail } from "~/api/workflows";
import { ApprovalCard } from "~/components/workflows/approval-card";
import { CheckpointList } from "~/components/workflows/checkpoint-list";
import {
  findApprovalPrompt,
  findPendingApproval,
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
          {/* A settled run always carries an outcome, so the outcome
              replaces the status rather than repeating beside it. */}
          <Badge variant={run.outcome ? OUTCOME_VARIANT[run.outcome] : "neutral"}>
            {run.outcome ?? run.status}
          </Badge>
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

        <CheckpointList checkpoints={checkpoints} />
      </div>
    </>
  );
}
