import { RunWorkspace } from "~/components/workflows/run-workspace";
import { textParam } from "~/lib/search-params";
import { useEffect, useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import type { WorkflowRunDetail, WorkflowRunProvenance } from "@valet/api/wire";
import { useCancelRun, useRetryRun, useRunDetail } from "~/api/workflows";
import { useAdoptWorkspaceScope } from "~/lib/workspace-scope";
import { ApprovalCard } from "~/components/workflows/approval-card";
import { CheckpointList } from "~/components/workflows/checkpoint-list";
import { PolicyGateCard } from "~/components/workflows/policy-gate-card";
import {
  deriveRunResult,
  findApprovalPrompt,
  findPendingApproval,
  formatRunDuration,
  runNeedsApproval,
  statusByNodeId,
  runLabel,
} from "~/components/workflows/run-detail-helpers";
import { RunResultPanel } from "~/components/workflows/run-detail-result";
import { isWorkflowDefinitionShape } from "~/components/workflows/editor-model";
import { WorkflowPreview } from "~/components/workflows/preview";
import { RunWorkflowDialog } from "~/components/workflows/run-workflow-dialog";
import { triggerDataSchema, visibleTriggerFields } from "@valet/workflow";
import { Button, ConfirmDialog, Spinner } from "~/components/primitives";
import { RunStatusChip } from "~/components/workflows/run-status-chip";
import { formatWhen } from "~/lib/format-when";
import { formatUsdPrecise } from "~/lib/format-usage";
import { errorText } from "~/lib/error-text";

/**
 * `/workflows/runs/$runId` — the settled run's result first, then
 * pending gates and expandable steps. The diagram is optional.
 * Polls every 5s via `useRunDetail` (stops once
 * `run.status === 'settled'`).
 */
export const Route = createFileRoute("/workflows/runs/$runId")({
  component: RunDetailPage,
  validateSearch: (raw: unknown): { view?: "details" | "conversation"; conversation?: string } => ({
    view: textParam(raw, "view") === "details" ? "details" : undefined,
    conversation: textParam(raw, "conversation"),
  }),
});

function RunDetailPage() {
  const { runId } = Route.useParams();
  const search = Route.useSearch();
  const { data, isLoading, error } = useRunDetail(runId);
  // Arriving from a run notification for a team's run: move the switcher to
  // the run's workspace so the nav matches the page instead of showing
  // Personal. `data` is undefined while loading; adoption waits for it.
  useAdoptWorkspaceScope(data?.owner);
  const cancelRun = useCancelRun(runId);
  const retryRun = useRetryRun(runId);
  const resetRetry = retryRun.reset;
  // A refused retry belongs to its run. This page stays mounted when it
  // moves to another run, so the refusal must not follow it there.
  useEffect(() => resetRetry(), [runId, resetRetry]);
  const navigate = useNavigate();
  const [retryInputOpen, setRetryInputOpen] = useState(false);
  // A retry from the start can change the trigger inputs, for example a
  // shorter date range. The server checks them against the saved workflow.
  const schema = data && isWorkflowDefinitionShape(data.run.definition)
    ? visibleTriggerFields(triggerDataSchema(data.run.definition))
    : {};
  const goToRun = (newRunId: string) => void navigate({ to: "/workflows/runs/$runId", params: { runId: newRunId } });

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
    <div className="min-w-0 flex-1 flex flex-col min-h-0">
      <div className="px-4 py-4 sm:px-6 border-b border-line">
        <Link to="/workflows" className="inline-flex min-h-11 items-center text-xs text-muted hover:text-ink sm:min-h-0">
          ← Workflows
        </Link>
      </div>
      <RunWorkspace conversations={data.conversations ?? []} view={search.view} conversationId={search.conversation}
        onSelect={(view, conversation) => void navigate({ to: "/workflows/runs/$runId", params: { runId }, search: { view, conversation }, replace: true })}>
      <RunDetailBody
        runId={runId}
        data={data}
        onCancel={() => cancelRun.mutate()}
        cancelPending={cancelRun.isPending}
        onRetry={(from) => {
          if (from === "start" && Object.keys(schema).length > 0) {
            setRetryInputOpen(true);
            return;
          }
          retryRun.mutate({ from }, { onSuccess: ({ runId: newRunId }) => goToRun(newRunId) });
        }}
        retryPending={retryRun.isPending}
        retryError={retryRun.error ? errorText(retryRun.error) : undefined}
        onExplainFailure={(nodeId, iteration) => void navigate({
          to: "/workflows/$workflowId",
          params: { workflowId: data.run.workflowId },
          search: { explainRun: runId, explainStep: nodeId, ...(iteration > 0 ? { explainIteration: iteration } : {}) },
        })}
      />
      </RunWorkspace>
      {Object.keys(schema).length > 0 && (
        <RunWorkflowDialog
          workflowId={data.run.workflowId}
          workflowName={runLabel(data.run)}
          schema={schema}
          open={retryInputOpen}
          onOpenChange={setRetryInputOpen}
          onStarted={goToRun}
          retryOf={{ runId, input: runInputData(data.run.params) }}
        />
      )}
    </div>
  );
}

