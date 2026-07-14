import { useState, type FormEvent } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import type { WorkflowDefinitionSummary } from "@valet/api/wire";
import {
  useCreateWorkflow,
  useStartRun,
  useUpdateWorkflow,
  useWorkflowRuns,
  useWorkflows,
} from "~/api/workflows";
import {
  extractValidationErrors,
  parseDefinitionInput,
} from "~/components/workflows/definition-form-helpers";
import { Button, Spinner } from "~/components/primitives";

/**
 * `/workflows` — the definitions list + JSON textarea create/edit form
 * (plan decision 19: deliberately spartan, no visual editor). Clicking a
 * definition expands an inline run list (lazy-fetched, so the index page
 * doesn't N+1 `GET /workflows/:id/runs` for every row) with a "Run" button
 * per definition.
 */
export const Route = createFileRoute("/workflows/")({
  component: WorkflowsIndexPage,
});

export function WorkflowsIndexPage() {
  const { data, isLoading, error } = useWorkflows();
  const [expandedId, setExpandedId] = useState<string | undefined>(undefined);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<WorkflowDefinitionSummary | undefined>(undefined);

  const workflows = data?.workflows ?? [];

  function openCreate() {
    setEditing(undefined);
    setFormOpen(true);
  }

  function openEdit(wf: WorkflowDefinitionSummary) {
    setEditing(wf);
    setFormOpen(true);
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="flex items-center justify-between px-6 py-4 border-b border-line">
        <h1 className="text-lg font-semibold tracking-tight text-ink font-display">Workflows</h1>
        <Button size="sm" onClick={openCreate}>
          New workflow
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto p-6 space-y-4">
        {formOpen && (
          <DefinitionForm
            editing={editing}
            onClose={() => setFormOpen(false)}
          />
        )}

        {isLoading && (
          <div className="flex items-center gap-2 text-sm text-muted">
            <Spinner size={14} /> Loading workflows…
          </div>
        )}
        {!isLoading && error && (
          <div className="text-sm text-danger-500">Failed to load workflows.</div>
        )}
        {!isLoading && !error && workflows.length === 0 && (
          <div className="text-sm text-muted">No workflows yet — create one above.</div>
        )}

        {!isLoading && workflows.length > 0 && (
          <ul className="space-y-2">
            {workflows.map((wf) => (
              <DefinitionRow
                key={wf.id}
                workflow={wf}
                expanded={expandedId === wf.id}
                onToggle={() => setExpandedId(expandedId === wf.id ? undefined : wf.id)}
                onEdit={() => openEdit(wf)}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function DefinitionRow({
  workflow,
  expanded,
  onToggle,
  onEdit,
}: {
  workflow: WorkflowDefinitionSummary;
  expanded: boolean;
  onToggle: () => void;
  onEdit: () => void;
}) {
  const startRun = useStartRun(workflow.id);
  const runsQ = useWorkflowRuns(workflow.id, { enabled: expanded });

  return (
    <li className="rounded border border-line bg-paper">
      <div className="flex items-center justify-between px-4 py-3">
        <button
          type="button"
          onClick={onToggle}
          className="text-sm font-medium text-ink hover:underline text-left"
        >
          {workflow.name}
          {expanded && runsQ.data && (
            <span className="ml-2 text-xs text-muted font-normal">
              {runsQ.data.runs.length} run{runsQ.data.runs.length === 1 ? "" : "s"}
            </span>
          )}
        </button>
        <div className="flex gap-2">
          <Button size="sm" variant="secondary" onClick={onEdit}>
            Edit
          </Button>
          <Button
            size="sm"
            onClick={() => startRun.mutate()}
            disabled={startRun.isPending}
          >
            Run
          </Button>
        </div>
      </div>

      {expanded && (
        <div className="border-t border-line px-4 py-3">
          {runsQ.isLoading && (
            <div className="flex items-center gap-2 text-xs text-muted">
              <Spinner size={12} /> Loading runs…
            </div>
          )}
          {!runsQ.isLoading && (runsQ.data?.runs.length ?? 0) === 0 && (
            <div className="text-xs text-muted">No runs yet.</div>
          )}
          {!runsQ.isLoading && (runsQ.data?.runs.length ?? 0) > 0 && (
            <ul className="space-y-1">
              {runsQ.data?.runs.map((r) => (
                <li key={r.runId}>
                  <Link
                    to="/workflows/runs/$runId"
                    params={{ runId: r.runId }}
                    className="text-xs font-mono text-moss hover:underline"
                  >
                    {r.runId} — {r.status}
                    {r.outcome ? ` (${r.outcome})` : ""}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </li>
  );
}

function DefinitionForm({
  editing,
  onClose,
}: {
  editing?: WorkflowDefinitionSummary;
  onClose: () => void;
}) {
  const [name, setName] = useState(editing?.name ?? "");
  const [text, setText] = useState(
    editing ? JSON.stringify(editing.definition, null, 2) : "",
  );
  const [errors, setErrors] = useState<string[]>([]);
  const create = useCreateWorkflow();
  const update = useUpdateWorkflow(editing?.id ?? "");
  const pending = create.isPending || update.isPending;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setErrors([]);
    const parsed = parseDefinitionInput(text);
    if (!parsed.ok) {
      setErrors([parsed.error]);
      return;
    }
    try {
      if (editing) {
        await update.mutateAsync({ name, definition: parsed.value });
      } else {
        await create.mutateAsync({ name, definition: parsed.value });
      }
      onClose();
    } catch (err) {
      setErrors(extractValidationErrors(err));
    }
  }

  return (
    <form
      onSubmit={(e) => void onSubmit(e)}
      className="rounded border border-line bg-paper p-4 space-y-3"
    >
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium text-ink">
          {editing ? `Edit ${editing.name}` : "New workflow"}
        </h2>
        <button
          type="button"
          onClick={onClose}
          className="text-xs text-muted hover:text-ink"
        >
          Cancel
        </button>
      </div>
      <input
        type="text"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Workflow name"
        required
        className="w-full rounded border border-line bg-[--bg] px-2 py-1.5 text-sm text-ink placeholder:text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-moss"
      />
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder='{"version":"dag/v1","nodes":[...],"edges":[...]}'
        required
        rows={12}
        className="w-full rounded border border-line bg-[--bg] px-2 py-1.5 font-mono text-xs text-ink placeholder:text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-moss"
      />
      {errors.length > 0 && (
        <ul className="text-xs text-danger-500 list-disc pl-4 space-y-0.5">
          {errors.map((e, i) => (
            <li key={i}>{e}</li>
          ))}
        </ul>
      )}
      <Button type="submit" size="sm" disabled={pending}>
        {pending ? "Saving…" : editing ? "Save" : "Create"}
      </Button>
    </form>
  );
}
