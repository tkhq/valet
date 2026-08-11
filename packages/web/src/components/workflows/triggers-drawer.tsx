import { WebhookSection } from "./webhook-section";
import { ScheduleSection } from "./schedule-section";

/**
 * Triggers panel for one workflow: the webhook URL and cron schedules.
 * First UI over `POST /api/workflows/:id/webhook` and the schedule routes;
 * before this, both were API-only.
 */
export function TriggersPanel({ workflowId }: { workflowId: string }) {
  return (
    <div className="space-y-6 px-4 py-3">
      <WebhookSection workflowId={workflowId} />
      <ScheduleSection workflowId={workflowId} />
    </div>
  );
}
