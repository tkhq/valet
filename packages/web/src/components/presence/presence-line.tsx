/**
 * One line of presence on a place page
 * (docs/specs/2026-10-16-presence-hub-design.md Part C steps 2 and 3): the
 * sentence linked to the line's page, an on/off switch, and an overflow
 * menu with Edit, Appears as, and Delete. A problem renders under the row
 * with the thread picker, and a personal line that a team line paused says so.
 */
import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { MoreHorizontal } from "lucide-react";
import type { EventSubscriptionWire } from "@valet/api/wire";
import { useDeleteEventSubscription, usePatchEventSubscription } from "~/api/events";
import { usePinnedThreadTitle } from "~/api/rule";
import { useMe } from "~/api/settings";
import { useWorkflows } from "~/api/workflows";
import { EditSubscriptionDialog } from "~/components/events/edit-subscription-dialog";
import {
  Button, ConfirmDialog, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, Switch, WorkRow,
} from "~/components/primitives";
import { errorText } from "~/lib/error-text";
import { ThreadProblem } from "./problem-badge";
import {
  PAUSED_BY_TEAM, PresenceBadges, lineReadOnly, lineWorkspace, pausedByTeam, pinnedTitle, storedPolicy, targetLabel,
} from "./presence-rows";

export function PresenceLine({ sub, sentence }: { sub: EventSubscriptionWire; sentence: string }) {
  const me = useMe();
  const workflows = useWorkflows();
  const patch = usePatchEventSubscription();
  const remove = useDeleteEventSubscription();
  const pinTitles = usePinnedThreadTitle(storedPolicy(sub));
  const [editing, setEditing] = useState<"line" | "appearance" | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const readOnly = lineReadOnly(sub, me.data?.id);
  const workflowId = sub.target.kind === "workflow" ? sub.target.workflowId : undefined;
  const workflowName = workflows.data?.workflows.find((w) => w.id === workflowId)?.name;

  function save(body: Parameters<typeof patch.mutate>[0]["body"]) {
    setError(null);
    patch.mutate({ id: sub.id, body }, { onError: (err) => setError(errorText(err)) });
  }

  return (
    <div>
      <WorkRow
        title={<Link to="/presence/rules/$id" params={{ id: sub.id }}>{sentence}</Link>}
        badge={<PresenceBadges sub={sub} />}
        detail={sub.name}
        actions={(
          <>
            <Switch
              checked={sub.enabled}
              disabled={readOnly || patch.isPending}
              onCheckedChange={(enabled) => save({ enabled })}
              aria-label={`${sub.enabled ? "Turn off" : "Turn on"} ${sub.name}`}
            />
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button type="button" variant="ghost" size="sm" aria-label={`More for ${sub.name}`}>
                  <MoreHorizontal className="h-4 w-4" aria-hidden />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem disabled={readOnly} onSelect={() => setEditing("line")}>Edit</DropdownMenuItem>
                <DropdownMenuItem disabled={readOnly} onSelect={() => setEditing("appearance")}>Appears as</DropdownMenuItem>
                <DropdownMenuItem
                  disabled={readOnly}
                  className="text-danger-500"
                  onSelect={() => {
                    // React Query holds `error` until the next mutate, so
                    // without this the last refusal greets the next open.
                    remove.reset();
                    setDeleting(true);
                  }}
                >
                  Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        )}
      />
      {(sub.problem || pausedByTeam(sub) || error) && (
        <div className="px-4 pb-3 sm:pl-5">
          {sub.problem && (
            <ThreadProblem
              variant="inline"
              problem={sub.problem}
              threadTitle={pinnedTitle(sub, pinTitles)}
              workspace={lineWorkspace(sub)}
              readOnly={readOnly}
              onPick={(thread) => save({ thread })}
              pending={patch.isPending}
            />
          )}
          {pausedByTeam(sub) && <p role="status" className="mt-2 text-sm text-warning-fg">{PAUSED_BY_TEAM}</p>}
          {error && <p role="alert" className="mt-2 text-sm text-danger-500">{error}</p>}
        </div>
      )}
      {editing !== null && (
        <EditSubscriptionDialog
          open
          onOpenChange={(open) => { if (!open) setEditing(null); }}
          sub={sub}
          targetLabel={targetLabel(sub, workflowName)}
          focus={editing === "appearance" ? "appearance" : undefined}
        />
      )}
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={`Delete "${sub.name}"?`}
        description="Valet stops listening for this here. Its past activity stays."
        confirmLabel="Delete"
        pendingLabel="Deleting…"
        pending={remove.isPending}
        error={remove.error ? errorText(remove.error) : undefined}
        onConfirm={() => remove.mutate(sub.id, { onSuccess: () => setDeleting(false) })}
      />
    </div>
  );
}
