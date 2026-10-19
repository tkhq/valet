/** Workspace delivery history, with organization-wide diagnostics available
 * on request. The Activity pane renders it; each stored event reads as an
 * activity sentence (`~/components/presence/activity-row`). The chips are
 * `All`, `Problems`, and one per service (spec 2026-10-16 presence hub,
 * Part F step 2); receipts sit under a disclosure for admins. */
import { useState, type ReactNode } from "react";
import type { EventLogItem } from "@valet/api/wire";
import { useEventLog } from "~/api/events";
import { useMe } from "~/api/settings";
import { Badge, Button, EmptyRow, ErrorRow, FilterChips, LoadingRow, WorkRow, WorkList } from "~/components/primitives";
import { SearchInput } from "~/components/search-input";
import { useListOwner } from "~/lib/use-list-owner";
import { relativeTime } from "~/lib/relative-time";
import { problemStage, reasonLabel } from "~/lib/event-log-labels";
import { ActivityRow, LOG_STATUS_META, useWorkflowsByListener } from "~/components/presence/activity-row";
import { ServiceMark } from "~/components/presence/service-mark";
import { ReceiptsPanel } from "./receipts-panel";

/** A service the Activity chips filter by. */
export type LogService = "slack" | "github" | "linear";

/** One chip: the whole Log, its problems, or one service's rows. */
export type LogFilter = "all" | "problems" | LogService;

/** A service chip: the service's small mark, then its name. */
function serviceChip(service: LogService, name: string): ReactNode {
  return <><ServiceMark service={service} size="sm" />{name}</>;
}

const FILTERS: readonly { value: LogFilter; label: ReactNode }[] = [
  { value: "all", label: "All" },
  { value: "problems", label: "Problems" },
  { value: "slack", label: serviceChip("slack", "Slack") },
  { value: "github", label: serviceChip("github", "GitHub") },
  { value: "linear", label: serviceChip("linear", "Linear") },
];

/** The rows a service chip keeps: those whose event key starts with `<service>.`.
 * The server has no service filter, so the Log filters the loaded pages. */
export function itemsForFilter(items: readonly EventLogItem[], filter: LogFilter): EventLogItem[] {
  if (filter === "all" || filter === "problems") return [...items];
  return items.filter((item) => item.eventKey?.startsWith(`${filter}.`) ?? false);
}

export function EventLog({ filter, onFilterChange, query, onQueryChange, place, placeName }: {
  filter: LogFilter;
  onFilterChange: (next: LogFilter) => void;
  /** The search text; the server matches it against the stored events. */
  query: string;
  onQueryChange: (next: string) => void;
  /** A place key: the server keeps the events in that place or inside it. */
  place?: string;
  /** The place's name for the empty state, such as `acme/api`. */
  placeName?: string;
}) {
  const me = useMe();
  const admin = !me.error && me.data?.orgRole === "admin";
  const owner = useListOwner();
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [receiptsOpen, setReceiptsOpen] = useState(false);
  const log = useEventLog({
    owner, problems: filter === "problems", diagnostics: showDiagnostics, ...(query ? { q: query } : {}), ...(place ? { place } : {}),
  });
  const items = itemsForFilter(log.data?.pages.flatMap((page) => page.items) ?? [], filter);
  const first = log.data?.pages[0];
  const workflowsByListener = useWorkflowsByListener();

  return (
    <div className="space-y-4">
      <label className="flex items-center gap-2 text-sm text-muted"><input type="checkbox" checked={showDiagnostics} onChange={event => setShowDiagnostics(event.target.checked)} />Show diagnostics</label>
      <FilterChips label="Show" value={filter} onChange={onFilterChange} options={FILTERS} />
      <SearchInput
        value={query}
        onSettled={onQueryChange}
        placeholder="Search activity"
        aria-label="Search"
        maxLength={200}
      />
      {admin && (
        <details onToggle={(event) => setReceiptsOpen(event.currentTarget.open)} className="text-sm">
          <summary className="cursor-pointer text-muted hover:text-ink">Diagnostics</summary>
          {/* The receipts list loads only when the reader opens it. */}
          {receiptsOpen && <div className="mt-3"><ReceiptsPanel /></div>}
        </details>
      )}
      {first && (
        <p className="text-xs text-muted">
          {showDiagnostics && first.lastEventAt ? `Last incoming activity ${relativeTime(first.lastEventAt)}. ` : ""}
          Activity from the last {first.windowDays} days. If you turn something off in Presence, its new deliveries stop. Existing history stays visible.
          {showDiagnostics && " Diagnostics also include incoming events and problems from the whole organization."}
        </p>
      )}
      {owner === undefined && me.isError && <ErrorRow>Could not load your workspace. Reload the page to try again.</ErrorRow>}
      {log.isPending && owner !== undefined && <LoadingRow label="Loading the log…" />}
      {log.error && <ErrorRow>{log.error.message || "Could not load the log. Reload the page to try again."}</ErrorRow>}
      {log.data && items.length === 0 && (
        <EmptyRow>{emptyText({ filter, query, place, placeName, windowDays: first?.windowDays ?? 30 })}</EmptyRow>
      )}
      {items.length > 0 && (
        <WorkList>
          {groupLogItems(items).map(({ item, count }) => item.kind === "event"
            ? <ActivityRow key={`event:${item.id}`} item={item} workflowsByListener={workflowsByListener} />
            : <ProblemRow key={`problem:${item.id}`} item={item} count={count} />)}
        </WorkList>
      )}
      {log.hasNextPage && (
        <Button variant="secondary" size="sm" disabled={log.isFetchingNextPage} onClick={() => void log.fetchNextPage()}>
          {log.isFetchingNextPage ? "Loading…" : "Load more"}
        </Button>
      )}
    </div>
  );
}

/**
 * What the Log says when no row shows. A place alone says nothing happened
 * there; any other filter names how to widen it; no filter says no
 * activity yet.
 */
export function emptyText({ filter, query, place, placeName, windowDays }: {
  filter: LogFilter;
  query: string;
  place: string | undefined;
  placeName: string | undefined;
  windowDays: number;
}): string {
  const otherFilter = query.trim() !== "" || filter !== "all";
  if (place !== undefined && !otherFilter) {
    return `Nothing happened in ${placeName ?? "this place"} in the last ${windowDays} days.`;
  }
  if (place !== undefined) return "Nothing matches. Choose All or remove the place.";
  if (query.trim() !== "") return "Nothing matches. Choose All or clear Search.";
  if (filter !== "all") return "Nothing matches. Choose All.";
  return "No activity yet. To receive events, select Listen for… on a place in Presence. To inspect incoming webhooks, turn on Show diagnostics.";
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

/** A recorded problem. The badge carries the status, so a row has no separate status mark. */
function ProblemRow({ item, count }: { item: EventLogItem; count: number }) {
  const meta = LOG_STATUS_META[item.status];
  const source = [item.service, item.eventKey && item.eventKey !== item.service ? item.eventKey : null].filter(Boolean).join(" · ");
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
