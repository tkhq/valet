/**
 * The editor's draft (docs/specs/2026-10-16-presence-hub-design.md Part H).
 * One state type holds a line or a routine while the reader edits it. Pure
 * functions fill it from a stored line or routine, change it, and turn it
 * into the create or patch body that Create or Save sends. The side pane
 * reads its sentence from that body, so the sentence equals the stored
 * sentence (INV-H7).
 */
import { type Appearance, type AssistantThreadPolicy, validateAppearance } from "@valet/shared";
import type {
  CreateEventSubscriptionRequest,
  CreateWorkflowScheduleRequest,
  EventDeliveryPolicy,
  EventSubscriptionAudienceWire,
  EventSubscriptionTargetWire,
  EventSubscriptionWire,
  PatchEventSubscriptionRequest,
  UpdateWorkflowScheduleRequest,
} from "@valet/api/wire";
import { fromWireFilters, pruneFilterRows, toWireFilters, type UiFilterRow } from "~/components/events/filter-editor";
import { promptFieldsToTarget } from "~/components/events/prompt-fields";
import { WEEKDAYS, cronFromDayAndTime } from "~/components/events/schedule-step";
import { buildSubscriptionPatch } from "~/components/events/subscription-patch";
import { unionFilterFields, type CatalogService } from "~/components/events/subscription-match";
import type { WhenService } from "~/components/events/wizard-preview";
import { SLACK_APP_MENTION, selectsSlackMention, hasChannelScopeFilter, storedAnyChannel } from "~/lib/slack-mention";
import { placeFilter, type PreselectedPlace } from "../place-filter";
import type { SectionId } from "./section";
import { parseSlackThreadLink, slackThreadFilterRows } from "./slack-thread-link";
import type { Routine } from "../routine-helpers";
import {
  channelWords,
  followsSlackThread,
  isCreatorScopeFilter,
  partsText,
  type RoutineLike,
  type SentenceNames,
  type SentencePart,
} from "../sentences";
import {
  defaultWizardThreadPolicy,
  displayThreadPolicy,
  sameThreadPolicy,
  subjectKindForKeys,
  type SubjectKind,
} from "../thread-policy-copy";

/** The When choice: an event service, or a schedule. */
export type EditorService = WhenService | "schedule";

/** What Valet does: reply in the conversation, work on the event, or run a workflow. */
export type DoKind = "reply" | "work" | "workflow";

/** Which assistant acts. */
export type AssistantKind = "user" | "team" | "org";

/**
 * What the editor opens on. `initialSection` opens that section at once,
 * such as a page's `Change` link under Where (spec Part D step 1.6).
 */
export type EditorMode = (
  | {
    kind: "create";
    /** `team` starts a Slack mention line that the team's assistant answers (the team Slack setup). */
    /**
     * `fixedWorkflowId` locks Do on that workflow (a workflow's panel adds
     * a line that must show in that panel); `workflowId` only preselects it.
     */
    preselected?: {
      place?: PreselectedPlace;
      workflowId?: string;
      fixedWorkflowId?: string;
      schedule?: boolean;
      team?: { id: string; name: string };
    };
  }
  | { kind: "edit"; line: EventSubscriptionWire }
  | { kind: "edit-routine"; routine: Routine }
  | { kind: "review"; line: EventSubscriptionWire; replaces?: { id: string; name: string } }
) & { initialSection?: SectionId };

/** Days of the week, a time, and a zone make the cron, unless a typed cron overrides them. */
export interface ScheduleDraft {
  days: ReadonlySet<number>;
  time: string;
  timezone: string;
  cronOverride: string | null;
}

export interface Draft {
  service: EditorService;
  schedule: ScheduleDraft;
  events: ReadonlySet<string>;
  /** The conditions, in stored order. The creator scope row sits here too. */
  conditions: readonly UiFilterRow[];
  /** The stored creator scope row's id: a pill the reader cannot remove. */
  creatorScopeId: string | null;
  /** The condition a place preselected. It comes back after an event change
   * drops it, unless the reader removed it or changed the service. */
  placeRow: UiFilterRow | null;
  placeRemoved: boolean;
  /** The explicit opt-out of a mention line's channel requirement. */
  anyChannel: boolean;
  /** True for `A reply in one Slack thread`: `slack.message` with the
   * thread's `channel` and `thread_ts` conditions. */
  threadFollow: boolean;
  /** The pasted message link, as typed. Its parse sets the conditions. */
  threadLink: string;
  doKind: DoKind;
  workflowId: string;
  assistant: AssistantKind;
  teamId: string | null;
  /** Who may mention a team assistant. Sent only for a team reply line. */
  audience: EventSubscriptionAudienceWire;
  /** A workflow routine's run input, as JSON text. Empty sends no input. */
  runInput: string;
  /** The line's standing instruction (`systemPrompt`), or the routine's prompt. */
  instructions: string;
  /** The event message template, under Advanced. */
  promptTemplates: { userPromptTemplate: string };
  /** The reader's Where choice. Null while a pinned thread is not picked yet. */
  where: AssistantThreadPolicy | null;
  /** False while the default Where holds; the default follows the events. */
  whereChosen: boolean;
  /** The picked thread's title, for the sentence. */
  whereTitle?: string;
  deliveryPolicy: EventDeliveryPolicy;
  pauseOnOverlap: boolean;
  appearance: Appearance;
  name: string;
  /** False while the name follows the suggestion. */
  nameEdited: boolean;
}

