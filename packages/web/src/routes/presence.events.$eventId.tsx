import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import type { GetEventResponse } from "@valet/api/wire";
import { useEvent } from "~/api/events";
import { DeliveryList } from "~/components/events/delivery-list";
import { EventReceiptStages } from "~/components/events/receipts-panel";
import { RedeliverButton } from "~/components/events/redeliver-button";
import { ActivitySentence, useWorkflowsByListener } from "~/components/presence/activity-row";
import { PRESENCE_CRUMB, PresenceDetailPage, type PresenceCrumb } from "~/components/presence/page-shell";
import { activityLead, activitySentenceParts, eventInWords } from "~/components/presence/sentences";
import { Badge, ErrorRow, LoadingRow } from "~/components/primitives";
import { formatWhen } from "~/lib/format-when";

/**
 * `/presence/events/$eventId`: one event at its own URL. It replaces
 * `/events/$eventId`. Its title is the event in words and its place, with
 * the event's summary under it. The page shows the activity sentence, the deliveries,
 * the control that sends the event again, the receipt stages, and the
 * payload (docs/specs/2026-10-16-presence-hub-design.md Part E step 2).
 *
 * The Activity row can expand an event in place, but an expansion has no
 * address. An event that broke a run has to be paste-able into a ticket, so
 * it gets a route.
 */
export const Route = createFileRoute("/presence/events/$eventId")({
  component: PresenceEventPage,
});

/** `Presence › Activity › <event in words>`. Until the event loads, the last crumb reads `Event`. */
export function eventCrumbs(eventKey: string | undefined): PresenceCrumb[] {
  return [PRESENCE_CRUMB, { label: "Activity", to: "/presence/activity" }, { label: eventInWords(eventKey) }];
}

/**
 * The page title and the muted line under it: `<event in words> in
 * <place>`, as the Activity row leads, then the event's own summary. Until
 * the event loads, the title reads `Event`.
 */
export function eventHeading(event: GetEventResponse["event"] | undefined): { title: string; subtitle?: string } {
  if (event === undefined) return { title: "Event" };
  const title = activityLead(event, event.place !== undefined ? { place: event.place } : {});
  const summary = event.summary.trim();
  return summary.length > 0 && summary !== title ? { title, subtitle: summary } : { title };
}

export function PresenceEventPage() {
  const { eventId } = Route.useParams();
  const { data, isLoading, error } = useEvent(eventId);
  const heading = eventHeading(data?.event);
  return (
    <PresenceDetailPage crumbs={eventCrumbs(data?.event.eventKey)} title={heading.title} subtitle={heading.subtitle}>
      {isLoading && <LoadingRow label="Loading event…" />}
      {(error != null || (!isLoading && !data)) && (
        <ErrorRow>Could not load this event. Reload the page. If it still fails, open Activity and find the event again.</ErrorRow>
      )}
      {data && <EventDetailBody data={data} />}
    </PresenceDetailPage>
  );
}

/**
 * Props-driven body, split out from `PresenceEventPage` so it renders
 * without route context. Same split as `RunDetailBody`.
 */
export function EventDetailBody({ data }: { data: GetEventResponse }) {
  const { event, deliveries } = data;
  const refs = Object.entries(event.refs);
  const workflowsByListener = useWorkflowsByListener();
  const [receiptsOpen, setReceiptsOpen] = useState(false);
  // The same place the Activity row names, so the page's lead matches it.
  const names = { ...(event.place !== undefined ? { place: event.place } : {}), workflowsByListener };

  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm font-medium text-ink [overflow-wrap:anywhere]">
          <ActivitySentence eventId={event.id} sentence={activitySentenceParts(event, deliveries, names)} />
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Badge variant="accent">{event.service}</Badge>
          <span className="break-all font-mono text-xs text-muted">{event.eventKey}</span>
          {event.actor?.login && <span className="min-w-0 text-xs text-muted [overflow-wrap:anywhere]">{event.actor.login}</span>}
        </div>
        <p className="mt-1 text-xs text-muted">
          Occurred {formatWhen(event.occurredAt)} · received {formatWhen(event.receivedAt)}
        </p>
        {refs.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {/* `break-all`, not `break-words`: a ref value is one unbroken
                token (a branch name, a URL, a commit sha), and only a rule
                that can break mid-token lets the chip shrink inside the row
                instead of running past its edge. */}
            {refs.map(([key, value]) => (
              <span key={key} className="rounded-sm bg-neutral-100 px-1.5 py-0.5 font-mono text-[11px] text-muted break-all dark:bg-neutral-800">
                {key}: {value}
              </span>
            ))}
          </div>
        )}
      </div>

      <div>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-medium text-ink">Deliveries</h2>
          <RedeliverButton eventId={event.id} eventKey={event.eventKey} deliveries={deliveries} />
        </div>
        <DeliveryList deliveries={deliveries} />
      </div>

      <details onToggle={(toggle) => setReceiptsOpen(toggle.currentTarget.open)}>
        <summary className="cursor-pointer text-sm font-medium text-ink">Intake stages</summary>
        <div className="mt-2">
          <EventReceiptStages eventId={event.id} open={receiptsOpen} />
        </div>
      </details>

      <div>
        <h2 className="mb-2 text-sm font-medium text-ink">Payload</h2>
        <pre className="max-h-96 overflow-auto rounded-md bg-neutral-50 p-3 font-mono text-xs text-ink dark:bg-neutral-900">
          {JSON.stringify(event.payload, null, 2)}
        </pre>
      </div>
    </div>
  );
}
