/**
 * The Activity pane (docs/specs/2026-10-16-presence-hub-design.md Part F):
 * the Log of `/events`, with each stored event read as one sentence. The
 * chips write `status` (`problems`) or `service`, and the Search box writes
 * `q`, the name the old Log used, so a redirected `/events` link opens the
 * same view. A place page's `View all` writes `place`, its key; the server
 * keeps the events in that place or inside it, and the pane shows a
 * removable `In <place>` chip. The page is a drill-in under the breadcrumb `Presence ›
 * Activity` (Part F step 2). The overview owns the onboarding paragraphs; with
 * no place and no routine, Activity keeps the log and offers its own Add.
 */
import { useState } from "react";
import { Plus, X } from "lucide-react";
import type { PresencePlaceWire } from "@valet/api/wire";
import { usePresencePlaces } from "~/api/presence";
import { AutomationWizard } from "~/components/events/automation-wizard";
import { EventLog, type LogFilter, type LogService } from "~/components/events/event-log";
import { Button } from "~/components/primitives";
import { textParam } from "~/lib/search-params";
import { useNotPresentAnywhere } from "./onboarding";
import { PRESENCE_CRUMB, PresenceDetailPage } from "./page-shell";
import { isServiceRoot } from "./places";

export interface ActivitySearch {
  status?: "problems";
  service?: LogService;
  /** A place key (`slack:T1/C900`): only the events in that place or inside it. */
  place?: string;
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
  const place = textParam(raw, "place");
  const q = textParam(raw, "q");
  return {
    ...(status === "problems" ? { status } : {}),
    ...(status !== "problems" && isService(service) ? { service } : {}),
    ...(place ? { place } : {}),
    ...(q ? { q } : {}),
  };
}

/**
 * The words of the place chip: `In <label>` for a place, or the service-wide
 * place's own name (`Across GitHub`). A key the places list does not hold
 * reads by its last part (`github:acme/api` reads `In api`).
 */
export function placeChipText(key: string, places: readonly PresencePlaceWire[]): string {
  const place = places.find((candidate) => candidate.subject === key);
  if (place !== undefined) return isServiceRoot(place) ? place.label : `In ${place.label}`;
  const last = key.split(/[:/]/).filter((part) => part !== "").at(-1) ?? key;
  return `In ${last}`;
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
  const keepPlace = search.place !== undefined ? { place: search.place } : {};
  const keepChip = {
    ...(search.status ? { status: search.status } : {}),
    ...(search.service ? { service: search.service } : {}),
  };
  const onFilterChange = (filter: LogFilter) => onSearchChange({
    ...(filter === "problems" ? { status: "problems" as const } : {}),
    ...(isService(filter) ? { service: filter } : {}),
    ...keepPlace,
    ...keepQ(search.q),
  });
  const onQueryChange = (q: string) => onSearchChange({ ...keepChip, ...keepPlace, ...keepQ(q) });
  const onClearPlace = () => onSearchChange({ ...keepChip, ...keepQ(search.q) });
  return (
    <PresenceDetailPage crumbs={[PRESENCE_CRUMB, { label: "Activity" }]} title="Activity">
      {/* This page has no header Add, so a workspace that is not present anywhere gets one here. */}
      {notPresent && (
        <Button className="mb-4" onClick={() => setAdding(true)}>
          <Plus aria-hidden className="h-3.5 w-3.5" />
          Add
        </Button>
      )}
      {search.place !== undefined && <PlaceChip placeKey={search.place} onClear={onClearPlace} />}
      <EventLog
        filter={activityFilter(search)}
        onFilterChange={onFilterChange}
        query={search.q ?? ""}
        onQueryChange={onQueryChange}
        {...(search.place !== undefined ? { place: search.place } : {})}
      />
      {adding && <AutomationWizard open onOpenChange={setAdding} />}
    </PresenceDetailPage>
  );
}

/** The place filter as a chip with a Remove button. */
function PlaceChip({ placeKey, onClear }: { placeKey: string; onClear: () => void }) {
  const places = usePresencePlaces();
  const label = placeChipText(placeKey, places.data?.places ?? []);
  return (
    <p className="mb-4 inline-flex items-center gap-1 rounded-full border border-ink bg-ink py-0.5 pl-3 pr-1 text-xs text-paper">
      <span>{label}</span>
      <button
        type="button"
        onClick={onClear}
        aria-label={`Remove the place filter ${label}`}
        className="inline-grid h-5 w-5 place-items-center rounded-full hover:bg-paper/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-moss"
      >
        <X aria-hidden className="h-3 w-3" />
      </button>
    </p>
  );
}
