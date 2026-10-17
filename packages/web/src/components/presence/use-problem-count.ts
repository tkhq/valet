/**
 * The rail's Activity count (docs/specs/2026-10-16-presence-hub-design.md
 * Part F step 4): the distinct problems of the active workspace. A line of
 * presence with an open problem counts once, and so does a routine that the
 * scheduler turned off (`disabledReason`). A dead delivery in the last day
 * counts once per line, and only when that line does not already count for
 * its own problem and was not edited after the delivery. So one fault counts
 * once, and a fixed line stops counting at once. The rail also marks the
 * places that a line with a problem names.
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
  rules: readonly Pick<EventSubscriptionWire, "id" | "filters" | "problem" | "updatedAt">[];
  triggers: readonly WorkflowTriggerItem[];
  log: readonly Pick<EventLogItem, "at" | "deliveries">[];
  places: readonly PresencePlaceWire[];
  now: number;
}): ProblemCount {
  const broken = input.rules.filter((rule) => (rule.problem ?? "") !== "");
  const offRoutines = input.triggers.filter(isRoutine).filter((routine) => (routine.detail.disabledReason ?? "") !== "");
  const counted = new Set(broken.map((rule) => rule.id));
  const editedAt = new Map(input.rules.map((rule) => [rule.id, rule.updatedAt]));
  // A dead delivery names its line by `subscriptionId`. The line counts once:
  // not again when its own problem already counts, and not when an edit came
  // after the delivery (the edit is the fix).
  const deadLines = new Set<string>();
  for (const item of input.log) {
    if (item.at < input.now - PROBLEM_WINDOW_MS) continue;
    for (const delivery of item.deliveries ?? []) {
      if (delivery.status !== "dead" || counted.has(delivery.subscriptionId)) continue;
      const edited = editedAt.get(delivery.subscriptionId);
      if (edited !== undefined && edited >= (delivery.deliveredAt ?? item.at)) continue;
      deadLines.add(delivery.subscriptionId);
    }
  }
  const problemPlaces = new Set(broken.flatMap((rule) => placeSubjectsForRule(rule, input.places)));
  return { count: broken.length + offRoutines.length + deadLines.size, problemPlaces };
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
