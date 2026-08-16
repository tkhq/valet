import { useMemo, useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { MoreHorizontal } from "lucide-react";
import { triggerDataSchema, type WorkflowDefinition } from "@valet/workflow";
import type { ListWorkflowRunsResponse } from "@valet/api/wire";
import {
  useStartRun,
  useUpdateWorkflow,
  useWorkflow,
  useWorkflowRuns,
  useWorkflowVersion,
  useWorkflowVersions,
  type UpdateWorkflowMutation,
} from "~/api/workflows";
import { isWorkflowDefinitionShape } from "~/components/workflows/editor-model";
import { RunWorkflowDialog } from "~/components/workflows/run-workflow-dialog";
import { Editor } from "~/components/workflows/editor/editor";
import { TriggersPanel } from "~/components/workflows/triggers-drawer";
import { WorkflowPreview } from "~/components/workflows/preview";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Spinner,
} from "~/components/primitives";
import { relativeTime } from "~/lib/relative-time";
import { runCountLabel } from "~/lib/run-count";
import { cn } from "~/lib/cn";

/**
 * `/workflows/$workflowId` — the visual editor page (plan decision 11):
 * canvas + inspector + Save (Task 8-10's `Editor`) plus a Run button and a
 * collapsible runs section. Replaces the old index-page JSON create/edit
 * form as the place definitions are actually edited; `workflows.index.tsx`
 * now only links here.
 */
export const Route = createFileRoute("/workflows/$workflowId")({
  component: WorkflowEditorRoute,
});

function WorkflowEditorRoute() {
  const { workflowId } = Route.useParams();
  return <WorkflowEditorPage workflowId={workflowId} />;
}

export function WorkflowEditorPage({ workflowId }: { workflowId: string }) {
  const { data, isLoading, error } = useWorkflow(workflowId);
  const update = useUpdateWorkflow(workflowId);
  const startRun = useStartRun(workflowId);
  const runsQ = useWorkflowRuns(workflowId);
  const navigate = useNavigate();

  const definition = useMemo<WorkflowDefinition | null>(() => {
    if (!data) return null;
    return isWorkflowDefinitionShape(data.definition) ? data.definition : null;
  }, [data]);

  if (isLoading) {
    return (
      <div className="flex-1 flex items-center gap-2 p-6 text-sm text-muted">
        <Spinner size={14} /> Loading workflow…
      </div>
    );
  }
  if (error || !data || !definition) {
    return <div className="flex-1 p-6 text-sm text-danger-500">Failed to load workflow.</div>;
  }

  return (
    <WorkflowEditorPane
      // Force a full remount on wf→wf navigation (review fix 4): without
      // this, `WorkflowEditorPane`'s `name`/`committedName` state — seeded
      // once from `initialName` at mount — would carry over from the
      // previous workflow while `Editor`'s own `initialDefinition` prop
      // silently changed underneath it, showing stale name/definition
      // state until the next edit.
      key={workflowId}
      workflowId={workflowId}
      initialName={data.name}
      initialDefinition={definition}
      update={update}
      startRun={startRun}
      runsQuery={runsQ}
      navigate={navigate}
    />
  );
}

