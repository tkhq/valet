import { Link } from "@tanstack/react-router";
import { useDecisions } from "~/api/queries";
import { useRunDetail } from "~/api/workflows";
import { useAdoptWorkspaceScope } from "~/lib/workspace-scope";
import { DecisionGateCard } from "~/components/session/decision-gate-card";

/** Workflow session nodes have engine gates, separate from workflow approval nodes. */
export function WorkflowAgentApprovals({ sessionId }: { sessionId: string }) {
  const runId = sessionId.split(":")[1];
  const run = useRunDetail(runId);
  useAdoptWorkspaceScope(run.data?.owner);
  const decisions = useDecisions(sessionId, { refetchInterval: 2000 });
  const pending = decisions.error ? undefined : decisions.data?.gates.filter((gate) => gate.status === "pending");
  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-4">
      <Link to="/workflows/runs/$runId" params={{ runId }} className="text-sm underline">Open workflow run</Link>
      <h1 className="text-lg font-semibold">Workflow agent approvals</h1>
      {decisions.isLoading && <p>Loading approvals…</p>}
      {decisions.error && <p role="alert">Cannot load approvals. Check your access to this workflow, then reload the page.</p>}
      {pending?.length === 0 && <p>No pending approvals. Open the workflow run to see its current status.</p>}
      {pending?.map((gate) => <DecisionGateCard key={gate.id} sessionId={sessionId} gate={gate} />)}
    </div>
  );
}
