import { useState } from "react";
import { ChevronRight, RefreshCw } from "lucide-react";
import type { EventDeliveryWire, EventSummaryWire } from "@valet/api/wire";
import {
  Badge,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Spinner,
} from "~/components/primitives";
import { useEvent, useEventCatalog, useEvents } from "~/api/events";

function formatWhen(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

const DELIVERY_VARIANT: Record<EventDeliveryWire["status"], "neutral" | "success" | "danger"> = {
  pending: "neutral",
  delivered: "success",
  failed: "danger",
  dead: "danger",
};

/**
 * The org's event feed: every normalized event ingested from integration
 * webhooks, newest first, filterable by service and event key (both drawn
 * from the plugin trigger catalog). A row expands into the raw payload and
 * the delivery attempts made for it, so "my subscription never fired" is
 * answerable from this page alone.
 */
export function EventFeed() {
  const [service, setService] = useState<string | undefined>(undefined);
  const [key, setKey] = useState<string | undefined>(undefined);
  const catalogQ = useEventCatalog();
  const eventsQ = useEvents({ service, key });
  const [expanded, setExpanded] = useState<string | null>(null);

  const services = catalogQ.data?.services ?? [];
  const keysForService = service
    ? (services.find((s) => s.service === service)?.entries ?? []).map((e) => e.key)
    : [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="secondary" size="sm">
              {service ?? "All services"}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuItem
              onSelect={() => {
                setService(undefined);
                setKey(undefined);
              }}
            >
              All services
            </DropdownMenuItem>
            {services.map((s) => (
              <DropdownMenuItem
                key={s.service}
                onSelect={() => {
                  setService(s.service);
                  setKey(undefined);
                }}
              >
                {s.service}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        {service && keysForService.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button type="button" variant="secondary" size="sm" className="font-mono text-xs">
                {key ?? "All events"}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuItem onSelect={() => setKey(undefined)}>All events</DropdownMenuItem>
              {keysForService.map((k) => (
                <DropdownMenuItem key={k} className="font-mono text-xs" onSelect={() => setKey(k)}>
                  {k}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}

        <div className="flex-1" />
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label="Refresh events"
          disabled={eventsQ.isFetching}
          onClick={() => void eventsQ.refetch()}
        >
          <RefreshCw className={`h-3.5 w-3.5 ${eventsQ.isFetching ? "animate-spin" : ""}`} aria-hidden />
        </Button>
      </div>

      {eventsQ.isLoading && (
        <div className="flex items-center gap-2 py-4 text-sm text-muted">
          <Spinner size={14} /> Loading events…
        </div>
      )}
      {eventsQ.error && <p className="py-4 text-sm text-danger-500">Failed to load events.</p>}

      {eventsQ.data && eventsQ.data.events.length === 0 && (
        <p className="py-4 text-sm text-muted">
          No events yet. Events appear here when a connected integration sends a webhook — connect
          one on the Integrations page.
        </p>
      )}

      {eventsQ.data && eventsQ.data.events.length > 0 && (
        <div className="divide-y divide-line border-t border-line">
          {eventsQ.data.events.map((event) => (
            <EventRow
              key={event.id}
              event={event}
              open={expanded === event.id}
              onToggle={() => setExpanded((cur) => (cur === event.id ? null : event.id))}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function EventRow({
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
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-label={open ? `Collapse ${event.summary}` : `Expand ${event.summary}`}
        className="flex w-full min-w-0 items-center gap-2 text-left"
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

      {open && <EventDetail eventId={event.id} />}
    </div>
  );
}

function EventDetail({ eventId }: { eventId: string }) {
  const detailQ = useEvent(eventId);

  if (detailQ.isLoading) {
    return (
      <div className="ml-6 flex items-center gap-2 py-3 text-xs text-muted">
        <Spinner size={12} /> Loading event…
      </div>
    );
  }
  if (detailQ.error || !detailQ.data) {
    return <p className="ml-6 py-3 text-xs text-danger-500">Failed to load this event.</p>;
  }

  const { event, deliveries } = detailQ.data;
  return (
    <div className="ml-6 mt-2 space-y-3 border-l border-line pl-4">
      <div>
        <p className="mb-1 text-xs font-medium text-muted">Deliveries</p>
        {deliveries.length === 0 && (
          <p className="text-xs text-muted">
            No subscription matched this event. Create one in the Subscriptions tab to act on it.
          </p>
        )}
        {deliveries.map((d) => (
          <div key={d.id} className="flex items-center gap-2 py-1">
            <Badge variant={DELIVERY_VARIANT[d.status]}>{d.status}</Badge>
            <span className="text-xs text-muted">
              {d.attempts} attempt{d.attempts === 1 ? "" : "s"}
            </span>
            {d.deliveredAt !== null && (
              <span className="text-xs text-muted">delivered {formatWhen(d.deliveredAt)}</span>
            )}
            {d.lastError && (
              <span className="min-w-0 flex-1 truncate text-xs text-danger-500">{d.lastError}</span>
            )}
          </div>
        ))}
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