// ── Schedules ──────────────────────────────────────────────────────────

const DEFAULT_TIME = "09:00";

export function defaultSchedule(timezone: string): ScheduleDraft {
  return { days: new Set(WEEKDAYS), time: DEFAULT_TIME, timezone, cronOverride: null };
}

/** The cron the schedule draft makes: the typed cron, else the days and time. */
export function scheduleCron(schedule: ScheduleDraft): string {
  return (schedule.cronOverride ?? cronFromDayAndTime(schedule.days, schedule.time)).trim();
}

/**
 * The days and time a stored cron names, when `cronFromDayAndTime` could
 * have made it. Any other cron stays a typed cron.
 */
export function scheduleFromCron(cron: string, timezone: string): ScheduleDraft {
  const parts = cron.trim().split(/\s+/);
  const fallback: ScheduleDraft = { ...defaultSchedule(timezone), cronOverride: cron.trim() };
  if (parts.length !== 5) return fallback;
  const [min = "", hour = "", dom = "", month = "", dow = ""] = parts;
  if (dom !== "*" || month !== "*" || !/^\d{1,2}$/.test(min) || !/^\d{1,2}$/.test(hour)) return fallback;
  let days: number[];
  if (dow === "*") days = [0, 1, 2, 3, 4, 5, 6];
  else if (dow === "1-5") days = [...WEEKDAYS];
  else if (/^\d(,\d)*$/.test(dow)) days = dow.split(",").map(Number);
  else return fallback;
  const time = `${hour.padStart(2, "0")}:${min.padStart(2, "0")}`;
  const schedule: ScheduleDraft = { days: new Set(days), time, timezone, cronOverride: null };
  // Only a cron that the days and time make again round-trips.
  return cronFromDayAndTime(schedule.days, time) === cron.trim() ? schedule : fallback;
}

// ── Seeds ──────────────────────────────────────────────────────────────

function isWhen(service: string): service is WhenService {
  return service === "slack" || service === "github" || service === "linear";
}

function serviceOfKeys(keys: readonly string[]): WhenService {
  for (const key of keys) {
    const prefix = key.split(".")[0] ?? "";
    if (isWhen(prefix)) return prefix;
  }
  return "slack";
}

function placeRowFor(place: PreselectedPlace | undefined): UiFilterRow | null {
  const filter = place ? placeFilter(place) : null;
  if (filter === null) return null;
  return { id: crypto.randomUUID(), field: filter.field, op: "eq", value: filter.value, label: filter.label };
}

/** A fresh draft for Create. The service is the place's, else Slack until the
 * connected services load. A team workspace starts on its team's assistant. */
export function newDraft(options: {
  preselected?: Extract<EditorMode, { kind: "create" }>["preselected"];
  teamId?: string;
  timezone: string;
}): Draft {
  const { preselected, timezone } = options;
  const team = preselected?.team;
  const teamId = team?.id ?? options.teamId;
  const place = preselected?.place;
  const placeRow = placeRowFor(place);
  const service: EditorService = preselected?.schedule ? "schedule" : place !== undefined && isWhen(place.service) ? place.service : "slack";
  const workflowId = preselected?.fixedWorkflowId ?? preselected?.workflowId;
  return {
    service,
    schedule: defaultSchedule(timezone),
    events: team !== undefined && service === "slack" ? new Set([SLACK_APP_MENTION]) : new Set(),
    conditions: placeRow !== null ? [placeRow] : [],
    creatorScopeId: null,
    placeRow,
    placeRemoved: false,
    anyChannel: false,
    threadFollow: false,
    threadLink: "",
    doKind: workflowId !== undefined ? "workflow" : service === "slack" ? "reply" : "work",
    workflowId: workflowId ?? "",
    assistant: teamId !== undefined ? "team" : "user",
    teamId: teamId ?? null,
    audience: "organization",
    runInput: "",
    instructions: "",
    promptTemplates: { userPromptTemplate: "" },
    where: null,
    whereChosen: false,
    deliveryPolicy: "always",
    pauseOnOverlap: true,
    appearance: {},
    name: "",
    nameEdited: false,
  };
}

/** The stored creator scope row of a mention line. */
function creatorScopeId(sub: EventSubscriptionWire, rows: readonly UiFilterRow[]): string | null {
  const team = sub.target.kind === "assistant" && sub.target.assistant === "team";
  if (team || !selectsSlackMention(sub.eventKeys)) return null;
  return rows.find((row) => toWireFilters([row]).some(isCreatorScopeFilter))?.id ?? null;
}

