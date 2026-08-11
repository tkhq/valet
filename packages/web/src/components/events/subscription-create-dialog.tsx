import { useState } from "react";
import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  ErrorRow,
  Input,
  LoadingRow,
} from "~/components/primitives";
import { useCreateEventSubscription, useEventCatalog } from "~/api/events";
import { useWorkflows } from "~/api/workflows";
import { errorText } from "~/lib/error-text";

type TargetChoice =
  | { kind: "orchestrator"; orchestrator: "user" | "org" }
  | { kind: "workflow"; workflowId: string };

/**
 * Create dialog for an event subscription. Offers only catalog keys, so a
 * subscription cannot name an event the ingest matcher can never match.
 * Filters are API-only for now — this dialog does not build them.
 */
export function SubscriptionCreateDialog({
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
            {catalogQ.isLoading && <LoadingRow label="Loading catalog…" className="py-2 text-xs" />}
            {catalogQ.error != null && (
              <ErrorRow className="py-2 text-xs">Failed to load the event catalog.</ErrorRow>
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
