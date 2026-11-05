/**
 * The faults the **Needs attention** banner lists
 * (docs/specs/2026-10-16-presence-hub-design.md Part B step 2, Part F step
 * 4): the distinct faults of the active workspace. A line of presence with
 * an open problem is one fault, and so is a routine that the scheduler
 * turned off (`disabledReason`). A dead delivery in the last day is one
 * fault per line, and only when that line has no problem of its own, was
 * not edited after the delivery, and no later delivery settled it. So one fault shows once, and a fixed line
 * drops out at once.
 */
import type { EventLogItem, EventSubscriptionWire, PresencePlaceWire, WorkflowTriggerItem } from "@valet/api/wire";
import { useEventLog, useEventSubscriptions } from "~/api/events";
import { usePresencePlaces } from "~/api/presence";
import { usePinnedThreadTitles } from "~/api/rule";
import { useWorkflowTriggers } from "~/api/workflows";
import { useListOwner } from "~/lib/use-list-owner";
import { blockSubjectFor, faultLeadParts, placeLeadParts, type OverviewService } from "./overview-groups";
import { isPinProblem, pinProblemText } from "./problem-badge";
import { isRoutine, type Routine } from "./routine-helpers";
import {
  activitySentence, activitySentenceParts, partsText, replies, text, type ActivitySentenceParts, type SentencePart, type ThreadTitles,
} from "./sentences";

/** How far back a dead delivery counts. */
export const FAULT_WINDOW_MS = 24 * 60 * 60 * 1000;

export type Fault =
  /** `lead` names the line's place before the fault: `In acme/api,` or
   * `Everywhere in Slack,`. `leadParts` is the same lead with the place as a token. */
  | { kind: "line"; sub: EventSubscriptionWire; text: string; lead?: string; leadParts?: readonly SentencePart[] }
  | { kind: "routine"; routine: Routine; text: string }
  /** `sentence` is `text` as parts, with the place and the thread as tokens. */
  | {
    kind: "delivery"; eventId: string; subscriptionId: string; text: string; sentence?: ActivitySentenceParts;
    lead?: string; leadParts?: readonly SentencePart[];
  };

/** A lead's string and parts, or nothing. */
function leadFields(parts: SentencePart[] | null): { lead?: string; leadParts?: SentencePart[] } {
  return parts === null ? {} : { lead: partsText(parts), leadParts: parts };
}

/** A Log row's place as a lead: a token when the row names its key. */
function eventLeadParts(item: EventLogItem): SentencePart[] | null {
  if (item.place === undefined) return null;
  const service = item.placeKey !== undefined ? serviceOf(item.placeKey) : null;
  if (item.placeKey === undefined || service === null) return [text(`In ${item.place},`)];
  return placeLeadParts(item.place, service, item.placeKey);
}

function serviceOf(key: string): OverviewService | null {
  const prefix = key.split(":", 1)[0];
  return prefix === "slack" || prefix === "github" || prefix === "linear" ? prefix : null;
}

export interface Faults {
  faults: Fault[];
  /** The keys of the overview blocks that hold a line with a fault. */
  faultedPlaces: ReadonlySet<string>;
}

/** A line's problem as the reader sees it. */
function lineFaultText(sub: EventSubscriptionWire, titles: ThreadTitles): string {
  const problem = sub.problem ?? "";
  if (!isPinProblem(problem)) return problem;
  const thread = sub.target.kind === "assistant" ? sub.target.thread : undefined;
  const title = thread?.mode === "existing" ? titles[thread.threadId]?.title ?? undefined : undefined;
  return pinProblemText(title);
}