/** The draft of a stored line. Every section reads as its summary. */
export function draftFromLine(sub: EventSubscriptionWire, timezone = "UTC"): Draft {
  const rows = fromWireFilters(sub.filters);
  const target = sub.target;
  const assistant = target.kind === "assistant";
  const deliveryPolicy = assistant ? target.deliveryPolicy ?? "always" : "always";
  return {
    service: serviceOfKeys(sub.eventKeys),
    schedule: defaultSchedule(timezone),
    events: new Set(sub.eventKeys),
    conditions: rows,
    creatorScopeId: creatorScopeId(sub, rows),
    placeRow: null,
    placeRemoved: false,
    anyChannel: storedAnyChannel(sub.eventKeys, sub.filters),
    threadFollow: followsSlackThread(sub),
    threadLink: "",
    doKind: target.kind === "workflow" ? "workflow" : target.follow === true ? "reply" : "work",
    workflowId: target.kind === "workflow" ? target.workflowId : "",
    assistant: assistant ? target.assistant ?? "user" : sub.ownerType === "team" ? "team" : sub.ownerType === "org" ? "org" : "user",
    teamId: assistant ? target.teamId ?? (sub.ownerType === "team" ? sub.ownerId : null) : null,
    audience: sub.audience ?? "organization",
    runInput: "",
    instructions: assistant ? target.systemPrompt ?? "" : "",
    promptTemplates: { userPromptTemplate: assistant ? target.userPromptTemplate ?? "" : "" },
    where: assistant ? displayThreadPolicy(target, sub.eventKeys) : null,
    whereChosen: true,
    deliveryPolicy,
    // The patch compares an absent value with `false` once the policy is
    // not `always`, so an untouched line sends no change.
    pauseOnOverlap: assistant ? target.pauseOnOverlap ?? deliveryPolicy === "always" : true,
    appearance: target.appearance ?? {},
    name: sub.name,
    nameEdited: true,
  };
}

/** The draft of a stored routine. */
export function draftFromRoutine(routine: Routine): Draft {
  const { detail } = routine;
  const workflow = detail.targetKind === "workflow";
  return {
    service: "schedule",
    schedule: scheduleFromCron(detail.cron, detail.timezone),
    events: new Set(),
    conditions: [],
    creatorScopeId: null,
    placeRow: null,
    placeRemoved: false,
    anyChannel: false,
    threadFollow: false,
    threadLink: "",
    doKind: workflow ? "workflow" : "work",
    workflowId: routine.workflowId ?? "",
    assistant: detail.ownerType === "team" ? "team" : "user",
    teamId: detail.ownerType === "team" ? detail.ownerId : null,
    audience: "organization",
    runInput: detail.input != null ? JSON.stringify(detail.input, null, 2) : "",
    instructions: detail.prompt ?? "",
    promptTemplates: { userPromptTemplate: "" },
    where: workflow ? null : detail.thread ?? { mode: "own" },
    whereChosen: true,
    deliveryPolicy: "always",
    pauseOnOverlap: true,
    appearance: {},
    name: routine.name,
    nameEdited: true,
  };
}

/** The draft a mode opens on. */
export function draftForMode(mode: EditorMode, options: { teamId?: string; timezone: string }): Draft {
  switch (mode.kind) {
    case "create":
      return newDraft({ preselected: mode.preselected, teamId: options.teamId, timezone: options.timezone });
    case "edit":
    case "review":
      return draftFromLine(mode.line, options.timezone);
    case "edit-routine":
      return draftFromRoutine(mode.routine);
  }
}

// ── Changes ────────────────────────────────────────────────────────────

/**
 * A new When service. The events and the conditions belong to the old
 * service, so they go (Review Focus 4). A draft launched from a place
 * keeps the place's service, so it never comes here. Do keeps a choice the
 * new service offers.
 */
export function setService(draft: Draft, next: EditorService): Draft {
  if (next === draft.service) return draft;
  let doKind = draft.doKind;
  if (doKind === "reply" && next !== "slack") doKind = "work";
  if (next === "slack" && draft.service === "schedule" && doKind === "work") doKind = "reply";
  return {
    ...draft,
    service: next,
    events: new Set(),
    conditions: [],
    creatorScopeId: null,
    anyChannel: false,
    threadFollow: false,
    threadLink: "",
    doKind,
    // A schedule has no organization assistant.
    assistant: next === "schedule" && draft.assistant === "org" ? "user" : draft.assistant,
    where: null,
    whereChosen: false,
    whereTitle: undefined,
  };
}

/**
 * Picks or drops one event. A condition whose field no picked event
 * carries goes; the preselected place comes back once an event carries
 * its field again, unless the reader removed it.
 *
 * On a new line (`create`), unchecking the last mention turns Reply into
 * Work on it: only a mention starts a conversation to reply in. A stored
 * line locks Do, so its draft keeps Reply and Save says why.
 */
export function toggleEvent(
  draft: Draft,
  key: string,
  services: readonly CatalogService[],
  options: { create?: boolean } = {},
): Draft {
  const events = new Set(draft.events);
  if (events.has(key)) events.delete(key);
  else events.add(key);
  const fields = unionFilterFields([...services], events);
  const mention = selectsSlackMention([...events]);
  let conditions = [...draft.conditions];
  // The creator scope belongs to a mention. With no mention picked, nothing
  // shows the row and the server no longer adds it, so it goes with the
  // mention instead of narrowing the other events unseen.
  if (!mention && draft.creatorScopeId !== null) conditions = conditions.filter((row) => row.id !== draft.creatorScopeId);
  // An empty event set carries no fields. Pruning against it would drop
  // every condition on the way from one event to another.
  if (events.size > 0) conditions = pruneFilterRows(conditions, fields);
  const pin = draft.placeRow;
  if (
    pin !== null &&
    !draft.placeRemoved &&
    fields.some((f) => f.field === pin.field) &&
    !conditions.some((row) => row.id === pin.id || row.field === pin.field)
  ) {
    conditions = [pin, ...conditions];
  }
  const creatorScopeId = conditions.some((row) => row.id === draft.creatorScopeId) ? draft.creatorScopeId : null;
  const lostMention = !mention && selectsSlackMention([...draft.events]);
  const doKind = options.create === true && lostMention && draft.doKind === "reply" ? "work" : draft.doKind;
  return { ...draft, events, conditions, creatorScopeId, doKind, anyChannel: mention ? draft.anyChannel : false };
}

