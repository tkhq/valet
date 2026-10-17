/**
 * The rail's Activity count (docs/specs/2026-10-16-presence-hub-design.md
 * Part F step 4): the problems of the active workspace in the last day.
 * Three sources add up: lines of presence with an open problem, routines
 * that the scheduler turned off (`disabledReason`), and Activity rows with a
 * dead delivery. The rail also marks the places that a line with a problem
 * names.
 */
import type { EventLogItem, EventSubscriptionWire, PresencePlaceWire, WorkflowTriggerItem } from "@valet/api/wire";
import { useEventLog, useEventSubscriptions } from "~/api/events";
import { usePresencePlaces } from "~/api/presence";
import { useWorkflowTriggers } from "~/api/workflows";
import { useListOwner } from "~/lib/use-list-owner";
import { placeSubjectsForRule } from "./places";
import { isRoutine } from "./routines-pane";

/** How far back a dead delivery counts. */
export const PROBLEM_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface ProblemCount {
  count: number;
  problemPlaces: ReadonlySet<string>;
}

export function problemCount(input: {
  rules: readonly Pick<EventSubscriptionWire, "filters" | "problem">[];
  triggers: readonly WorkflowTriggerItem[];
  log: readonly Pick<EventLogItem, "at" | "deliveries">[];
  places: readonly PresencePlaceWire[];
  now: number;
}): ProblemCount {
  const broken = input.rules.filter((rule) => (rule.problem ?? "") !== "");
  const offRoutines = input.triggers.filter(isRoutine).filter((routine) => (routine.detail.disabledReason ?? "") !== "");
  const dead = input.log.filter((item) =>
    item.at >= input.now - PROBLEM_WINDOW_MS && (item.deliveries ?? []).some((delivery) => delivery.status === "dead"));
  const problemPlaces = new Set(broken.flatMap((rule) => placeSubjectsForRule(rule, input.places)));
  return { count: broken.length + offRoutines.length + dead.length, problemPlaces };
}

export function useProblemCount(): ProblemCount {
  const owner = useListOwner();
  const enabled = owner !== undefined;
  const rules = useEventSubscriptions(owner, { enabled });
  const triggers = useWorkflowTriggers(undefined, owner, { enabled });
  const log = useEventLog({ owner, problems: true });
  const places = usePresencePlaces();
  return problemCount({
    rules: rules.data?.subscriptions ?? [],
    triggers: triggers.data?.triggers ?? [],
    log: log.data?.pages.flatMap((page) => page.items) ?? [],
    places: places.data?.places ?? [],
    now: Date.now(),
  });
}
