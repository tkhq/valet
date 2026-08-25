import { useMemo, useState } from "react";
import { MoreHorizontal, Plus } from "lucide-react";
import type { EventSubscriptionTargetWire, EventSubscriptionWire } from "@valet/api/wire";
import {
  Badge,
  Button,
  ConfirmDialog,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  EmptyRow,
  ErrorRow,
  LoadingRow,
  Switch,
  Tooltip,
} from "~/components/primitives";
import {
  useDeleteEventSubscription,
  useEventSubscriptions,
  usePatchEventSubscription,
} from "~/api/events";
import { useMe, useOrg, useTeams } from "~/api/settings";
import { useWorkflows } from "~/api/workflows";
import { errorText } from "~/lib/error-text";
import { useListOwner } from "~/lib/use-list-owner";
import { OwnerBadge } from "~/components/owner-badge";
import { eligibleTeams } from "~/components/session/assistant-rail";
import { SubscriptionCreateDialog } from "./subscription-create-dialog";

/** Mirrors the server's `canMutateSubscription`: an org-owned subscription
 * is everyone's to manage, a team's belongs to its members, and a personal
 * one to its owner. */
export function canMutate(
  sub: EventSubscriptionWire,
  userId: string | undefined,
  memberTeamIds: ReadonlySet<string>,
): boolean {
  if (sub.ownerType === "org") return true;
  if (sub.ownerType === "team") return memberTeamIds.has(sub.ownerId);
  return sub.ownerId === userId;
}

function describeTarget(
  target: EventSubscriptionTargetWire,
  workflowNames: Map<string, string>,
  teamNames: Map<string, string>,
): string {
  if (target.kind === "workflow") {
    return `Run workflow: ${workflowNames.get(target.workflowId) ?? target.workflowId}`;
  }
  if (target.orchestrator === "org") return "Notify the org assistant";
  if (target.orchestrator === "team") {
    const name = target.teamId !== undefined ? teamNames.get(target.teamId) : undefined;
    return name !== undefined ? `Notify ${name}'s assistant` : "Notify the team's assistant";
  }
  return "Notify your assistant";
}

/**
 * Event subscriptions: the rules that turn an ingested event into action —
 * a workflow run or an orchestrator prompt. List with enable/disable and
 * delete; create via `SubscriptionCreateDialog`. Rows show filters
 * read-only (filters are API-only for now).
 *
 * The list is the active workspace's, plus every org-owned subscription:
 * your own rows and the org's in the personal workspace, one team's and the
 * org's in a team workspace. An org-owned row belongs to no single
 * workspace, so the route returns it in all of them — otherwise the create
 * dialog's "Notify the org assistant" option writes a row this page can
 * never disable. Ownership therefore still varies row to row, which is what
 * the badges say.
 *
 * The list is held until the workspace owner resolves, for the same reason
 * the feed holds its own query: an owner-less request is the org-wide list.
 * The owner never resolves when identity itself fails, so the panel reads
 * the identity query directly and reports that instead of holding for ever.
 */
export function SubscriptionsPanel() {
  const owner = useListOwner();
  const meQ = useMe();
  // `useListOwner` answers undefined both while identity loads AND when it
  // fails, so a held list would otherwise sit on "Loading subscriptions…"
  // for ever. Read the identity query directly to tell the two apart.
  const ownerFailed = owner === undefined && meQ.isError;
  const subsQ = useEventSubscriptions(owner, {
    // `useListOwner()` answers undefined while the caller's identity is in
    // flight, and an owner-less request lists every subscription in the
    // org. The page header names the active workspace, so a held query
    // beats one frame of every colleague's automations under it. Same gate
    // the feed uses.
    enabled: owner !== undefined,
  });
  const workflowsQ = useWorkflows();
  const teamsQ = useTeams();
  const [creating, setCreating] = useState(false);

  const workflowNames = useMemo(
    () => new Map((workflowsQ.data?.workflows ?? []).map((w) => [w.id, w.name])),
    [workflowsQ.data],
  );
  const orgQ = useOrg();
  const teamNames = useMemo(
    () => new Map((teamsQ.data?.teams ?? []).map((t) => [t.id, t.name])),
    [teamsQ.data],
  );
  // Membership, not visibility: an org admin sees every team in the org,
  // but only a member may manage a team's subscriptions. `eligibleTeams` is
  // the one encoding of that rule (callerRole plus the org feature gate).
  const memberTeamIds = useMemo(
    () =>
      new Set(
        eligibleTeams(teamsQ.data?.teams, orgQ.data?.features.organizations).map((t) => t.id),
      ),
    [teamsQ.data, orgQ.data],
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-muted">
          A subscription runs a workflow or prompts an orchestrator when a matching event arrives.
        </p>
        <Button type="button" size="sm" className="shrink-0 gap-1.5" onClick={() => setCreating(true)}>
          <Plus className="h-3.5 w-3.5" aria-hidden />
          New subscription
        </Button>
      </div>

      {/* `isPending`, not `isLoading`: the query is held (not fetching)
          while the owner resolves, and a held list is still loading. */}
      {subsQ.isPending && !ownerFailed && <LoadingRow label="Loading subscriptions…" />}
      {subsQ.error != null && <ErrorRow>Failed to load subscriptions.</ErrorRow>}
      {/* This tab has no unscoped state to fall back to — the feed's "All"
          control has no counterpart here — so the only move left is to load
          the page again. */}
      {ownerFailed && (
        <ErrorRow>
          Could not load your workspace, so subscriptions cannot be listed for it. Reload the page
          to try again.
        </ErrorRow>
      )}

      {subsQ.data && subsQ.data.subscriptions.length === 0 && (
        <EmptyRow>No subscriptions yet. Create one above.</EmptyRow>
      )}

      {subsQ.data && subsQ.data.subscriptions.length > 0 && (
        <div className="divide-y divide-line border-t border-line">
          {subsQ.data.subscriptions.map((sub) => (
            <SubscriptionRow
              key={sub.id}
              sub={sub}
              workflowNames={workflowNames}
              teamNames={teamNames}
              viewerId={meQ.data?.id}
              mutable={canMutate(sub, meQ.data?.id, memberTeamIds)}
            />
          ))}
        </div>
      )}

      {/* Mounted only while open: the dialog computes its default target at
          mount, so mount time must be open time (see its header comment).
          Also keeps its catalog/workflow queries off the tab's initial
          load. */}
      {creating && <SubscriptionCreateDialog open onOpenChange={setCreating} />}
    </div>
  );
}

