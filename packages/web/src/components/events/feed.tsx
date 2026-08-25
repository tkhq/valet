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
import { useListOwner } from "~/lib/use-list-owner";
import { EventRow } from "./event-row";

/** Sentinel for "no filter applied". */
const ALL = "";

/** The feed API's own page size; the UI has no pagination yet, so a feed
 * at exactly this count may be hiding older events. */
const FEED_PAGE_SIZE = 50;

/** Which events the feed asks for: those delivered to the active
 * workspace's subscriptions, or every event the org ingested. The route
 * owns the value, in `?scope=` — see `routes/events.index.tsx`. */
export type FeedScope = "workspace" | "all";

const SCOPE_OPTIONS = [
  { value: "workspace", label: "This workspace" },
  { value: "all", label: "All" },
] as const;

/**
 * The event feed: normalized events ingested from integration webhooks,
 * newest first, filterable by service and event key (both drawn from the
 * plugin trigger catalog). A row expands into the raw payload and the
 * delivery attempts made for it, so "my subscription never fired" is
 * answerable from this page alone.
 *
 * The scope control decides which events the question is asked about. It
 * starts at "This workspace", the events that reached the active
 * workspace's own subscriptions. "All" restores the org-wide feed, and it
 * must stay available: an event that matched nothing you own is precisely
 * the row you open when your subscription never fired.
 *
 * `scope` is a prop, not local state, because the Activity and
 * Subscriptions tabs unmount each other. The round trip that needs "All" —
 * find an unmatched event, open the Subscriptions tab to read the rule,
 * come back — is exactly the one that would discard it. The route holds it
 * in `?scope=`.
 */
export function EventFeed({
  scope,
  onScopeChange,
}: {
  scope: FeedScope;
  onScopeChange: (next: FeedScope) => void;
}) {
  const [service, setService] = useState(ALL);
  const [key, setKey] = useState(ALL);
  const owner = useListOwner();
  const catalogQ = useEventCatalog();
  const eventsQ = useEvents(
    { service: service || undefined, key: key || undefined },
    scope === "workspace" ? owner : undefined,
    // `useListOwner` answers undefined while the caller's identity loads,
    // and an owner-less request IS the org-wide feed. A control that says
    // "This workspace" must not show the org's events for that one frame,
    // so hold the query until the owner resolves.
    { enabled: scope === "all" || owner !== undefined },
  );
  const [expanded, setExpanded] = useState<string | null>(null);

  const services = catalogQ.data?.services ?? [];
  const keysForService = service
    ? (services.find((s) => s.service === service)?.entries ?? []).map((e) => e.key)
    : [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <SelectMenu
          value={scope}
          onChange={onScopeChange}
          // The trigger sits beside "All services" and "All events", so it
          // names the dimension it filters.
          triggerLabel={`Scope: ${scope === "all" ? "All" : "This workspace"}`}
          options={SCOPE_OPTIONS}
        />

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

      {/* `isPending`, not `isLoading`: the query is held (not fetching)
          while the owner resolves, and a held feed is still loading. */}
      {eventsQ.isPending && <LoadingRow label="Loading events…" />}
      {eventsQ.error != null && (
        <ErrorRow>Failed to load events. Press refresh to try again.</ErrorRow>
      )}

      {eventsQ.data && eventsQ.data.events.length === 0 && (
        <EmptyRow>
          {scope === "workspace"
            ? "No events reached this workspace's subscriptions yet. Select All to see every event the organization received."
            : "No events yet. Events appear here when a connected integration sends a webhook — connect one on the Integrations page."}
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
