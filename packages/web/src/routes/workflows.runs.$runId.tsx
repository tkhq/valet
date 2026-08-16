import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import type { WorkflowRunDetail } from "@valet/api/wire";
import { useCancelRun, useRetryRun, useRunDetail } from "~/api/workflows";
import { ApprovalCard } from "~/components/workflows/approval-card";
import { CheckpointList } from "~/components/workflows/checkpoint-list";
import { PolicyGateCard } from "~/components/workflows/policy-gate-card";
import {
  findApprovalPrompt,
  findPendingApproval,
  runNeedsApproval,
  statusByNodeId,
} from "~/components/workflows/run-detail-helpers";
import { isWorkflowDefinitionShape } from "~/components/workflows/editor-model";
import { WorkflowPreview } from "~/components/workflows/preview";
import { Button, Spinner } from "~/components/primitives";
import { RunStatusChip } from "~/components/workflows/run-status-chip";

/**
 * `/workflows/runs/$runId` — status header, checkpoint list, pending-gate
 * cards, Cancel button (plan decision 19). Polls every 5s via `useRunDetail`
 * (stops once `run.status === 'settled'`).
 */
export const Route = createFileRoute("/workflows/runs/$runId")({
  component: RunDetailPage,
});

function RunDetailPage() {
  const { runId } = Route.useParams();
  const { data, isLoading, error } = useRunDetail(runId);
  const cancelRun = useCancelRun(runId);
  const retryRun = useRetryRun(runId);
  const navigate = useNavigate();

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
        onRetry={() =>
          retryRun.mutate(undefined, {
            onSuccess: ({ runId: newRunId }) =>
              navigate({ to: "/workflows/runs/$runId", params: { runId: newRunId } }),
          })
        }
        retryPending={retryRun.isPending}
      />
    </div>
  );
}

export interface RunDetailBodyProps {
  runId: string;
  data: WorkflowRunDetail;
  onCancel: () => void;
  cancelPending: boolean;
  onRetry: () => void;
  retryPending: boolean;
}

/**
 * Props-driven body (status bar + gate cards + checkpoint list), split out
 * from `RunDetailPage` so it's testable without router/query wiring — the
 * router `<Link>` above is the only thing that needs real router context, and
 * it's kept out of this component.
 */
export function RunDetailBody({
  runId,
  data,
  onCancel,
  cancelPending,
  onRetry,
  retryPending,
}: RunDetailBodyProps) {
  const { run, checkpoints } = data;
  const pendingGates = data.pendingGates ?? [];
  const needsApproval = runNeedsApproval(run, pendingGates);
  const nonTerminal = run.status !== "settled";
  const retryable =
    run.status === "settled" && (run.outcome === "failed" || run.outcome === "cancelled");
  const nodeStatuses = statusByNodeId(run, checkpoints);

  // Legacy signal-based approval: still resolve the prompt for approval-kind
  // gates that come via the old waitingOn path (fallback for older runs).
  const legacyPending =
    run.status === "parked" && pendingGates.length === 0
      ? findPendingApproval(run.waitingOn)
      : undefined;
  const legacyPrompt = legacyPending
    ? findApprovalPrompt(run.definition, legacyPending.nodeId)
    : undefined;

  return (
    <>
      <div className="flex items-center justify-between px-6 py-4 border-b border-line">
        <h1 className="text-lg font-semibold tracking-tight text-ink font-display">
          {run.runId}
        </h1>
        <div className="flex items-center gap-2">
          <RunStatusChip
            status={run.status}
            outcome={run.outcome}
            needsApproval={needsApproval}
          />
          {nonTerminal && (
            <Button size="sm" variant="danger" onClick={onCancel} disabled={cancelPending}>
              Cancel run
            </Button>
          )}
          {retryable && (
            <Button size="sm" onClick={onRetry} disabled={retryPending}>
              Retry run
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

        {/* Render ALL pending gates — approval gates first, then policy gates */}
        {pendingGates.map((gate) =>
          gate.kind === "approval" ? (
            <ApprovalCard
              key={gate.nodeId}
              runId={runId}
              nodeId={gate.nodeId}
              prompt={gate.prompt ?? findApprovalPrompt(run.definition, gate.nodeId)}
            />
          ) : (
            <PolicyGateCard key={`${gate.nodeId}:${gate.iteration ?? 0}`} runId={runId} gate={gate} />
          ),
        )}

        {/* Legacy fallback for runs that predate pendingGates */}
        {legacyPending && (
          <ApprovalCard runId={runId} nodeId={legacyPending.nodeId} prompt={legacyPrompt} />
        )}

        <CheckpointList checkpoints={checkpoints} />
      </div>
    </>
  );
}