function SubscriptionRow({
  sub,
  workflowNames,
  teamNames,
  viewerId,
  mutable,
}: {
  sub: EventSubscriptionWire;
  workflowNames: Map<string, string>;
  teamNames: Map<string, string>;
  /** The caller's user id; undefined while `useMe` loads. */
  viewerId: string | undefined;
  /** False for a colleague's personal subscription — visible, not actionable. */
  mutable: boolean;
}) {
  const patch = usePatchEventSubscription();
  const del = useDeleteEventSubscription();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [toggleError, setToggleError] = useState<string | null>(null);

  return (
    <div className="flex items-center gap-3 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-medium text-ink">{sub.name}</span>
          {/* Ownership varies row to row here, so it is badged: "Org" for
              an org-owned row, the team's name for a team's (`OwnerBadge`),
              and "Personal" for a COLLEAGUE's. The scoped list returns no
              colleague's row, so that last badge marks a row the server
              should not have sent — it keeps such a row from reading as
              yours. An unbadged row is yours. */}
          {sub.ownerType === "org" && (
            <Badge variant="accent" className="shrink-0">
              Org
            </Badge>
          )}
          {sub.ownerType === "team" && (
            <OwnerBadge ownerType={sub.ownerType} ownerId={sub.ownerId} />
          )}
          {sub.ownerType === "user" && viewerId !== undefined && sub.ownerId !== viewerId && (
            <Tooltip content="A colleague's personal subscription. Only they can change it.">
              <Badge variant="neutral" className="shrink-0">
                Personal
              </Badge>
            </Tooltip>
          )}
        </div>
        <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          {sub.eventKeys.map((k) => (
            <span key={k} className="font-mono text-xs text-muted">
              {k}
            </span>
          ))}
          <span className="text-xs text-muted">
            → {describeTarget(sub.target, workflowNames, teamNames)}
          </span>
          {sub.filters.length > 0 && (
            <span className="text-xs text-muted">
              · {sub.filters.length} filter{sub.filters.length === 1 ? "" : "s"}
            </span>
          )}
        </div>
        {toggleError && <p className="mt-1 text-xs text-danger-500">{toggleError}</p>}
      </div>

      <Switch
        checked={sub.enabled}
        disabled={patch.isPending || !mutable}
        aria-label={sub.enabled ? `Disable ${sub.name}` : `Enable ${sub.name}`}
        onCheckedChange={(enabled) => {
          setToggleError(null);
          patch.mutate(
            { id: sub.id, body: { enabled } },
            { onError: (err) => setToggleError(errorText(err)) },
          );
        }}
      />

      {mutable && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="ghost" size="sm" aria-label={`${sub.name} actions`}>
              <MoreHorizontal className="h-4 w-4" aria-hidden />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem className="text-danger-500" onSelect={() => setConfirmDelete(true)}>
              Delete subscription
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Delete ${sub.name}?`}
        description="Matching events will no longer run this target. Past events and deliveries are kept."
        confirmLabel="Delete subscription"
        pendingLabel="Deleting…"
        pending={del.isPending}
        error={del.error != null ? errorText(del.error) : undefined}
        onConfirm={() => del.mutate(sub.id, { onSuccess: () => setConfirmDelete(false) })}
      />
    </div>
  );
}
