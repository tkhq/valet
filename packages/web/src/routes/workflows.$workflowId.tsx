import { useMemo, useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import type { WorkflowDefinition } from "@valet/workflow";
import type { ListWorkflowRunsResponse } from "@valet/api/wire";
import {
  useStartRun,
  useUpdateWorkflow,
  useWorkflow,
  useWorkflowRuns,
  type UpdateWorkflowMutation,
} from "~/api/workflows";
import { isWorkflowDefinitionShape } from "~/components/workflows/editor-model";
import { Editor } from "~/components/workflows/editor/editor";
import { Badge, Button, Spinner } from "~/components/primitives";

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
  initialName,
  initialDefinition,
  update,
  startRun,
  runsQuery,
  navigate,
}: {
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

  async function handleSave(next: WorkflowDefinition) {
    await update.mutateAsync({ name, definition: next });
    setCommittedName(name);
  }

  function handleCancelName() {
    setName(committedName);
  }

  async function handleRun() {
    const result = await startRun.mutateAsync();
    void navigate({ to: "/workflows/runs/$runId", params: { runId: result.runId } });
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
        <Button size="sm" onClick={() => void handleRun()} disabled={startRun.isPending}>
          {startRun.isPending ? "Starting…" : "Run"}
        </Button>
      </div>

      <div className="min-h-0 flex-1">
        <Editor
          initialDefinition={initialDefinition}
          onSave={handleSave}
          saving={update.isPending}
          externalDirty={nameDirty}
          onCancelExternal={handleCancelName}
        />
      </div>

      <RunsSection runsQuery={runsQuery} />
    </div>
  );
}

function RunsSection({
  runsQuery,
}: {
  runsQuery: {
    data?: ListWorkflowRunsResponse;
    isLoading: boolean;
    error: unknown;
  };
}) {
  const [open, setOpen] = useState(false);
  const runs = runsQuery.data?.runs ?? [];

  return (
    <div className="border-t border-line">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between px-6 py-2 text-xs font-medium text-muted hover:text-ink"
      >
        <span>
          Runs{runsQuery.data ? ` (${runs.length})` : ""}
        </span>
        <span>{open ? "▲" : "▼"}</span>
      </button>

      {open && (
        <div className="max-h-48 overflow-y-auto px-6 pb-3">
          {runsQuery.isLoading && (
            <div className="flex items-center gap-2 text-xs text-muted">
              <Spinner size={12} /> Loading runs…
            </div>
          )}
          {!runsQuery.isLoading && runsQuery.error != null && (
            <div className="text-xs text-danger-500">Failed to load runs.</div>
          )}
          {!runsQuery.isLoading && runsQuery.error == null && runs.length === 0 && (
            <div className="text-xs text-muted">No runs yet.</div>
          )}
          {!runsQuery.isLoading && runsQuery.error == null && runs.length > 0 && (
            <ul className="space-y-1">
              {runs.map((r) => (
                <li key={r.runId} className="flex items-center gap-2">
                  <Link
                    to="/workflows/runs/$runId"
                    params={{ runId: r.runId }}
                    className="text-xs font-mono text-moss hover:underline"
                  >
                    {r.runId}
                  </Link>
                  <span className="text-xs text-muted">{r.status}</span>
                  {r.outcome && <Badge variant={r.outcome === "failed" ? "danger" : "neutral"}>{r.outcome}</Badge>}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
