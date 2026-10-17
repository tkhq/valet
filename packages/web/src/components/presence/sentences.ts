/**
 * The one-sentence rows of the Presence hub, as pure functions
 * (docs/specs/2026-10-16-presence-hub-design.md Part C step 1, Part D step 1,
 * Part E step 1, Part F step 1). A line of presence, a routine, and an
 * activity row each read as one sentence, so the rules are tested without a
 * render.
 *
 * Copy here uses only the left column of the spec's Terminology table.
 */
import type { Appearance, AssistantThreadPolicy } from "@valet/shared";
import type {
  EventDeliveryThreadRef,
  EventDeliveryWire,
  EventSubscriptionFilterWire,
  EventSubscriptionWire,
  GetWorkflowTriggerCatalogResponse,
} from "@valet/api/wire";
import { deliveryStatusLine } from "~/components/events/delivery-copy";
import {
  displayThreadPolicy,
  ownOptionLabel,
  subjectKindForKeys,
  subjectOptionLabel,
  type RuleKind,
  type SubjectKind,
} from "./thread-policy-copy";

/** Thread titles by thread id. A thread that is not here reads as a generic name. */
export type ThreadTitles = Readonly<Record<string, { title: string | null | undefined }>>;

/** The workflows a sentence may name, by id. */
export type WorkflowNames = ReadonlyArray<{ id: string; name: string }>;

type Catalog = GetWorkflowTriggerCatalogResponse["catalog"];

/**
 * Where a line's or a routine's deliveries land, as one phrase for the **Runs in** control.
 * `threadTitle` names an `existing` thread; without it the phrase falls back
 * to a generic name.
 */
export function runsInLabel(
  policy: AssistantThreadPolicy,
  subjectKind: SubjectKind | null,
  ruleKind: RuleKind,
  threadTitle?: string,
): string {
  switch (policy.mode) {
    case "new":
      return "A new thread each time";
    case "subject":
      return subjectOptionLabel(subjectKind);
    case "own":
      return ownOptionLabel(ruleKind);
    case "existing":
      return hasText(threadTitle) ? `The thread ${threadTitle}` : "The thread you picked";
  }
}

function hasText(value: string | null | undefined): value is string {
  return value !== undefined && value !== null && value.trim().length > 0;
}

function threadTitle(threads: ThreadTitles, threadId: string): string | undefined {
  const title = threads[threadId]?.title;
  return hasText(title) ? title : undefined;
}

function workflowName(workflows: WorkflowNames, workflowId: string | undefined): string | undefined {
  if (workflowId === undefined) return undefined;
  return workflows.find((w) => w.id === workflowId)?.name;
}

// ── Events in words ─────────────────────────────────────────────────────

/**
 * Short names for the common event keys. `when` is the clause after "When"
 * in a sentence, split into its actor and verb so that two events with one
 * verb share it ("a pull request review or a check completes"). `one` leads
 * an activity row ("Mention in #incidents"). A key that is not here falls
 * back to the event picker's label.
 */
const EVENT_WORDS: Readonly<Record<string, { when: readonly [string, string]; one: string }>> = {
  "slack.app_mention": { when: ["someone", "mentions Valet"], one: "Mention" },
  "slack.message": { when: ["someone", "posts a message"], one: "Message" },
  "slack.bot_message": { when: ["an app", "posts a message"], one: "App message" },
  "slack.reaction_added": { when: ["someone", "adds a reaction"], one: "Added reaction" },
  "slack.reaction_removed": { when: ["someone", "removes a reaction"], one: "Removed reaction" },
  "github.issue_comment.created": { when: ["someone", "comments"], one: "Comment" },
  "github.pull_request_review_comment.created": { when: ["someone", "leaves a review comment"], one: "Review comment" },
  "github.pull_request_review.submitted": { when: ["a pull request review", "completes"], one: "Pull request review" },
  "github.pull_request.opened": { when: ["a pull request", "opens"], one: "Opened pull request" },
  "github.pull_request.ready_for_review": { when: ["a pull request", "is ready for review"], one: "Pull request ready for review" },
  "github.pull_request.synchronize": { when: ["someone", "pushes to a pull request"], one: "Pull request push" },
  "github.check_run.completed": { when: ["a check", "completes"], one: "Completed check" },
  "github.check_suite.completed": { when: ["a check", "completes"], one: "Completed check" },
  "github.pull_request.checks_completed": { when: ["a check", "completes"], one: "Completed check" },
  "github.workflow_run.completed": { when: ["a workflow run", "completes"], one: "Completed workflow run" },
  "linear.issue.create": { when: ["an issue", "is created"], one: "New issue" },
};

