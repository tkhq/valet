/**
 * One sentence row: a line of presence on the overview roster and on a
 * place page (docs/specs/2026-10-16-presence-hub-design.md Part B step 5,
 * Part C steps 2 and 3). The left column holds the sentence, linked to the
 * line's page, with the line's name under it and a `Team` or `Org` mark for
 * a line the viewer's personal workspace does not own. The right column
 * holds a small on/off switch and an overflow menu with Edit, Appears as,
 * and Delete. An off line reads muted with `Off` under it, and a proposal
 * reads `Proposed`. A faulted line carries the danger mark before its
 * sentence. Under the row, a pin problem shows `Pick another thread`, which
 * opens the picker; the **Needs attention** banner shows the same picker
 * open. A personal line that a team line paused names the team and offers
 * **Keep both**.
 */
import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { MoreHorizontal } from "lucide-react";
import type { EventSubscriptionWire } from "@valet/api/wire";
import { useDeleteEventSubscription, useEventSubscriptions, usePatchEventSubscription } from "~/api/events";
import { usePinnedThreadTitle } from "~/api/rule";
import { useWorkflows } from "~/api/workflows";
import { EditSubscriptionDialog } from "~/components/events/edit-subscription-dialog";
import {
  Badge, Button, ConfirmDialog, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, Switch,
} from "~/components/primitives";
import { cn } from "~/lib/cn";
import { errorText } from "~/lib/error-text";
import { ThreadProblem, isPinProblem } from "./problem-badge";
import {
  OwnerBadge, deleteLineDescription, isProposal, lineWorkspace, pausedByTeam, pausedByTeamText, pausingTeamId,
  pinnedTitle, storedPolicy, targetLabel, teamName, useLineAccess, type TeamLike,
} from "./presence-rows";
import { Sentence } from "./sentence";
import { partsText, type SentencePart } from "./sentences";
import { useSentenceNames } from "./use-sentence-names";

export function PresenceLine({ sub, sentence }: {
  sub: EventSubscriptionWire;
  /** The line's sentence. As parts, its places, threads, workflows, and people read as tokens. */
  sentence: string | readonly SentencePart[];
}) {
  const workflows = useWorkflows();
  const patch = usePatchEventSubscription();
  const pinTitles = usePinnedThreadTitle(storedPolicy(sub));
  const names = useSentenceNames();
  const { readOnly, readOnlyText, teams } = useLineAccess(sub);
  const [editing, setEditing] = useState<"line" | "appearance" | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const workflowNames = workflows.data?.workflows ?? [];
  const workflowId = sub.target.kind === "workflow" ? sub.target.workflowId : undefined;
  const workflowName = workflowNames.find((w) => w.id === workflowId)?.name;

  function save(body: Parameters<typeof patch.mutate>[0]["body"]) {
    setError(null);
    patch.mutate({ id: sub.id, body }, { onError: (err) => setError(errorText(err)) });
  }

  const paused = pausedByTeam(sub);
  const proposal = isProposal(sub);
  const problem = sub.problem ?? "";
  // A pin problem the viewer can fix waits behind one button, so the row
  // stays one line until the reader asks for the picker.
  const collapsed = isPinProblem(problem) && !readOnly && !picking;
  return (
    <div
      data-presence-line={sub.id}
      className="-mx-2 grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-4 gap-y-0.5 rounded-md px-2 py-1.5 hover:bg-ink-wash"
    >
      <div className="min-w-0">
        <p className="text-base [overflow-wrap:anywhere]">
          {problem !== "" && <span aria-hidden="true" className="mr-2 inline-block h-2 w-2 rounded-full bg-danger-500 align-[2px]" />}
          <Link
            to="/presence/rules/$id"
            params={{ id: sub.id }}
            aria-label={typeof sentence === "string" ? undefined : partsText(sentence)}
            className={cn("text-base hover:underline", sub.enabled ? "text-ink" : "text-muted")}
          >
            {/* The tokens sit inside the line's link, so they do not link on their own. */}
            {typeof sentence === "string" ? sentence : <Sentence parts={sentence} links={false} />}
          </Link>
        </p>
        <p className="mt-px text-xs text-muted [overflow-wrap:anywhere]">
          {sub.name}
          {sub.ownerType !== "user" && <> <OwnerBadge ownerType={sub.ownerType} /></>}
        </p>
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
            <DropdownMenuItem disabled={readOnly} className="text-danger-500" onSelect={() => setDeleting(true)}>
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {!sub.enabled && !paused && (
        <p className="col-span-full text-xs text-muted">
          {proposal ? <Badge variant="accent">Proposed</Badge> : "Off"}
        </p>
      )}
      {paused && (
        <div className="col-span-full">
          <PausedLine sub={sub} teams={teams} readOnly={readOnly} />
        </div>
      )}
      {problem !== "" && collapsed && (
        <div className="col-span-full">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-auto px-1.5 py-0.5 text-xs font-normal text-danger-600 hover:text-danger-600 dark:text-danger-500"
            onClick={() => setPicking(true)}
          >
            Pick another thread
          </Button>
        </div>
      )}
      {problem !== "" && !collapsed && (
        <div className="col-span-full">
          <ThreadProblem
            variant="inline"
            problem={problem}
            threadTitle={pinnedTitle(sub, pinTitles)}
            workspace={lineWorkspace(sub)}
            readOnly={readOnly}
            readOnlyText={readOnlyText}
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
          names={names}
          threadTitles={pinTitles}
          workflows={workflowNames}
        />
      )}
      <DeleteLineDialog sub={sub} teams={teams} open={deleting} onOpenChange={setDeleting} />
    </div>
  );
}

