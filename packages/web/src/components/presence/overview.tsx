/**
 * The Presence overview (docs/specs/2026-10-16-presence-hub-design.md Part
 * B), the landing page of `/presence`. In order: **Add**, the **Needs
 * attention** banner, the groups `Slack`, `GitHub`, `Linear` with a block
 * per place, the group `On a schedule` with the routines, and a link to
 * Activity. A workspace with no block and no routine sees the onboarding
 * cards in place of the groups.
 *
 * Past `COLLAPSE_THRESHOLD` blocks, a filter box shows and each place group
 * collapses to its name and block count. A group with a fault stays open,
 * and so does every group while the filter has text.
 */
import { useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { useEventSubscriptions } from "~/api/events";
import { usePresencePlaces } from "~/api/presence";
import { useWorkflowTriggers } from "~/api/workflows";
import { AutomationWizard } from "~/components/events/automation-wizard";
import { Button, Input, WorkList, textLinkClass } from "~/components/primitives";
import { useListOwner } from "~/lib/use-list-owner";
import { AttentionBanner } from "./attention-banner";
import { Onboarding } from "./onboarding";
import { COLLAPSE_THRESHOLD, overviewGroups, type OverviewGroup } from "./overview-groups";
import { PlaceBlock } from "./place-block";
import { SERVICE_NAMES } from "./places";
import { RoutineRow, isRoutine, useRoutineSentence, type Routine } from "./routines-pane";
import { useFaults } from "./use-faults";

/** The reads refresh at this interval (spec Part B step 10). */
const REFRESH_MS = 60_000;

/** The groups whose blocks match the filter text, by name. An empty text keeps every block. */
export function filterGroups(groups: readonly OverviewGroup[], text: string): OverviewGroup[] {
  const needle = text.trim().toLowerCase();
  if (needle === "") return [...groups];
  return groups
    .map((group) => ({ ...group, blocks: group.blocks.filter((block) => block.label.toLowerCase().includes(needle)) }))
    .filter((group) => group.blocks.length > 0);
}

export function Overview() {
  const owner = useListOwner();
  const enabled = owner !== undefined;
  const placesQ = usePresencePlaces({ refetchInterval: REFRESH_MS });
  const linesQ = useEventSubscriptions(owner, { enabled, refetchInterval: REFRESH_MS });
  const triggersQ = useWorkflowTriggers(undefined, owner, { enabled, refetchInterval: REFRESH_MS });
  const { faults, faultedPlaces } = useFaults();
  const [adding, setAdding] = useState(false);

  const failed = placesQ.isError || linesQ.isError || triggersQ.isError;
  const loaded = placesQ.isSuccess && linesQ.isSuccess && triggersQ.isSuccess;

  return (
    <div className="min-w-0 space-y-6">
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button size="sm" onClick={() => setAdding(true)}>
          <Plus aria-hidden className="h-3.5 w-3.5" />
          Add
        </Button>
      </div>
      <AttentionBanner faults={faults} />
      {failed && (
        <p role="alert" className="text-sm text-danger-500">Could not load Presence. Reload the page to try again.</p>
      )}
      {!failed && !loaded && <p className="text-sm text-muted">Loading…</p>}
      {!failed && loaded && (
        <OverviewBody
          groups={overviewGroups(placesQ.data.places, linesQ.data.subscriptions, faultedPlaces)}
          routines={triggersQ.data.triggers.filter(isRoutine)}
          faultedPlaces={faultedPlaces}
        />
      )}
      <p>
        <Link to="/presence/activity" className={textLinkClass}>Activity</Link>
      </p>
      {adding && <AutomationWizard open onOpenChange={setAdding} />}
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
  const blockCount = groups.reduce((sum, group) => sum + group.blocks.length, 0);
  const collapsing = blockCount > COLLAPSE_THRESHOLD;
  const shown = collapsing ? filterGroups(groups, filter) : groups;
  const filtering = collapsing && filter.trim() !== "";
  return (
    <div className="space-y-8">
      {collapsing && (
        <Input
          type="search"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder="Filter places"
          aria-label="Filter places"
        />
      )}
      {shown.map((group) => {
        const name = SERVICE_NAMES[group.service];
        const blocks = <div className="space-y-4">{group.blocks.map((block) => <PlaceBlock key={block.subject} block={block} />)}</div>;
        if (!collapsing) {
          return (
            <section key={group.service} aria-labelledby={`presence-group-${group.service}`} className="space-y-3">
              <h2 id={`presence-group-${group.service}`} className="font-display text-lg text-ink">{name}</h2>
              {blocks}
            </section>
          );
        }
        const open = filtering || group.blocks.some((block) => faultedPlaces.has(block.subject));
        return <CollapsedGroup key={group.service} name={name} count={group.blocks.length} open={open}>{blocks}</CollapsedGroup>;
      })}
      {routines.length > 0 && <ScheduleGroup routines={routines} />}
    </div>
  );
}

/**
 * A place group past the threshold: a disclosure with the group's name and
 * block count. `open` follows the faults and the filter. The reader's own
 * toggle wins until `open` changes.
 */
function CollapsedGroup({ name, count, open, children }: { name: string; count: number; open: boolean; children: ReactNode }) {
  return (
    // The key remounts the element when `open` changes, so the new value applies.
    <details key={String(open)} open={open} className="space-y-3">
      <summary className="cursor-pointer font-display text-lg text-ink">{`${name} · ${count}`}</summary>
      <div className="mt-3">{children}</div>
    </details>
  );
}

/** The `On a schedule` group: one block of routine rows and `+ New routine` (spec Part B step 6). */
function ScheduleGroup({ routines }: { routines: Routine[] }) {
  const [creating, setCreating] = useState(false);
  const sentence = useRoutineSentence(routines);
  return (
    <section id="schedule" aria-labelledby="presence-group-schedule" className="space-y-3">
      <h2 id="presence-group-schedule" className="font-display text-lg text-ink">On a schedule</h2>
      <WorkList>
        {routines.map((routine) => <RoutineRow key={routine.id} routine={routine} sentence={sentence(routine)} />)}
        <div className="px-2 py-1.5 sm:pl-3">
          <Button size="sm" variant="ghost" className="text-muted" onClick={() => setCreating(true)}>
            + New routine
          </Button>
        </div>
      </WorkList>
      {creating && <AutomationWizard open onOpenChange={setCreating} startOn="routine" />}
    </section>
  );
}
