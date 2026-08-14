import { useState } from "react";
import { RefreshCw } from "lucide-react";
import {
  Button,
  EmptyRow,
  ErrorRow,
  LoadingRow,
  SelectMenu,
} from "~/components/primitives";
import { useEventCatalog, useEvents } from "~/api/events";
import { EventRow } from "./event-row";

/** Sentinel for "no filter applied". */
const ALL = "";

/** The feed API's own page size; the UI has no pagination yet, so a feed
 * at exactly this count may be hiding older events. */
const FEED_PAGE_SIZE = 50;

/**
 * The org's event feed: every normalized event ingested from integration
 * webhooks, newest first, filterable by service and event key (both drawn
 * from the plugin trigger catalog). A row expands into the raw payload and
 * the delivery attempts made for it, so "my subscription never fired" is
 * answerable from this page alone.
 */
export function EventFeed() {
  const [service, setService] = useState(ALL);
  const [key, setKey] = useState(ALL);
  const catalogQ = useEventCatalog();
  const eventsQ = useEvents({ service: service || undefined, key: key || undefined });
  const [expanded, setExpanded] = useState<string | null>(null);

  const services = catalogQ.data?.services ?? [];
  const keysForService = service
    ? (services.find((s) => s.service === service)?.entries ?? []).map((e) => e.key)
    : [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <SelectMenu
          value={service}
          onChange={(next) => {
            setService(next);
            setKey(ALL);
          }}
          options={[
            { value: ALL, label: "All services" },
            ...services.map((s) => ({ value: s.service, label: s.service })),
          ]}
        />

        {service && keysForService.length > 0 && (
          <SelectMenu
            value={key}
            onChange={setKey}
            triggerClassName="font-mono text-xs"
            options={[
              { value: ALL, label: "All events" },
              ...keysForService.map((k) => ({ value: k, label: <span className="font-mono text-xs">{k}</span> })),
            ]}
          />
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

      {eventsQ.isLoading && <LoadingRow label="Loading events…" />}
      {eventsQ.error != null && (
        <ErrorRow>Failed to load events. Press refresh to try again.</ErrorRow>
      )}

      {eventsQ.data && eventsQ.data.events.length === 0 && (
        <EmptyRow>
          No events yet. Events appear here when a connected integration sends a webhook — connect
          one on the Integrations page.
        </EmptyRow>
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

      {eventsQ.data && eventsQ.data.events.length >= FEED_PAGE_SIZE && (
        <p className="pt-1 text-xs text-muted">
          Showing the most recent {FEED_PAGE_SIZE} events. Narrow with a service or event filter to
          see more of this type.
        </p>
      )}
    </div>
  );
}
