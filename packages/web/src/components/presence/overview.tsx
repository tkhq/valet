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
 *
 * After a Create in the editor, the overview waits until
 * its lists hold the new id, then scrolls the new line's place row, or the
 * `On a schedule` group for a routine, into view and marks it for two
 * seconds (spec Part H step 9).
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import type { EventSubscriptionWire, PresencePlaceWire, WorkflowTriggerItem } from "@valet/api/wire";
import { useEventSubscriptions } from "~/api/events";
import { usePresencePlaces } from "~/api/presence";
import { useWorkflowTriggers } from "~/api/workflows";
import { Button, Input } from "~/components/primitives";
import { cn } from "~/lib/cn";
import { useListOwner } from "~/lib/use-list-owner";
import { AttentionBanner } from "./attention-banner";
import { announceCreated, clearCreated, useCreatedTarget, type CreatedTarget } from "./created-highlight";
import { LineEditor } from "./editor/line-editor";
import { Onboarding, overviewEmpty } from "./onboarding";
import { COLLAPSE_THRESHOLD, countText, overviewGroups, type OverviewGroup } from "./overview-groups";
import { CREATED_HIGHLIGHT_CLASS, PlaceRow, QUIET_ADD_CLASS } from "./place-row";
import { SERVICE_NAMES } from "./places";
import { RoutineRosterRow } from "./routine-row";
import { ServiceMark, type MarkService } from "./service-mark";
import { isRoutine, useRoutineRowParts, type Routine } from "./routine-helpers";
import { useFaults } from "./use-faults";

/** The reads refresh at this interval (spec Part B step 10). */
const REFRESH_MS = 60_000;

/** How long a new row stays marked (spec Part H step 9). */
export const HIGHLIGHT_MS = 2_000;

/** The `On a schedule` group's anchor. The routine page's `On a schedule` crumb links `/presence#schedule`. */
export const SCHEDULE_ANCHOR = "schedule";

/** What a Create marks: the place row that holds the new line, by subject,
 * or the schedule group for a routine. Undefined until the lists hold the id. */
export function highlightKey(
  created: CreatedTarget,
  groups: readonly OverviewGroup[],
  routines: readonly Routine[],
): string | undefined {
  if (created.kind === "routine") return routines.some((routine) => routine.id === created.id) ? SCHEDULE_ANCHOR : undefined;
  for (const group of groups) {
    const block = group.blocks.find((candidate) => candidate.lines.some((line) => line.id === created.id));
    if (block !== undefined) return block.subject;
  }
  return undefined;
}

/** The groups whose places match the filter text, by name. An empty text keeps every place. */
export function filterGroups(groups: readonly OverviewGroup[], text: string): OverviewGroup[] {
  const needle = text.trim().toLowerCase();
  if (needle === "") return [...groups];
  return groups
    .map((group) => ({ ...group, blocks: group.blocks.filter((block) => block.label.toLowerCase().includes(needle)) }))
    .filter((group) => group.blocks.length > 0);
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
 * button, which opens the editor on When. The empty state keeps only Add.
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
      <LineEditor open={adding} onOpenChange={setAdding} mode={{ kind: "create" }} onSaved={announceCreated} />
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
        />
      )}
    </div>
  );
}

/**
 * Marks what a Create added. The mark waits until the lists hold the new
 * id, so it lands after the refetch. Each mark is a new object, so a second
 * Create in the same place restarts the two seconds.
 */
function useCreatedHighlight(groups: readonly OverviewGroup[], routines: readonly Routine[]) {
  const created = useCreatedTarget();
  const [highlight, setHighlight] = useState<{ key: string } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const target = created === null ? undefined : highlightKey(created, groups, routines);
  useEffect(() => {
    if (target === undefined) return;
    clearCreated();
    setHighlight({ key: target });
  }, [target]);
  useEffect(() => {
    if (highlight === null) return;
    // On the next frame, so a collapsed group the mark opened has opened.
    const frame = requestAnimationFrame(() => {
      rootRef.current?.querySelector('[data-highlight="true"]')?.scrollIntoView({ block: "center" });
    });
    const timer = setTimeout(() => setHighlight(null), HIGHLIGHT_MS);
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(timer);
    };
  }, [highlight]);
  return { highlighted: highlight?.key, rootRef };
}

