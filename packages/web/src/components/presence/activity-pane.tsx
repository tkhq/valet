/**
 * The Activity pane (docs/specs/2026-10-16-presence-hub-design.md Part F):
 * the Log of `/events`, with each stored event read as one sentence. The
 * chips write `status` (`problems`) or `service`, and the Place box writes
 * `q`, the name the old Log used, so a redirected `/events` link opens the
 * same view. The page is a drill-in under the breadcrumb `Presence ›
 * Activity` (Part F step 2). The overview owns the onboarding paragraphs; with
 * no place and no routine, Activity keeps the log and offers its own Add.
 */
import { useState } from "react";
import { Plus } from "lucide-react";
import { AutomationWizard } from "~/components/events/automation-wizard";
import { EventLog, type LogFilter, type LogService } from "~/components/events/event-log";
import { Button } from "~/components/primitives";
import { textParam } from "~/lib/search-params";
import { useNotPresentAnywhere } from "./onboarding";
import { PRESENCE_CRUMB, PresenceDetailPage } from "./page-shell";

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
  const [adding, setAdding] = useState(false);
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
    <PresenceDetailPage crumbs={[PRESENCE_CRUMB, { label: "Activity" }]} title="Activity">
      {/* This page has no header Add, so a workspace that is not present anywhere gets one here. */}
      {notPresent && (
        <Button className="mb-4" onClick={() => setAdding(true)}>
          <Plus aria-hidden className="h-3.5 w-3.5" />
          Add
        </Button>
      )}
      <EventLog
        filter={activityFilter(search)}
        onFilterChange={onFilterChange}
        query={search.q ?? ""}
        onQueryChange={onQueryChange}
      />
      {adding && <AutomationWizard open onOpenChange={setAdding} />}
    </PresenceDetailPage>
  );
}
