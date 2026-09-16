/**
 * Pending-approval card for `/workflows/runs/$runId` (plan decision 19).
 * Rendered when the run is parked on an `approval` node's signal wait
 * (`findPendingApproval` in `./run-detail-helpers`). Approve/Deny call
 * `POST /workflows/runs/:runId/approvals/:nodeId` via `useResolveApproval`.
 *
 * Given accent-tinted styling and a "waiting on you" framing — the run
 * genuinely cannot proceed without this, so it should read as the one
 * thing on the page demanding attention, not another card in the list.
 *
 * The tint is `bg-moss-wash`, an alpha token, not a solid step off the
 * `accent` ramp. That ramp is a fixed set of literals that does not follow
 * the theme, so a solid fill needs a `dark:` partner to stay readable. This
 * card shipped with a partner naming `accent-950`, a step the ramp does not
 * define, so Tailwind emitted nothing for it. In dark mode the light fill
 * therefore survived under near-white `--ink` text.
 *
 * Naming a step that exists would not have fixed it either. Tailwind 3.4
 * cannot put an alpha channel into the raw `oklch(...)` literals this config
 * declares, and the config sets no `<alpha-value>` placeholder, so
 * `dark:bg-accent-900/40` emits nothing as well. An alpha wash carries its
 * alpha inside the token. It needs no partner and no modifier, and it sits
 * over whatever `--paper` currently is, so it cannot fall out of step again.
 */
import { useState } from "react";
import { Hand } from "lucide-react";
import { useResolveApproval } from "~/api/workflows";
import { Button, ConfirmDialog, Input } from "~/components/primitives";

export interface ApprovalCardProps {
  runId: string;
  nodeId: string;
  prompt?: string;
  iteration?: number;
  confirmActions?: boolean;
}

export function ApprovalCard({ runId, nodeId, prompt, iteration, confirmActions = false }: ApprovalCardProps) {
  const [note, setNote] = useState("");
  const [confirmation, setConfirmation] = useState<boolean | null>(null);
  const resolve = useResolveApproval(runId);

  function respond(approved: boolean) {
    if (confirmActions) {
      setConfirmation(approved);
      return;
    }
    submit(approved);
  }

  function submit(approved: boolean) {
    resolve.mutate({
      nodeId,
      body: { approved, note: note.trim() || undefined, iteration },
    });
    setConfirmation(null);
  }

  return (
    <div className="rounded-md border border-accent-300 bg-moss-wash p-4 space-y-3 dark:border-accent-800">
      <div className="flex items-start gap-2.5">
        <Hand className="mt-0.5 h-4 w-4 shrink-0 text-accent-600 dark:text-accent-400" aria-hidden />
        <div className="min-w-0 flex-1 space-y-1">
          <p className="text-xs font-medium uppercase tracking-wide text-accent-700 dark:text-accent-400">
            Waiting on you
          </p>
          <p className="break-words text-sm font-medium text-ink">{prompt ?? `Approval required: ${nodeId}`}</p>
        </div>
      </div>
      <Input
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="Optional note"
        aria-label="Optional note"
      />
      <div className="flex flex-wrap gap-2">
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
      <ConfirmDialog
        open={confirmation !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmation(null);
        }}
        title={confirmation ? "Approve this workflow step?" : "Deny this workflow step?"}
        description={
          confirmation
            ? "The run continues past this step."
            : "The run stops at this step unless the workflow handles denial."
        }
        confirmLabel={confirmation ? "Approve step" : "Deny step"}
        onConfirm={() => submit(confirmation === true)}
      />
      {resolve.isError && <div className="text-xs text-danger-500">Failed to record response — try again.</div>}
    </div>
  );
}
