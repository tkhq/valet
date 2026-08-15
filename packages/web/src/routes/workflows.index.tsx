import { useState } from "react";
import { createFileRoute, Link, useNavigate, useSearch } from "@tanstack/react-router";
import { Clock, Trash2, Zap } from "lucide-react";
import type { WorkflowDefinitionSummary, WorkflowTriggerItem } from "@valet/api/wire";
import {
  useAllWorkflowRuns,
  useDeleteWorkflow,
  useStartRun,
  useWorkflowRuns,
  useWorkflowTriggers,
  useWorkflows,
} from "~/api/workflows";
import { NewWorkflowDialog } from "~/components/workflows/new-workflow-dialog";
import { TriggerList } from "~/components/workflows/trigger-list";
import { RunStatusChip } from "~/components/workflows/run-status-chip";
import { Button, Spinner } from "~/components/primitives";

/**
 * `/workflows` — tabbed hub (Workflows | Runs | Triggers). The Workflows tab
 * preserves the definitions list with trigger badges; Runs shows the global
 * runs feed; Triggers shows the unified `TriggerList`. Tab state lives in the
 * `?tab=` search param so each tab is linkable.
 */

type HubTab = "workflows" | "runs" | "triggers";

export const Route = createFileRoute("/workflows/")({
  component: WorkflowsIndexPage,
  validateSearch: (search: Record<string, unknown>): { tab?: HubTab } => ({
    tab: search.tab === "runs" || search.tab === "triggers" ? search.tab : undefined,
  }),
});

const TABS: { id: HubTab; label: string }[] = [
  { id: "workflows", label: "Workflows" },
  { id: "runs", label: "Runs" },
  { id: "triggers", label: "Triggers" },
];

