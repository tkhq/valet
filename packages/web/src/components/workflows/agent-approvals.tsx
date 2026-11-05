import { useDecisions } from "~/api/queries";
import { useRunDetail } from "~/api/workflows";
import { useAdoptWorkspaceScope } from "~/lib/workspace-scope";
import { DecisionGateCard } from "~/components/session/decision-gate-card";
import { BackLink, EmptyRow, ErrorRow, LoadingRow, PageHeader, pageClass } from "~/components/primitives";

/** Workflow session nodes have engine gates, separate from workflow approval nodes. */
export function WorkflowAgentApprovals({ sessionId }: { sessionId: string }) {
  const runId = sessionId.split(":")[1];
  const run = useRunDetail(runId);
  useAdoptWorkspaceScope(run.data?.owner);
  const decisions = useDecisions(sessionId, { refetchInterval: 2000 });
  const pending = decisions.error ? undefined : decisions.data?.gates.filter((gate) => gate.status === "pending");
  return (
    <div className="min-w-0 flex-1 overflow-y-auto">
      <div className={pageClass}>
        <PageHeader
          back={<BackLink to="/workflows/runs/$runId" params={{ runId }}>Workflow run</BackLink>}
          title="Workflow agent approvals"
        />
        <div className="mt-6 space-y-4">
          {decisions.isLoading && <LoadingRow label="Loading approvals…" />}
          {decisions.error && <ErrorRow>Cannot load approvals. Check your access to this workflow, then reload the page.</ErrorRow>}
          {pending?.length === 0 && <EmptyRow>No pending approvals. Open the workflow run to see its current status.</EmptyRow>}
          {pending?.map((gate) => <DecisionGateCard key={gate.id} sessionId={sessionId} gate={gate} />)}
        </div>
      </div>
    </div>
  );
}
