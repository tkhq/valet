/**
 * The wizard's preview line (docs/specs/2026-10-16-presence-hub-design.md
 * Part H step 1). The wizard's state becomes a draft of what Create stores,
 * and the draft reads as the same sentence the Presence lists show. Pure, so
 * the preview is tested without the dialog.
 *
 * Each draft mirrors the request body the wizard's create handler sends, so
 * the preview equals the stored line's sentence. The `Follow a Slack thread`
 * outcome stores a `slack.message` line with `channel` and `thread_ts`
 * filters, so its preview reads through the same renderer as every line.
 */
import type { Appearance, AssistantThreadPolicy } from "@valet/shared";
import type {
  EventSubscriptionFilterWire,
  EventSubscriptionTargetWire,
  EventSubscriptionWire,
  GetWorkflowTriggerCatalogResponse,
} from "@valet/api/wire";
import { toWireFilters, type UiFilterRow } from "~/components/events/filter-editor";
import {
  partsText,
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
import type { WizardOutcome } from "~/components/presence/thread-policy-copy";
import { parseSlackThreadLink, slackThreadFilterRows } from "./slack-thread-preset";

/** The service a line listens to, as the wizard's When step names it. */
export type WhenService = "slack" | "github" | "linear";

/** The wizard's target choice: an assistant, or a workflow. */
export type WizardTarget =
  | { kind: "assistant"; assistant: "user" | "org" }
  | { kind: "assistant"; assistant: "team"; teamId: string }
  | { kind: "workflow"; workflowId: string };

/** The wizard state fields that the preview reads. */
export interface WizardState {
  outcome: WizardOutcome;
  /** The service the When step chose. It names the events until the reader picks one. */
  service: WhenService;
  keys: readonly string[];
  filterRows: readonly UiFilterRow[];
  replyChannels: readonly { id: string; label: string }[];
  anyChannel: boolean;
  target: WizardTarget;
  appearance: Appearance;
  name: string;
  cron: string;
  timezone: string;
  prompt: string;
  /** The effective Runs in policy. Null while an existing thread is not picked yet. */
  thread: AssistantThreadPolicy | null;
  follow: boolean;
  /** The pasted Slack message link of the follow outcome. */
  threadLink: string;
}

/** What the wizard will create, in the shape its sentence reads. */
export type WizardDraft =
  | { kind: "presence"; sub: EventSubscriptionWire; service: WhenService }
  | { kind: "routine"; routine: RoutineLike };

type Catalog = GetWorkflowTriggerCatalogResponse["catalog"];

const SLACK_APP_MENTION = "slack.app_mention";
const SLACK_MESSAGE = "slack.message";

/**
 * The follow outcome's filters: the channel and thread of the pasted link,
 * the same rows its create sends. Before a link parses, an empty `thread_ts`
 * filter keeps the sentence on the Slack thread.
 */
function threadFilters(state: WizardState): EventSubscriptionFilterWire[] {
  const preset = parseSlackThreadLink(state.threadLink);
  if (preset === null) return [{ field: "thread_ts", op: "eq", value: "" }];
  return toWireFilters(slackThreadFilterRows(preset));
}

/** The reply outcome's channel filters, the same ones its create sends. */
function replyFilters(state: WizardState): EventSubscriptionFilterWire[] {
  if (state.anyChannel) return [];
  const [only] = state.replyChannels;
  if (state.replyChannels.length === 1 && only !== undefined) {
    return [{ field: "channel", op: "eq", value: only.id, label: only.label }];
  }
  return [
    {
      field: "channel",
      op: "in",
      value: state.replyChannels.map((ch) => ch.id),
      labels: state.replyChannels.map((ch) => ch.label),
    },
  ];
}

/** An assistant target as the wire types it. */
type AssistantTargetWire = Extract<EventSubscriptionTargetWire, { kind: "assistant" }>;

/** The assistant fields of a target: the workspace's assistant, never a workflow. */
function assistantOf(target: WizardTarget): AssistantTargetWire {
  if (target.kind !== "assistant") return { kind: "assistant", assistant: "user" };
  return target.assistant === "team"
    ? { kind: "assistant", assistant: "team", teamId: target.teamId }
    : { kind: "assistant", assistant: target.assistant };
}

function eventTarget(state: WizardState): EventSubscriptionTargetWire {
  const appearance = Object.keys(state.appearance).length > 0 ? { appearance: state.appearance } : {};
  const thread = state.thread !== null ? { thread: state.thread } : {};
  if (state.outcome === "reply") {
    return { ...assistantOf(state.target), ...appearance, follow: state.follow, ...thread };
  }
  // A workflow outcome always runs a workflow, even before one is chosen.
  if (state.outcome === "workflow" || (state.outcome !== "notify" && state.target.kind === "workflow")) {
    const workflowId = state.target.kind === "workflow" ? state.target.workflowId : "";
    return { kind: "workflow", workflowId, ...appearance };
  }
  // A notification or a Slack thread follow sends `follow: false`; the raw
  // outcome sends no follow flag.
  const follow = state.outcome === "notify" || state.outcome === "thread" ? { follow: false } : {};
  return { ...assistantOf(state.target), ...follow, ...thread, ...appearance };
}

/** The draft the wizard's state describes. */
export function wizardDraft(state: WizardState): WizardDraft {
  if (state.outcome === "schedule") {
    const name = state.name.trim();
    const workflow = state.target.kind === "workflow";
    const routine: RoutineLike = {
      name: name.length > 0 ? name : "this routine",
      ...(state.target.kind === "workflow" ? { workflowId: state.target.workflowId } : {}),
      detail: {
        cron: state.cron.trim(),
        timezone: state.timezone.trim() || undefined,
        targetKind: workflow ? "workflow" : "assistant",
        ...(!workflow && state.thread !== null ? { thread: state.thread } : {}),
      },
    };
    return { kind: "routine", routine };
  }
  const reply = state.outcome === "reply";
  const thread = state.outcome === "thread";
  const sub: EventSubscriptionWire = {
    id: "draft",
    name: state.name.trim(),
    ownerType: "user",
    ownerId: "draft",
    eventKeys: reply ? [SLACK_APP_MENTION] : thread ? [SLACK_MESSAGE] : [...state.keys],
    filters: reply ? replyFilters(state) : thread ? threadFilters(state) : toWireFilters([...state.filterRows]),
    target: eventTarget(state),
    enabled: true,
    createdBy: "draft",
    createdAt: 0,
    updatedAt: 0,
  };
  return { kind: "presence", sub, service: state.service };
}

const SERVICE_NAMES: Readonly<Record<WhenService, string>> = { slack: "Slack", github: "GitHub", linear: "Linear" };

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

/** The draft as the sentence the lists show. */
export function wizardSentence(
  draft: WizardDraft,
  catalog: Catalog | undefined,
  workflows: WorkflowNames,
  threads: ThreadTitles,
): string {
  return partsText(wizardSentenceParts(draft, catalog, workflows, threads));
}

/** Parts with the first letter of the first text part in upper case. */
function capitalized(parts: readonly SentencePart[]): SentencePart[] {
  const [first, ...rest] = parts;
  if (first === undefined || first.kind !== "text") return [...parts];
  return [text(first.text.charAt(0).toUpperCase() + first.text.slice(1)), ...rest];
}

/**
 * The draft's When, as the review step lists it: `Someone mentions Valet in
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
