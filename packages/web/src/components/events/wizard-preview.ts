/**
 * The wizard's preview line (docs/specs/2026-10-16-presence-hub-design.md
 * Part H step 1). The wizard's state becomes a draft of what Create stores,
 * and the draft reads as the same sentence the Presence lists show. Pure, so
 * the preview is tested without the dialog.
 *
 * Each draft mirrors the request body the wizard's create handler sends, so
 * the preview equals the stored line's sentence.
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
  presenceDoes,
  presenceSentence,
  routineDoes,
  routineSentence,
  type RoutineLike,
  type ThreadTitles,
  type WorkflowNames,
} from "~/components/presence/sentences";
import type { WizardOutcome } from "~/components/presence/thread-policy-copy";
import { parseSlackThreadLink } from "./slack-thread-preset";

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
  | { kind: "routine"; routine: RoutineLike }
  | { kind: "thread"; link: string | null };

type Catalog = GetWorkflowTriggerCatalogResponse["catalog"];

const SLACK_APP_MENTION = "slack.app_mention";

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
  // A notification never follows a thread; the raw outcome sends no follow flag.
  const follow = state.outcome === "notify" ? { follow: false } : {};
  return { ...assistantOf(state.target), ...follow, ...thread, ...appearance };
}

/** The draft the wizard's state describes. */
export function wizardDraft(state: WizardState): WizardDraft {
  if (state.outcome === "thread") {
    return { kind: "thread", link: parseSlackThreadLink(state.threadLink) !== null ? state.threadLink.trim() : null };
  }
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
  const sub: EventSubscriptionWire = {
    id: "draft",
    name: state.name.trim(),
    ownerType: "user",
    ownerId: "draft",
    eventKeys: reply ? [SLACK_APP_MENTION] : [...state.keys],
    filters: reply ? replyFilters(state) : toWireFilters([...state.filterRows]),
    target: eventTarget(state),
    enabled: true,
    createdBy: "draft",
    createdAt: 0,
    updatedAt: 0,
  };
  return { kind: "presence", sub, service: state.service };
}

const SERVICE_NAMES: Readonly<Record<WhenService, string>> = { slack: "Slack", github: "GitHub", linear: "Linear" };

/** The place a draft with no events names: its first filter's label or value, else the service. */
function placeOf(filters: readonly EventSubscriptionFilterWire[], service: WhenService): string {
  for (const filter of filters) {
    if (filter.op !== "eq" && filter.op !== "in") continue;
    if (typeof filter.value === "string") return filter.label?.trim() || filter.value;
    const labels = filter.value.map((v, i) => filter.labels?.[i]?.trim() || v);
    if (labels.length > 0) return labels.join(" or ");
  }
  return SERVICE_NAMES[service];
}

/** The draft as the sentence the lists show. */
export function wizardSentence(
  draft: WizardDraft,
  catalog: Catalog | undefined,
  workflows: WorkflowNames,
  threads: ThreadTitles,
): string {
  if (draft.kind === "thread") {
    return `When someone replies in ${draft.link ?? "the Slack thread"}, reply in that thread.`;
  }
  if (draft.kind === "routine") {
    const { routine } = draft;
    // An empty schedule has no words yet.
    if (routine.detail.cron.length === 0) {
      return `On a schedule, ${routine.name}: ${routineDoes(routine, workflows, threads)}.`;
    }
    return routineSentence(routine, workflows, threads);
  }
  const { sub, service } = draft;
  if (sub.eventKeys.length > 0) return presenceSentence(sub, catalog, workflows, threads);
  // No event is picked yet. Slack's When choice already names the mention.
  if (service === "slack") {
    return presenceSentence({ ...sub, eventKeys: [SLACK_APP_MENTION] }, catalog, workflows, threads);
  }
  const preposition = service === "github" ? "on" : "in";
  const displayName = sub.target.appearance?.displayName?.trim();
  const as = displayName ? `, as ${displayName}` : "";
  return `When something happens ${preposition} ${placeOf(sub.filters, service)}, ${presenceDoes(sub, workflows, threads)}${as}.`;
}
