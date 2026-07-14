import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import type { WorkflowDefinitionSummary } from "@valet/api/wire";
import { useCreateWorkflow, useStartRun, useWorkflowRuns, useWorkflows } from "~/api/workflows";
import { Button, Spinner } from "~/components/primitives";

/** A brand-new definition's starting shape — the minimal valid `dag/v1`
 * graph (trigger straight into stop). "New workflow" creates one of these
 * immediately and drops the user into the editor rather than an empty
 * canvas or a JSON textarea (plan decision 11). */
function blankDefinition() {
  return {
    version: "dag/v1" as const,
    nodes: [
      { id: "trigger", type: "trigger" as const },
      { id: "stop", type: "stop" as const, outcome: "success" as const },
    ],
    edges: [{ from: "trigger", to: "stop" }],
  };
}

/**
 * `/workflows` — the definitions list (plan decision 11). Each row's name
 * links to `/workflows/$workflowId` (the visual editor); the JSON
 * create/edit form is gone — "New workflow" POSTs a minimal definition and
 * navigates straight to the editor, and editing an existing definition
 * happens on its editor page, not here.
 */
export const Route = createFileRoute("/workflows/")({
  component: WorkflowsIndexPage,
});

export function WorkflowsIndexPage() {
  const { data, isLoading, error } = useWorkflows();
  const create = useCreateWorkflow();
  const navigate = useNavigate();

  const workflows = data?.workflows ?? [];

  async function handleCreate() {
    const created = await create.mutateAsync({
      name: "Untitled workflow",
      definition: blankDefinition(),
    });
    void navigate({ to: "/workflows/$workflowId", params: { workflowId: created.id } });
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="flex items-center justify-between px-6 py-4 border-b border-line">
        <h1 className="text-lg font-semibold tracking-tight text-ink font-display">Workflows</h1>
        <Button size="sm" onClick={() => void handleCreate()} disabled={create.isPending}>
          {create.isPending ? "Creating…" : "New workflow"}
        </Button>
      </div>

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
          <div className="text-sm text-muted">No workflows yet — create one above.</div>
        )}

        {!isLoading && workflows.length > 0 && (
          <ul className="space-y-2">
            {workflows.map((wf) => (
              <DefinitionRow key={wf.id} workflow={wf} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function DefinitionRow({ workflow }: { workflow: WorkflowDefinitionSummary }) {
  const startRun = useStartRun(workflow.id);
  const runsQ = useWorkflowRuns(workflow.id);
  const navigate = useNavigate();
  const runCount = runsQ.data?.runs.length;

  async function handleRun() {
    const result = await startRun.mutateAsync();
    void navigate({ to: "/workflows/runs/$runId", params: { runId: result.runId } });
  }

  return (
    <li className="flex items-center justify-between rounded border border-line bg-paper px-4 py-3">
      <Link
        to="/workflows/$workflowId"
        params={{ workflowId: workflow.id }}
        className="text-sm font-medium text-ink hover:underline"
      >
        {workflow.name}
        {runCount !== undefined && (
          <span className="ml-2 text-xs text-muted font-normal">
            {runCount} run{runCount === 1 ? "" : "s"}
          </span>
        )}
      </Link>
      <Button size="sm" onClick={() => void handleRun()} disabled={startRun.isPending}>
        {startRun.isPending ? "Starting…" : "Run"}
      </Button>
    </li>
  );
}
