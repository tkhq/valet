/** Workspace delivery history, with organization-wide diagnostics available on request. */
import { useState } from "react";
import { Link } from "@tanstack/react-router";
import type { EventLogItem, EventLogStatus } from "@valet/api/wire";
import { useEventLog } from "~/api/events";
import { useMe } from "~/api/settings";
import { Badge, Button, EmptyRow, ErrorRow, FilterChips, LoadingRow, WorkRow, WorkList } from "~/components/primitives";
import { SearchInput } from "~/components/search-input";
import { useListOwner } from "~/lib/use-list-owner";
import { relativeTime } from "~/lib/relative-time";
import { problemStage, reasonLabel } from "~/lib/event-log-labels";
import { ReceiptsPanel } from "./receipts-panel";

export type LogFilter = "all" | "problems" | "receipts";

const STATUS_META: Record<EventLogStatus, { label: string; badge: "success" | "warning" | "danger" | "neutral" | "accent" }> = {
  delivered: { label: "Delivered", badge: "success" },
  pending: { label: "In progress", badge: "accent" },
  failed: { label: "Failed", badge: "danger" },
  skipped: { label: "Skipped", badge: "neutral" },
  filtered: { label: "Filtered out", badge: "neutral" },
  no_match: { label: "No match", badge: "neutral" },
  rejected: { label: "Rejected", badge: "warning" },
};

const FILTERS: readonly { value: LogFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "problems", label: "Problems" },
];

export function EventLog({ filter, onFilterChange, query, onQueryChange }: {
  filter: LogFilter;
  onFilterChange: (next: LogFilter) => void;
  query: string;
  onQueryChange: (next: string) => void;
}) {
  const me = useMe();
  const admin = !me.error && me.data?.orgRole === "admin";
  const owner = useListOwner();
  const [showDiagnostics, setShowDiagnostics] = useState(filter === "receipts");
  const receipts = showDiagnostics && filter === "receipts" && admin;
  const log = useEventLog({ owner: receipts ? undefined : owner, problems: filter === "problems", diagnostics: showDiagnostics, ...(query ? { q: query } : {}) });
  const items = log.data?.pages.flatMap((page) => page.items) ?? [];
  const first = log.data?.pages[0];

  return (
    <div className="space-y-4">
      <label className="flex items-center gap-2 text-sm text-muted"><input type="checkbox" checked={showDiagnostics} onChange={event => { setShowDiagnostics(event.target.checked); if (!event.target.checked && filter === "receipts") onFilterChange("all"); }} />Show diagnostics</label>
      <FilterChips
        label="Show"
        value={receipts ? "receipts" : filter === "receipts" ? "all" : filter}
        onChange={onFilterChange}
        options={admin && showDiagnostics ? [...FILTERS, { value: "receipts", label: "Raw receipts" }] : FILTERS}
      />
      {receipts ? <ReceiptsPanel /> : <>
        <SearchInput
          value={query}
          onSettled={onQueryChange}
          placeholder="Search events and problems"
          aria-label="Search the log"
          maxLength={200}
        />
        {first && (
          <p className="text-xs text-muted">
            {showDiagnostics && first.lastEventAt ? `Last incoming activity ${relativeTime(first.lastEventAt)}. ` : ""}
            Subscription activity from the last {first.windowDays} days. Turning off a subscription stops new deliveries; existing history stays visible.
            {showDiagnostics && " Diagnostics also include incoming events and problems from the whole organization."}
          </p>
        )}
        {owner === undefined && me.isError && <ErrorRow>Could not load your workspace. Reload the page to try again.</ErrorRow>}
        {log.isPending && owner !== undefined && <LoadingRow label="Loading the log…" />}
        {log.error && <ErrorRow>{log.error.message || "Could not load the log. Reload the page to try again."}</ErrorRow>}
        {log.data && items.length === 0 && (
          <EmptyRow>{query || filter === "problems" ? "Nothing matches. Choose All or clear the search." : "No subscription activity yet. Enable a subscription to receive events, or turn on Show diagnostics to inspect incoming webhooks."}</EmptyRow>
        )}
        {items.length > 0 && (
          <WorkList>
            {groupLogItems(items).map(({ item, count }) => <LogRow key={`${item.kind}:${item.id}`} item={item} count={count} />)}
          </WorkList>
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

/** Consecutive problems with the same reason and detail read as one row with a count. */
export function groupLogItems(items: readonly EventLogItem[]): Array<{ item: EventLogItem; count: number }> {
  const groups: Array<{ item: EventLogItem; count: number }> = [];
  for (const item of items) {
    const last = groups.at(-1);
    if (last && item.kind === "problem" && last.item.kind === "problem"
      && last.item.reason === item.reason && last.item.detail === item.detail) last.count += 1;
    else groups.push({ item, count: 1 });
  }
  return groups;
}

/** The badge carries the status, so a row has no separate status mark. */
function LogRow({ item, count }: { item: EventLogItem; count: number }) {
  const meta = STATUS_META[item.status];
  const source = [item.service, item.eventKey && item.eventKey !== item.service ? item.eventKey : null].filter(Boolean).join(" · ");
  if (item.kind === "event") {
    return (
      <WorkRow
        title={<Link to="/events/$eventId" params={{ eventId: item.id }}>{item.summary || item.eventKey || "Event"}</Link>}
        badge={<Badge variant={meta.badge}>{meta.label}</Badge>}
        time={item.at}
        detail={[source, item.actor, item.detail ?? `${item.deliveryCount} ${item.deliveryCount === 1 ? "delivery" : "deliveries"}`].filter(Boolean).join(" · ")}
      />
    );
  }
  const reason = item.reason ?? "";
  const label = reasonLabel(reason);
  return (
    <WorkRow
      title={<span title={`${problemStage(reason)} · Reference: ${item.id}`}>{label}{count > 1 && <span className="ml-1.5 font-normal text-muted">×{count}</span>}</span>}
      badge={label === meta.label ? undefined : <Badge variant={meta.badge}>{meta.label}</Badge>}
      time={item.at}
      detail={[source, item.detail].filter(Boolean).join(" · ")}
    />
  );
}
