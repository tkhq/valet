import { useState } from "react";
import { Clock, Pencil, Play, Trash2, Zap } from "lucide-react";
import type { WorkflowTriggerItem } from "@valet/api/wire";
import {
  useDeleteEventTrigger,
  useDeleteSchedule,
  useRunScheduleNow,
  useUpdateEventTrigger,
  useUpdateSchedule,
  useWorkflowTriggers,
  useWorkflows,
} from "~/api/workflows";
import { Button, Spinner, Switch } from "~/components/primitives";
import { TriggerDialog } from "./trigger-dialog";

/** Relative "in 2h" formatting for next fire times. */
function relativeTime(ms: number): string {
  const delta = ms - Date.now();
  if (delta <= 0) return "due now";
  const minutes = Math.round(delta / 60_000);
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `in ${hours}h`;
  return `in ${Math.round(hours / 24)}d`;
}

function triggerSummary(t: WorkflowTriggerItem): string {
  if (t.kind === "schedule") {
    const next = t.enabled ? ` · next ${relativeTime(t.detail.nextFireAt)}` : "";
    const target = t.detail.targetKind === "orchestrator" ? " · orchestrator" : "";
    return `${t.detail.cron} (${t.detail.timezone})${target}${next}`;
  }
  return t.detail.eventKeys.join(", ");
}

export function TriggerList({ workflowId }: { workflowId?: string }) {
  const { data, isLoading, error } = useWorkflowTriggers(workflowId);
  const workflowsQ = useWorkflows();
  const updateSchedule = useUpdateSchedule();
  const updateEvent = useUpdateEventTrigger();
  const deleteSchedule = useDeleteSchedule();
  const deleteEvent = useDeleteEventTrigger();
  const runNow = useRunScheduleNow();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<WorkflowTriggerItem | undefined>(undefined);
  const [actionError, setActionError] = useState<string | null>(null);

  const nameById = new Map(
    (workflowsQ.data?.workflows ?? []).map((w) => [w.id, w.name]),
  );
  const triggers = data?.triggers ?? [];

  async function guarded(fn: () => Promise<unknown>) {
    setActionError(null);
    try {
      await fn();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Request failed.");
    }
  }

  function toggle(t: WorkflowTriggerItem) {
    const body = { enabled: !t.enabled };
    void guarded(() =>
      t.kind === "schedule"
        ? updateSchedule.mutateAsync({ id: t.id, body })
        : updateEvent.mutateAsync({ id: t.id, body }),
    );
  }

  function remove(t: WorkflowTriggerItem) {
    if (!confirm(`Delete trigger "${t.name}"?`)) return;
    void guarded(() =>
      t.kind === "schedule"
        ? deleteSchedule.mutateAsync(t.id)
        : deleteEvent.mutateAsync(t.id),
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-ink">Triggers</span>
        <Button
          size="sm"
          onClick={() => {
            setEditing(undefined);
            setDialogOpen(true);
          }}
        >
          New trigger
        </Button>
      </div>

      {actionError && <div className="text-xs text-danger-500">{actionError}</div>}
      {isLoading && (
        <div className="flex items-center gap-2 text-sm text-muted">
          <Spinner size={14} /> Loading triggers…
        </div>
      )}
      {!isLoading && error && (
        <div className="text-sm text-danger-500">Failed to load triggers.</div>
      )}
      {!isLoading && !error && triggers.length === 0 && (
        <div className="text-sm text-muted">
          {workflowId
            ? "No triggers yet. Create one to run this on a schedule or on an event."
            : "No triggers yet. Create one to run a workflow on a schedule or on an event."}
        </div>
      )}

      <ul className="space-y-2">
        {triggers.map((t) => (
          <li
            key={`${t.kind}:${t.id}`}
            className="flex items-center gap-3 rounded border border-line bg-paper px-4 py-3"
          >
            {t.kind === "schedule" ? (
              <Clock className="h-4 w-4 shrink-0 text-muted" aria-label="schedule trigger" />
            ) : (
              <Zap className="h-4 w-4 shrink-0 text-muted" aria-label="event trigger" />
            )}
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium text-ink">{t.name}</div>
              <div className="truncate text-xs text-muted">
                {triggerSummary(t)}
                {!workflowId && t.workflowId && ` · ${nameById.get(t.workflowId) ?? t.workflowId}`}
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {t.kind === "schedule" && (
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`Run now: ${t.name}`}
                  onClick={() => void guarded(() => runNow.mutateAsync(t.id))}
                  disabled={runNow.isPending}
                >
                  <Play className="h-4 w-4" />
                </Button>
              )}
              <Button
                size="sm"
                variant="ghost"
                aria-label={`Edit ${t.name}`}
                onClick={() => {
                  setEditing(t);
                  setDialogOpen(true);
                }}
              >
                <Pencil className="h-4 w-4" />
              </Button>
              <Button
                size="sm"
                variant="ghost"
                aria-label={`Delete ${t.name}`}
                onClick={() => remove(t)}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
              <Switch
                checked={t.enabled}
                onCheckedChange={() => toggle(t)}
                aria-label={`${t.enabled ? "Disable" : "Enable"} ${t.name}`}
              />
            </div>
          </li>
        ))}
      </ul>

      <TriggerDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        workflowId={workflowId}
        editing={editing}
      />
    </div>
  );
}
