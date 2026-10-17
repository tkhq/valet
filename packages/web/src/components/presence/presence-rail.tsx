/**
 * The Presence rail (docs/specs/2026-10-16-presence-hub-design.md Part B).
 * In order: **New routine**, **Activity** with the problem count,
 * **Routines** with the routine count, then one group per service. A group
 * header is the service-wide place, and its rows are the places at the mid
 * grain: Slack channels, GitHub repositories, and Linear teams. A pull
 * request or an issue never shows here; its repository's or team's page
 * lists it as a thread.
 *
 * Past `RAIL_FILTER_THRESHOLD` places, a filter box shows and each group
 * collapses, with the selected place's group open. On a narrow viewport the
 * rail is a dropdown, as the Settings rail is.
 */
import { useState } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import { ChevronDown, Plus } from "lucide-react";
import type { PresencePlaceService, PresencePlaceWire } from "@valet/api/wire";
import { usePresencePlaces } from "~/api/presence";
import { useWorkflowTriggers } from "~/api/workflows";
import {
  Badge, Button, DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger, Input,
} from "~/components/primitives";
import { TriggerDialog } from "~/components/workflows/trigger-dialog";
import { useResponsiveOverlay } from "~/hooks/use-responsive-overlay";
import { cn } from "~/lib/cn";
import { errorText } from "~/lib/error-text";
import { useListOwner } from "~/lib/use-list-owner";
import { SERVICE_NAMES, isMidGrain, isServiceRoot } from "./places";
import { isRoutine } from "./routines-tab";
import { useProblemCount } from "./use-problem-count";

export interface RailPlace {
  subject: string;
  label: string;
  service: PresencePlaceService;
  count: number;
  active: boolean;
  problem: boolean;
}

export interface RailGroup {
  service: PresencePlaceService;
  root: PresencePlaceWire | undefined;
  places: RailPlace[];
}

/** Past this many places, the filter box shows and the groups collapse. */
export const RAIL_FILTER_THRESHOLD = 8;

const SERVICES: readonly PresencePlaceService[] = ["slack", "github", "linear"];

/** The header of a group with no service-wide row in the places list. */
const ROOT_LABELS: Readonly<Record<PresencePlaceService, string>> = {
  slack: "Everywhere in Slack",
  github: "Across GitHub",
  linear: "Across Linear",
};

/** The rail's groups, in service order. A group keeps its mid-grain rows and
 * its service-wide row as `root`. A group with no mid-grain row and no line
 * at its service-wide row does not show. */
export function railGroups(places: readonly PresencePlaceWire[], problems: ReadonlySet<string>): RailGroup[] {
  const groups: RailGroup[] = [];
  for (const service of SERVICES) {
    const rows = places.filter((place) => place.service === service);
    const root = rows.find(isServiceRoot);
    const mids = rows.filter(isMidGrain).map((place): RailPlace => ({
      subject: place.subject,
      label: place.label,
      service,
      count: place.listenerCount,
      active: place.activeThreadCount > 0,
      problem: problems.has(place.subject),
    }));
    if (mids.length === 0 && (root === undefined || root.listenerCount === 0)) continue;
    groups.push({ service, root, places: mids });
  }
  return groups;
}

/** The header text of a group: the service-wide row's reach, or the service's default. */
export function groupLabel(group: Pick<RailGroup, "service" | "root">): string {
  return group.root?.scopeLabel ?? ROOT_LABELS[group.service];
}

/** The place key a pathname selects, or undefined. */
function selectedSubject(pathname: string): string | undefined {
  const match = /^\/presence\/places\/([^/]+)\/?$/.exec(pathname);
  if (!match) return undefined;
  try {
    return decodeURIComponent(match[1]!);
  } catch {
    return match[1];
  }
}

function normalize(pathname: string): string {
  return pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
}

const rowClass = (active: boolean) => cn(
  "flex items-center gap-2 rounded-lg px-2.5 py-1.5 transition-colors",
  active ? "bg-ink-wash text-ink" : "text-muted hover:bg-ink-wash hover:text-ink",
);