/**
 * The Delete confirm for a line, on its row and on its page. A team or org
 * line names its owner. `onDeleted` runs after the delete, such as a page
 * that leaves for Presence.
 */
export function DeleteLineDialog({ sub, teams, open, onOpenChange, onDeleted }: {
  sub: EventSubscriptionWire;
  teams: readonly TeamLike[] | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDeleted?: () => void;
}) {
  const remove = useDeleteEventSubscription();
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={(next) => {
        // React Query holds `error` until the next mutate, so without this
        // the last refusal greets the next open.
        if (!next) remove.reset();
        onOpenChange(next);
      }}
      title={`Delete "${sub.name}"?`}
      description={deleteLineDescription(sub, teams)}
      confirmLabel="Delete"
      pendingLabel="Deleting…"
      pending={remove.isPending}
      error={remove.error ? errorText(remove.error) : undefined}
      onConfirm={() => remove.mutate(sub.id, {
        onSuccess: () => {
          onOpenChange(false);
          onDeleted?.();
        },
      })}
    />
  );
}

/**
 * A personal line that a team line paused: it names the team, and **Keep
 * both** turns the line on again and stops a team line from pausing it.
 */
export function PausedLine({ sub, teams, readOnly, className }: {
  sub: EventSubscriptionWire;
  teams: readonly TeamLike[] | undefined;
  readOnly: boolean;
  className?: string;
}) {
  const subsQ = useEventSubscriptions();
  const patch = usePatchEventSubscription();
  const [error, setError] = useState<string | null>(null);
  const teamId = pausingTeamId(sub, subsQ.data?.subscriptions ?? [], teams);
  const team = teamId === undefined ? "the team" : teamName(teams, teamId);
  return (
    <div className={cn("space-y-1", className)}>
      <p className="flex flex-wrap items-baseline gap-x-2 text-xs text-muted">
        <span role="status">{pausedByTeamText(team)}</span>
        {!readOnly && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-auto px-1.5 py-0.5 text-xs font-normal text-ink"
            disabled={patch.isPending}
            onClick={() => {
              setError(null);
              patch.mutate(
                { id: sub.id, body: { pauseOnOverlap: false, enabled: true } },
                { onError: (err) => setError(errorText(err)) },
              );
            }}
          >
            Keep both
          </Button>
        )}
      </p>
      {error && <p role="alert" className="text-xs text-danger-500">{error}</p>}
    </div>
  );
}
