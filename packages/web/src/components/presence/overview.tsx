/**
 * The Presence overview (docs/specs/2026-10-16-presence-hub-design.md Part
 * B), the landing page of `/presence`, set as a roster. In order: the
 * **Needs attention** section, then the groups `Slack`, `GitHub`, `Linear`
 * with a place row per place, and the group `On a schedule` with a row per
 * routine. A workspace with no place row and no routine sees the onboarding
 * paragraphs in place of the groups. The header's action pair, **Activity**
 * and **Add**, is `OverviewActions`, which the section layout renders beside
 * the title on this page only.
 *
 * Past `COLLAPSE_THRESHOLD` places, a filter box shows and each group
 * collapses to its heading and count. A group with a fault stays open, and
 * so does every place group while the filter has text.
 */
import { useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import type { EventSubscriptionWire, PresencePlaceWire, WorkflowTriggerItem } from "@valet/api/wire";
import { useEventSubscriptions } from "~/api/events";
import { usePresencePlaces } from "~/api/presence";
import { useWorkflowTriggers } from "~/api/workflows";
import { AutomationWizard } from "~/components/events/automation-wizard";
import { Button, Input } from "~/components/primitives";
import { useListOwner } from "~/lib/use-list-owner";
import { AttentionBanner } from "./attention-banner";
import { Onboarding } from "./onboarding";
import { COLLAPSE_THRESHOLD, countText, overviewGroups, type OverviewGroup } from "./overview-groups";
import { PlaceRow, QUIET_ADD_CLASS } from "./place-row";
import { SERVICE_NAMES } from "./places";
import { RoutineRosterRow } from "./routine-row";
import { isRoutine, useRoutineDoes, type Routine } from "./routines-pane";
import { useFaults } from "./use-faults";

/** The reads refresh at this interval (spec Part B step 10). */
const REFRESH_MS = 60_000;

/** The groups whose places match the filter text, by name. An empty text keeps every place. */
export function filterGroups(groups: readonly OverviewGroup[], text: string): OverviewGroup[] {
  const needle = text.trim().toLowerCase();
  if (needle === "") return [...groups];
  return groups
    .map((group) => ({ ...group, blocks: group.blocks.filter((block) => block.label.toLowerCase().includes(needle)) }))
    .filter((group) => group.blocks.length > 0);
}

/** True when the workspace has no place row and no routine (spec Part B step 9). */
export function overviewEmpty(
  places: readonly PresencePlaceWire[],
  lines: readonly EventSubscriptionWire[],
  triggers: readonly WorkflowTriggerItem[],
): boolean {
  return overviewGroups(places, lines, new Set()).length === 0 && !triggers.some(isRoutine);
}

/** The overview's three reads, refreshed every minute. */
function useOverviewReads() {
  const owner = useListOwner();
  const enabled = owner !== undefined;
  const placesQ = usePresencePlaces({ refetchInterval: REFRESH_MS });
  const linesQ = useEventSubscriptions(owner, { enabled, refetchInterval: REFRESH_MS });
  const triggersQ = useWorkflowTriggers(undefined, owner, { enabled, refetchInterval: REFRESH_MS });
  const failed = placesQ.isError || linesQ.isError || triggersQ.isError;
  const data = placesQ.isSuccess && linesQ.isSuccess && triggersQ.isSuccess
    ? { places: placesQ.data.places, lines: linesQ.data.subscriptions, triggers: triggersQ.data.triggers }
    : undefined;
  return { failed, data };
}

/**
 * The header's action pair (spec Part B step 1): **Activity**, a secondary
 * button that links to `/presence/activity`, and **Add**, the primary
 * button, which opens the wizard on When. The empty state keeps only Add.
 */
export function OverviewActions() {
  const { data } = useOverviewReads();
  const [adding, setAdding] = useState(false);
  const empty = data !== undefined && overviewEmpty(data.places, data.lines, data.triggers);
  return (
    <div className="flex items-center gap-2">
      {!empty && (
        <Button asChild variant="secondary">
          <Link to="/presence/activity">Activity</Link>
        </Button>
      )}
      <Button onClick={() => setAdding(true)}>
        <Plus aria-hidden className="h-3.5 w-3.5" />
        Add
      </Button>
      {adding && <AutomationWizard open onOpenChange={setAdding} />}
    </div>
  );
}

export function Overview() {
  const { failed, data } = useOverviewReads();
  const { faults, faultedPlaces } = useFaults();
  return (
    <div className="min-w-0 space-y-9 pt-2">
      <AttentionBanner faults={faults} />
      {failed && (
        <p role="alert" className="text-sm text-danger-500">Could not load Presence. Reload the page to try again.</p>
      )}
      {!failed && data === undefined && <p className="text-sm text-muted">Loading…</p>}
      {!failed && data !== undefined && (
        <OverviewBody
          groups={overviewGroups(data.places, data.lines, faultedPlaces)}
          routines={data.triggers.filter(isRoutine)}
          faultedPlaces={faultedPlaces}
        />
      )}
    </div>
  );
}

function OverviewBody({ groups, routines, faultedPlaces }: {
  groups: OverviewGroup[];
  routines: Routine[];
  faultedPlaces: ReadonlySet<string>;
}) {
  const [filter, setFilter] = useState("");
  if (groups.length === 0 && routines.length === 0) return <Onboarding />;
  const placeCount = groups.reduce((sum, group) => sum + group.blocks.length, 0);
  const collapsing = placeCount > COLLAPSE_THRESHOLD;
  const shown = collapsing ? filterGroups(groups, filter) : groups;
  const filtering = collapsing && filter.trim() !== "";
  return (
    <div className="space-y-9">
      {collapsing && (
        <Input
          type="search"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder="Filter places"
          aria-label="Filter places"
        />
      )}
      {shown.map((group) => (
        <Group
          key={group.service}
          id={`presence-group-${group.service}`}
          name={SERVICE_NAMES[group.service]}
          count={countText(group.blocks.length, "place")}
          collapsing={collapsing}
          open={filtering || group.blocks.some((block) => faultedPlaces.has(block.subject))}
        >
          {group.blocks.map((block) => <PlaceRow key={block.subject} block={block} />)}
        </Group>
      ))}
      {routines.length > 0 && (
        <Group
          id="presence-group-schedule"
          name="On a schedule"
          count={countText(routines.length, "routine")}
          collapsing={collapsing}
          open={routines.some((routine) => (routine.detail.disabledReason ?? "") !== "")}
        >
          <ScheduleRows routines={routines} />
        </Group>
      )}
    </div>
  );
}

/** A group heading: a small muted label on a hairline rule, with the count at the right. */
function GroupHeading({ id, name, count }: { id: string; name: string; count: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-line pb-2 text-xs font-medium text-muted">
      <h2 id={id} className="text-xs font-medium text-muted">{name}</h2>
      <span className="tabular-nums">{count}</span>
    </div>
  );
}

/**
 * One group of the roster (spec Part B steps 3 and 8). Past the threshold
 * the group is a disclosure whose summary is its heading. `open` follows
 * the faults and the filter, and the reader's own toggle wins until `open`
 * changes.
 */
function Group({ id, name, count, collapsing, open, children }: {
  id: string;
  name: string;
  count: string;
  collapsing: boolean;
  open: boolean;
  children: ReactNode;
}) {
  if (!collapsing) {
    return (
      <section aria-labelledby={id}>
        <GroupHeading id={id} name={name} count={count} />
        <div>{children}</div>
      </section>
    );
  }
  return (
    <section aria-labelledby={id}>
      {/* The key remounts the element when `open` changes, so the new value applies. */}
      <details key={String(open)} open={open}>
        <summary className="cursor-pointer list-none [&::-webkit-details-marker]:hidden">
          <GroupHeading id={id} name={name} count={count} />
        </summary>
        <div>{children}</div>
      </details>
    </section>
  );
}

/** The `On a schedule` rows: one per routine, with `+ New routine` closing the last (spec Part B step 6). */
function ScheduleRows({ routines }: { routines: Routine[] }) {
  const [creating, setCreating] = useState(false);
  const does = useRoutineDoes(routines);
  const last = routines.at(-1)?.id;
  return (
    <>
      {routines.map((routine) => (
        <RoutineRosterRow key={routine.id} routine={routine} sentence={`${routine.name}: ${does(routine)}.`}>
          {routine.id === last && (
            <Button size="sm" variant="ghost" className={QUIET_ADD_CLASS} onClick={() => setCreating(true)}>
              + New routine
            </Button>
          )}
        </RoutineRosterRow>
      ))}
      {creating && <AutomationWizard open onOpenChange={setCreating} startOn="routine" />}
    </>
  );
}
