/**
 * The Activity tab (docs/specs/2026-10-16-presence-hub-design.md Part E):
 * the Log of `/events`, with each stored event read as one sentence. The
 * filters live in the URL as `status` and `q`, the names the old Log used,
 * so a redirected `/events` link opens the same view.
 */
import { EventLog, type LogFilter } from "~/components/events/event-log";
import { textParam } from "~/lib/search-params";

export interface ActivitySearch {
  status?: Exclude<LogFilter, "all">;
  q?: string;
}

/** Only non-default values stay. An absent or hand-edited value reads as the whole Log. */
export function readActivitySearch(raw: unknown): ActivitySearch {
  const status = textParam(raw, "status");
  const q = textParam(raw, "q");
  return {
    ...(status === "problems" || status === "receipts" ? { status } : {}),
    ...(q ? { q } : {}),
  };
}

/** The Log with its filters controlled by the caller, which keeps them in the URL. */
export function ActivityTab({ search, onSearchChange }: {
  search: ActivitySearch;
  onSearchChange: (next: ActivitySearch) => void;
}) {
  const write = (next: { status?: LogFilter; q?: string }) => {
    const merged = { status: search.status, q: search.q, ...next };
    onSearchChange({
      ...(merged.status && merged.status !== "all" ? { status: merged.status } : {}),
      ...(merged.q ? { q: merged.q } : {}),
    });
  };
  return (
    <EventLog
      filter={search.status ?? "all"}
      onFilterChange={(status) => write({ status })}
      query={search.q ?? ""}
      onQueryChange={(q) => write({ q })}
    />
  );
}