function WorkflowEditorPane({
  workflowId,
  initialName,
  initialDefinition,
  update,
  startRun,
  runsQuery,
  navigate,
}: {
  workflowId: string;
  initialName: string;
  initialDefinition: WorkflowDefinition;
  update: UpdateWorkflowMutation;
  startRun: ReturnType<typeof useStartRun>;
  runsQuery: {
    data?: ListWorkflowRunsResponse;
    isLoading: boolean;
    error: unknown;
  };
  navigate: ReturnType<typeof useNavigate>;
}) {
  // Right-side drawer: runs list / version history / triggers. Header
  // buttons toggle it — the old bottom collapsible was invisible under a
  // full-height canvas ("no way to view the list of runs").
  const [drawer, setDrawer] = useState<"runs" | "history" | "triggers" | null>(null);
  // The rename control (review fix 1): name state lives here, at the page
  // level, rather than in `Editor` — `Editor` only needs to know whether
  // the name is dirty (`externalDirty`) so a rename rides the same
  // Save/Cancel actions as a definition edit. `committedName` tracks the
  // last-saved value locally instead of comparing against the query's
  // live `data.name`, so there's no race with the invalidate-then-refetch
  // that follows a successful save.
  const [name, setName] = useState(initialName);
  const [committedName, setCommittedName] = useState(initialName);
  const nameDirty = name !== committedName;
  const [runOpen, setRunOpen] = useState(false);

  // Run executes the SAVED definition (the api snapshots the stored row),
  // so the run dialog's schema comes from `initialDefinition`, not the
  // editor's in-progress draft.
  const schema = triggerDataSchema(initialDefinition);
  const hasSchema = schema !== undefined && Object.keys(schema).length > 0;

  async function handleSave(next: WorkflowDefinition) {
    await update.mutateAsync({ name, definition: next });
    setCommittedName(name);
  }

  function handleCancelName() {
    setName(committedName);
  }

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

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="flex items-center justify-between px-6 py-4 border-b border-line">
        <div className="flex items-center gap-3 min-w-0">
          <Link to="/workflows" className="text-xs text-muted hover:text-ink shrink-0">
            ← Workflows
          </Link>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            aria-label="Workflow name"
            placeholder="Untitled workflow"
            className="min-w-0 rounded border border-transparent bg-transparent px-1 -mx-1 text-lg font-semibold tracking-tight text-ink font-display hover:border-line focus:border-line focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/40"
          />
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant={drawer === "runs" ? "secondary" : "ghost"}
            onClick={() => setDrawer((d) => (d === "runs" ? null : "runs"))}
          >
            Runs{runsQuery.data ? ` (${runCountLabel(runsQuery.data)})` : ""}
          </Button>
          <Button
            size="sm"
            variant={drawer === "triggers" ? "secondary" : "ghost"}
            onClick={() => setDrawer((d) => (d === "triggers" ? null : "triggers"))}
          >
            Triggers
          </Button>
          <Button size="sm" onClick={() => void handleRun()} disabled={startRun.isPending}>
            {startRun.isPending ? "Starting…" : "Run"}
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                size="sm"
                variant={drawer === "history" ? "secondary" : "ghost"}
                aria-label="More"
              >
                <MoreHorizontal className="h-4 w-4" aria-hidden />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => setDrawer((d) => (d === "history" ? null : "history"))}>
                Version history
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {hasSchema && schema && (
        <RunWorkflowDialog
          workflowId={workflowId}
          workflowName={committedName}
          schema={schema}
          open={runOpen}
          onOpenChange={setRunOpen}
          onStarted={goToRun}
        />
      )}

      <div className="relative min-h-0 flex-1">
        <Editor
          initialDefinition={initialDefinition}
          onSave={handleSave}
          saving={update.isPending}
          externalDirty={nameDirty}
          onCancelExternal={handleCancelName}
        />
        {drawer === "runs" && <RunsDrawer runsQuery={runsQuery} onClose={() => setDrawer(null)} />}
        {drawer === "triggers" && (
          <DrawerShell title="Triggers" onClose={() => setDrawer(null)}>
            <TriggersPanel workflowId={workflowId} />
          </DrawerShell>
        )}
        {drawer === "history" && (
          <HistoryDrawer
            workflowId={workflowId}
            currentName={committedName}
            update={update}
            onClose={() => setDrawer(null)}
          />
        )}
      </div>
    </div>
  );
}

function DrawerShell({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="absolute inset-y-0 right-0 z-10 flex w-96 max-w-full flex-col border-l border-line bg-paper shadow-xl">
      <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
        <span className="text-sm font-medium text-ink">{title}</span>
        <button type="button" onClick={onClose} aria-label={`Close ${title.toLowerCase()}`} className="text-muted hover:text-ink">
          ✕
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
    </div>
  );
}