function OverviewBody({ groups, routines }: {
  groups: OverviewGroup[];
  routines: Routine[];
}) {
  const [filter, setFilter] = useState("");
  const { highlighted, rootRef } = useCreatedHighlight(groups, routines);
  if (groups.length === 0 && routines.length === 0) return <Onboarding />;
  const placeCount = groups.reduce((sum, group) => sum + group.blocks.length, 0);
  const collapsing = placeCount > COLLAPSE_THRESHOLD;
  const shown = collapsing ? filterGroups(groups, filter) : groups;
  const filtering = collapsing && filter.trim() !== "";
  return (
    <div ref={rootRef} className="space-y-9">
      {collapsing && (
        <Input
          type="search"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder="Filter places"
          aria-label="Filter places"
        />
      )}
      {filtering && shown.length === 0 && <p className="text-sm text-muted">No place matches.</p>}
      {shown.map((group) => (
        <Group
          key={group.service}
          id={`presence-group-${group.service}`}
          mark={group.service}
          name={SERVICE_NAMES[group.service]}
          count={countText(group.blocks.length, "place")}
          collapsing={collapsing}
          open={filtering || group.blocks.some((block) => block.hasFault || block.subject === highlighted)}
        >
          {group.blocks.map((block) => <PlaceRow key={block.subject} block={block} highlighted={block.subject === highlighted} />)}
        </Group>
      ))}
      {routines.length > 0 && (
        <Group
          id={SCHEDULE_ANCHOR}
          mark="schedule"
          name="On a schedule"
          count={countText(routines.length, "routine")}
          collapsing={collapsing}
          open={highlighted === SCHEDULE_ANCHOR || routines.some((routine) => (routine.detail.disabledReason ?? "") !== "")}
          highlighted={highlighted === SCHEDULE_ANCHOR}
        >
          <ScheduleRows routines={routines} />
        </Group>
      )}
    </div>
  );
}

/** A group heading: the group's mark and a small muted label on a hairline rule, with the count at the right. */
function GroupHeading({ id, mark, name, count }: { id: string; mark: MarkService; name: string; count: string }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-line pb-2 text-xs font-medium text-muted">
      <h2 id={id} className="flex items-center gap-2 text-xs font-medium text-muted">
        <ServiceMark service={mark} size="md" />
        {name}
      </h2>
      <span className="tabular-nums">{count}</span>
    </div>
  );
}

/**
 * One group of the roster (spec Part B steps 3 and 8). Past the threshold
 * the group is a disclosure whose summary is its heading. `open` is true
 * while the group has a fault or the filter has text. The disclosure opens
 * when `open` turns true, until the reader toggles it. It never closes on
 * its own: a fix inside it, or a dialog it holds, must not vanish.
 */
function Group({ id, mark, name, count, collapsing, open, highlighted = false, children }: {
  id: string;
  /** The service mark before the name; the schedule group's is the clock. */
  mark: MarkService;
  name: string;
  count: string;
  collapsing: boolean;
  open: boolean;
  /** True for two seconds after a Create adds a routine to this group. */
  highlighted?: boolean;
  children: ReactNode;
}) {
  const [shown, setShown] = useState(open);
  const userTouched = useRef(false);
  useEffect(() => {
    if (open && !userTouched.current) setShown(true);
  }, [open]);
  const highlight = { "data-highlight": highlighted ? "true" : undefined, className: cn("transition-colors", highlighted && CREATED_HIGHLIGHT_CLASS) };
  if (!collapsing) {
    return (
      <section aria-labelledby={id} {...highlight}>
        <GroupHeading id={id} mark={mark} name={name} count={count} />
        <div>{children}</div>
      </section>
    );
  }
  return (
    <section aria-labelledby={id} {...highlight}>
      <details
        open={shown}
        onToggle={(event) => {
          // The browser also fires `toggle` when `shown` changes the element, so only a change is the reader's.
          const next = event.currentTarget.open;
          if (next === shown) return;
          userTouched.current = true;
          setShown(next);
        }}
      >
        <summary className="cursor-pointer list-none [&::-webkit-details-marker]:hidden">
          <GroupHeading id={id} mark={mark} name={name} count={count} />
        </summary>
        <div>{children}</div>
      </details>
    </section>
  );
}

/** The `On a schedule` rows: one per routine, with `+ New routine` closing the last (spec Part B step 6). */
function ScheduleRows({ routines }: { routines: Routine[] }) {
  const [creating, setCreating] = useState(false);
  const sentence = useRoutineRowParts(routines);
  const last = routines.at(-1)?.id;
  return (
    <>
      {routines.map((routine) => (
        <RoutineRosterRow key={routine.id} routine={routine} sentence={sentence(routine)}>
          {routine.id === last && (
            <Button size="sm" variant="ghost" className={QUIET_ADD_CLASS} onClick={() => setCreating(true)}>
              + New routine
            </Button>
          )}
        </RoutineRosterRow>
      ))}
      <LineEditor open={creating} onOpenChange={setCreating} mode={{ kind: "create", preselected: { schedule: true } }} onSaved={announceCreated} />
    </>
  );
}
