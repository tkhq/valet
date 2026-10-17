import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import type {
  WorkflowDefinitionSummary,
  WorkflowTriggerItem,
} from "@valet/api/wire";
import { triggerDataSchema, visibleTriggerFields } from "@valet/workflow";
import { AlertCircle, Clock, MoreHorizontal, Trash2, Zap } from "lucide-react";
import { useState } from "react";
import {
  useDeleteWorkflow,
  useSetWorkflowEnabled,
  useStartRun,
  useWorkflows,
  useWorkflowTriggers,
} from "~/api/workflows";
import { OwnerBadge } from "~/components/owner-badge";
import {
  Button,
  ConfirmDialog,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Spinner,
  Switch,
} from "~/components/primitives";
import { ImportV1Dialog } from "~/components/workflows/import-v1-dialog";
import { ImportWorkflowDialog } from "~/components/workflows/import-workflow-dialog";
import { NewWorkflowDialog } from "~/components/workflows/new-workflow-dialog";
import { RunWorkflowDialog } from "~/components/workflows/run-workflow-dialog";
import { WorkflowCreation } from "~/components/workflows/workflow-creation";
import { relativeTime } from "~/lib/relative-time";
import { useListOwner } from "~/lib/use-list-owner";

/** `/workflows`: the workflow list and composer, back at its own top-nav
 * entry (spec Part A, Part G step 1). `validateSearch` keeps `workspace`,
 * `run`, `gate`, and `review` typed for links built before this move. */
export const Route = createFileRoute("/workflows/")({
  component: WorkflowsTab,
  validateSearch: (search: Record<string, unknown>): { workspace?: string; run?: string; gate?: string; review?: string } => ({
    workspace: typeof search.workspace === "string" ? search.workspace : undefined,
    run: typeof search.run === "string" ? search.run : undefined,
    gate: typeof search.gate === "string" ? search.gate : undefined,
    review: typeof search.review === "string" ? search.review : undefined,
  }),
});

export function WorkflowsTab() {
  const [creating, setCreating] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [v1Open, setV1Open] = useState(false);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button size="sm" onClick={() => setCreating(true)}>New workflow</Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild><Button size="sm" variant="ghost" aria-label="Workflow options"><MoreHorizontal className="h-4 w-4" /></Button></DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => setImportOpen(true)}>Import workflow</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setV1Open(true)}>Import from V1</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setNewOpen(true)}>Manual setup</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <NewWorkflowDialog open={newOpen} onOpenChange={setNewOpen} />
      <ImportWorkflowDialog open={importOpen} onOpenChange={setImportOpen} />
      <ImportV1Dialog open={v1Open} onOpenChange={setV1Open} />

      <WorkflowList creating={creating} onBegin={() => setCreating(true)} onBack={() => setCreating(false)} />
    </div>
  );
}

