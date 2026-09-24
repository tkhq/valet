/**
 * Problems tab — the org-admin Slack webhook event log. The existing event
 * list supplies the summaries; expanded rows show delivery status and errors.
 */
import { useState } from "react";
import { RefreshCw } from "lucide-react";
import { Button, EmptyRow, ErrorRow, LoadingRow } from "~/components/primitives";
import { useEvents } from "~/api/events";
import { EventRow } from "./event-row";

const SLACK_PAGE_SIZE = 50;

export function DropsPanel() {
  const eventsQ = useEvents({ service: "slack" });
  const [expanded, setExpanded] = useState<string | null>(null);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <p className="flex-1 text-sm text-muted">
          Received Slack webhook events. Open an event to inspect its delivery status and errors.
        </p>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label="Refresh Slack webhook events"
          disabled={eventsQ.isFetching}
          onClick={() => void eventsQ.refetch()}
        >
          <RefreshCw className={`h-3.5 w-3.5 ${eventsQ.isFetching ? "animate-spin" : ""}`} aria-hidden />
        </Button>
      </div>

      {eventsQ.isPending && <LoadingRow label="Loading Slack webhook events…" />}
      {eventsQ.error != null && (
        <ErrorRow>Could not load Slack webhook events. Confirm that you are an organization admin, then refresh.</ErrorRow>
      )}
      {eventsQ.data && eventsQ.data.events.length === 0 && (
        <EmptyRow>No Slack webhook events are recorded yet. Submit a Slack form, then refresh this list.</EmptyRow>
      )}
      {eventsQ.data && eventsQ.data.events.length > 0 && (
        <div className="divide-y divide-line border-t border-line">
          {eventsQ.data.events.map((event) => (
            <EventRow
              key={event.id}
              event={event}
              open={expanded === event.id}
              onToggle={() => setExpanded((current) => (current === event.id ? null : event.id))}
            />
          ))}
        </div>
      )}
      {eventsQ.data && eventsQ.data.events.length >= SLACK_PAGE_SIZE && (
        <p className="text-xs text-muted">Showing the most recent {SLACK_PAGE_SIZE} Slack webhook events.</p>
      )}
    </div>
  );
}