/** The trigger input values a run started with. */
function runInputData(params: unknown): Record<string, unknown> {
  const input = params && typeof params === "object" ? (params as { input?: unknown }).input : undefined;
  const data = input && typeof input === "object" ? (input as { data?: unknown }).data : undefined;
  return data && typeof data === "object" && !Array.isArray(data) ? { ...(data as Record<string, unknown>) } : {};
}

export interface RunDetailBodyProps {
  runId: string;
  data: WorkflowRunDetail;
  onCancel: () => void;
  cancelPending: boolean;
  onRetry: (from: "failed_step" | "start" | "changed_steps") => void;
  retryPending: boolean;
  /** Why the last retry was refused, with the corrective action. */
  retryError?: string;
  /** Opens the workflow editor and asks its assistant why this step failed. */
  onExplainFailure?: (nodeId: string, iteration: number) => void;
}

/**
 * Props-driven body (result panel + status bar + gate cards + checkpoint
 * list), split out from `RunDetailPage` so it's testable without router/query
 * wiring — the router `<Link>` above is the only thing that needs real router
 * context, and it's kept out of this component.
 */
export function RunDetailBody({
  runId,
  data,
  onCancel,
  cancelPending,
  onRetry,
  retryPending,
  retryError,
  onExplainFailure,
}: RunDetailBodyProps) {
  // Cancel stops a run part-way and cannot be undone, so it asks first.
  const [cancelOpen, setCancelOpen] = useState(false);
  // A re-run repeats the actions of the tool steps it runs, so it asks first.
  const [rerunOpen, setRerunOpen] = useState(false);
  const [diagramOpen, setDiagramOpen] = useState(false);
  const { run, checkpoints } = data;
  const stepCosts = data.stepCosts ?? [];
  const modelChanges = data.modelChanges ?? [];
  const pendingGates = data.pendingGates ?? [];
  const needsApproval = runNeedsApproval(run, pendingGates);
  const nonTerminal = run.status !== "settled";
  const retryable =
    run.status === "settled" && (run.outcome === "failed" || run.outcome === "cancelled");
  // Only worth offering when a finished step can be reused.
  const stepRetryable = retryable && run.outcome === "failed" && checkpoints.some((cp) => cp.status === "completed");
  const definition = isWorkflowDefinitionShape(run.definition) ? run.definition : undefined;
  // The server lists the steps that run again only for a completed run,
  // with each tool step's action from the workflow that will run.
  const rerunSteps = run.status === "settled" && run.outcome === "completed" ? data.rerunSteps ?? [] : [];
  const rerunNames = rerunSteps.map((step) => step.nodeId).join(", ");
  const rerunActions = rerunSteps.flatMap((step) => step.action ? [`${step.nodeId} (${step.action})`] : []);
  const nodeOrder = definition?.nodes.flatMap((node) => node.type === "foreach" ? [node.id, node.body.id] : [node.id]);
  const nodeStatuses = statusByNodeId(run, checkpoints);
  const activeSteps = Object.entries(nodeStatuses.status)
    .filter(([, status]) => status === "running" || status === "waiting")
    .map(([id]) => id);
  // The answer the person came for. Present only once the run has settled.
  const result = deriveRunResult(run, checkpoints);
  const duration = formatRunDuration(run.createdAt, run.updatedAt);
  const provenance = data.provenance;
  const changedSince = run.status === "settled" ? changesSinceRun(provenance) : [];

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
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-4 sm:px-6 border-b border-line">
        {/* A run id has no length bound. A flex item defaults to
            `min-width: auto`, so without `min-w-0` the heading refuses to
            shrink and pushes the status chip and the run controls off the
            row. */}
        <h1 className="min-w-0 break-words text-lg sm:truncate font-semibold tracking-tight text-ink font-display" title={run.runId}>
          {runLabel(run)}
        </h1>
        <div className="flex max-w-full flex-wrap items-center gap-2">
          <RunStatusChip
            status={run.status}
            outcome={run.outcome}
            needsApproval={needsApproval}
          />
          {nonTerminal && (
            <Button
              size="sm"
              variant="danger"
              onClick={() => setCancelOpen(true)}
              disabled={cancelPending}
            >
              {cancelPending ? "Cancelling…" : "Cancel run"}
            </Button>
          )}
          {stepRetryable && (
            <Button size="sm" onClick={() => onRetry("failed_step")} disabled={retryPending}
              title="Reuses the finished steps before the failure. A step edited since this run runs again.">
              {retryPending ? "Retrying…" : "Retry failed step"}
            </Button>
          )}
          {retryable && (
            <Button size="sm" variant={stepRetryable ? "secondary" : "primary"} onClick={() => onRetry("start")} disabled={retryPending}>
              {stepRetryable ? "Retry from start" : retryPending ? "Retrying…" : "Retry run"}
            </Button>
          )}
          {rerunSteps.length > 0 && (
            <Button size="sm" onClick={() => setRerunOpen(true)} disabled={retryPending}
              title={`Runs again: ${rerunNames}. Every other step keeps this run's result.`}>
              {retryPending ? "Re-running…" : "Re-run changed steps"}
            </Button>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={rerunOpen && rerunSteps.length > 0}
        onOpenChange={setRerunOpen}
        title="Re-run changed steps?"
        description={`These steps run again: ${rerunNames}. Every other step keeps this run's result.`}
        confirmLabel="Re-run changed steps"
        confirmVariant="primary"
        onConfirm={() => {
          setRerunOpen(false);
          onRetry("changed_steps");
        }}
      >
        {rerunActions.length > 0 && (
          <p className="rounded border border-line bg-warning-wash px-3 py-2 text-sm text-ink">
            These tool steps do their action: {rerunActions.join(", ")}.
          </p>
        )}
      </ConfirmDialog>

      {/* Tied to `nonTerminal` so a run that settles while the dialog is open
          takes the dialog with it — a confirm on a settled run does nothing. */}
      <ConfirmDialog
        open={cancelOpen && nonTerminal}
        onOpenChange={setCancelOpen}
        title="Cancel this run?"
        description="The run stops at the step it reached and cannot continue. To run the workflow again, select Retry run."
        confirmLabel="Cancel run"
        onConfirm={() => {
          setCancelOpen(false);
          onCancel();
        }}
      />

      <div className="min-w-0 flex-1 overflow-y-auto p-4 sm:p-6 space-y-4">
        {retryError && <p role="alert" className="text-sm text-danger-500">{retryError}</p>}

        {/* Above the answer: with no edit, a changed model is the likely
            reason a result differs from the last run. The Steps list marks
            the changed steps. */}
        {modelChanges.length > 0 && (
          <p role="status" className="rounded border border-line bg-warning-wash px-3 py-2 text-sm text-ink">
            The model changed for {modelChanges.length} {modelChanges.length === 1 ? "step" : "steps"} since the last run. The workflow was not edited.
          </p>
        )}

        {/* A failure often has a fix that shipped or an edit made after the
            run. Say so before the person starts debugging the old run. */}
        {changedSince.length > 0 && run.outcome !== "completed" && (
          <p role="status" className="rounded border border-line bg-warning-wash px-3 py-2 text-sm text-ink">
            Since this run, {changedSince.join(" and ")}. A retry uses the current versions.
          </p>
        )}

        {/* The settled answer comes first. Everything below it explains how
            the run reached that answer. */}
        {result && <RunResultPanel result={result} />}

        {/* Timings stay on one quiet line: they matter when a run is slow,
            and never more than the result itself. */}
        <p className="text-xs text-muted">
          Started {formatWhen(run.createdAt)}
          {/* `updatedAt` is the last write, not the current time. It gives a
              true duration only after the run stops writing. */}
          {run.status === "settled" && duration && ` · Ran for ${duration}`}
          {` · ${checkpoints.length} ${checkpoints.length === 1 ? "step" : "steps"}`}
          {provenance?.workflowVersion !== undefined && ` · Workflow version ${provenance.workflowVersion}`}
          {provenance?.build && ` · Valet build ${shortSha(provenance.build)}`}
        </p>

        {nonTerminal && activeSteps.length > 0 && (
          <p role="status" className="text-sm text-ink [overflow-wrap:anywhere]">
            {run.status === "parked" ? "Waiting at: " : "Running: "}{activeSteps.join(", ")}
          </p>
        )}

        {/* Render ALL pending gates — approval gates first, then policy gates */}
        {pendingGates.map((gate) =>
          gate.kind === "approval" ? (
            <ApprovalCard
              key={gate.nodeId}
              runId={runId}
              nodeId={gate.nodeId}
              prompt={gate.prompt ?? findApprovalPrompt(run.definition, gate.nodeId)}
              summary={gate.summary}
              details={gate.details}
              iteration={gate.iteration}
            />
          ) : (
            <PolicyGateCard key={gate.gateId ?? `${gate.nodeId}:${gate.iteration ?? 0}`} runId={runId} gate={gate} />
          ),
        )}

        {/* Legacy fallback for runs that predate pendingGates */}
        {legacyPending && (
          <ApprovalCard runId={runId} nodeId={legacyPending.nodeId} prompt={legacyPrompt} />
        )}

        <div>
          <h2 className="mb-2 flex items-baseline justify-between gap-3 text-xs font-medium uppercase tracking-wide text-muted">
            Steps
            {stepCosts.length > 0 && (
              <span className="normal-case tracking-normal tabular-nums">
                {/* A + marks a lower bound: some calls had no price. */}
                {formatUsdPrecise(stepCosts.reduce((sum, cost) => sum + cost.costUsd, 0))}
                {stepCosts.some((cost) => cost.unpricedTurns > 0) ? "+" : ""} model spend
              </span>
            )}
          </h2>
          <CheckpointList checkpoints={checkpoints} promotedNodeId={result?.nodeId} nodeStatuses={nodeStatuses.status} nodeOrder={nodeOrder} stepCosts={stepCosts} modelChanges={modelChanges}
            onExplainFailure={run.status === "settled" ? onExplainFailure : undefined} />
        </div>
        {definition && (
          <details onToggle={(event) => setDiagramOpen(event.currentTarget.open)}>
            <summary className="min-h-11 cursor-pointer py-3 text-sm text-muted hover:text-ink">Workflow diagram</summary>
            {diagramOpen && (
              <WorkflowPreview definition={definition} statusByNodeId={nodeStatuses.status} badgeByNodeId={nodeStatuses.badges} height={320} />
            )}
          </details>
        )}
      </div>
    </>
  );
}

function shortSha(sha: string): string {
  return sha.slice(0, 9);
}

/** What changed between the run and now: the server build, the saved workflow, or both. */
export function changesSinceRun(provenance: WorkflowRunProvenance | undefined): string[] {
  if (!provenance) return [];
  const changes: string[] = [];
  if (provenance.build && provenance.serverBuild && provenance.build !== provenance.serverBuild) {
    changes.push(`Valet was updated (build ${shortSha(provenance.build)} to ${shortSha(provenance.serverBuild)})`);
  }
  if (provenance.workflowVersion !== undefined && provenance.latestWorkflowVersion !== undefined
    && provenance.latestWorkflowVersion > provenance.workflowVersion) {
    changes.push(`the workflow was edited (version ${provenance.workflowVersion} to ${provenance.latestWorkflowVersion})`);
  }
  return changes;
}
