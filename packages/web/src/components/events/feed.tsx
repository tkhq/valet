import { useState } from "react";
import { RefreshCw } from "lucide-react";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  EmptyRow,
  ErrorRow,
  LoadingRow,
} from "~/components/primitives";
import { useEventCatalog, useEvents } from "~/api/events";
import { EventRow } from "./event-row";

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

      {eventsQ.isLoading && <LoadingRow label="Loading events…" />}
      {eventsQ.error != null && <ErrorRow>Failed to load events.</ErrorRow>}

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
    </div>
  );
}
