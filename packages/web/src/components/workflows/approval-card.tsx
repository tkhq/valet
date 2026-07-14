/**
 * Pending-approval card for `/workflows/runs/$runId` (plan decision 19).
 * Rendered when the run is parked on an `approval` node's signal wait
 * (`findPendingApproval` in `./run-detail-helpers`). Approve/Deny call
 * `POST /workflows/runs/:runId/approvals/:nodeId` via `useResolveApproval`.
 */
import { useState } from "react";
import { useResolveApproval } from "~/api/workflows";
import { Button } from "~/components/primitives";

export interface ApprovalCardProps {
  runId: string;
  nodeId: string;
  prompt?: string;
}

export function ApprovalCard({ runId, nodeId, prompt }: ApprovalCardProps) {
  const [note, setNote] = useState("");
  const resolve = useResolveApproval(runId);

  function respond(approved: boolean) {
    resolve.mutate({ nodeId, body: { approved, note: note.trim() || undefined } });
  }

  return (
    <div className="rounded border border-line bg-paper p-4 space-y-3">
      <div className="text-sm font-medium text-ink">
        {prompt ?? `Approval required: ${nodeId}`}
      </div>
      <input
        type="text"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="Optional note"
        className="w-full rounded border border-line bg-[--bg] px-2 py-1.5 text-sm text-ink placeholder:text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-moss"
      />
      <div className="flex gap-2">
        <Button size="sm" onClick={() => respond(true)} disabled={resolve.isPending}>
          Approve
        </Button>
        <Button
          size="sm"
          variant="danger"
          onClick={() => respond(false)}
          disabled={resolve.isPending}
        >
          Deny
        </Button>
      </div>
      {resolve.isError && (
        <div className="text-xs text-danger-500">Failed to record response — try again.</div>
      )}
    </div>
  );
}