function WorkflowList({ creating, onBegin, onBack }: { creating: boolean; onBegin: () => void; onBack: () => void }) {
  // The nav's workspace switcher decides which workspace this list is FOR.
  // Without it the list answers with the caller's own workflows plus every
  // team's, which is a union that does not change when the switcher does —
  // so switching appeared to do nothing.
  const owner = useListOwner();
  const { data, isLoading, error } = useWorkflows(owner, { refetchInterval: 5_000, enabled: owner !== undefined });
  // Scoped to the same workspace, so the per-row routine and listener counts
  // match the list they annotate rather than the caller's whole reach.
  const triggersQ = useWorkflowTriggers(undefined, owner);
  const workflows = data?.workflows ?? [];

  // Group the listeners and routines by workflow for the per-row badges.
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
  if (workflows.length === 0 || creating) {
    return <WorkflowCreation key={owner?.ownerId} onBegin={onBegin} onBack={workflows.length > 0 ? onBack : undefined} />;
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-sm text-muted">{workflows.length} workflow{workflows.length === 1 ? "" : "s"} in this workspace</p><p className="text-xs text-muted">Open a workflow to edit its steps and what starts it.</p></div>
    <ul className="space-y-3">
      {workflows.map((wf) => (
        <DefinitionRow key={wf.id} workflow={wf} triggers={triggersByWf.get(wf.id) ?? []} />
      ))}
    </ul>
    </div>
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
  // On while any listener or routine can start it. The switch flips them
  // all, and its label reads the saved state the server returns.
  const setEnabled = useSetWorkflowEnabled();
  const on = triggers.some((trigger) => trigger.enabled);
  const del = useDeleteWorkflow();
  const navigate = useNavigate();
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [runOpen, setRunOpen] = useState(false);

  // A start node with declared, visible inputs routes through the run
  // dialog. Without one (a start node whose only field is `hidden` is one an
  // event maps in, not a person) Run starts immediately, with no empty
  // dialog.
  const schema = visibleTriggerFields(triggerDataSchema(workflow.definition));
  const hasSchema = Object.keys(schema).length > 0;

  function goToRun(runId: string) {
    void navigate({ to: "/workflows/runs/$runId", params: { runId } });
  }

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
    if (hasSchema) {
      setRunOpen(true);
      return;
    }
    const result = await startRun.mutateAsync();
    goToRun(result.runId);
  }

  async function handleDelete() {
    setDeleteError(null);
    try {
      await del.mutateAsync(workflow.id);
      setDeleteOpen(false);
    } catch (err) {
      // 409 = active runs; surface the server's actionable message. The
      // dialog stays open so the message sits beside the button that
      // caused it, and a retry needs no second trip through the row.
      setDeleteError(err instanceof Error ? err.message : "Delete failed.");
    }
  }

  return (
    // `relative` anchors the name link's stretched hit area below. The whole
    // row opens the workflow, because a row that looks like one target should
    // be one: clicking the empty space beside the name did nothing before.
    <li className="group relative flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-paper px-4 py-4 hover:border-ink-wash-strong">
      {/* The assistant badge is a link of its own, so it sits beside the name
          link, not inside it. Anything interactive here must sit ABOVE the
          stretched area — nesting it inside the anchor would be invalid and
          would swallow its own click. */}
      {/* At least 16rem wide, so on a narrow screen the actions wrap below the
          name instead of squeezing it to an ellipsis. */}
      <div className="flex min-w-0 flex-1 basis-64 flex-wrap items-center gap-2">
        <Link
          to="/workflows/$workflowId"
          params={{ workflowId: workflow.id }}
          className="min-w-0 truncate text-sm font-medium text-ink after:absolute after:inset-0 after:content-[''] group-hover:underline"
        >
          {workflow.name}
        </Link>
        <span className="relative z-10">
          <OwnerBadge
            ownerType={workflow.ownerType}
            ownerId={workflow.ownerId}
          />
        </span>
        {workflow.origin === "repo" && workflow.upstream && (
          <span
            title={`${workflow.upstream.repoFullName}:${workflow.upstream.path}`}
            className="relative z-10 max-w-full truncate rounded-full bg-ink-wash-strong px-2 py-0.5 font-mono text-xs text-muted"
          >
            {workflow.upstream.repoFullName}:{workflow.upstream.path}
          </span>
        )}

        <p className="basis-full text-xs leading-5 text-muted">Updated {relativeTime(workflow.updatedAt)}</p>
        <p className="basis-full text-xs text-muted">{nextFireAt ? `Next run ${new Date(nextFireAt).toLocaleString()}` : scheduleCount > 0 ? "Routine off" : eventCount > 0 ? "Runs when its event happens" : "Run when needed"}{workflow.latestRun ? ` · Last run ${workflow.latestRun.outcome ?? workflow.latestRun.status}` : " · No runs yet"}</p>
      </div>
      {hasSchema && (
        <RunWorkflowDialog
          workflowId={workflow.id}
          workflowName={workflow.name}
          schema={schema}
          open={runOpen}
          onOpenChange={setRunOpen}
          onStarted={goToRun}
        />
      )}
      <div className="relative z-10 flex max-w-full flex-wrap items-center gap-2">
        {scheduleCount > 0 && (
          <span
            aria-label={`${scheduleCount} routine${scheduleCount === 1 ? "" : "s"}`}
            title={nextFireAt ? `Next run ${new Date(nextFireAt).toLocaleString()}` : undefined}
            className="inline-flex items-center gap-1 rounded-full bg-ink-wash-strong px-2 py-0.5 text-xs text-muted"
          >
            <Clock className="h-3 w-3" /> {scheduleCount}
          </span>
        )}
        {eventCount > 0 && (
          <span
            aria-label={`${eventCount} ${eventCount === 1 ? "event" : "events"}`}
            className="inline-flex items-center gap-1 rounded-full bg-ink-wash-strong px-2 py-0.5 text-xs text-muted"
          >
            <Zap className="h-3 w-3" /> {eventCount}
          </span>
        )}
        {triggers.length > 0 && (
          <label className="inline-flex items-center gap-2 text-xs text-muted">
            <Switch checked={on} onCheckedChange={(enabled) => setEnabled.mutate({ triggers, enabled })} disabled={setEnabled.isPending}
              aria-label={`${workflow.name} ${on ? "on" : "off"}`} />
            {setEnabled.isPending ? "Saving…" : setEnabled.isError ? <span role="alert" className="text-danger-500">{setEnabled.error?.message ?? "Not saved."} Try again.</span> : on ? "On" : "Off"}
          </label>
        )}
        {workflow.latestFailedRun && (
          <Link
            to="/workflows/runs/$runId"
            params={{ runId: workflow.latestFailedRun.runId }}
            title={`Last failed ${relativeTime(workflow.latestFailedRun.failedAt)}`}
            className="inline-flex min-h-8 items-center gap-1.5 rounded border border-danger-500/30 px-2.5 py-1 text-xs font-medium text-danger-500 hover:bg-danger-500/10"
          >
            <AlertCircle className="h-3.5 w-3.5" /> View latest failed run
          </Link>
        )}
        <Button size="sm" onClick={() => void handleRun()} disabled={startRun.isPending}>
          {startRun.isPending ? "Starting…" : "Run"}
        </Button>
        {workflow.origin !== "repo" && (
          <>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setDeleteError(null);
                setDeleteOpen(true);
              }}
              disabled={del.isPending}
              aria-label={`Delete ${workflow.name}`}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
            <ConfirmDialog
              open={deleteOpen}
              onOpenChange={setDeleteOpen}
              title={`Delete "${workflow.name}"?`}
              description="The workflow, its saved versions, and what starts it are deleted. Settled run history is kept."
              confirmLabel="Delete workflow"
              pendingLabel="Deleting…"
              pending={del.isPending}
              error={deleteError}
              onConfirm={() => void handleDelete()}
            />
          </>
        )}
      </div>
    </li>
  )
}
