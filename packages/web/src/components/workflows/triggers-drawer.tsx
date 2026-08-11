import { useState } from "react";
import { Check, Copy, Trash2 } from "lucide-react";
import { Button, Input, Label, Spinner } from "~/components/primitives";
import {
  useCreateWorkflowSchedule,
  useDeleteWorkflowSchedule,
  useDeleteWorkflowWebhook,
  useMintWorkflowWebhook,
  useWorkflowSchedules,
  useWorkflowWebhook,
} from "~/api/workflows";
import { errorText } from "~/lib/error-text";

function formatWhen(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Triggers panel for one workflow: the webhook URL (mint, copy, rotate,
 * delete — the URL carries the bearer secret, so rotating invalidates the
 * old one) and cron schedules (list, create, delete). First UI over
 * `POST /api/workflows/:id/webhook` and the schedule routes; before this,
 * both were API-only.
 */
export function TriggersPanel({ workflowId }: { workflowId: string }) {
  return (
    <div className="space-y-6 px-4 py-3">
      <WebhookSection workflowId={workflowId} />
      <ScheduleSection workflowId={workflowId} />
    </div>
  );
}

function WebhookSection({ workflowId }: { workflowId: string }) {
  const webhookQ = useWorkflowWebhook(workflowId);
  const mint = useMintWorkflowWebhook(workflowId);
  const del = useDeleteWorkflowWebhook(workflowId);
  const [copied, setCopied] = useState(false);

  const hook = webhookQ.data;
  const url = hook
    ? `${window.location.origin}/api/hooks/workflows/${workflowId}/${hook.hookId}`
    : null;

  async function copy() {
    if (!url) return;
    await navigator.clipboard.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <section>
      <h3 className="text-xs font-medium uppercase tracking-wide text-muted">Webhook</h3>
      <p className="mt-1 text-xs text-muted">
        A POST to this URL starts a run with the request body as input. The URL carries the
        secret — share it only with the caller.
      </p>

      {webhookQ.isLoading && (
        <div className="mt-2 flex items-center gap-2 text-xs text-muted">
          <Spinner size={12} /> Loading…
        </div>
      )}
      {webhookQ.error != null && (
        <p className="mt-2 text-xs text-danger-500">Failed to load the webhook status.</p>
      )}

      {!webhookQ.isLoading && hook === null && (
        <Button
          type="button"
          size="sm"
          className="mt-2"
          disabled={mint.isPending}
          onClick={() => mint.mutate()}
        >
          {mint.isPending ? "Creating…" : "Create webhook URL"}
        </Button>
      )}

      {url && (
        <div className="mt-2 space-y-2">
          <div className="flex items-center gap-1.5">
            <code className="min-w-0 flex-1 truncate rounded bg-neutral-50 px-2 py-1.5 font-mono text-xs text-ink dark:bg-neutral-900">
              {url}
            </code>
            <Button type="button" size="sm" variant="ghost" aria-label="Copy webhook URL" onClick={() => void copy()}>
              {copied ? <Check className="h-3.5 w-3.5" aria-hidden /> : <Copy className="h-3.5 w-3.5" aria-hidden />}
            </Button>
          </div>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={mint.isPending}
              onClick={() => {
                if (confirm("Rotate the webhook URL? The current URL stops working immediately.")) {
                  mint.mutate();
                }
              }}
            >
              Rotate
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={del.isPending}
              onClick={() => {
                if (confirm("Delete the webhook? Callers holding the URL get 404s.")) {
                  del.mutate();
                }
              }}
            >
              Delete
            </Button>
          </div>
        </div>
      )}

      {mint.error && <p className="mt-2 text-xs text-danger-500">{errorText(mint.error)}</p>}
      {del.error && <p className="mt-2 text-xs text-danger-500">{errorText(del.error)}</p>}
    </section>
  );
}

function ScheduleSection({ workflowId }: { workflowId: string }) {
  const schedulesQ = useWorkflowSchedules(workflowId);
  const create = useCreateWorkflowSchedule(workflowId);
  const del = useDeleteWorkflowSchedule(workflowId);

  const [name, setName] = useState("");
  const [cron, setCron] = useState("");
  const [timezone, setTimezone] = useState("");
  const [error, setError] = useState<string | null>(null);

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

      {schedulesQ.isLoading && (
        <div className="mt-2 flex items-center gap-2 text-xs text-muted">
          <Spinner size={12} /> Loading…
        </div>
      )}
      {schedulesQ.error != null && (
        <p className="mt-2 text-xs text-danger-500">Failed to load schedules.</p>
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
                disabled={del.isPending}
                onClick={() => del.mutate(s.scheduleId)}
              >
                <Trash2 className="h-3.5 w-3.5" aria-hidden />
              </Button>
            </li>
          ))}
        </ul>
      )}
      {!schedulesQ.isLoading && schedules.length === 0 && (
        <p className="mt-2 text-xs text-muted">No schedules yet.</p>
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
    </section>
  );
}