const SLACK_MESSAGE = "slack.message";

/**
 * Turns `A reply in one Slack thread` on or off. On, the line hears
 * `slack.message` and waits for a link; the thread's conditions come from
 * the link. Off, the draft goes back to picking events, with the place a
 * launcher preselected.
 */
export function setThreadFollow(draft: Draft, on: boolean): Draft {
  if (on === draft.threadFollow) return draft;
  const placeRow = draft.placeRow !== null && !draft.placeRemoved ? [draft.placeRow] : [];
  return {
    ...draft,
    threadFollow: on,
    threadLink: "",
    events: on ? new Set([SLACK_MESSAGE]) : new Set(),
    conditions: placeRow,
    creatorScopeId: null,
    anyChannel: false,
    // A thread follow works on each reply; it never starts a conversation to follow.
    doKind: draft.doKind === "workflow" ? "workflow" : on ? "work" : draft.doKind,
    where: null,
    whereChosen: false,
    whereTitle: undefined,
  };
}

/**
 * A pasted link. A link that parses replaces the thread's `channel` and
 * `thread_ts` conditions; one that does not keeps the conditions, and the
 * editor shows the error.
 */
export function setThreadLink(draft: Draft, link: string): Draft {
  const thread = parseSlackThreadLink(link);
  if (thread === null) return { ...draft, threadLink: link };
  const rest = draft.conditions.filter((row) => row.field !== "channel" && row.field !== "thread_ts");
  return { ...draft, threadLink: link, conditions: [...slackThreadFilterRows(thread), ...rest] };
}

/**
 * The thread a thread-follow draft names, from its conditions. `channelLabel`
 * is the channel's words (`channelWords`): the saved label, else the name
 * from `names`, else the raw id, as the sentence names it.
 */
export function draftThread(draft: Draft, names: SentenceNames = {}): { channel: string; channelLabel: string; threadTs: string } | null {
  const ts = draft.conditions.find((row) => row.field === "thread_ts" && row.op === "eq" && row.value.trim().length > 0);
  if (ts === undefined) return null;
  const channel = draft.conditions.find((row) => row.field === "channel" && row.op === "eq");
  return {
    channel: channel?.value ?? "",
    channelLabel: channel === undefined ? "" : channelWords(channel.value, channel.label, names),
    threadTs: ts.value.trim(),
  };
}

/** Removes one condition. The creator scope cannot be removed. */
export function removeCondition(draft: Draft, id: string): Draft {
  if (id === draft.creatorScopeId) return draft;
  return {
    ...draft,
    conditions: draft.conditions.filter((row) => row.id !== id),
    placeRemoved: draft.placeRow?.id === id ? true : draft.placeRemoved,
  };
}

/** Adds one condition. A channel condition turns Any channel off: the two say opposite things. */
export function addCondition(draft: Draft, row: UiFilterRow): Draft {
  const conditions = [...draft.conditions, row];
  const scoped = hasChannelScopeFilter(toWireFilters(conditions));
  return { ...draft, conditions, anyChannel: scoped ? false : draft.anyChannel };
}

// ── Derived facts ──────────────────────────────────────────────────────

/** The unit one thread per place groups by, or null when the events name none. */
export function draftSubjectKind(draft: Draft): SubjectKind | null {
  if (draft.service === "schedule") return null;
  return subjectKindForKeys([...draft.events]);
}

function outcomeOf(doKind: DoKind): "reply" | "notify" | "workflow" {
  return doKind === "reply" ? "reply" : doKind === "work" ? "notify" : "workflow";
}

/** The Where that holds until the reader picks one (thread policy spec defaults). */
export function defaultWhere(draft: Draft): AssistantThreadPolicy {
  // A routine and a followed Slack thread each keep one history.
  if (draft.service === "schedule" || draft.threadFollow) return { mode: "own" };
  return defaultWizardThreadPolicy(outcomeOf(draft.doKind), draftSubjectKind(draft));
}

/** The Where the draft saves: the reader's choice, else the default. A
 * grouping choice falls back once the events name no place to group by. */
export function effectiveWhere(draft: Draft): AssistantThreadPolicy | null {
  if (!draft.whereChosen) return defaultWhere(draft);
  if (draft.where?.mode === "subject" && draftSubjectKind(draft) === null) return defaultWhere(draft);
  return draft.where;
}

/** True when the line works through an assistant, not a workflow. */
export function isAssistantDraft(draft: Draft): boolean {
  return draft.doKind !== "workflow";
}

/** True when a stored or created mention line hears only its creator.
 * The server adds the creator scope on every write of a mention line that
 * is not a team assistant's (`enforceMentionScope`), so a stored line whose
 * mention was unchecked and checked again still gets it. A workflow line has
 * no team assistant, so the server scopes it to its creator too. */
export function hasCreatorScope(draft: Draft): boolean {
  if (draft.service === "schedule" || !selectsSlackMention([...draft.events])) return false;
  return !teamAssistantDraft(draft);
}

/** The workspace key whose threads the picker lists. The organization's
 * assistant has none, so it cannot pin a thread. */
export function draftWorkspace(draft: Draft, mode: EditorMode): string | undefined {
  if (mode.kind === "edit" || mode.kind === "review") {
    const { ownerType, ownerId } = mode.line;
    return ownerType === "user" ? "user" : ownerType === "team" ? ownerId : undefined;
  }
  if (mode.kind === "edit-routine") {
    const { ownerType, ownerId } = mode.routine.detail;
    return ownerType === "user" ? "user" : ownerType === "team" ? ownerId : undefined;
  }
  if (draft.assistant === "user") return "user";
  if (draft.assistant === "team") return draft.teamId ?? undefined;
  return undefined;
}

