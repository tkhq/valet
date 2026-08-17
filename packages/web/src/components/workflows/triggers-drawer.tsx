import { WebhookSection } from "./webhook-section";
import { TriggerList } from "./trigger-list";

/**
 * Triggers panel for one workflow: the webhook URL, the cron schedules and
 * the event triggers. `TriggerList` scoped to this workflow owns the last
 * two. One list, one cache: a second schedule list on the same page would
 * show rows the first list's create and delete never refresh.
 */
export function TriggersPanel({ workflowId }: { workflowId: string }) {
  return (
    <div className="space-y-6 px-4 py-3">
      <WebhookSection workflowId={workflowId} />
      <TriggerList workflowId={workflowId} />
    </div>
  );
}