export function PresenceRail() {
  const sectionMenu = useResponsiveOverlay("sm");
  const pathname = normalize(useRouterState({ select: (state) => state.location.pathname }));
  const owner = useListOwner();
  const placesQ = usePresencePlaces({ refetchInterval: 60_000 });
  const triggersQ = useWorkflowTriggers(undefined, owner, { enabled: owner !== undefined });
  const problems = useProblemCount();
  const [filter, setFilter] = useState("");
  const [creating, setCreating] = useState(false);

  const routineCount = triggersQ.isSuccess ? triggersQ.data.triggers.filter(isRoutine).length : undefined;
  const groups = railGroups(placesQ.data?.places ?? [], problems.problemPlaces);
  const placeCount = groups.reduce((sum, group) => sum + group.places.length, 0);
  const filtering = placeCount > RAIL_FILTER_THRESHOLD;
  const needle = filtering ? filter.trim().toLowerCase() : "";
  const shownGroups = groups
    .map((group) => ({ ...group, places: group.places.filter((place) => place.label.toLowerCase().includes(needle)) }))
    .filter((group) => needle === "" || group.places.length > 0);

  const selected = selectedSubject(pathname);
  const activityActive = pathname === "/presence" || pathname === "/presence/activity" || pathname.startsWith("/presence/events/");
  const routinesActive = pathname === "/presence/routines";
  const selectedGroup = groups.find((group) => group.root?.subject === selected || group.places.some((place) => place.subject === selected));
  const selectedPlace = selectedGroup?.places.find((place) => place.subject === selected);
  const currentLabel = selectedGroup !== undefined
    ? `${SERVICE_NAMES[selectedGroup.service]} / ${selectedPlace?.label ?? groupLabel(selectedGroup)}`
    : activityActive ? "Activity" : routinesActive ? "Routines" : "Presence";

  return (
    <nav aria-label="Presence" className="w-full shrink-0 space-y-3 text-sm sm:w-60">
      <Button size="sm" variant="secondary" className="w-full justify-start" onClick={() => setCreating(true)}>
        <Plus aria-hidden className="h-3.5 w-3.5" />
        New routine
      </Button>
      <div className="sm:hidden">
        <DropdownMenu open={sectionMenu.open} onOpenChange={sectionMenu.setOpen}>
          <DropdownMenuTrigger asChild>
            <Button variant="secondary" className="w-full justify-between" aria-label={`Presence section: ${currentLabel}`}>
              <span className="truncate">{currentLabel}</span>
              <ChevronDown className="h-4 w-4 shrink-0" aria-hidden />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent className="w-[var(--radix-dropdown-menu-trigger-width)]">
            <DropdownMenuItem asChild>
              <Link to="/presence" aria-current={activityActive ? "page" : undefined} className={activityActive ? "bg-ink-wash text-ink" : undefined}>
                Activity
                {problems.count > 0 && <Badge variant="danger" className="ml-auto">{problems.count}</Badge>}
              </Link>
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <Link to="/presence/routines" aria-current={routinesActive ? "page" : undefined} className={routinesActive ? "bg-ink-wash text-ink" : undefined}>
                Routines
              </Link>
            </DropdownMenuItem>
            {groups.map((group) => (
              <DropdownMenuGroup key={group.service} aria-label={SERVICE_NAMES[group.service]}>
                <DropdownMenuLabel>{SERVICE_NAMES[group.service]}</DropdownMenuLabel>
                {group.root !== undefined && (
                  <DropdownMenuItem asChild>
                    <Link to="/presence/places/$subject" params={{ subject: group.root.subject }} aria-current={selected === group.root.subject ? "page" : undefined}>
                      {groupLabel(group)}
                    </Link>
                  </DropdownMenuItem>
                )}
                {group.places.map((place) => (
                  <DropdownMenuItem key={place.subject} asChild>
                    <Link
                      to="/presence/places/$subject"
                      params={{ subject: place.subject }}
                      aria-current={selected === place.subject ? "page" : undefined}
                      className={selected === place.subject ? "bg-ink-wash text-ink" : undefined}
                    >
                      <span className="truncate">{place.label}</span>
                    </Link>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuGroup>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div className="hidden space-y-5 sm:block">
        <ul className="space-y-0.5">
          <li>
            <Link to="/presence" aria-current={activityActive ? "page" : undefined} className={rowClass(activityActive)}>
              <span className="min-w-0 flex-1 truncate">Activity</span>
              {problems.count > 0 && <Badge variant="danger">{problems.count}</Badge>}
            </Link>
          </li>
          <li>
            <Link to="/presence/routines" aria-current={routinesActive ? "page" : undefined} className={rowClass(routinesActive)}>
              <span className="min-w-0 flex-1 truncate">Routines</span>
              {routineCount !== undefined && <span className="text-xs tabular-nums text-muted">{routineCount}</span>}
            </Link>
          </li>
        </ul>
        {placesQ.isError && (
          <p role="alert" className="px-2.5 text-xs text-danger-500">
            {errorText(placesQ.error, "Could not load the places. Reload the page to try again.")}
          </p>
        )}
        {filtering && (
          <Input
            type="search"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Filter places"
            aria-label="Filter places"
          />
        )}
        {shownGroups.map((group) => {
          const body = <RailGroupBody group={group} selected={selected} />;
          if (!filtering) return <div key={group.service}>{body}</div>;
          const open = needle !== "" || selectedGroup?.service === group.service;
          return (
            <details key={group.service} open={open}>
              <summary className="cursor-pointer list-none px-2.5 text-xs text-muted">{SERVICE_NAMES[group.service]}</summary>
              {body}
            </details>
          );
        })}
      </div>
      {creating && <TriggerDialog open onOpenChange={setCreating} schedulesOnly />}
    </nav>
  );
}

function RailGroupBody({ group, selected }: { group: RailGroup; selected: string | undefined }) {
  const label = groupLabel(group);
  const rootActive = group.root !== undefined && group.root.subject === selected;
  return (
    <div role="group" aria-label={SERVICE_NAMES[group.service]}>
      {group.root !== undefined
        ? (
          <Link
            to="/presence/places/$subject"
            params={{ subject: group.root.subject }}
            aria-current={rootActive ? "page" : undefined}
            className={cn(rowClass(rootActive), "text-xs")}
          >
            <span className="min-w-0 flex-1 truncate">{label}</span>
            {group.root.listenerCount > 0 && <span aria-hidden className="tabular-nums">{group.root.listenerCount}</span>}
          </Link>
        )
        : <div className="px-2.5 py-1.5 text-xs text-muted">{label}</div>}
      <ul className="space-y-0.5">
        {group.places.map((place) => <RailRow key={place.subject} place={place} active={place.subject === selected} />)}
      </ul>
    </div>
  );
}

function RailRow({ place, active }: { place: RailPlace; active: boolean }) {
  return (
    <li>
      <Link
        to="/presence/places/$subject"
        params={{ subject: place.subject }}
        aria-current={active ? "page" : undefined}
        className={rowClass(active)}
      >
        <span className="min-w-0 flex-1 truncate">{place.label}</span>
        {place.active && <span role="img" aria-label="Active thread" className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />}
        {place.problem && <span role="img" aria-label="Has a problem" className="h-1.5 w-1.5 shrink-0 rounded-full bg-danger-500" />}
        <span aria-hidden className="text-xs tabular-nums text-muted">{place.count}</span>
      </Link>
    </li>
  );
}
