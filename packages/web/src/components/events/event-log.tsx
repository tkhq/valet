/**
 * The Events Log: stored events and recorded problems in one timeline,
 * newest first. Status chips narrow it to one outcome; a stored event opens
 * its own page (deliveries, payload, redeliver). Admins also get the raw
 * incoming receipts behind their own chip, in place of the list.
 */
import { Link } from "@tanstack/react-router";
import type { EventLogItem, EventLogStatus } from "@valet/api/wire";
import { useEventLog } from "~/api/events";
import { useMe } from "~/api/settings";
import { Badge, Button, EmptyRow, ErrorRow, FilterChips, LoadingRow, SelectMenu, StatusDot, WorkRow } from "~/components/primitives";
import { SearchInput } from "~/components/search-input";
import { useListOwner } from "~/lib/use-list-owner";
import { relativeTime } from "~/lib/relative-time";
import { problemStage, reasonLabel } from "~/lib/event-log-labels";
import { ReceiptsPanel } from "./receipts-panel";

export type LogScope = "workspace" | "all";
export type LogFilter = "all" | Exclude<EventLogStatus, "pending"> | "receipts";

const STATUS_META: Record<EventLogStatus, { label: string; badge: "success" | "warning" | "danger" | "neutral" | "accent"; tone: "success" | "warning" | "danger" | "neutral" | "info" }> = {
  delivered: { label: "Delivered", badge: "success", tone: "success" },
  pending: { label: "In progress", badge: "accent", tone: "info" },
  failed: { label: "Failed", badge: "danger", tone: "danger" },
  filtered: { label: "Filtered out", badge: "neutral", tone: "neutral" },
  no_match: { label: "No match", badge: "neutral", tone: "neutral" },
  rejected: { label: "Rejected", badge: "warning", tone: "warning" },
};

const FILTERS: readonly { value: LogFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "delivered", label: "Delivered" },
  { value: "failed", label: "Failed" },
  { value: "filtered", label: "Filtered out" },
  { value: "no_match", label: "No match" },
  { value: "rejected", label: "Rejected" },
];

const SCOPE_OPTIONS = [
  { value: "workspace", label: "This workspace" },
  { value: "all", label: "All" },
] as const;

export function EventLog({ scope, onScopeChange, filter, onFilterChange, query, onQueryChange }: {
  scope: LogScope;
  onScopeChange: (next: LogScope) => void;
  filter: LogFilter;
  onFilterChange: (next: LogFilter) => void;
  query: string;
  onQueryChange: (next: string) => void;
}) {
  const me = useMe();
  const admin = !me.error && me.data?.orgRole === "admin";
  const owner = useListOwner();
  const receipts = filter === "receipts" && admin;
  const status = filter === "all" || filter === "receipts" ? undefined : filter;
  // An owner-less request is the org-wide Log, so "This workspace" waits for the owner.
  const canFetch = !receipts && (scope === "all" || owner !== undefined);
  const log = useEventLog(
    { ...(scope === "workspace" && owner ? { owner } : {}), ...(status ? { status } : {}), ...(query ? { q: query } : {}) },
    { enabled: canFetch },
  );
  const items = log.data?.pages.flatMap((page) => page.items) ?? [];
  const first = log.data?.pages[0];

  return (
    <div className="space-y-4">
      <FilterChips
        label="Show"
        value={receipts ? "receipts" : filter === "receipts" ? "all" : filter}
        onChange={onFilterChange}
        options={admin ? [...FILTERS, { value: "receipts", label: "Raw receipts" }] : FILTERS}
      />
      {receipts ? <ReceiptsPanel /> : <>
        <div className="flex flex-wrap items-center gap-2">
          <SearchInput
            value={query}
            onSettled={onQueryChange}
            placeholder="Search events and problems"
            aria-label="Search the log"
            maxLength={200}
            className="min-w-0 flex-1"
          />
          <SelectMenu value={scope} onChange={onScopeChange} options={SCOPE_OPTIONS}
            triggerLabel={`Scope: ${scope === "all" ? "All" : "This workspace"}`} />
        </div>
        {first && (
          <p className="text-xs text-muted">
            {first.lastEventAt ? `Last activity ${relativeTime(first.lastEventAt)}.` : "Nothing has arrived yet."}
            {first.windowDays !== null && ` Events from the last ${first.windowDays} days that reached this workspace. Problems are listed for the whole organization.`}
          </p>
        )}
        {!canFetch && me.isError && <ErrorRow>Could not load your workspace. Choose Scope: All to see every event.</ErrorRow>}
        {log.isPending && canFetch && <LoadingRow label="Loading the log…" />}
        {log.error && <ErrorRow>{log.error.message || "Could not load the log. Reload the page to try again."}</ErrorRow>}
        {log.data && items.length === 0 && (
          <EmptyRow>{query || status ? "Nothing matches these filters. Choose All or clear the search." : "Nothing has arrived yet. Events and problems appear here as integrations report them."}</EmptyRow>
        )}
        {items.length > 0 && (
          <div className="divide-y divide-line rounded-lg border border-line bg-paper">
            {items.map((item) => <LogRow key={`${item.kind}:${item.id}`} item={item} />)}
          </div>
        )}
        {log.hasNextPage && (
          <Button variant="secondary" size="sm" disabled={log.isFetchingNextPage} onClick={() => void log.fetchNextPage()}>
            {log.isFetchingNextPage ? "Loading…" : "Load more"}
          </Button>
        )}
      </>}
    </div>
  );
}

function LogRow({ item }: { item: EventLogItem }) {
  const meta = STATUS_META[item.status];
  const source = [item.service, item.eventKey && item.eventKey !== item.service ? item.eventKey : null].filter(Boolean).join(" · ");
  if (item.kind === "event") {
    return (
      <WorkRow
        leading={<StatusDot tone={meta.tone} label={meta.label} />}
        title={<Link to="/events/$eventId" params={{ eventId: item.id }}>{item.summary || item.eventKey || "Event"}</Link>}
        badge={<Badge variant={meta.badge}>{meta.label}</Badge>}
        time={item.at}
        detail={<span className="text-xs">
          {source && <span className="font-mono">{source}</span>}
          {item.actor && ` · ${item.actor}`}
          {` · ${item.deliveryCount} ${item.deliveryCount === 1 ? "delivery" : "deliveries"}`}
        </span>}
      />
    );
  }
  const reason = item.reason ?? "";
  return (
    <WorkRow
      leading={<StatusDot tone={meta.tone} label={meta.label} />}
      title={reasonLabel(reason)}
      badge={reasonLabel(reason) === meta.label ? undefined : <Badge variant={meta.badge}>{meta.label}</Badge>}
      time={item.at}
      detail={<>
        {item.detail && <span className="block">{item.detail}</span>}
        <span className="mt-1 block text-xs">
          {problemStage(reason)}{source && <> · <span className="font-mono">{source}</span></>} · Reference: {item.id}
        </span>
      </>}
    />
  );
}
