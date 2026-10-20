/**
 * A new line's or routine's sentence before Create
 * (docs/specs/2026-10-16-presence-hub-design.md Part H step 9). The editor
 * builds the draft from the request body Create sends, and the draft reads
 * as the same sentence the Presence lists show. Pure, so the sentence is
 * tested without the editor.
 */
import type {
  EventSubscriptionFilterWire,
  EventSubscriptionWire,
  GetWorkflowTriggerCatalogResponse,
} from "@valet/api/wire";
import {
  placeParts,
  presenceDoesParts,
  presenceSentenceParts,
  presenceWhenParts,
  routineDoesParts,
  scheduleInWords,
  routineSentenceParts,
  text,
  tidy,
  type RoutineLike,
  type SentencePart,
  type ThreadTitles,
  type WorkflowNames,
} from "~/components/presence/sentences";
import { SERVICE_NAMES } from "~/components/presence/service-mark";

/** The service a line acts on, as the editor's When section names it. */
export type WhenService = "slack" | "github" | "linear";

/** What Create will store, in the shape its sentence reads. */
export type WizardDraft =
  | { kind: "presence"; sub: EventSubscriptionWire; service: WhenService }
  | { kind: "routine"; routine: RoutineLike };

type Catalog = GetWorkflowTriggerCatalogResponse["catalog"];

const SLACK_APP_MENTION = "slack.app_mention";

/** The filter fields that name a place a token can link to. */
const PLACE_FIELDS = new Set(["channel", "repo", "team", "identifier"]);

/** The place a draft with no events names: its first filter, else the service. */
function placeOf(filters: readonly EventSubscriptionFilterWire[], service: WhenService): SentencePart[] {
  for (const filter of filters) {
    if (filter.op !== "eq" && filter.op !== "in") continue;
    if (PLACE_FIELDS.has(filter.field)) return placeParts(service, filter);
    if (typeof filter.value === "string") return [text(filter.label?.trim() || filter.value)];
    const labels = filter.value.map((v, i) => filter.labels?.[i]?.trim() || v);
    if (labels.length > 0) return [text(labels.join(" or "))];
  }
  return [text(SERVICE_NAMES[service])];
}

/**
 * The draft as the stored line will read. The server adds the creator's
 * Slack user filter to an org or workflow mention line (api
 * events/mention-scope.ts), so the preview adds it too, and the draft's
 * creator is the viewer: the sentence reads `When you mention Valet`.
 */
const DRAFT_CREATOR = "draft";

function asStored(sub: EventSubscriptionWire): EventSubscriptionWire {
  const mention = sub.eventKeys.some((k) => k === SLACK_APP_MENTION || k === "slack.*");
  const team = sub.target.kind === "assistant" && sub.target.assistant === "team";
  if (!mention || team || sub.filters.some((f) => f.field === "user")) return sub;
  return { ...sub, createdBy: DRAFT_CREATOR, filters: [...sub.filters, { field: "user", op: "eq", value: "" }] };
}

/** The draft as parts of the sentence the lists show. */
export function wizardSentenceParts(
  draft: WizardDraft,
  catalog: Catalog | undefined,
  workflows: WorkflowNames,
  threads: ThreadTitles,
): SentencePart[] {
  if (draft.kind === "routine") {
    const { routine } = draft;
    // An empty schedule has no words yet.
    if (routine.detail.cron.length === 0) {
      return tidy([text(`On a schedule, ${routine.name}: `), ...routineDoesParts(routine, workflows, threads), text(".")]);
    }
    return routineSentenceParts(routine, workflows, threads);
  }
  const { sub, service } = draft;
  const names = { me: DRAFT_CREATOR };
  if (sub.eventKeys.length > 0) return presenceSentenceParts(asStored(sub), catalog, workflows, threads, names);
  // No event is picked yet. Slack's default Do replies to a mention.
  if (service === "slack") {
    return presenceSentenceParts(asStored({ ...sub, eventKeys: [SLACK_APP_MENTION] }), catalog, workflows, threads, names);
  }
  const preposition = service === "github" ? "on" : "in";
  const displayName = sub.target.appearance?.displayName?.trim();
  const as: SentencePart[] = displayName ? [text(", as "), { kind: "person", text: displayName }] : [];
  return tidy([
    text(`When something happens ${preposition} `),
    ...placeOf(sub.filters, service),
    text(", "),
    ...presenceDoesParts(sub, workflows, threads),
    ...as,
    text("."),
  ]);
}

/** Parts with the first letter of the first text part in upper case. */
function capitalized(parts: readonly SentencePart[]): SentencePart[] {
  const [first, ...rest] = parts;
  if (first === undefined || first.kind !== "text") return [...parts];
  return [text(first.text.charAt(0).toUpperCase() + first.text.slice(1)), ...rest];
}

/**
 * The draft's When, as the editor's When summary reads it: `Someone mentions Valet in
 * #incidents`, `Something happens on acme/api`, or the schedule in words.
 */
export function wizardWhenParts(draft: WizardDraft, catalog: Catalog | undefined): SentencePart[] {
  if (draft.kind === "routine") {
    const { cron, timezone } = draft.routine.detail;
    return [text(cron.length === 0 ? "On a schedule" : scheduleInWords(cron, timezone))];
  }
  const { sub, service } = draft;
  const names = { me: DRAFT_CREATOR };
  if (sub.eventKeys.length > 0) return capitalized(presenceWhenParts(asStored(sub), catalog, names));
  if (service === "slack") return capitalized(presenceWhenParts(asStored({ ...sub, eventKeys: [SLACK_APP_MENTION] }), catalog, names));
  return tidy([text(`Something happens ${service === "github" ? "on" : "in"} `), ...placeOf(sub.filters, service)]);
}
