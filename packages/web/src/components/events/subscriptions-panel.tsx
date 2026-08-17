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
} from "~/components/primitives";
import {
  useDeleteEventSubscription,
  useEventSubscriptions,
  usePatchEventSubscription,
} from "~/api/events";
import { useMe } from "~/api/settings";
import { useWorkflows } from "~/api/workflows";
import { errorText } from "~/lib/error-text";
import { SubscriptionCreateDialog } from "./subscription-create-dialog";

/** An org-owned subscription is everyone's to manage; a personal one is
 * only its creator's — mirrors the server's `canMutateSubscription`. */
function canMutate(sub: EventSubscriptionWire, userId: string | undefined): boolean {
  return sub.ownerType === "org" || sub.ownerId === userId;
}

function describeTarget(
  target: EventSubscriptionTargetWire,
  workflowNames: Map<string, string>,
): string {
  if (target.kind === "workflow") {
    return `Run workflow: ${workflowNames.get(target.workflowId) ?? target.workflowId}`;
  }
  return target.orchestrator === "org" ? "Notify org orchestrator" : "Notify your orchestrator";
}

/**
 * Event subscriptions: the rules that turn an ingested event into action —
 * a workflow run or an orchestrator prompt. List with enable/disable and
 * delete; create via `SubscriptionCreateDialog`. Rows show filters
 * read-only (filters are API-only for now).
 */
export function SubscriptionsPanel() {
  const subsQ = useEventSubscriptions();
  const workflowsQ = useWorkflows();
  const meQ = useMe();
  const [creating, setCreating] = useState(false);

  const workflowNames = useMemo(
    () => new Map((workflowsQ.data?.workflows ?? []).map((w) => [w.id, w.name])),
    [workflowsQ.data],
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

      {subsQ.isLoading && <LoadingRow label="Loading subscriptions…" />}
      {subsQ.error != null && <ErrorRow>Failed to load subscriptions.</ErrorRow>}

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
              mutable={canMutate(sub, meQ.data?.id)}
            />
          ))}
        </div>
      )}

      <SubscriptionCreateDialog open={creating} onOpenChange={setCreating} />
    </div>
  );
}

function SubscriptionRow({
  sub,
  workflowNames,
  mutable,
}: {
  sub: EventSubscriptionWire;
  workflowNames: Map<string, string>;
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
          <Badge variant={sub.ownerType === "org" ? "accent" : "neutral"} className="shrink-0">
            {sub.ownerType === "org" ? "Org" : "Personal"}
          </Badge>
        </div>
        <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          {sub.eventKeys.map((k) => (
            <span key={k} className="font-mono text-xs text-muted">
              {k}
            </span>
          ))}
          <span className="text-xs text-muted">→ {describeTarget(sub.target, workflowNames)}</span>
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
