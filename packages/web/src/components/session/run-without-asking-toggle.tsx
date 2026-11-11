import { useState, type ReactNode } from "react";
import { useSetThreadApprovalBypass, useThreads } from "~/api/queries";
import { useMe, useTeams } from "~/api/settings";
import { ConfirmDialog, Switch } from "~/components/primitives";
import { cn } from "~/lib/cn";
import { extractActionError } from "~/lib/extract-action-error";
import { canAdministerSession } from "./use-can-administer-session";
import type { AssistantOwner } from "@valet/api/wire";

/**
 * The thread's "Run without asking" switch, shown in the composer footer.
 * Turning it on asks first, because Valet then stops asking for approval.
 * Turning it off needs no confirm. It shows nothing when the viewer cannot
 * turn it on and it is off, the same rule the thread menu item used.
 */
export function RunWithoutAskingToggle({ sessionId, threadId, owner, className, onlyWhenOn = false, fallback = null, compactLabel = false, onError }: {
  fallback?: ReactNode;
  sessionId: string;
  threadId?: string;
  owner: AssistantOwner | undefined;
  className?: string;
  /** Show nothing while it is off. A read-only thread uses this: the viewer can only turn it off. */
  onlyWhenOn?: boolean;
  /** Hide the visible text in a narrow `@container` box; the switch keeps its accessible name. */
  compactLabel?: boolean;
  /** Receives the mutation error so the caller can show it outside a tight row. Without it the error shows inline. */
  onError?: (message: string | null) => void;
}) {
  const me = useMe();
  const teams = useTeams({ enabled: owner?.type === "team" });
  const threads = useThreads(sessionId, undefined, threadId);
  const bypass = useSetThreadApprovalBypass(sessionId);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const thread = threads.data?.threads.find((t) => t.id === threadId);
  if (!thread || !owner) return fallback;
  const on = thread.approvalBypass === true;
  // The server's rule: the owner of a personal thread, or a team admin.
  // Anyone who sees it on may turn it off.
  // An org-owned thread has no one who may turn it on.
  const canEnable = owner.type === "user"
    ? owner.id === me.data?.id
    : owner.type === "team" && canAdministerSession(owner, teams.data, me.data);
  if (!on && (onlyWhenOn || !canEnable)) return fallback;

  function set(next: boolean) {
    if (!thread) return;
    setError(null);
    onError?.(null);
    bypass.mutate({ threadId: thread.id, on: next }, {
      onError: (err) => (onError ?? setError)(extractActionError(err, next ? "Could not turn on Run without asking. Try again." : "Could not turn off Run without asking. Try again.")),
    });
  }

  return (
    <>
      <div className={cn("flex shrink-0 items-center gap-2 text-xs", className)}>
        {error && !onError && <span role="alert" className="text-danger-500">{error}</span>}
        <label className="flex cursor-pointer items-center gap-2 whitespace-nowrap text-muted">
          <span className={cn(on && "font-medium text-warning-fg", compactLabel && "hidden [@container(min-width:34rem)]:inline")}>
            Run without asking
          </span>
          <Switch
            size="sm"
            checked={on}
            disabled={bypass.isPending}
            aria-label="Run without asking"
            onCheckedChange={(next) => { if (next) setConfirming(true); else set(false); }}
          />
        </label>
      </div>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Run without asking?"
        description="Valet stops asking for approval in this thread and the agents it starts, for the actions you could always allow yourself."
        confirmLabel="Run without asking"
        confirmVariant="primary"
        onConfirm={() => { setConfirming(false); set(true); }}
      >
        <p className="text-sm text-muted">Valet still asks for critical actions, actions an admin rule names, and a teammate's shared account. Turn it off from this switch at any time.</p>
      </ConfirmDialog>
    </>
  );
}
