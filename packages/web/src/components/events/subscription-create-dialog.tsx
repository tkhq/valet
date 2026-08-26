import { useState } from "react";
import { Button, Dialog, DialogContent, DialogFooter, ErrorRow, Input, LoadingRow, SelectMenu } from "~/components/primitives";
import { useCreateEventSubscription, useEventCatalog } from "~/api/events";
import { useWorkflows } from "~/api/workflows";
import { errorText } from "~/lib/error-text";
import { useTeams } from "~/api/settings";
import { type ActiveWorkspace, useActiveWorkspace, workspaceName } from "~/components/workspace-clause";

type TargetChoice =
  | { kind: "orchestrator"; orchestrator: "user" | "org" }
  | { kind: "orchestrator"; orchestrator: "team"; teamId: string }
  | { kind: "workflow"; workflowId: string };

/** What the dialog targets before anyone touches it: the active workspace's
 * assistant. The subscription's owner follows its target server-side, so
 * this is how a subscription is born in the workspace the switcher names. */
function targetFor(scopedTeamId: string | undefined): TargetChoice {
  return scopedTeamId !== undefined
    ? { kind: "orchestrator", orchestrator: "team", teamId: scopedTeamId }
    : { kind: "orchestrator", orchestrator: "user" };
}

/** The owner `POST /api/event-subscriptions` will stamp, read off the TARGET
 * the same way the route reads it — not off the active workspace. A workflow
 * the list has not loaded reads as the caller's, the route's own fallback, so
 * the notice below cannot name the wrong team. */
function filedOwner(
  target: TargetChoice,
  workflows: { id: string; ownerType: "user" | "team"; ownerId: string }[],
): { type: "user" | "team" | "org"; teamId?: string } {
  if (target.kind !== "workflow") {
    return target.orchestrator === "team"
      ? { type: "team", teamId: target.teamId }
      : { type: target.orchestrator };
  }
  const wf = workflows.find((w) => w.id === target.workflowId);
  return wf?.ownerType === "team" ? { type: "team", teamId: wf.ownerId } : { type: "user" };
}

/** Where the row will be listed, when that is not the workspace on screen;
 * null when the two agree. Both directions count: a team-owned row armed
 * from the personal workspace also lands elsewhere, so the notice cannot be
 * gated on a team being on screen. Org-owned rows list everywhere. */
function filedElsewhere(
  filed: { type: "user" | "team" | "org"; teamId?: string },
  ws: ActiveWorkspace | undefined,
  teams: { id: string; name: string }[],
): string | null {
  if (filed.type === "org" || ws === undefined) return null;
  const activeTeamId = ws.kind === "team" ? ws.team.id : undefined;
  if (filed.type === "team") {
    if (filed.teamId === activeTeamId) return null;
    return teams.find((t) => t.id === filed.teamId)?.name ?? "the team that owns it";
  }
  return activeTeamId === undefined ? null : "your personal workspace";
}

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
  const ws = useActiveWorkspace();
  const teamsQ = useTeams();
  const scopedTeam = ws?.kind === "team" ? ws.team : undefined;
  const scopedTeamId = scopedTeam?.id;

  // The default is computed ONCE, at mount. The panel mounts this dialog
  // only while it is open, so mount time IS open time — and nothing may
  // rewrite the target afterwards. An effect used to re-derive it whenever
  // the workspace resolved, which silently replaced a target the user had
  // already picked when the teams query landed late. If the workspace is
  // still unknown at open, the default is your own assistant and the team
  // option appears (unselected) when the query lands.
  const [name, setName] = useState("");
  const [keys, setKeys] = useState<Set<string>>(new Set());
  const [target, setTarget] = useState<TargetChoice>(() => targetFor(scopedTeamId));
  const [error, setError] = useState<string | null>(null);

  const workflows = workflowsQ.data?.workflows ?? [];
  const services = catalogQ.data?.services ?? [];
  const targetReady = target.kind === "orchestrator" || target.workflowId.length > 0;
  const elsewhere = filedElsewhere(filedOwner(target, workflows), ws, teamsQ.data?.teams ?? []);
  const canSubmit = name.trim().length > 0 && keys.size > 0 && targetReady && !create.isPending;


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
        onSuccess: () => onOpenChange(false),
        onError: (err) => setError(errorText(err)),
      },
    );
  }

  // No reset machinery: closing unmounts the dialog (the panel mounts it
  // only while open), so the next open starts from a fresh mount.
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
                Notify your assistant
              </label>
              {/* Only the active workspace's team is offered. Targeting a
                  different team is a workspace change, not a form field —
                  the switcher answers "whose", everywhere. */}
              {scopedTeam && (
                <label className="flex items-center gap-2 text-sm text-ink">
                  <input
                    type="radio"
                    name="subscription-target"
                    checked={target.kind === "orchestrator" && target.orchestrator === "team"}
                    onChange={() =>
                      setTarget({ kind: "orchestrator", orchestrator: "team", teamId: scopedTeam.id })
                    }
                  />
                  Notify {scopedTeam.name}&apos;s assistant
                </label>
              )}
              <label className="flex items-center gap-2 text-sm text-ink">
                <input
                  type="radio"
                  name="subscription-target"
                  checked={target.kind === "orchestrator" && target.orchestrator === "org"}
                  onChange={() => setTarget({ kind: "orchestrator", orchestrator: "org" })}
                />
                Notify the org assistant
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
                <div className="ml-6">
                  <SelectMenu
                    value={target.workflowId}
                    onChange={(workflowId) => setTarget({ kind: "workflow", workflowId })}
                    triggerLabel={
                      workflows.find((w) => w.id === target.workflowId)?.name ?? "Pick a workflow"
                    }
                    options={workflows.map((w) => ({ value: w.id, label: w.name }))}
                  />
                </div>
              )}
              {workflows.length === 0 && (
                <p className="ml-6 text-xs text-muted">
                  You have no workflows yet — create one on the Workflows page to use this target.
                </p>
              )}
            </div>
          </div>

          {elsewhere !== null && ws !== undefined && (
            <p className="text-xs text-muted">
              Ownership follows the target. This subscription will be listed in {elsewhere}, not in{" "}
              {workspaceName(ws)}.
            </p>
          )}

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
