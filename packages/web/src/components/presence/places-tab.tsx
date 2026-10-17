/**
 * The Places tab (docs/specs/2026-10-16-presence-hub-design.md Part B): the
 * channels, repositories, and Linear teams where this workspace's Valet is
 * present, grouped by service. A view toggle shows **All listeners** instead,
 * one flat table of every listener.
 *
 * A row names its listener count and whether a thread is active there. A
 * listener that names no single place counts on its parent row, which reads
 * `Across acme/api` or `Everywhere in Slack`, so it is listed once.
 */
import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import type { PresencePlaceService, PresencePlaceWire } from "@valet/api/wire";
import { usePresencePlaces } from "~/api/presence";
import { Badge, Button, EmptyRow, ErrorRow, FilterChips, LoadingRow, WorkList, WorkRow } from "~/components/primitives";
import { AutomationWizard } from "~/components/events/automation-wizard";
import { ListenButton } from "~/components/events/team-slack-setup";
import { useWorkspaceScope } from "~/lib/workspace-scope";
import { errorText } from "~/lib/error-text";
import { AllListenersTable } from "./all-listeners-table";

export type PlacesView = "places" | "listeners";

const VIEWS = [
  { value: "places", label: "Places" },
  { value: "listeners", label: "All listeners" },
] as const;

export const SERVICE_NAMES: Readonly<Record<PresencePlaceService, string>> = {
  slack: "Slack",
  github: "GitHub",
  linear: "Linear",
};

const SERVICES: readonly PresencePlaceService[] = ["slack", "github", "linear"];

const EMPTY_GROUP: Readonly<Record<PresencePlaceService, string>> = {
  slack: "Valet is in no Slack channel in this workspace yet.",
  github: "Valet is in no GitHub repository in this workspace yet.",
  linear: "Valet is in no Linear team in this workspace yet.",
};

/** A service-wide row: the Slack workspace (`slack:<team>`), `github:*`, or `linear:*`. */
export function isServiceRoot(place: Pick<PresencePlaceWire, "subject" | "parent">): boolean {
  if (place.parent !== null) return false;
  return place.subject === "github:*" || place.subject === "linear:*" || /^slack:[^/]+$/.test(place.subject);
}

/** One row of a service group, with its depth under a parent row. */
export interface PlaceLine {
  place: PresencePlaceWire;
  depth: 0 | 1;
}

/**
 * The rows of one service, in API order, with each child under its parent.
 * A service-wide row shows only when something counts there; otherwise its
 * children are the group's top rows, because the group heading already
 * names the service.
 */
export function placeLines(places: readonly PresencePlaceWire[], service: PresencePlaceService): PlaceLine[] {
  const rows = places.filter((p) => p.service === service);
  const shown = (p: PresencePlaceWire) => !isServiceRoot(p) || p.listenerCount > 0 || p.activeThreadCount > 0;
  const hiddenRoots = new Set(rows.filter((p) => !shown(p)).map((p) => p.subject));
  const subjects = new Set(rows.map((p) => p.subject));
  const top = rows.filter((p) => shown(p) && (p.parent === null || hiddenRoots.has(p.parent) || !subjects.has(p.parent)));
  const lines: PlaceLine[] = [];
  for (const parent of top) {
    lines.push({ place: parent, depth: 0 });
    for (const child of rows) {
      if (child.parent === parent.subject && !top.includes(child)) lines.push({ place: child, depth: 1 });
    }
  }
  return lines;
}

function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** The second line of a place row: its reach, its listeners, and its active threads. */
export function placeDetail(place: PresencePlaceWire): string {
  const parts: string[] = [];
  if (place.scopeLabel !== undefined && place.listenerCount > 0) parts.push(place.scopeLabel);
  parts.push(place.listenerCount === 0 ? "No listeners" : count(place.listenerCount, "listener", "listeners"));
  parts.push(place.activeThreadCount === 0 ? "No active thread" : count(place.activeThreadCount, "active thread", "active threads"));
  return parts.join(" · ");
}

export function PlacesTab({ view, onViewChange }: { view: PlacesView; onViewChange: (view: PlacesView) => void }) {
  const [adding, setAdding] = useState(false);
  const teamId = useWorkspaceScope().teamId;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <FilterChips options={VIEWS} value={view} onChange={onViewChange} label="Places view" />
        <div className="flex shrink-0 items-center gap-2">
          {teamId !== undefined && <ListenButton teamId={teamId} size="sm">Listen in channels</ListenButton>}
          <Button size="sm" variant="secondary" onClick={() => setAdding(true)}>
            <Plus aria-hidden className="h-3.5 w-3.5" />
            New listener
          </Button>
        </div>
      </div>
      {adding && <AutomationWizard open onOpenChange={setAdding} />}
      {view === "places" ? <PlacesByService /> : <AllListenersTable />}
    </div>
  );
}

function PlacesByService() {
  const places = usePresencePlaces();
  if (places.isPending) return <LoadingRow />;
  if (places.isError) {
    return <ErrorRow>{errorText(places.error, "Could not load the channels, repositories, and teams. Reload the page to try again.")}</ErrorRow>;
  }
  const all = places.data.places;
  return (
    <div className="space-y-6">
      {SERVICES.map((service) => {
        const lines = placeLines(all, service);
        return (
          <section key={service} aria-label={SERVICE_NAMES[service]}>
            <h2 className="mb-3 font-display text-lg">{SERVICE_NAMES[service]}</h2>
            {lines.length === 0
              ? <EmptyRow className="py-1">{EMPTY_GROUP[service]}</EmptyRow>
              : (
                <WorkList>
                  <PlaceTree lines={lines} />
                </WorkList>
              )}
          </section>
        );
      })}
    </div>
  );
}

/** The rows as a nested list: each child row is an item of a list inside
 * its parent's item, so a screen reader announces the nesting. */
function PlaceTree({ lines }: { lines: readonly PlaceLine[] }) {
  const groups: Array<{ parent: PresencePlaceWire; children: PresencePlaceWire[] }> = [];
  for (const line of lines) {
    if (line.depth === 0) groups.push({ parent: line.place, children: [] });
    else groups.at(-1)?.children.push(line.place);
  }
  return (
    <ul className="divide-y divide-line">
      {groups.map(({ parent, children }) => (
        <li key={parent.subject}>
          <PlaceRow place={parent} />
          {children.length > 0 && (
            <ul aria-label={`Inside ${parent.label}`} className="divide-y divide-line border-t border-line pl-6">
              {children.map((child) => <li key={child.subject}><PlaceRow place={child} /></li>)}
            </ul>
          )}
        </li>
      ))}
    </ul>
  );
}

function PlaceRow({ place }: { place: PresencePlaceWire }) {
  return (
    <WorkRow
      title={<Link to="/presence/places/$subject" params={{ subject: place.subject }}>{place.label}</Link>}
      badge={place.activeThreadCount > 0 ? <Badge variant="accent">Active</Badge> : undefined}
      {...(place.lastActivityAt !== null ? { time: place.lastActivityAt } : {})}
      detail={placeDetail(place)}
    />
  );
}