/** "github.workflow_run.completed" → "Workflow run completed". */
function keyInWords(key: string): string {
  const rest = key.includes(".") ? key.slice(key.indexOf(".") + 1) : key;
  const words = rest.replace(/[._*]+/g, " ").trim();
  if (words.length === 0) return key;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

/** The event picker's label for a key, without its leading "When ". */
function pickerLabel(key: string, catalog: Catalog | undefined): string | undefined {
  for (const service of catalog ?? []) {
    const entry = service.entries.find((e) => e.key === key);
    if (entry && hasText(entry.description)) {
      return lowerFirst(entry.description.replace(/^when\s+/i, "").replace(/\.$/, ""));
    }
  }
  return undefined;
}

/** One event as an actor and a verb. A picker label or a key in words is one clause with no verb to share. */
function eventClause(key: string, catalog: Catalog | undefined): readonly [string, string] {
  const known = EVENT_WORDS[key]?.when;
  if (known) return known;
  return [pickerLabel(key, catalog) ?? `${lowerFirst(keyInWords(key))} happens`, ""];
}

/** Joins items as `a`, `a or b`, or `a, b, or c`. */
function joinOr(items: readonly string[]): string {
  if (items.length <= 2) return items.join(" or ");
  return `${items.slice(0, -1).join(", ")}, or ${items[items.length - 1]}`;
}

/**
 * The events after "When": each a clause, joined by "or". An event drops its
 * verb when the next event has the same verb, so the verb is said once.
 */
function eventsInWords(keys: readonly string[], catalog: Catalog | undefined): string {
  const clauses: Array<readonly [string, string]> = [];
  for (const key of keys) {
    const clause = eventClause(key, catalog);
    if (!clauses.some(([actor, verb]) => actor === clause[0] && verb === clause[1])) clauses.push(clause);
  }
  const words = clauses.map(([actor, verb], i) => {
    const next = clauses[i + 1];
    const shared = verb.length > 0 && next !== undefined && next[1] === verb;
    return shared || verb.length === 0 ? actor : `${actor} ${verb}`;
  });
  return joinOr(words);
}

/** One event, as the lead of an activity row. */
export function eventInWords(eventKey: string | null | undefined): string {
  if (!hasText(eventKey)) return "Event";
  return EVENT_WORDS[eventKey]?.one ?? keyInWords(eventKey);
}

/**
 * True when the keys carry a conversation the assistant answers: Slack
 * mentions, messages, and direct messages, and pull request comments.
 */
export function isConversational(keys: readonly string[]): boolean {
  return keys.some(
    (k) =>
      k === "slack.app_mention" ||
      k === "slack.message" ||
      k.startsWith("slack.message.") ||
      k === "slack.*" ||
      k.startsWith("github.issue_comment.") ||
      k.startsWith("github.pull_request_review_comment."),
  );
}

// ── Places in words ─────────────────────────────────────────────────────

type Service = "slack" | "github" | "linear";

function serviceOf(keys: readonly string[]): Service | null {
  for (const key of keys) {
    if (key.startsWith("slack.")) return "slack";
    if (key.startsWith("github.")) return "github";
    if (key.startsWith("linear.")) return "linear";
  }
  return null;
}

/** Filter fields that name a place, per service, most specific first. */
const PLACE_FIELDS: Readonly<Record<Service, readonly string[]>> = {
  slack: ["channel"],
  github: ["repo"],
  linear: ["identifier", "team"],
};

/** The place a line listens in when no filter names one. */
const ANY_PLACE: Readonly<Record<Service, string>> = {
  slack: "any channel",
  github: "any repository",
  linear: "any team",
};

/** Filter fields that name who sent the event. */
const SENDER_FIELDS: readonly string[] = ["user", "sender", "creator"];

function filterValues(filter: EventSubscriptionFilterWire): string[] {
  if (Array.isArray(filter.value)) {
    return filter.value.map((v, i) => (hasText(filter.labels?.[i]) ? (filter.labels?.[i] ?? v) : v));
  }
  return [hasText(filter.label) ? filter.label : filter.value];
}

function presencePlace(service: Service | null, filters: readonly EventSubscriptionFilterWire[]): string | null {
  if (service === null) return null;
  for (const field of PLACE_FIELDS[service]) {
    const filter = filters.find((f) => f.field === field && (f.op === "eq" || f.op === "in"));
    if (filter) {
      const values = filterValues(filter);
      if (values.length > 0) return joinOr(values);
    }
  }
  return ANY_PLACE[service];
}

function senderFilter(filters: readonly EventSubscriptionFilterWire[]): string | null {
  const filter = filters.find((f) => SENDER_FIELDS.includes(f.field) && f.op === "eq");
  if (!filter) return null;
  const values = filterValues(filter);
  return values.length === 1 ? (values[0] ?? null) : null;
}

/** An event's place from its refs: `#channel`, `acme/api#12`, `ENG-42`. */
export function eventPlace(refs: Readonly<Record<string, string>> | null | undefined): string | null {
  if (!refs) return null;
  if (hasText(refs.channel_name)) return `#${refs.channel_name}`;
  if (hasText(refs.channel)) return refs.channel;
  if (hasText(refs.repo)) {
    const number = refs.pull_request ?? refs.issue;
    return hasText(number) ? `${refs.repo}#${number}` : refs.repo;
  }
  if (hasText(refs.identifier)) return refs.identifier;
  if (hasText(refs.team)) return refs.team;
  return null;
}

// ── Lines of presence ───────────────────────────────────────────────────

function pinnedThread(threads: ThreadTitles, threadId: string): string {
  const title = threadTitle(threads, threadId);
  return title === undefined ? "the pinned thread" : `the ${title} thread`;
}

/** The `<do>` of a line (spec Part C step 2). */
function presenceDoes(sub: EventSubscriptionWire, workflows: WorkflowNames, threads: ThreadTitles): string {
  const target = sub.target;
  if (target.kind === "workflow") {
    return `run ${workflowName(workflows, target.workflowId) ?? "a workflow"}`;
  }
  // An absent policy on conversational keys replies in a new thread per
  // delivery (delivery threads spec Part A).
  if ((target.thread === undefined || target.thread === null) && isConversational(sub.eventKeys)) {
    return "reply in a new thread";
  }
  const policy = displayThreadPolicy(target, sub.eventKeys);
  switch (policy.mode) {
    case "new":
      return isConversational(sub.eventKeys) ? "reply in a new thread" : "work in a new thread each time";
    case "subject":
      return `work in one thread per ${subjectKindForKeys(sub.eventKeys) ?? "place"}`;
    case "own":
      return "work in its own thread";
    case "existing":
      return `work in ${pinnedThread(threads, policy.threadId)}`;
  }
}

function appearancePart(appearance: Appearance | undefined): string {
  return hasText(appearance?.displayName) ? `, as ${appearance.displayName}` : "";
}

/**
 * A line of presence as one sentence:
 * `When <events>[ from <sender>] <in|on> <place>, <do>[, as <appearance>].`
 * `in` for Slack and Linear, `on` for GitHub. Without a place:
 * `When <events>[ from <sender>], <do>[, as <appearance>].`
 */
export function presenceSentence(
  sub: EventSubscriptionWire,
  catalog: Catalog | undefined,
  workflows: WorkflowNames,
  threads: ThreadTitles,
): string {
  const service = serviceOf(sub.eventKeys);
  const place = presencePlace(service, sub.filters);
  const where = place === null ? "" : ` ${service === "github" ? "on" : "in"} ${place}`;
  const sender = senderFilter(sub.filters);
  const from = sender === null ? "" : ` from ${sender}`;
  const events = eventsInWords(sub.eventKeys, catalog);
  return `When ${events}${from}${where}, ${presenceDoes(sub, workflows, threads)}${appearancePart(sub.target.appearance)}.`;
}

// ── Routines ────────────────────────────────────────────────────────────

/** The fields of a schedule row that its sentence reads. */
export interface RoutineLike {
  name: string;
  workflowId?: string;
  detail: {
    cron: string;
    /** IANA name. A zone other than UTC follows the schedule words. */
    timezone?: string;
    targetKind: "workflow" | "assistant";
    thread?: AssistantThreadPolicy;
  };
}

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function clock(hour: number, minute: number): string {
  return `${hour}:${String(minute).padStart(2, "0")}`;
}

function intIn(text: string, min: number, max: number): number | null {
  if (!/^\d+$/.test(text)) return null;
  const n = Number(text);
  return n >= min && n <= max ? n : null;
}

/**
 * A five-field cron expression in words, for the common shapes. Any other
 * expression is shown as it is, so the sentence never states a wrong time.
 */
export function cronInWords(cron: string): string {
  const parts = cron.trim().split(/\s+/);
  const fallback = `On the schedule ${cron.trim()}`;
  if (parts.length !== 5) return fallback;
  const [min = "", hour = "", dom = "", month = "", dow = ""] = parts;
  const every = /^\*\/(\d+)$/.exec(min);
  if (every && hour === "*" && dom === "*" && month === "*" && dow === "*") {
    return `Every ${every[1]} minutes`;
  }
  const m = intIn(min, 0, 59);
  if (m === null || month !== "*") return fallback;
  if (hour === "*" && dom === "*" && dow === "*") return `Every hour at ${m} minutes past`;
  const h = intIn(hour, 0, 23);
  if (h === null) return fallback;
  const at = clock(h, m);
  if (dom === "*" && dow === "*") return `Every day at ${at}`;
  if (dom === "*" && dow === "1-5") return `Every weekday at ${at}`;
  if (dom === "*") {
    const d = intIn(dow, 0, 7);
    return d === null ? fallback : `Every ${DAYS[d % 7]} at ${at}`;
  }
  const day = intIn(dom, 1, 31);
  if (day !== null && dow === "*") return `On day ${day} of every month at ${at}`;
  return fallback;
}

/** The `<do>` of a routine (spec Part E step 1). */
function routineDoes(routine: RoutineLike, workflows: WorkflowNames, threads: ThreadTitles): string {
  if (routine.detail.targetKind === "workflow") {
    return `run ${workflowName(workflows, routine.workflowId) ?? "a workflow"}`;
  }
  const policy = routine.detail.thread ?? { mode: "own" };
  switch (policy.mode) {
    case "new":
      return "work in a new thread each time";
    case "existing":
      return `work in ${pinnedThread(threads, policy.threadId)}`;
    // A routine has no subject; the server refuses `subject`, so it reads as `own`.
    case "subject":
    case "own":
      return "work in its own thread";
  }
}

/** The schedule in words, with the timezone in parentheses when it is not UTC. */
function scheduleInWords(cron: string, timezone: string | undefined): string {
  const words = cronInWords(cron);
  return timezone === undefined || timezone === "UTC" || timezone === "Etc/UTC" ? words : `${words} (${timezone})`;
}

/** A routine as one sentence: `<schedule in words>, <name>: <do>.` */
export function routineSentence(routine: RoutineLike, workflows: WorkflowNames, threads: ThreadTitles): string {
  return `${scheduleInWords(routine.detail.cron, routine.detail.timezone)}, ${routine.name}: ${routineDoes(routine, workflows, threads)}.`;
}

// ── Activity ────────────────────────────────────────────────────────────

/** The fields of an event that its activity sentence reads. */
export interface ActivityEvent {
  eventKey: string | null;
  refs?: Readonly<Record<string, string>> | null;
}

export interface ActivityNames {
  threads?: ThreadTitles;
  /** The workflow a workflow delivery started. */
  workflowName?: string;
  /** Workflow names by subscription id, for a row whose deliveries reach several workflows. */
  workflowsByListener?: Readonly<Record<string, string>>;
  /** The place, when the caller knows a better name than the event's refs give. */
  place?: string;
}

/** A thread an outcome names, with the words a reader sees for it. */
export interface ActivityThread {
  ref: EventDeliveryThreadRef;
  label: string;
}

/**
 * One delivery's outcome in an activity row. With `thread`, the outcome
 * reads `<words> <thread label>`, and a renderer can link the label.
 * `runId` names the workflow run the outcome started.
 */
export interface ActivityOutcome {
  words: string;
  thread?: ActivityThread;
  runId?: string;
}

/** The server's skip text for a claim whose thread this viewer may not open. */
const CLAIMED_ELSEWHERE = /^skipped, claimed by (another )?thread\b/i;

/** A status line as the tail of a sentence: first letter lower case, no final period. */
function asTail(line: string): string {
  return lowerFirst(line.replace(/\.$/, ""));
}

function skipReason(delivery: EventDeliveryWire): string {
  // Reuse the delivery list's wording, without its leading "Skipped".
  const line = deliveryStatusLine(delivery, 0).replace(/^skipped(,| by)?\s*/i, "");
  return asTail(line.length > 0 ? line : "delivery preferences");
}

function activityThread(ref: EventDeliveryThreadRef, threads: ThreadTitles): ActivityThread {
  const title = hasText(ref.title) ? ref.title : threadTitle(threads, ref.threadId);
  return { ref, label: title ?? "a thread" };
}

function deliveryOutcome(event: ActivityEvent, delivery: EventDeliveryWire, names: ActivityNames): ActivityOutcome {
  const threads = names.threads ?? {};
  const workflow = names.workflowName ?? names.workflowsByListener?.[delivery.subscriptionId];
  if (delivery.claimedBy) return { words: "claimed by", thread: activityThread(delivery.claimedBy, threads) };
  if (delivery.status === "skipped") {
    // A claim by a thread this viewer may not open never shows the thread's id.
    if (delivery.lastError && CLAIMED_ELSEWHERE.test(delivery.lastError)) return { words: "claimed by another thread" };
    return { words: `skipped: ${skipReason(delivery)}` };
  }
  if (delivery.runId !== undefined) return { words: `started ${workflow ?? "a workflow"} run`, runId: delivery.runId };
  if (delivery.status === "delivered") {
    if (delivery.thread) {
      const conversational = event.eventKey !== null && isConversational([event.eventKey]);
      return { words: conversational ? "replied in" : "delivered to", thread: activityThread(delivery.thread, threads) };
    }
    if (workflow !== undefined) return { words: `started ${workflow} run` };
    return { words: "delivered" };
  }
  // Pending, failed, or dead: say what the delivery list says.
  return { words: asTail(deliveryStatusLine(delivery, Date.now())) };
}

/** The lead of an activity row: `<event in words>[ in <place>]`. */
export function activityLead(event: ActivityEvent, names: ActivityNames = {}): string {
  const place = names.place ?? eventPlace(event.refs);
  return `${eventInWords(event.eventKey)}${place === null ? "" : ` in ${place}`}`;
}

/** Each delivery's outcome, in order. No delivery reads `no one listening`. */
export function activityOutcomes(
  event: ActivityEvent,
  delivery: EventDeliveryWire | readonly EventDeliveryWire[] | null,
  names: ActivityNames = {},
): ActivityOutcome[] {
  const deliveries: readonly EventDeliveryWire[] = delivery === null ? [] : Array.isArray(delivery) ? delivery : [delivery];
  if (deliveries.length === 0) return [{ words: "no one listening" }];
  return deliveries.map((d) => deliveryOutcome(event, d, names));
}

/** One outcome as text. */
export function outcomeText(outcome: ActivityOutcome): string {
  return outcome.thread ? `${outcome.words} ${outcome.thread.label}` : outcome.words;
}

/**
 * An activity row as one sentence: `<event in words> in <place> → <outcome>`.
 * The outcome is `replied in <thread>`, `delivered to <thread>`, `claimed by
 * <thread>`, `started <workflow> run`, `skipped: <reason>`, or `no one listening`.
 * Several deliveries join their outcomes with commas.
 */
export function activitySentence(
  event: ActivityEvent,
  delivery: EventDeliveryWire | readonly EventDeliveryWire[] | null,
  names: ActivityNames = {},
): string {
  return `${activityLead(event, names)} → ${activityOutcomes(event, delivery, names).map(outcomeText).join(", ")}`;
}
