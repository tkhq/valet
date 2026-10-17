/**
 * The Activity pane (docs/specs/2026-10-16-presence-hub-design.md Part F):
 * the Log of `/events`, with each stored event read as one sentence. The
 * chips write `status` (`problems`) or `service`, and the Place box writes
 * `q`, the name the old Log used, so a redirected `/events` link opens the
 * same view. With no place and no routine, the pane shows the onboarding
 * cards instead (Part C step 8).
 */
import { EventLog, type LogFilter, type LogService } from "~/components/events/event-log";
import { textParam } from "~/lib/search-params";
import { Onboarding, useNotPresentAnywhere } from "./onboarding";

export interface ActivitySearch {
  status?: "problems";
  service?: LogService;
  q?: string;
}

const SERVICES: readonly LogService[] = ["slack", "github", "linear"];

function isService(value: string | undefined): value is LogService {
  return SERVICES.some((service) => service === value);
}

/** Only non-default values stay. An absent or hand-edited value reads as the
 * whole Log. The old `receipts` status also reads as the whole Log: receipts
 * now sit under their own disclosure. */
export function readActivitySearch(raw: unknown): ActivitySearch {
  const status = textParam(raw, "status");
  const service = textParam(raw, "service");
  const q = textParam(raw, "q");
  return {
    ...(status === "problems" ? { status } : {}),
    ...(status !== "problems" && isService(service) ? { service } : {}),
    ...(q ? { q } : {}),
  };
}

/** The chip a search selects. `Problems` and a service chip exclude each other. */
export function activityFilter(search: ActivitySearch): LogFilter {
  return search.status === "problems" ? "problems" : search.service ?? "all";
}

/** The Log with its filters controlled by the caller, which keeps them in the URL. */
export function ActivityPane({ search, onSearchChange }: {
  search: ActivitySearch;
  onSearchChange: (next: ActivitySearch) => void;
}) {
  const notPresent = useNotPresentAnywhere();
  if (notPresent) return <Onboarding />;
  // A blank box clears q. The draft keeps its spaces, so the box's own echo matches it.
  const keepQ = (q: string | undefined) => (q !== undefined && q.trim() !== "" ? { q } : {});
  const onFilterChange = (filter: LogFilter) => onSearchChange({
    ...(filter === "problems" ? { status: "problems" as const } : {}),
    ...(isService(filter) ? { service: filter } : {}),
    ...keepQ(search.q),
  });
  const onQueryChange = (q: string) => onSearchChange({
    ...(search.status ? { status: search.status } : {}),
    ...(search.service ? { service: search.service } : {}),
    ...keepQ(q),
  });
  return (
    <EventLog
      filter={activityFilter(search)}
      onFilterChange={onFilterChange}
      query={search.q ?? ""}
      onQueryChange={onQueryChange}
    />
  );
}
