import { useState } from "react";
import { Trash2 } from "lucide-react";
import type { WorkflowScheduleWire } from "@valet/api/wire";
import {
  Button,
  ConfirmDialog,
  EmptyRow,
  ErrorRow,
  Input,
  Label,
  LoadingRow,
} from "~/components/primitives";
import { useCreateWorkflowSchedule, useDeleteWorkflowSchedule, useWorkflowSchedules } from "~/api/workflows";
import { errorText } from "~/lib/error-text";
import { formatWhen } from "~/lib/format-when";

/** Cron schedules for one workflow: list, create, delete. */
export function ScheduleSection({ workflowId }: { workflowId: string }) {
  const schedulesQ = useWorkflowSchedules(workflowId);
  const create = useCreateWorkflowSchedule(workflowId);
  const del = useDeleteWorkflowSchedule(workflowId);

  const [name, setName] = useState("");
  const [cron, setCron] = useState("");
  const [timezone, setTimezone] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<WorkflowScheduleWire | null>(null);

  const schedules = schedulesQ.data?.schedules ?? [];
  const canSubmit = name.trim().length > 0 && cron.trim().length > 0 && !create.isPending;

  function submit() {
    if (!canSubmit) return;
    setError(null);
    create.mutate(
      {
        name: name.trim(),
        cron: cron.trim(),
        ...(timezone.trim() ? { timezone: timezone.trim() } : {}),
      },
      {
        onSuccess: () => {
          setName("");
          setCron("");
        },
        onError: (err) => setError(errorText(err)),
      },
    );
  }

  return (
    <section>
      <h3 className="text-xs font-medium uppercase tracking-wide text-muted">Schedules</h3>
      <p className="mt-1 text-xs text-muted">
        Each schedule starts a run on its cron expression. A missed window collapses into one
        catch-up fire.
      </p>

      {schedulesQ.isLoading && <LoadingRow className="mt-2 py-0 text-xs" />}
      {schedulesQ.error != null && (
        <ErrorRow className="mt-2 py-0 text-xs">Failed to load schedules.</ErrorRow>
      )}

      {schedules.length > 0 && (
        <ul className="mt-2 divide-y divide-line border-t border-line">
          {schedules.map((s) => (
            <li key={s.scheduleId} className="flex items-center gap-2 py-2">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm text-ink">{s.name}</p>
                <p className="text-xs text-muted">
                  <span className="font-mono">{s.cron}</span> · {s.timezone} · next{" "}
                  {formatWhen(s.nextFireAt)}
                </p>
              </div>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                aria-label={`Delete schedule ${s.name}`}
                onClick={() => setDeleting(s)}
              >
                <Trash2 className="h-3.5 w-3.5" aria-hidden />
              </Button>
            </li>
          ))}
        </ul>
      )}
      {!schedulesQ.isLoading && schedulesQ.error == null && schedules.length === 0 && (
        <EmptyRow className="mt-2 py-0 text-xs">No schedules yet.</EmptyRow>
      )}

      <div className="mt-3 space-y-2">
        <div className="grid gap-1">
          <Label htmlFor="schedule-name">Name</Label>
          <Input
            id="schedule-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Nightly run"
          />
        </div>
        <div className="grid gap-1">
          <Label htmlFor="schedule-cron">Cron (5 fields)</Label>
          <Input
            id="schedule-cron"
            value={cron}
            onChange={(e) => setCron(e.target.value)}
            placeholder="0 9 * * 1-5"
            className="font-mono"
          />
        </div>
        <div className="grid gap-1">
          <Label htmlFor="schedule-tz">Timezone (optional, IANA)</Label>
          <Input
            id="schedule-tz"
            value={timezone}
            onChange={(e) => setTimezone(e.target.value)}
            placeholder="UTC"
          />
        </div>
        {error && <p className="text-xs text-danger-500">{error}</p>}
        <Button type="button" size="sm" disabled={!canSubmit} onClick={submit}>
          {create.isPending ? "Adding…" : "Add schedule"}
        </Button>
      </div>

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
        title={`Delete ${deleting?.name}?`}
        description="The schedule stops firing immediately. This cannot be undone."
        confirmLabel="Delete schedule"
        pendingLabel="Deleting…"
        pending={del.isPending}
        error={del.error != null ? errorText(del.error) : undefined}
        onConfirm={() => {
          if (!deleting) return;
          del.mutate(deleting.scheduleId, { onSuccess: () => setDeleting(null) });
        }}
      />
    </section>
  );
}
