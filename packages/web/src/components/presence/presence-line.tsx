/**
 * One sentence row: a line of presence on the overview roster and on a
 * place page (docs/specs/2026-10-16-presence-hub-design.md Part B step 5,
 * Part C steps 2 and 3). The left column holds the sentence, linked to the
 * line's page, with the line's name under it. The right column holds a
 * small on/off switch and an overflow menu with Edit, Appears as, and
 * Delete. An off line reads muted with `Off` under it. A faulted line
 * carries the danger mark before its sentence and its fix under the row. A
 * personal line that a team line paused says so under the row.
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
  Button, ConfirmDialog, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, Switch,
} from "~/components/primitives";
import { cn } from "~/lib/cn";
import { errorText } from "~/lib/error-text";
import { ThreadProblem } from "./problem-badge";
import {
  PAUSED_BY_TEAM, lineReadOnly, lineWorkspace, pausedByTeam, pinnedTitle, storedPolicy, targetLabel,
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

  const paused = pausedByTeam(sub);
  const faulted = Boolean(sub.problem);
  return (
    <div
      data-presence-line={sub.id}
      className="-mx-2 grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-4 gap-y-0.5 rounded-md px-2 py-1.5 hover:bg-ink-wash"
    >
      <div className="min-w-0">
        <p className="text-base [overflow-wrap:anywhere]">
          {faulted && <span aria-hidden="true" className="mr-2 inline-block h-2 w-2 rounded-full bg-danger-500 align-[2px]" />}
          <Link to="/presence/rules/$id" params={{ id: sub.id }} className={cn("text-base hover:underline", sub.enabled ? "text-ink" : "text-muted")}>
            {sentence}
          </Link>
        </p>
        <p className="mt-px text-xs text-muted [overflow-wrap:anywhere]">{sub.name}</p>
      </div>
      <div className="flex items-center gap-2 pt-1">
        <Switch
          size="sm"
          checked={sub.enabled}
          disabled={readOnly || patch.isPending}
          onCheckedChange={(enabled) => save({ enabled })}
          aria-label={`${sub.enabled ? "Turn off" : "Turn on"} ${sub.name}`}
        />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="ghost" size="icon" aria-label={`More for ${sub.name}`}>
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
      </div>
      {!sub.enabled && !paused && <p className="col-span-full text-xs text-muted">Off</p>}
      {paused && <p role="status" className="col-span-full text-xs text-muted">{PAUSED_BY_TEAM}</p>}
      {sub.problem && (
        <div className="col-span-full">
          <ThreadProblem
            variant="inline"
            problem={sub.problem}
            threadTitle={pinnedTitle(sub, pinTitles)}
            workspace={lineWorkspace(sub)}
            readOnly={readOnly}
            onPick={(thread) => save({ thread })}
            pending={patch.isPending}
          />
        </div>
      )}
      {error && <p role="alert" className="col-span-full text-sm text-danger-500">{error}</p>}
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