/** The faults in banner order: lines, then routines, then dead deliveries. */
export function faultsOf(input: {
  rules: readonly EventSubscriptionWire[];
  triggers: readonly WorkflowTriggerItem[];
  log: readonly EventLogItem[];
  places: readonly PresencePlaceWire[];
  titles: ThreadTitles;
  now: number;
}): Faults {
  const broken = input.rules.filter((rule) => (rule.problem ?? "") !== "");
  const offRoutines = input.triggers.filter(isRoutine).filter((routine) => (routine.detail.disabledReason ?? "") !== "");
  const listed = new Set(broken.map((rule) => rule.id));
  const editedAt = new Map(input.rules.map((rule) => [rule.id, rule.updatedAt]));
  const byId = new Map(input.rules.map((rule) => [rule.id, rule]));
  const repliesByListener = Object.fromEntries(input.rules.map((rule) => [rule.id, replies(rule)]));
  // The lines whose fault marks their place row, so a collapsed group with a fault stays open.
  const faultedLines: EventSubscriptionWire[] = [...broken];
  const faults: Fault[] = [
    ...broken.map((sub): Fault => (
      { kind: "line", sub, text: lineFaultText(sub, input.titles), ...leadFields(faultLeadParts(sub, input.places)) }
    )),
    ...offRoutines.map((routine): Fault => ({
      kind: "routine", routine, text: `${routine.name} is off: ${routine.detail.disabledReason ?? ""}`,
    })),
  ];
  // A dead delivery names its line by `subscriptionId`. The line shows once:
  // not again when its own problem already shows, and not when an edit came
  // after the delivery (the edit is the fix). The log is newest first, so
  // each line shows its latest dead delivery.
  for (const item of input.log) {
    if (item.at < input.now - FAULT_WINDOW_MS) continue;
    for (const delivery of item.deliveries ?? []) {
      // A dead delivery that a later delivery settled (a redelivery) is no fault.
      if (delivery.status !== "dead" || delivery.supersededBy !== undefined || listed.has(delivery.subscriptionId)) continue;
      const edited = editedAt.get(delivery.subscriptionId);
      if (edited !== undefined && edited >= (delivery.deliveredAt ?? item.at)) continue;
      listed.add(delivery.subscriptionId);
      const line = byId.get(delivery.subscriptionId);
      if (line !== undefined) faultedLines.push(line);
      // The line's place leads; a line this list does not hold falls back to the event's place.
      const lead = line !== undefined ? faultLeadParts(line, input.places) : eventLeadParts(item);
      const placeNames = {
        ...(item.place !== undefined ? { place: item.place } : {}),
        ...(item.placeKey !== undefined ? { placeKey: item.placeKey } : {}),
        repliesByListener,
      };
      faults.push({
        kind: "delivery",
        eventId: item.id,
        subscriptionId: delivery.subscriptionId,
        text: activitySentence({ eventKey: item.eventKey }, delivery, placeNames),
        sentence: activitySentenceParts({ eventKey: item.eventKey }, delivery, placeNames),
        ...leadFields(lead),
      });
    }
  }
  const faultedPlaces = new Set<string>();
  for (const sub of faultedLines) {
    const subject = blockSubjectFor(sub, input.places);
    if (subject !== null) faultedPlaces.add(subject);
  }
  return { faults, faultedPlaces };
}

/** The active workspace's faults, from the lines, the routines, the problem log, and the places. */
export function useFaults(): Faults & { isPending: boolean } {
  const owner = useListOwner();
  const enabled = owner !== undefined;
  const rules = useEventSubscriptions(owner, { enabled, refetchInterval: 60_000 });
  const triggers = useWorkflowTriggers(undefined, owner, { enabled, refetchInterval: 60_000 });
  const log = useEventLog({ owner, problems: true });
  const places = usePresencePlaces({ refetchInterval: 60_000 });
  const subs = rules.data?.subscriptions ?? [];
  const titles = usePinnedThreadTitles(subs.filter((sub) => (sub.problem ?? "") !== "").map((sub) => (
    sub.target.kind === "assistant" ? sub.target.thread : undefined
  )));
  const result = faultsOf({
    rules: subs,
    triggers: triggers.data?.triggers ?? [],
    log: log.data?.pages.flatMap((page) => page.items) ?? [],
    places: places.data?.places ?? [],
    titles,
    now: Date.now(),
  });
  return { ...result, isPending: !enabled || rules.isPending || triggers.isPending || log.isPending || places.isPending };
}
