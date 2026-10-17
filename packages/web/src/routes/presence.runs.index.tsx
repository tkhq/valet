import { useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useAllWorkflowRuns } from "~/api/workflows";
import { Pager } from "~/components/pager";
import { EmptyRow, ErrorRow, LoadingRow, WorkList, WorkRow } from "~/components/primitives";
import { RunStatusChip } from "~/components/workflows/run-status-chip";
import { currentCursor, pageNumber, popCursor, pushCursor } from "~/lib/cursor-stack";
import { errorText } from "~/lib/error-text";
import { useListOwner } from "~/lib/use-list-owner";

/** `/presence/runs`: the Runs tab, every workflow run of the workspace the
 * switcher names, newest first (spec Part F step 1). It replaces the Runs
 * tab of `/workflows`. */
export const Route = createFileRoute("/presence/runs/")({
  component: RunsTab,
});

export function RunsTab() {
  const owner = useListOwner();
  // A new workspace starts on page one: its cursors name another list.
  return <WorkspaceRuns key={`${owner?.ownerType}:${owner?.ownerId}`} />;
}

function WorkspaceRuns() {
  // Without the switcher's owner, the list holds the caller's runs plus every
  // team's, which does not follow the switcher. So the read waits for it.
  const owner = useListOwner();
  const [cursors, setCursors] = useState<string[]>([]);
  const cursor = currentCursor(cursors);
  const runsQ = useAllWorkflowRuns(owner, cursor === undefined ? undefined : { cursor }, { enabled: owner !== undefined });
  const runs = runsQ.data?.runs ?? [];
  const nextCursor = runsQ.data?.nextCursor;

  return (
    <div className="space-y-3">
      <WorkList>
        {(owner === undefined || runsQ.isPending) && <LoadingRow className="px-4" />}
        {runsQ.isError && (
          <ErrorRow className="px-4">{errorText(runsQ.error, "Could not load the runs. Reload the page to try again.")}</ErrorRow>
        )}
        {runsQ.isSuccess && runs.length === 0 && (
          <EmptyRow className="px-4 py-3">No runs yet. Run a workflow from the Workflows tab.</EmptyRow>
        )}
        {runs.map((run) => (
          <WorkRow
            key={run.runId}
            title={<Link to="/presence/runs/$runId" params={{ runId: run.runId }}>{run.workflowName}</Link>}
            badge={<RunStatusChip status={run.status} outcome={run.outcome} needsApproval={run.needsApproval ?? false} />}
            time={run.createdAt}
            detail={<span className="font-mono text-xs">{run.runId}</span>}
          />
        ))}
      </WorkList>
      {runsQ.isSuccess && (
        <Pager
          label="runs"
          page={pageNumber(cursors)}
          hasPrevious={cursors.length > 0}
          hasNext={nextCursor !== undefined}
          onPrevious={() => setCursors(popCursor(cursors))}
          onNext={() => {
            if (nextCursor !== undefined) setCursors(pushCursor(cursors, nextCursor));
          }}
        />
      )}
    </div>
  );
}
