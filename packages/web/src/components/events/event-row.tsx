import { Link } from "@tanstack/react-router";
import { ChevronRight, ExternalLink } from "lucide-react";
import type { EventSummaryWire } from "@valet/api/wire";
import { Badge, ErrorRow, LoadingRow } from "~/components/primitives";
import { useEvent } from "~/api/events";
import { formatWhen } from "~/lib/format-when";
import { DeliveryList } from "./delivery-list";

/** One feed row; expands into the raw payload and its delivery attempts. The
 * trailing link opens the same event at its own URL, so it can go in a
 * ticket. */
export function EventRow({
  event,
  open,
  onToggle,
}: {
  event: EventSummaryWire;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="py-2.5">
      <div className="flex w-full min-w-0 items-center gap-2">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          aria-label={open ? `Collapse ${event.summary}` : `Expand ${event.summary}`}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <ChevronRight
            className={`h-4 w-4 shrink-0 text-muted transition-transform ${open ? "rotate-90" : ""}`}
            aria-hidden
          />
          <Badge variant="accent" className="shrink-0">
            {event.service}
          </Badge>
          <span className="shrink-0 font-mono text-xs text-muted">{event.eventKey}</span>
          <span className="min-w-0 flex-1 truncate text-sm text-ink">{event.summary}</span>
          {event.actor?.login && (
            <span className="hidden shrink-0 text-xs text-muted sm:block">{event.actor.login}</span>
          )}
          <span className="shrink-0 text-xs text-muted">{formatWhen(event.receivedAt)}</span>
        </button>
        <Link
          to="/events/$eventId"
          params={{ eventId: event.id }}
          aria-label={`Open ${event.summary}`}
          title="Open this event at its own URL"
          className="shrink-0 rounded-sm p-1 text-muted hover:text-ink"
        >
          <ExternalLink className="h-3.5 w-3.5" aria-hidden />
        </Link>
      </div>

      {open && <EventDetail eventId={event.id} />}
    </div>
  );
}

function EventDetail({ eventId }: { eventId: string }) {
  const detailQ = useEvent(eventId);

  if (detailQ.isLoading) {
    return <LoadingRow label="Loading event…" className="ml-6 py-3 text-xs" />;
  }
  if (detailQ.error || !detailQ.data) {
    return <ErrorRow className="ml-6 py-3 text-xs">Failed to load this event. Press refresh to try again.</ErrorRow>;
  }

  const { event, deliveries } = detailQ.data;
  return (
    <div className="ml-6 mt-2 space-y-3 border-l border-line pl-4">
      <div>
        <p className="mb-1 text-xs font-medium text-muted">Deliveries</p>
        <DeliveryList deliveries={deliveries} />
      </div>
      <div>
        <p className="mb-1 text-xs font-medium text-muted">Payload</p>
        <pre className="max-h-72 overflow-auto rounded-md bg-neutral-50 p-3 font-mono text-xs text-ink dark:bg-neutral-900">
          {JSON.stringify(event.payload, null, 2)}
        </pre>
      </div>
    </div>
  );
}