export function WorkflowsIndexPage() {
  // Use the top-level useSearch hook so the test mock works without
  // Route.useSearch() requiring a real router context.
  const search = useSearch({ strict: false }) as { tab?: HubTab };
  const navigate = useNavigate();
  const tab: HubTab = search.tab ?? "workflows";
  const [newOpen, setNewOpen] = useState(false);

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="border-b border-line px-6 pt-4">
        <div className="flex items-center justify-between">
          <h1 className="text-lg font-semibold tracking-tight text-ink font-display">Workflows</h1>
          <Button size="sm" onClick={() => setNewOpen(true)}>
            New workflow
          </Button>
        </div>
        <div role="tablist" className="mt-3 flex gap-1">
          {TABS.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={tab === t.id}
              onClick={() =>
                void navigate({
                  to: "/workflows",
                  search: t.id === "workflows" ? {} : { tab: t.id },
                })
              }
              className={`rounded-t px-3 py-1.5 text-sm border-b-2 ${
                tab === t.id
                  ? "border-ink font-medium text-ink"
                  : "border-transparent text-muted hover:text-ink"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      <NewWorkflowDialog open={newOpen} onOpenChange={setNewOpen} />

      <div className="flex-1 overflow-y-auto p-6">
        {tab === "workflows" && <WorkflowsTab onNew={() => setNewOpen(true)} />}
        {tab === "runs" && <RunsTab />}
        {tab === "triggers" && <TriggerList />}
      </div>
    </div>
  );
}

function WorkflowsTab({ onNew }: { onNew: () => void }) {
  const { data, isLoading, error } = useWorkflows();
  const triggersQ = useWorkflowTriggers();
  const workflows = data?.workflows ?? [];

  // Group triggers by workflowId for per-row badges.
  const triggersByWf = new Map<string, WorkflowTriggerItem[]>();
  for (const t of triggersQ.data?.triggers ?? []) {
    if (!t.workflowId) continue;
    const list = triggersByWf.get(t.workflowId) ?? [];
    list.push(t);
    triggersByWf.set(t.workflowId, list);
  }

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted">
        <Spinner size={14} /> Loading workflows…
      </div>
    );
  }
  if (error) {
    return <div className="text-sm text-danger-500">Failed to load workflows.</div>;
  }
  if (workflows.length === 0) {
    return (
      <div className="text-sm text-muted">
        No workflows yet —{" "}
        <button
          type="button"
          onClick={onNew}
          className="text-ink underline underline-offset-2 hover:text-moss"
        >
          create one
        </button>
        .
      </div>
    );
  }

  return (
    <ul className="space-y-2">
      {workflows.map((wf) => (
        <DefinitionRow key={wf.id} workflow={wf} triggers={triggersByWf.get(wf.id) ?? []} />
      ))}
    </ul>
  );
}

function DefinitionRow({
  workflow,
  triggers,
}: {
  workflow: WorkflowDefinitionSummary;
  triggers: WorkflowTriggerItem[];
}) {
  const startRun = useStartRun(workflow.id);
  const runsQ = useWorkflowRuns(workflow.id);
  const del = useDeleteWorkflow();
  const navigate = useNavigate();
  const runs = runsQ.data?.runs ?? [];
  const runCount = runsQ.data?.runs.length;
  const latestRun = runs[0];
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const schedules = triggers.filter(
    (t): t is Extract<WorkflowTriggerItem, { kind: "schedule" }> => t.kind === "schedule",
  );
  const events = triggers.filter((t) => t.kind === "event");
  const scheduleCount = schedules.length;
  const eventCount = events.length;

  // Earliest next fire among enabled schedules.
  const nextFire = schedules
    .filter((t) => t.enabled)
    .map((t) => t.detail.nextFireAt)
    .reduce((min, v) => Math.min(min, v), Infinity);
  const nextFireAt = isFinite(nextFire) ? nextFire : undefined;

  async function handleRun() {
    const result = await startRun.mutateAsync();
    void navigate({ to: "/workflows/runs/$runId", params: { runId: result.runId } });
  }

  async function handleDelete() {
    if (!confirm(`Delete workflow "${workflow.name}"? Settled run history is kept.`)) return;
    setDeleteError(null);
    try {
      await del.mutateAsync(workflow.id);
    } catch (err) {
      // 409 = active runs; surface the server's actionable message.
      setDeleteError(err instanceof Error ? err.message : "Delete failed.");
    }
  }

  return (
    <li className="flex items-center justify-between gap-3 rounded border border-line bg-paper px-4 py-3">
      <Link
        to="/workflows/$workflowId"
        params={{ workflowId: workflow.id }}
        className="min-w-0 text-sm font-medium text-ink hover:underline"
      >
        {workflow.name}
        {runCount !== undefined && (
          <span className="ml-2 text-xs text-muted font-normal">
            {runCount} run{runCount === 1 ? "" : "s"}
          </span>
        )}
      </Link>
      <div className="flex items-center gap-2 shrink-0 flex-wrap">
        {scheduleCount > 0 && (
          <span
            aria-label={`${scheduleCount} schedule${scheduleCount === 1 ? "" : "s"}`}
            title={nextFireAt ? `next fire ${new Date(nextFireAt).toLocaleString()}` : undefined}
            className="inline-flex items-center gap-1 rounded-full bg-muted/10 px-2 py-0.5 text-xs text-muted"
          >
            <Clock className="h-3 w-3" /> {scheduleCount}
          </span>
        )}
        {eventCount > 0 && (
          <span
            aria-label={`${eventCount} event trigger${eventCount === 1 ? "" : "s"}`}
            className="inline-flex items-center gap-1 rounded-full bg-muted/10 px-2 py-0.5 text-xs text-muted"
          >
            <Zap className="h-3 w-3" /> {eventCount}
          </span>
        )}
        {latestRun && (
          <RunStatusChip status={latestRun.status} outcome={latestRun.outcome} />
        )}
        {deleteError && <span className="text-xs text-danger-500">{deleteError}</span>}
        <Button size="sm" onClick={() => void handleRun()} disabled={startRun.isPending}>
          {startRun.isPending ? "Starting…" : "Run"}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => void handleDelete()}
          disabled={del.isPending}
          aria-label={`Delete ${workflow.name}`}
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>
    </li>
  );
}

function RunsTab() {
  const { data, isLoading, error } = useAllWorkflowRuns();
  const runs = data?.runs ?? [];

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted">
        <Spinner size={14} /> Loading runs…
      </div>
    );
  }
  if (error) {
    return <div className="text-sm text-danger-500">Failed to load runs.</div>;
  }
  if (runs.length === 0) {
    return (
      <div className="text-sm text-muted">
        No runs yet. Run a workflow from the Workflows tab.
      </div>
    );
  }

  return (
    <ul className="space-y-2">
      {runs.map((r) => (
        <li key={r.runId}>
          <Link
            to="/workflows/runs/$runId"
            params={{ runId: r.runId }}
            className="flex items-center justify-between gap-3 rounded border border-line bg-paper px-4 py-3 hover:border-ink/30"
          >
            <div className="min-w-0">
              <div className="truncate text-sm font-medium text-ink">{r.workflowName}</div>
              <div className="truncate text-xs text-muted font-mono">{r.runId}</div>
            </div>
            <div className="flex shrink-0 items-center gap-3">
              <span className="text-xs text-muted">{new Date(r.createdAt).toLocaleString()}</span>
              <RunStatusChip status={r.status} outcome={r.outcome} />
            </div>
          </Link>
        </li>
      ))}
    </ul>
  );
}
