import { useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Trash2 } from "lucide-react";
import type { WorkflowDefinitionSummary } from "@valet/api/wire";
import { triggerDataSchema } from "@valet/workflow";
import { useDeleteWorkflow, useStartRun, useWorkflowRuns, useWorkflows } from "~/api/workflows";
import { OwnerBadge } from "~/components/owner-badge";
import { runCountLabel } from "~/lib/run-count";
import { NewWorkflowDialog } from "~/components/workflows/new-workflow-dialog";
import { RunWorkflowDialog } from "~/components/workflows/run-workflow-dialog";
import { TemplateGallery } from "~/components/workflows/template-gallery";
import { Button, Spinner } from "~/components/primitives";
import { cn } from "~/lib/cn";

/**
 * `/workflows` — the definitions list (plan decision 11). Each row's name
 * links to `/workflows/$workflowId` (the visual editor); the JSON
 * create/edit form is gone — "New workflow" opens `NewWorkflowDialog`
 * (review fix 1: a name prompt instead of a hardcoded "Untitled
 * workflow"), which POSTs the entered name + a minimal definition and
 * navigates straight to the editor. Editing an existing definition happens
 * on its editor page, not here.
 *
 * Templates live on this page too, and where they live depends on what the
 * caller already has. With no workflows, the gallery IS the page: an empty
 * automation product with no starting points is the hardest possible first
 * run, and a person with nothing to list needs nothing else on screen. With
 * workflows, the list stays the page and templates move behind a tab — one
 * click away, one row of chrome, and never between somebody and the twenty
 * workflows they came here to open.
 *
 * The gallery is mounted only when it is shown, so the templates request is
 * never made for a caller who stays on their list.
 */
export const Route = createFileRoute("/workflows/")({
  component: WorkflowsIndexPage,
});

type Tab = "workflows" | "templates";

const TABS: ReadonlyArray<{ id: Tab; label: string }> = [
  { id: "workflows", label: "Your workflows" },
  { id: "templates", label: "Templates" },
];

export function WorkflowsIndexPage() {
  const { data, isLoading, error } = useWorkflows();
  const [newOpen, setNewOpen] = useState(false);
  const [tab, setTab] = useState<Tab>("workflows");

  const workflows = data?.workflows ?? [];
  const settled = !isLoading && !error;
  const empty = settled && workflows.length === 0;

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

        {empty && (
          <>
            <p className="text-sm text-muted">
              No workflows yet. Start from a template, or build one from scratch with{" "}
              <button
                type="button"
                onClick={() => setNewOpen(true)}
                className="text-ink underline underline-offset-2 hover:text-moss"
              >
                New workflow
              </button>
              .
            </p>
            <TemplateGallery />
          </>
        )}

        {settled && workflows.length > 0 && (
          <>
            <div className="flex items-center gap-2" role="tablist" aria-label="Workflows or templates">
              {TABS.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  role="tab"
                  aria-selected={tab === entry.id}
                  onClick={() => setTab(entry.id)}
                  className={cn(
                    "rounded-full border px-3 py-1 text-xs transition-colors",
                    tab === entry.id
                      ? "border-moss bg-moss text-white"
                      : "border-line bg-paper text-muted hover:text-ink",
                  )}
                >
                  {entry.label}
                </button>
              ))}
            </div>

            {tab === "workflows" ? (
              <ul className="space-y-2">
                {workflows.map((wf) => (
                  <DefinitionRow key={wf.id} workflow={wf} />
                ))}
              </ul>
            ) : (
              <TemplateGallery />
            )}
          </>
        )}
      </div>
    </div>
  );
}

function DefinitionRow({ workflow }: { workflow: WorkflowDefinitionSummary }) {
  const startRun = useStartRun(workflow.id);
  const runsQ = useWorkflowRuns(workflow.id);
  const del = useDeleteWorkflow();
  const navigate = useNavigate();
  const runCount = runsQ.data?.runs.length;
  const countLabel = runCountLabel(runsQ.data);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [runOpen, setRunOpen] = useState(false);

  // A trigger with declared inputs routes through the run dialog; without
  // one, Run starts immediately as before (no empty-dialog flash).
  const schema = triggerDataSchema(workflow.definition);
  const hasSchema = schema !== undefined && Object.keys(schema).length > 0;

  function goToRun(runId: string) {
    void navigate({ to: "/workflows/runs/$runId", params: { runId } });
  }

  async function handleRun() {
    if (hasSchema) {
      setRunOpen(true);
      return;
    }
    const result = await startRun.mutateAsync();
    goToRun(result.runId);
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
      {/* The owner badge is a link of its own, so it sits beside the name
          link, not inside it. */}
      <div className="flex min-w-0 items-center gap-2">
        <Link
          to="/workflows/$workflowId"
          params={{ workflowId: workflow.id }}
          className="min-w-0 truncate text-sm font-medium text-ink hover:underline"
        >
          {workflow.name}
        </Link>
        <OwnerBadge ownerType={workflow.ownerType} ownerId={workflow.ownerId} />
        {countLabel !== undefined && (
          <span className="shrink-0 text-xs font-normal text-muted">
            {countLabel} run{runCount === 1 && !runsQ.data?.nextCursor ? "" : "s"}
          </span>
        )}
      </div>
      {hasSchema && schema && (
        <RunWorkflowDialog
          workflowId={workflow.id}
          workflowName={workflow.name}
          schema={schema}
          open={runOpen}
          onOpenChange={setRunOpen}
          onStarted={goToRun}
        />
      )}
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
