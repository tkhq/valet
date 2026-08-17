import { Link, createFileRoute } from "@tanstack/react-router";
import type { GetEventResponse } from "@valet/api/wire";
import { useEvent } from "~/api/events";
import { DeliveryList } from "~/components/events/delivery-list";
import { RedeliverButton } from "~/components/events/redeliver-button";
import { Badge, ErrorRow, LoadingRow } from "~/components/primitives";
import { formatWhen } from "~/lib/format-when";

/**
 * `/events/$eventId` — one event at its own URL: payload, delivery attempts,
 * and the control that sends it again.
 *
 * The feed can expand an event in place, but an expansion has no address. An
 * event that broke a run has to be paste-able into a ticket, so it gets a
 * route.
 */
export const Route = createFileRoute("/events/$eventId")({
  component: EventDetailPage,
});

function EventDetailPage() {
  const { eventId } = Route.useParams();
  const { data, isLoading, error } = useEvent(eventId);

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto max-w-4xl px-6 py-10">
        <Link to="/events" className="text-xs text-muted hover:text-ink">
          ← Events
        </Link>
        {isLoading && <LoadingRow label="Loading event…" />}
        {(error != null || (!isLoading && !data)) && (
          <ErrorRow>
            Failed to load this event. Reload the page, or open the Events list to find it again.
          </ErrorRow>
        )}
        {data && <EventDetailBody data={data} />}
      </div>
    </div>
  );
}

/**
 * Props-driven body, split out from `EventDetailPage` so it renders without
 * router context — the back `<Link>` above is the only part that needs it.
 * Same split as `RunDetailBody`.
 */
export function EventDetailBody({ data }: { data: GetEventResponse }) {
  const { event, deliveries } = data;
  const refs = Object.entries(event.refs);

  return (
    <div className="mt-4 space-y-6">
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="accent">{event.service}</Badge>
          <span className="font-mono text-xs text-muted">{event.eventKey}</span>
          {event.actor?.login && <span className="text-xs text-muted">{event.actor.login}</span>}
        </div>
        <h1 className="mt-2 font-display text-xl text-ink">{event.summary}</h1>
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

      <div>
        <h2 className="mb-2 text-sm font-medium text-ink">Payload</h2>
        <pre className="max-h-96 overflow-auto rounded-md bg-neutral-50 p-3 font-mono text-xs text-ink dark:bg-neutral-900">
          {JSON.stringify(event.payload, null, 2)}
        </pre>
      </div>
    </div>
  );
}
