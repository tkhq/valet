import { useMemo, useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Trash2 } from "lucide-react";
import type { WorkflowDefinitionSummary } from "@valet/api/wire";
import { useDeleteWorkflow, useStartRun, useWorkflowRuns, useWorkflows } from "~/api/workflows";
import { useTeams } from "~/api/settings";
import { NewWorkflowDialog } from "~/components/workflows/new-workflow-dialog";
import { Badge, Button, Spinner } from "~/components/primitives";

/**
 * `/workflows` — the definitions list (plan decision 11). Each row's name
 * links to `/workflows/$workflowId` (the visual editor); the JSON
 * create/edit form is gone — "New workflow" opens `NewWorkflowDialog`
 * (review fix 1: a name prompt instead of a hardcoded "Untitled
 * workflow"), which POSTs the entered name + a minimal definition and
 * navigates straight to the editor. Editing an existing definition happens
 * on its editor page, not here.
 */
export const Route = createFileRoute("/workflows/")({
  component: WorkflowsIndexPage,
});

export function WorkflowsIndexPage() {
  const { data, isLoading, error } = useWorkflows();
  const teamsQ = useTeams();
  const [newOpen, setNewOpen] = useState(false);

  const workflows = data?.workflows ?? [];
  const teamNames = useMemo(
    () => new Map((teamsQ.data?.teams ?? []).map((t) => [t.id, t.name])),
    [teamsQ.data],
  );

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="flex items-center justify-between px-6 py-4 border-b border-line">
        <h1 className="text-lg font-semibold tracking-tight text-ink font-display">Workflows</h1>
        <Button size="sm" onClick={() => setNewOpen(true)}>
          New workflow
        </Button>
      </div>

      <NewWorkflowDialog open={newOpen} onOpenChange={setNewOpen} />

      <div className="flex-1 overflow-y-auto p-6 space-y-4">
        {isLoading && (
          <div className="flex items-center gap-2 text-sm text-muted">
            <Spinner size={14} /> Loading workflows…
          </div>
        )}
        {!isLoading && error && (
          <div className="text-sm text-danger-500">Failed to load workflows.</div>
        )}
        {!isLoading && !error && workflows.length === 0 && (
          <div className="text-sm text-muted">
            No workflows yet —{" "}
            <button
              type="button"
              onClick={() => setNewOpen(true)}
              className="text-ink underline underline-offset-2 hover:text-moss"
            >
              create one
            </button>
            .
          </div>
        )}

        {!isLoading && workflows.length > 0 && (
          <ul className="space-y-2">
            {workflows.map((wf) => (
              <DefinitionRow key={wf.id} workflow={wf} teamNames={teamNames} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function DefinitionRow({
  workflow,
  teamNames,
}: {
  workflow: WorkflowDefinitionSummary;
  teamNames: Map<string, string>;
}) {
  const startRun = useStartRun(workflow.id);
  const runsQ = useWorkflowRuns(workflow.id);
  const del = useDeleteWorkflow();
  const navigate = useNavigate();
  const runCount = runsQ.data?.runs.length;
  const [deleteError, setDeleteError] = useState<string | null>(null);

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
        {workflow.ownerType === "team" && (
          <Badge variant="accent" className="ml-2 align-middle">
            {teamNames.get(workflow.ownerId) ?? "Team"}
          </Badge>
        )}
        {runCount !== undefined && (
          <span className="ml-2 text-xs text-muted font-normal">
            {runCount} run{runCount === 1 ? "" : "s"}
          </span>
        )}
      </Link>
      <div className="flex items-center gap-2 shrink-0">
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