// ── Bodies ─────────────────────────────────────────────────────────────

/** What Create or Save sends. */
export type EditorBody =
  | { kind: "create-line"; body: CreateEventSubscriptionRequest }
  | { kind: "patch-line"; id: string; body: PatchEventSubscriptionRequest }
  | { kind: "create-routine"; body: CreateWorkflowScheduleRequest }
  | { kind: "patch-routine"; id: string; body: UpdateWorkflowScheduleRequest };

type AssistantTargetWire = Extract<EventSubscriptionTargetWire, { kind: "assistant" }>;

function assistantFields(draft: Draft): AssistantTargetWire {
  if (draft.assistant === "team" && draft.teamId !== null) return { kind: "assistant", assistant: "team", teamId: draft.teamId };
  return { kind: "assistant", assistant: draft.assistant === "team" ? "user" : draft.assistant };
}

function lineTarget(draft: Draft): EventSubscriptionTargetWire {
  const appearance = Object.keys(draft.appearance).length > 0 ? { appearance: draft.appearance } : {};
  if (draft.doKind === "workflow") return { kind: "workflow", workflowId: draft.workflowId, ...appearance };
  const where = effectiveWhere(draft);
  const thread = where !== null ? { thread: where } : {};
  const templates = promptFieldsToTarget({ systemPrompt: draft.instructions, userPromptTemplate: draft.promptTemplates.userPromptTemplate });
  const base = assistantFields(draft);
  const delivery = base.assistant === "user" ? { deliveryPolicy: draft.deliveryPolicy, pauseOnOverlap: draft.pauseOnOverlap } : {};
  // Only a mention starts a conversation to follow; a channel message never does.
  const follow = draft.doKind === "reply" && draft.events.has(SLACK_APP_MENTION);
  return { ...base, ...appearance, follow, ...thread, ...templates, ...delivery };
}

function createLineBody(draft: Draft): CreateEventSubscriptionRequest {
  const target = lineTarget(draft);
  const team = target.kind === "assistant" && target.assistant === "team";
  return {
    name: draft.name.trim(),
    eventKeys: [...draft.events],
    filters: toWireFilters([...draft.conditions]),
    target,
    // Only a team assistant has an audience, and only a reply line asks it.
    ...(draft.doKind === "reply" && team ? { audience: draft.audience } : {}),
    ...(draft.anyChannel && selectsSlackMention([...draft.events]) ? { anyChannel: true } : {}),
  };
}

/**
 * The thread policy a patch sends. A line with a stored policy compares
 * against it (`buildSubscriptionPatch`). A line with none runs the default
 * for its keys, so the Where choice compares against the default for the
 * keys the patch stores: an unchanged default sends nothing, and a Where
 * that the new keys would not default to is stored as chosen.
 */
function patchThread(draft: Draft, sub: EventSubscriptionWire): { thread?: AssistantThreadPolicy; explicit?: AssistantThreadPolicy } {
  const where = effectiveWhere(draft);
  if (sub.target.kind !== "assistant" || where === null) return {};
  if (sub.target.thread !== undefined && sub.target.thread !== null) return { thread: where };
  const patched = displayThreadPolicy(sub.target, [...draft.events]);
  return sameThreadPolicy(where, patched) ? {} : { explicit: where };
}

function patchLineBody(draft: Draft, sub: EventSubscriptionWire, review: boolean): PatchEventSubscriptionRequest {
  const assistant = sub.target.kind === "assistant";
  const { thread, explicit } = patchThread(draft, sub);
  const patch = buildSubscriptionPatch(sub, {
    name: draft.name,
    eventKeys: [...draft.events],
    filters: toWireFilters([...draft.conditions]),
    anyChannel: draft.anyChannel,
    prompts: { systemPrompt: draft.instructions, userPromptTemplate: draft.promptTemplates.userPromptTemplate },
    appearance: draft.appearance,
    ...(thread !== undefined ? { thread } : {}),
    ...(sub.ownerType === "user" && assistant
      ? { deliveryPreferences: { deliveryPolicy: draft.deliveryPolicy, pauseOnOverlap: draft.pauseOnOverlap } }
      : {}),
  }) ?? {};
  const body = explicit !== undefined ? { ...patch, thread: explicit } : patch;
  return review && !sub.enabled ? { ...body, enabled: true } : body;
}

/** The run input text as JSON: `none` for an empty field, `bad` for text that does not parse. */
export function parseRunInput(text: string): { kind: "none" } | { kind: "bad" } | { kind: "value"; value: unknown } {
  if (text.trim().length === 0) return { kind: "none" };
  try {
    return { kind: "value", value: JSON.parse(text) };
  } catch {
    return { kind: "bad" };
  }
}

function createRoutineBody(draft: Draft): CreateWorkflowScheduleRequest {
  const base = { name: draft.name.trim(), cron: scheduleCron(draft.schedule), timezone: draft.schedule.timezone.trim() };
  if (draft.doKind === "workflow") {
    const input = parseRunInput(draft.runInput);
    return { ...base, target: { kind: "workflow", workflowId: draft.workflowId, ...(input.kind === "value" ? { input: input.value } : {}) } };
  }
  const where = effectiveWhere(draft);
  return {
    ...base,
    target: { kind: "assistant", prompt: draft.instructions.trim() },
    ...(where !== null ? { thread: where } : {}),
    ...(draft.assistant === "team" && draft.teamId !== null ? { teamId: draft.teamId } : {}),
  };
}

