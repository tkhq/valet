import { useMemo, useState } from "react";
import { MoreHorizontal, Plus } from "lucide-react";
import type { EventSubscriptionTargetWire, EventSubscriptionWire } from "@valet/api/wire";
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Input,
  Spinner,
  Switch,
} from "~/components/primitives";
import {
  useCreateEventSubscription,
  useDeleteEventSubscription,
  useEventCatalog,
  useEventSubscriptions,
  usePatchEventSubscription,
} from "~/api/events";
import { useWorkflows } from "~/api/workflows";
import { errorText } from "~/lib/error-text";

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
 * delete; create via a dialog that draws its event keys from the plugin
 * trigger catalog, so only keys the ingest matcher can actually match are
 * offered. Filters are API-only for now: rows show them read-only, and the
 * create dialog does not build them yet.
 */
export function SubscriptionsPanel() {
  const subsQ = useEventSubscriptions();
  const workflowsQ = useWorkflows();
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

      {subsQ.isLoading && (
        <div className="flex items-center gap-2 py-4 text-sm text-muted">
          <Spinner size={14} /> Loading subscriptions…
        </div>
      )}
      {subsQ.error && <p className="py-4 text-sm text-danger-500">Failed to load subscriptions.</p>}

      {subsQ.data && subsQ.data.subscriptions.length === 0 && (
        <p className="py-4 text-sm text-muted">No subscriptions yet. Create one above.</p>
      )}

      {subsQ.data && subsQ.data.subscriptions.length > 0 && (
        <div className="divide-y divide-line border-t border-line">
          {subsQ.data.subscriptions.map((sub) => (
            <SubscriptionRow key={sub.id} sub={sub} workflowNames={workflowNames} />
          ))}
        </div>
      )}

      <CreateSubscriptionDialog open={creating} onOpenChange={setCreating} />
    </div>
  );
}

function SubscriptionRow({
  sub,
  workflowNames,
}: {
  sub: EventSubscriptionWire;
  workflowNames: Map<string, string>;
}) {
  const patch = usePatchEventSubscription();
  const del = useDeleteEventSubscription();
  const [confirmDelete, setConfirmDelete] = useState(false);

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
      </div>

      <Switch
        checked={sub.enabled}
        disabled={patch.isPending}
        aria-label={sub.enabled ? `Disable ${sub.name}` : `Enable ${sub.name}`}
        onCheckedChange={(enabled) => patch.mutate({ id: sub.id, body: { enabled } })}
      />

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

      <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <DialogContent
          title={`Delete ${sub.name}?`}
          description="Matching events will no longer run this target. Past events and deliveries are kept."
        >
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => setConfirmDelete(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="danger"
              disabled={del.isPending}
              onClick={() => del.mutate(sub.id, { onSuccess: () => setConfirmDelete(false) })}
            >
              {del.isPending ? "Deleting…" : "Delete subscription"}
            </Button>
          </DialogFooter>
          {del.error && <p className="text-xs text-danger-500">{del.error.message}</p>}
        </DialogContent>
      </Dialog>
    </div>
  );
}

type TargetChoice =
  | { kind: "orchestrator"; orchestrator: "user" | "org" }
  | { kind: "workflow"; workflowId: string };

function CreateSubscriptionDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const catalogQ = useEventCatalog();
  const workflowsQ = useWorkflows();
  const create = useCreateEventSubscription();

  const [name, setName] = useState("");
  const [keys, setKeys] = useState<Set<string>>(new Set());
  const [target, setTarget] = useState<TargetChoice>({ kind: "orchestrator", orchestrator: "user" });
  const [error, setError] = useState<string | null>(null);

  const workflows = workflowsQ.data?.workflows ?? [];
  const services = catalogQ.data?.services ?? [];
  const targetReady = target.kind === "orchestrator" || target.workflowId.length > 0;
  const canSubmit = name.trim().length > 0 && keys.size > 0 && targetReady && !create.isPending;

  function reset() {
    setName("");
    setKeys(new Set());
    setTarget({ kind: "orchestrator", orchestrator: "user" });
    setError(null);
  }

  function toggleKey(key: string) {
    setKeys((cur) => {
      const next = new Set(cur);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function submit() {
    if (!canSubmit) return;
    setError(null);
    create.mutate(
      { name: name.trim(), eventKeys: [...keys], target },
      {
        onSuccess: () => {
          reset();
          onOpenChange(false);
        },
        onError: (err) => setError(errorText(err)),
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="New subscription"
        description="Pick the events to match and what a match runs."
      >
        <div className="space-y-4">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Subscription name"
            aria-label="Subscription name"
          />

          <div>
            <p className="mb-1.5 text-xs font-medium text-muted">Events</p>
            {catalogQ.isLoading && (
              <div className="flex items-center gap-2 py-2 text-xs text-muted">
                <Spinner size={12} /> Loading catalog…
              </div>
            )}
            {catalogQ.error && (
              <p className="py-2 text-xs text-danger-500">Failed to load the event catalog.</p>
            )}
            {!catalogQ.isLoading && !catalogQ.error && services.length === 0 && (
              <p className="py-2 text-xs text-muted">
                No plugin publishes events yet. Connect an integration with triggers first.
              </p>
            )}
            <div className="max-h-56 space-y-3 overflow-y-auto">
              {services.map((s) => (
                <div key={s.service}>
                  <p className="mb-1 text-xs font-medium text-ink">{s.service}</p>
                  <div className="space-y-1">
                    {s.entries.map((entry) => (
                      <label
                        key={entry.key}
                        className="flex items-start gap-2 text-sm text-ink"
                        title={entry.description}
                      >
                        <input
                          type="checkbox"
                          className="mt-0.5"
                          checked={keys.has(entry.key)}
                          onChange={() => toggleKey(entry.key)}
                        />
                        <span className="font-mono text-xs">{entry.key}</span>
                      </label>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div>
            <p className="mb-1.5 text-xs font-medium text-muted">Then</p>
            <div className="space-y-1.5">
              <label className="flex items-center gap-2 text-sm text-ink">
                <input
                  type="radio"
                  name="subscription-target"
                  checked={target.kind === "orchestrator" && target.orchestrator === "user"}
                  onChange={() => setTarget({ kind: "orchestrator", orchestrator: "user" })}
                />
                Notify your orchestrator
              </label>
              <label className="flex items-center gap-2 text-sm text-ink">
                <input
                  type="radio"
                  name="subscription-target"
                  checked={target.kind === "orchestrator" && target.orchestrator === "org"}
                  onChange={() => setTarget({ kind: "orchestrator", orchestrator: "org" })}
                />
                Notify the org orchestrator
              </label>
              <label className="flex items-center gap-2 text-sm text-ink">
                <input
                  type="radio"
                  name="subscription-target"
                  checked={target.kind === "workflow"}
                  disabled={workflows.length === 0}
                  onChange={() => setTarget({ kind: "workflow", workflowId: workflows[0]?.id ?? "" })}
                />
                Run a workflow
              </label>
              {target.kind === "workflow" && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button type="button" variant="secondary" size="sm" className="ml-6">
                      {workflows.find((w) => w.id === target.workflowId)?.name ?? "Pick a workflow"}
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start">
                    {workflows.map((w) => (
                      <DropdownMenuItem
                        key={w.id}
                        onSelect={() => setTarget({ kind: "workflow", workflowId: w.id })}
                      >
                        {w.name}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
              {workflows.length === 0 && (
                <p className="ml-6 text-xs text-muted">
                  You have no workflows yet — create one on the Workflows page to use this target.
                </p>
              )}
            </div>
          </div>

          {error && <p className="text-xs text-danger-500">{error}</p>}
        </div>

        <DialogFooter>
          <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" disabled={!canSubmit} onClick={submit}>
            {create.isPending ? "Creating…" : "Create subscription"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