function RunsDrawer({
  runsQuery,
  onClose,
}: {
  runsQuery: { data?: ListWorkflowRunsResponse; isLoading: boolean; error: unknown };
  onClose: () => void;
}) {
  const runs = runsQuery.data?.runs ?? [];
  return (
    <DrawerShell
      title={`Runs${runsQuery.data ? ` (${runCountLabel(runsQuery.data)})` : ""}`}
      onClose={onClose}
    >
      {runsQuery.isLoading && (
        <div className="flex items-center gap-2 px-4 py-3 text-xs text-muted">
          <Spinner size={12} /> Loading runs…
        </div>
      )}
      {!runsQuery.isLoading && runsQuery.error != null && (
        <div className="px-4 py-3 text-xs text-danger-500">Failed to load runs.</div>
      )}
      {!runsQuery.isLoading && runsQuery.error == null && runs.length === 0 && (
        <div className="px-4 py-3 text-xs text-muted">No runs yet — press Run to start one.</div>
      )}
      <ul className="divide-y divide-line/60">
        {runs.map((r) => (
          <li key={r.runId}>
            <Link
              to="/workflows/runs/$runId"
              params={{ runId: r.runId }}
              className="flex items-center gap-2 px-4 py-2 hover:bg-ink-wash/60 transition-colors"
            >
              <span
                className={cn(
                  "inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[10px] font-medium",
                  r.needsApproval
                    ? "bg-amber-500/15 text-amber-700 dark:text-amber-300"
                    : r.outcome === "completed"
                      ? "bg-moss-wash text-moss"
                      : r.outcome === "failed"
                        ? "bg-rose-50 text-danger-500 dark:bg-rose-950/40"
                        : "bg-neutral-500/10 text-muted",
                )}
              >
                {r.needsApproval ? "needs approval" : (r.outcome ?? r.status)}
              </span>
              <span className="min-w-0 flex-1 truncate font-mono text-xs text-ink">{r.runId}</span>
              <span className="shrink-0 text-[10px] text-muted">{relativeTime(r.createdAt)}</span>
            </Link>
          </li>
        ))}
      </ul>
      {/* The list is one page. Say so — a silent cut reads as "these are all
          the runs". A paging control belongs with the run-list rebuild. */}
      {runsQuery.data?.nextCursor && (
        <div className="px-4 py-3 text-xs text-muted">
          Newest {runs.length} runs shown. Older runs stay reachable by run id.
        </div>
      )}
    </DrawerShell>
  );
}

function HistoryDrawer({
  workflowId,
  currentName,
  update,
  onClose,
}: {
  workflowId: string;
  currentName: string;
  update: UpdateWorkflowMutation;
  onClose: () => void;
}) {
  const versionsQ = useWorkflowVersions(workflowId);
  const [selected, setSelected] = useState<number | null>(null);
  const versionQ = useWorkflowVersion(workflowId, selected);
  const versions = versionsQ.data?.versions ?? [];
  const latest = versions[0]?.version;

  async function restore() {
    if (!versionQ.data) return;
    await update.mutateAsync({ name: currentName, definition: versionQ.data.definition });
    setSelected(null);
  }

  return (
    <DrawerShell title="History" onClose={onClose}>
      {versionsQ.isLoading && (
        <div className="flex items-center gap-2 px-4 py-3 text-xs text-muted">
          <Spinner size={12} /> Loading versions…
        </div>
      )}
      {!versionsQ.isLoading && versions.length === 0 && (
        <div className="px-4 py-3 text-xs text-muted">
          No versions yet — saved before version history existed. The next save creates v1.
        </div>
      )}
      <ul className="divide-y divide-line/60">
        {versions.map((v) => (
          <li key={v.version}>
            <button
              type="button"
              onClick={() => setSelected((cur) => (cur === v.version ? null : v.version))}
              className={cn(
                "flex w-full items-center gap-2 px-4 py-2 text-left transition-colors hover:bg-ink-wash/60",
                selected === v.version && "bg-moss-wash",
              )}
            >
              <span className="font-mono text-xs text-ink">v{v.version}</span>
              {v.version === latest && (
                <span className="rounded-full bg-moss-wash px-1.5 py-px text-[9px] font-medium text-moss">
                  current
                </span>
              )}
              <span className="min-w-0 flex-1 truncate text-xs text-muted">{v.name}</span>
              <span className="shrink-0 text-[10px] text-muted">{relativeTime(v.createdAt)}</span>
            </button>
            {selected === v.version && (
              <div className="space-y-2 border-t border-line/60 bg-paper px-3 py-2">
                {versionQ.isLoading && (
                  <div className="flex items-center gap-2 text-xs text-muted">
                    <Spinner size={12} /> Loading definition…
                  </div>
                )}
                {versionQ.data && isWorkflowDefinitionShape(versionQ.data.definition) && (
                  <WorkflowPreview definition={versionQ.data.definition} />
                )}
                {versionQ.data && !isWorkflowDefinitionShape(versionQ.data.definition) && (
                  <div className="text-xs text-muted">Stored definition is not a dag/v1 workflow.</div>
                )}
                {v.version !== latest && versionQ.data && (
                  <Button size="sm" variant="secondary" onClick={() => void restore()} disabled={update.isPending}>
                    {update.isPending ? "Restoring…" : `Restore v${v.version}`}
                  </Button>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
    </DrawerShell>
  );
}