function patchRoutineBody(draft: Draft, routine: Routine): UpdateWorkflowScheduleRequest {
  const { detail } = routine;
  const body: UpdateWorkflowScheduleRequest = {};
  const name = draft.name.trim();
  const cron = scheduleCron(draft.schedule);
  if (name !== routine.name) body.name = name;
  if (cron !== detail.cron) body.cron = cron;
  if (draft.schedule.timezone !== detail.timezone) body.timezone = draft.schedule.timezone;
  if (detail.targetKind === "workflow") {
    // An emptied field clears the stored input with `null`.
    const input = parseRunInput(draft.runInput);
    const stored = detail.input ?? null;
    if (input.kind === "value" && JSON.stringify(input.value) !== JSON.stringify(stored)) body.input = input.value;
    if (input.kind === "none" && stored !== null) body.input = null;
  }
  if (detail.targetKind === "assistant") {
    if (draft.instructions.trim() !== (detail.prompt ?? "")) body.prompt = draft.instructions.trim();
    const where = effectiveWhere(draft);
    if (where !== null && !sameThreadPolicy(where, detail.thread ?? { mode: "own" })) body.thread = where;
  }
  return body;
}

/** The body Create or Save sends for the draft in this mode. */
export function bodyFromDraft(draft: Draft, mode: EditorMode): EditorBody {
  switch (mode.kind) {
    case "create":
      return draft.service === "schedule"
        ? { kind: "create-routine", body: createRoutineBody(draft) }
        : { kind: "create-line", body: createLineBody(draft) };
    case "edit":
      return { kind: "patch-line", id: mode.line.id, body: patchLineBody(draft, mode.line, false) };
    case "review":
      return { kind: "patch-line", id: mode.line.id, body: patchLineBody(draft, mode.line, true) };
    case "edit-routine":
      return { kind: "patch-routine", id: mode.routine.id, body: patchRoutineBody(draft, mode.routine) };
  }
}

/** True when nothing would change: an empty patch. */
export function isEmptyBody(body: EditorBody): boolean {
  return (body.kind === "patch-line" || body.kind === "patch-routine") && Object.keys(body.body).length === 0;
}

// ── The stored shape a body becomes, for the sentence ──────────────────

/** A create body as the line the server stores, with placeholder ids. */
export function lineFromCreate(body: CreateEventSubscriptionRequest): EventSubscriptionWire {
  return {
    id: "draft",
    name: body.name,
    ownerType: "user",
    ownerId: "draft",
    eventKeys: body.eventKeys,
    filters: body.filters ?? [],
    target: body.target,
    enabled: true,
    createdBy: "draft",
    createdAt: 0,
    updatedAt: 0,
  };
}

/** A stored line with a patch applied, as the server stores it. */
export function applyLinePatch(sub: EventSubscriptionWire, patch: PatchEventSubscriptionRequest): EventSubscriptionWire {
  const appearance = patch.appearance === undefined ? sub.target.appearance : patch.appearance ?? undefined;
  let target: EventSubscriptionTargetWire;
  if (sub.target.kind === "assistant") {
    const next: AssistantTargetWire = { ...sub.target };
    if (patch.thread !== undefined) {
      if (patch.thread === null) delete next.thread;
      else next.thread = patch.thread;
    }
    for (const field of ["systemPrompt", "userPromptTemplate"] as const) {
      const value = patch[field];
      if (value === undefined) continue;
      if (value === null) delete next[field];
      else next[field] = value;
    }
    if (patch.deliveryPolicy !== undefined) next.deliveryPolicy = patch.deliveryPolicy;
    if (patch.pauseOnOverlap !== undefined) next.pauseOnOverlap = patch.pauseOnOverlap;
    if (appearance === undefined) delete next.appearance;
    else next.appearance = appearance;
    target = next;
  } else {
    target = { kind: "workflow", workflowId: sub.target.workflowId, ...(appearance !== undefined ? { appearance } : {}) };
  }
  return {
    ...sub,
    name: patch.name ?? sub.name,
    eventKeys: patch.eventKeys ?? sub.eventKeys,
    filters: patch.filters ?? sub.filters,
    enabled: patch.enabled ?? sub.enabled,
    target,
  };
}

/** A routine create body as the routine its sentence reads. */
export function routineFromCreate(body: CreateWorkflowScheduleRequest): RoutineLike {
  const name = body.name.length > 0 ? body.name : "this routine";
  if (body.target.kind === "workflow") {
    return { name, workflowId: body.target.workflowId, detail: { cron: body.cron, timezone: body.timezone, targetKind: "workflow" } };
  }
  return {
    name,
    detail: { cron: body.cron, timezone: body.timezone, targetKind: "assistant", ...(body.thread !== undefined ? { thread: body.thread } : {}) },
  };
}

