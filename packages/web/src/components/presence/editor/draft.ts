/**
 * The editor's draft (docs/specs/2026-10-16-presence-hub-design.md Part H).
 * One state type holds a line or a routine while the reader edits it. Pure
 * functions fill it from a stored line or routine, change it, and turn it
 * into the exact create or patch body that the old wizard and edit dialogs
 * sent. The side pane reads its sentence from that body, so the sentence
 * equals the stored sentence (INV-H7).
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
import { selectsSlackMention, hasChannelScopeFilter, storedAnyChannel } from "~/lib/slack-mention";
import { placeFilter, type PreselectedPlace } from "../place-filter";
import type { Routine } from "../routine-helpers";
import {
  isCreatorScopeFilter,
  partsText,
  type RoutineLike,
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

/** What the editor opens on. */
export type EditorMode =
  | { kind: "create"; preselected?: { place?: PreselectedPlace; workflowId?: string; schedule?: boolean } }
  | { kind: "edit"; line: EventSubscriptionWire }
  | { kind: "edit-routine"; routine: Routine }
  | { kind: "review"; line: EventSubscriptionWire; replaces?: { id: string; name: string } };

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
  doKind: DoKind;
  workflowId: string;
  assistant: AssistantKind;
  teamId: string | null;
  /** Who may mention a team assistant. Sent only for a team reply line. */
  audience: EventSubscriptionAudienceWire;
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
  const { preselected, teamId, timezone } = options;
  const place = preselected?.place;
  const placeRow = placeRowFor(place);
  const service: EditorService = preselected?.schedule ? "schedule" : place !== undefined && isWhen(place.service) ? place.service : "slack";
  const workflowId = preselected?.workflowId;
  return {
    service,
    schedule: defaultSchedule(timezone),
    events: new Set(),
    conditions: placeRow !== null ? [placeRow] : [],
    creatorScopeId: null,
    placeRow,
    placeRemoved: false,
    anyChannel: false,
    doKind: workflowId !== undefined ? "workflow" : service === "slack" ? "reply" : "work",
    workflowId: workflowId ?? "",
    assistant: teamId !== undefined ? "team" : "user",
    teamId: teamId ?? null,
    audience: "organization",
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

/** The stored creator scope row of a mention line (see the edit dialog). */
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
    doKind: target.kind === "workflow" ? "workflow" : target.follow === true ? "reply" : "work",
    workflowId: target.kind === "workflow" ? target.workflowId : "",
    assistant: assistant ? target.assistant ?? "user" : sub.ownerType === "team" ? "team" : sub.ownerType === "org" ? "org" : "user",
    teamId: assistant ? target.teamId ?? (sub.ownerType === "team" ? sub.ownerId : null) : null,
    audience: sub.audience ?? "organization",
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
    doKind: workflow ? "workflow" : "work",
    workflowId: routine.workflowId ?? "",
    assistant: detail.ownerType === "team" ? "team" : "user",
    teamId: detail.ownerType === "team" ? detail.ownerId : null,
    audience: "organization",
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
 * service, so they go, and a preselected place does not come back (Review
 * Focus 4). Do keeps a choice the new service offers.
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
    placeRemoved: draft.placeRow !== null ? true : draft.placeRemoved,
    anyChannel: false,
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
 */
export function toggleEvent(draft: Draft, key: string, services: readonly CatalogService[]): Draft {
  const events = new Set(draft.events);
  if (events.has(key)) events.delete(key);
  else events.add(key);
  const fields = unionFilterFields([...services], events);
  let conditions = pruneFilterRows([...draft.conditions], fields);
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
  return { ...draft, events, conditions, creatorScopeId, anyChannel: selectsSlackMention([...events]) ? draft.anyChannel : false };
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

export function addCondition(draft: Draft, row: UiFilterRow): Draft {
  return { ...draft, conditions: [...draft.conditions, row] };
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
  if (draft.service === "schedule") return { mode: "own" };
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

/** True when a stored or created mention line hears only its creator. */
export function hasCreatorScope(draft: Draft, mode: EditorMode): boolean {
  if (draft.service === "schedule" || !selectsSlackMention([...draft.events])) return false;
  if (mode.kind === "create") return draft.assistant !== "team";
  return draft.creatorScopeId !== null;
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
  return { ...base, ...appearance, follow: draft.doKind === "reply", ...thread, ...templates, ...delivery };
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

function patchLineBody(draft: Draft, sub: EventSubscriptionWire, review: boolean): PatchEventSubscriptionRequest {
  const assistant = sub.target.kind === "assistant";
  const where = effectiveWhere(draft);
  const body = buildSubscriptionPatch(sub, {
    name: draft.name,
    eventKeys: [...draft.events],
    filters: toWireFilters([...draft.conditions]),
    anyChannel: draft.anyChannel,
    prompts: { systemPrompt: draft.instructions, userPromptTemplate: draft.promptTemplates.userPromptTemplate },
    appearance: draft.appearance,
    ...(assistant && where !== null ? { thread: where } : {}),
    ...(sub.ownerType === "user" && assistant
      ? { deliveryPreferences: { deliveryPolicy: draft.deliveryPolicy, pauseOnOverlap: draft.pauseOnOverlap } }
      : {}),
  }) ?? {};
  return review && !sub.enabled ? { ...body, enabled: true } : body;
}

function createRoutineBody(draft: Draft): CreateWorkflowScheduleRequest {
  const base = { name: draft.name.trim(), cron: scheduleCron(draft.schedule), timezone: draft.schedule.timezone.trim() };
  if (draft.doKind === "workflow") return { ...base, target: { kind: "workflow", workflowId: draft.workflowId } };
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
export function applyRoutinePatch(routine: Routine, patch: UpdateWorkflowScheduleRequest): RoutineLike {
  const thread = patch.thread === undefined ? routine.detail.thread : patch.thread ?? undefined;
  return {
    name: patch.name ?? routine.name,
    ...(routine.workflowId !== undefined ? { workflowId: routine.workflowId } : {}),
    detail: {
      cron: patch.cron ?? routine.detail.cron,
      timezone: patch.timezone ?? routine.detail.timezone,
      targetKind: routine.detail.targetKind,
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

/** The reason Create or Save stays off, or null when the draft is ready. */
export function saveBlocker(draft: Draft, mode: EditorMode, context: { connected: boolean }): string | null {
  const routine = draft.service === "schedule";
  if (mode.kind === "create" && !routine && !context.connected) return "Connect the service first.";
  if (routine) {
    if (scheduleCron(draft.schedule).length === 0) return "Pick at least one day.";
  } else {
    if (draft.events.size === 0) return "Pick at least one event.";
    const filters = toWireFilters([...draft.conditions]);
    if (selectsSlackMention([...draft.events]) && !draft.anyChannel && !hasChannelScopeFilter(filters)) {
      return "Add a channel, or choose Any channel.";
    }
  }
  if (draft.doKind === "workflow" && draft.workflowId.length === 0) return "Pick a workflow.";
  if (draft.doKind !== "workflow" && effectiveWhere(draft) === null) return "Pick a thread for Where, or choose another option.";
  if (routine && draft.doKind !== "workflow" && draft.instructions.trim().length === 0) return "Give the routine instructions.";
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
    placeRow: undefined,
  });
}