/** A stored routine with a patch applied. */
export function applyRoutinePatch(routine: Routine, patch: UpdateWorkflowScheduleRequest): Routine {
  const { thread: storedThread, ...detail } = routine.detail;
  const thread = patch.thread === undefined ? storedThread : patch.thread ?? undefined;
  return {
    ...routine,
    name: patch.name ?? routine.name,
    enabled: patch.enabled ?? routine.enabled,
    detail: {
      ...detail,
      cron: patch.cron ?? detail.cron,
      timezone: patch.timezone ?? detail.timezone,
      ...(patch.prompt !== undefined ? { prompt: patch.prompt } : {}),
      ...(patch.input !== undefined ? { input: patch.input } : {}),
      ...(thread !== undefined ? { thread } : {}),
    },
  };
}

// ── Words ──────────────────────────────────────────────────────────────

const NAME_MAX = 40;

/**
 * A name from the When words: `a check completes on acme/api` becomes
 * `Check completes on acme/api`. The leading article goes, the first
 * letter is upper case, and a long name stops at a word under 40 characters.
 */
export function suggestedName(parts: readonly SentencePart[]): string {
  let words = partsText(parts).replace(/\s+/g, " ").trim().replace(/\.$/, "");
  words = words.replace(/^(a|an|the)\s+/i, "");
  if (words.length > NAME_MAX) {
    const cut = words.slice(0, NAME_MAX + 1);
    const space = cut.lastIndexOf(" ");
    words = (space > 0 ? cut.slice(0, space) : words.slice(0, NAME_MAX)).replace(/[,\s]+$/, "");
  }
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** `9:00`, not `09:00`. */
function clockText(time: string): string {
  const match = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  return match === null ? time : `${Number(match[1])}:${match[2]}`;
}

/** The first example step of a schedule: `It is 9:00 on a weekday.` */
function scheduleMoment(schedule: ScheduleDraft): string {
  if (schedule.cronOverride !== null) return `The schedule ${schedule.cronOverride.trim()} comes due.`;
  const days = [...schedule.days].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7));
  const at = clockText(schedule.time);
  if (days.length === 7) return `It is ${at} on any day.`;
  if (days.length === 5 && WEEKDAYS.every((d) => schedule.days.has(d))) return `It is ${at} on a weekday.`;
  const names = days.map((d) => DAY_NAMES[d] ?? "");
  const list = names.length <= 2 ? names.join(" or ") : `${names.slice(0, -1).join(", ")}, or ${names[names.length - 1]}`;
  return `It is ${at} on a ${list}.`;
}

/** Where Valet works, as the end of `It works in …` or `It replies in …`. */
export function whereWords(where: AssistantThreadPolicy | null, subjectKind: SubjectKind | null, title: string | undefined): string {
  if (where === null) return "a thread you pick";
  switch (where.mode) {
    case "new":
      return "a new thread";
    case "subject":
      return `the thread for its ${subjectKind ?? "place"}`;
    case "own":
      return "its own thread";
    case "existing":
      return title !== undefined && title.trim().length > 0 ? title : "the thread you picked";
  }
}

function upperFirst(words: string): string {
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Three steps that show what happens, from the current choices (Part H
 * step 8). `when` is the When clause in words, `workflow` the picked
 * workflow's name.
 */
export function exampleSteps(draft: Draft, words: { when: string; workflow?: string }): [string, string, string] {
  const routine = draft.service === "schedule";
  const instructions = draft.instructions.trim().length > 0;
  const first = routine ? scheduleMoment(draft.schedule) : `${upperFirst(words.when.trim())}.`;
  const what = draft.service === "slack" ? "the message" : "the event";
  const second = routine
    ? instructions ? "Valet reads your instructions." : "Valet starts the work."
    : instructions ? `Valet reads ${what} and your instructions.` : `Valet reads ${what}.`;
  const as = routine ? "" : `, as ${draft.appearance.displayName?.trim() || "Valet"}`;
  if (draft.doKind === "workflow") {
    return [first, second.replace(" and your instructions", ""), `It runs ${words.workflow ?? "the workflow"}${as}.`];
  }
  const where = whereWords(effectiveWhere(draft), draftSubjectKind(draft), draft.whereTitle);
  const verb = draft.doKind === "reply" ? "replies" : "works";
  return [first, second, `It ${verb} in ${where}${as}.`];
}

/** True when the line answers through a team's assistant: the server then
 * adds no creator scope (`enforceMentionScope`'s `teamAssistant`). */
function teamAssistantDraft(draft: Draft): boolean {
  return draft.doKind !== "workflow" && draft.assistant === "team" && draft.teamId !== null;
}

/**
 * The placeholder names in a template, or null for one the server cannot
 * read (an unclosed or nested `{{`). It mirrors `scanPlaceholders` in
 * packages/api/src/events/prompt-template.ts.
 */
function placeholderNames(value: string): string[] | null {
  const names: string[] = [];
  let from = 0;
  for (;;) {
    const open = value.indexOf("{{", from);
    if (open === -1) return names;
    const close = value.indexOf("}}", open + 2);
    if (close === -1) return null;
    const nextOpen = value.indexOf("{{", open + 2);
    if (nextOpen !== -1 && nextOpen < close) return null;
    names.push(value.slice(open + 2, close).trim());
    from = close + 2;
  }
}

/** Every name a template may use: `VARIABLE_RE` in prompt-template.ts. */
const VARIABLE_RE = /^(event\.(key|summary|body)|refs\.[A-Za-z0-9_-]+|payload\.[A-Za-z0-9_-]+)$/;

/** The one name the instructions (`systemPrompt`) accept: `INSTRUCTION_VARIABLE_RE` in prompt-template.ts. */
const INSTRUCTION_VARIABLE = "event.key";

function unknownVariable(name: string): string {
  return `{{${name}}} is not a variable. Use event.key, event.summary, event.body, refs.<name>, or payload.<field>.`;
}

/**
 * The refusal the server gives for the line's two templates, in the
 * editor's words (`validatePromptTemplate` in prompt-template.ts).
 * `services` is the event catalog; while it is empty, the payload check waits.
 */
function templateBlocker(draft: Draft, services: readonly CatalogService[]): string | null {
  const instructions = draft.instructions.trim();
  if (instructions.length > 0) {
    const names = placeholderNames(instructions);
    if (names === null) return "The instructions have an unclosed or nested {{. Close each {{ with }}.";
    const unknown = names.find((name) => !VARIABLE_RE.test(name));
    if (unknown !== undefined) return unknownVariable(unknown);
    // The api accepts these names, but only in the Event message.
    const bad = names.find((name) => name !== INSTRUCTION_VARIABLE);
    if (bad !== undefined) return `Instructions cannot use event variables. Move {{${bad}}} to the Event message.`;
  }
  const message = draft.promptTemplates.userPromptTemplate.trim();
  if (message.length > 0) {
    const names = placeholderNames(message);
    if (names === null) return "The Event message has an unclosed or nested {{. Close each {{ with }}.";
    const unknown = names.find((name) => !VARIABLE_RE.test(name));
    if (unknown !== undefined) return unknownVariable(unknown);
    if (services.length > 0) {
      const carried = new Set(unionFilterFields([...services], draft.events).map((f) => f.field));
      const missing = names.find((name) => name.startsWith("payload.") && !carried.has(name.slice("payload.".length)));
      if (missing !== undefined) {
        return `No picked event carries {{${missing}}}. Remove it from the Event message, or pick an event that carries it.`;
      }
    }
  }
  return null;
}

/** The reason Create or Save stays off, or null when the draft is ready.
 * `services` is the event catalog, for the Event message's payload check. */
export function saveBlocker(
  draft: Draft,
  mode: EditorMode,
  context: { connected: boolean; services?: readonly CatalogService[] },
): string | null {
  const routine = draft.service === "schedule";
  if (mode.kind === "create" && !routine && !context.connected) return "Connect the service first.";
  if (routine) {
    if (scheduleCron(draft.schedule).length === 0) {
      return draft.schedule.days.size === 0 ? "Pick at least one day." : "Enter a time, such as 09:00.";
    }
  } else {
    if (draft.threadFollow && draftThread(draft) === null) return "Paste the thread's link.";
    if (draft.events.size === 0) return "Pick at least one event.";
    const filters = toWireFilters([...draft.conditions]);
    const scoped = hasChannelScopeFilter(filters);
    if (draft.anyChannel && scoped) return "Turn off Any channel or remove the channel condition.";
    const mention = selectsSlackMention([...draft.events]);
    // The server adds the creator as a user condition, and it applies to
    // every event of the line (`enforceMentionScope` in mention-scope.ts).
    if (mention && [...draft.events].some((key) => key !== SLACK_APP_MENTION)) {
      return "A mention line can only listen for mentions. Uncheck the other events or the mention.";
    }
    if (mention && !draft.anyChannel && !scoped) {
      // A name condition also matches channels created later (`enforceMentionScope`).
      return filters.some((f) => f.field === "channel_name")
        ? "A channel name condition also matches new channels. Choose Any channel to keep it."
        : "Add a channel, or choose Any channel.";
    }
    if (mention && !teamAssistantDraft(draft) && draft.conditions.some((row) => row.field === "user" && row.id !== draft.creatorScopeId)) {
      return "A personal mention line already listens for your own mentions. Remove the user condition.";
    }
    // Only a mention starts a conversation to reply in; a stored Reply on
    // any other event would come back as Work on it. A stored line locks Do,
    // so its only way out is the mention.
    if (draft.doKind === "reply" && !mention) {
      return mode.kind === "create"
        ? "Reply answers a mention. Pick the mention in When, or choose Work on it."
        : "Reply answers a mention. Keep the mention picked in When.";
    }
  }
  if (draft.doKind === "workflow" && draft.workflowId.length === 0) return "Pick a workflow.";
  if (routine && draft.doKind === "workflow" && parseRunInput(draft.runInput).kind === "bad") return "The run input is not valid JSON.";
  if (draft.doKind !== "workflow" && effectiveWhere(draft) === null) return "Pick a thread for Where, or choose another option.";
  if (routine && draft.doKind !== "workflow" && draft.instructions.trim().length === 0) return "Give the routine instructions.";
  if (!routine && draft.doKind !== "workflow") {
    const template = templateBlocker(draft, context.services ?? []);
    if (template !== null) return template;
  }
  if (!routine) {
    const appearanceError = validateAppearance(draft.appearance);
    if (appearanceError) return appearanceError;
  }
  if (draft.name.trim().length === 0) return "Give it a name.";
  return null;
}

/** A stable text form of the draft, to tell an edited draft from the one it opened on. */
export function draftKey(draft: Draft): string {
  return JSON.stringify({
    ...draft,
    events: [...draft.events].sort(),
    schedule: { ...draft.schedule, days: [...draft.schedule.days].sort() },
    conditions: draft.conditions.map((row) => ({ ...row, id: undefined })),
    // Row ids are new on every read of a stored row, so the creator scope
    // reads as its position.
    creatorScopeId: draft.conditions.findIndex((row) => row.id === draft.creatorScopeId),
    placeRow: undefined,
  });
}
