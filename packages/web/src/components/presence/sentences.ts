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

/** What the event words read from a catalog: each entry's key and description. */
type EventDescriptions = ReadonlyArray<{ entries: ReadonlyArray<{ key: string; description?: string }> }>;

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

// ── Parts ───────────────────────────────────────────────────────────────

/** The services a sentence can name a place in. */
export type SentenceService = "slack" | "github" | "linear";

/**
 * One piece of a sentence. A text part is plain words. The other kinds name
 * a thing the reader can recognize, and a renderer shows each as a token
 * (`Ref`): a place (`#incidents`, `acme/api`), a thread, a workflow, or a
 * person. `subject` is the place key the places API reads.
 */
export type SentencePart =
  | { kind: "text"; text: string }
  | { kind: "place"; text: string; service: SentenceService; subject: string }
  | { kind: "thread"; text: string; sessionId?: string; threadId?: string }
  | { kind: "workflow"; text: string; id: string }
  | { kind: "person"; text: string };

/** The people a sentence may name. `members` maps a user id to a display name; `me` is the viewer's user id. */
export interface SentenceNames {
  members?: Readonly<Record<string, string>>;
  me?: string;
}

/** A text part. */
export function text(words: string): SentencePart {
  return { kind: "text", text: words };
}

/** The parts as one string. */
export function partsText(parts: readonly SentencePart[]): string {
  return parts.map((p) => p.text).join("");
}

/** Joins neighbor text parts and drops empty ones, so a renderer gets the fewest nodes. */
export function tidy(parts: readonly SentencePart[]): SentencePart[] {
  const out: SentencePart[] = [];
  for (const part of parts) {
    if (part.kind === "text" && part.text.length === 0) continue;
    const last = out[out.length - 1];
    if (part.kind === "text" && last?.kind === "text") out[out.length - 1] = text(last.text + part.text);
    else out.push(part);
  }
  return out;
}

/** Joins groups of parts as `a`, `a or b`, or `a, b, or c`. */
function joinPartsOr(groups: readonly (readonly SentencePart[])[]): SentencePart[] {
  const out: SentencePart[] = [];
  groups.forEach((group, i) => {
    if (i > 0) out.push(text(groups.length <= 2 ? " or " : i === groups.length - 1 ? ", or " : ", "));
    out.push(...group);
  });
  return out;
}

// ── Events in words ─────────────────────────────────────────────────────

/**
 * Short names for every event key the GitHub, Linear, and Slack catalogs
 * publish. `when` is the clause after "When" in a sentence, split into its
 * actor and verb so that two events with one verb share it ("a pull request
 * review or a check completes"). `one` leads an activity row ("Mention in
 * #incidents"). A key that is not here falls back to words derived from the
 * key (`derivedClause`).
 */
const EVENT_WORDS: Readonly<Record<string, { when: readonly [string, string]; one: string }>> = {
  "slack.app_mention": { when: ["someone", "mentions Valet"], one: "Mention" },
  "slack.message": { when: ["someone", "posts a message"], one: "Message" },
  "slack.bot_message": { when: ["an app", "posts a message"], one: "App message" },
  "slack.reaction_added": { when: ["someone", "adds a reaction"], one: "Added reaction" },
  "slack.reaction_removed": { when: ["someone", "removes a reaction"], one: "Removed reaction" },
  "slack.member_joined_channel": { when: ["someone", "joins a channel"], one: "Joined channel" },
  "slack.member_left_channel": { when: ["someone", "leaves a channel"], one: "Left channel" },
  "slack.channel_created": { when: ["a channel", "is created"], one: "New channel" },
  "slack.channel_rename": { when: ["a channel", "is renamed"], one: "Renamed channel" },
  "slack.channel_archive": { when: ["a channel", "is archived"], one: "Archived channel" },
  "slack.channel_unarchive": { when: ["a channel", "is unarchived"], one: "Unarchived channel" },
  "slack.file_shared": { when: ["someone", "shares a file"], one: "Shared file" },

  "github.push": { when: ["a push", "lands"], one: "Push" },
  "github.create": { when: ["a branch or tag", "is created"], one: "New branch or tag" },
  "github.delete": { when: ["a branch or tag", "is deleted"], one: "Deleted branch or tag" },
  "github.status": { when: ["a commit status", "changes"], one: "Commit status" },
  "github.pull_request.opened": { when: ["a pull request", "is opened"], one: "Opened pull request" },
  "github.pull_request.closed": { when: ["a pull request", "is closed"], one: "Closed pull request" },
  "github.pull_request.reopened": { when: ["a pull request", "is reopened"], one: "Reopened pull request" },
  "github.pull_request.edited": { when: ["a pull request", "is edited"], one: "Edited pull request" },
  "github.pull_request.labeled": { when: ["a pull request", "is labeled"], one: "Labeled pull request" },
  "github.pull_request.unlabeled": { when: ["a pull request", "loses a label"], one: "Unlabeled pull request" },
  "github.pull_request.ready_for_review": { when: ["a pull request", "is ready for review"], one: "Pull request ready for review" },
  "github.pull_request.synchronize": { when: ["someone", "pushes to a pull request"], one: "Pull request push" },
  "github.pull_request.checks_completed": { when: ["a check", "completes"], one: "Completed check" },
  "github.pull_request_review.submitted": { when: ["a pull request review", "completes"], one: "Pull request review" },
  "github.pull_request_review.edited": { when: ["a pull request review", "is edited"], one: "Edited review" },
  "github.pull_request_review.dismissed": { when: ["a pull request review", "is dismissed"], one: "Dismissed review" },
  "github.pull_request_review_comment.created": { when: ["someone", "leaves a review comment"], one: "Review comment" },
  "github.pull_request_review_comment.edited": { when: ["a review comment", "is edited"], one: "Edited review comment" },
  "github.pull_request_review_comment.deleted": { when: ["a review comment", "is deleted"], one: "Deleted review comment" },
  "github.pull_request_review_thread.resolved": { when: ["a review thread", "is resolved"], one: "Resolved review thread" },
  "github.pull_request_review_thread.unresolved": { when: ["a review thread", "is unresolved"], one: "Unresolved review thread" },
  "github.issues.opened": { when: ["an issue", "is opened"], one: "Opened issue" },
  "github.issues.closed": { when: ["an issue", "is closed"], one: "Closed issue" },
  "github.issues.reopened": { when: ["an issue", "is reopened"], one: "Reopened issue" },
  "github.issues.edited": { when: ["an issue", "is edited"], one: "Edited issue" },
  "github.issues.labeled": { when: ["an issue", "is labeled"], one: "Labeled issue" },
  "github.issues.unlabeled": { when: ["an issue", "loses a label"], one: "Unlabeled issue" },
  "github.issues.assigned": { when: ["an issue", "is assigned"], one: "Assigned issue" },
  "github.issues.unassigned": { when: ["an issue", "is unassigned"], one: "Unassigned issue" },
  "github.issue_comment.created": { when: ["someone", "comments"], one: "Comment" },
  "github.issue_comment.edited": { when: ["a comment", "is edited"], one: "Edited comment" },
  "github.issue_comment.deleted": { when: ["a comment", "is deleted"], one: "Deleted comment" },
  "github.release.published": { when: ["a release", "is published"], one: "Published release" },
  "github.release.created": { when: ["a release", "is created"], one: "New release" },
  "github.release.edited": { when: ["a release", "is edited"], one: "Edited release" },
  "github.release.deleted": { when: ["a release", "is deleted"], one: "Deleted release" },
  "github.workflow_run.completed": { when: ["a workflow run", "completes"], one: "Completed workflow run" },
  "github.workflow_run.requested": { when: ["a workflow run", "is requested"], one: "Requested workflow run" },
  "github.workflow_run.in_progress": { when: ["a workflow run", "starts"], one: "Started workflow run" },
  "github.check_run.completed": { when: ["a check", "completes"], one: "Completed check" },
  "github.check_run.created": { when: ["a check", "starts"], one: "Started check" },
  "github.check_run.rerequested": { when: ["a check", "is run again"], one: "Check run again" },
  "github.check_suite.completed": { when: ["a check", "completes"], one: "Completed check" },
  "github.check_suite.requested": { when: ["a check suite", "is requested"], one: "Requested check suite" },
  "github.check_suite.rerequested": { when: ["a check suite", "is run again"], one: "Check suite run again" },

  "linear.issue.create": { when: ["an issue", "is created"], one: "New issue" },
  "linear.issue.update": { when: ["an issue", "is updated"], one: "Updated issue" },
  "linear.issue.remove": { when: ["an issue", "is removed"], one: "Removed issue" },
  "linear.comment.create": { when: ["someone", "comments on an issue"], one: "Comment" },
  "linear.comment.update": { when: ["a comment", "is edited"], one: "Edited comment" },
  "linear.comment.remove": { when: ["a comment", "is removed"], one: "Removed comment" },
  "linear.project.create": { when: ["a project", "is created"], one: "New project" },
  "linear.project.update": { when: ["a project", "is updated"], one: "Updated project" },
  "linear.project.remove": { when: ["a project", "is removed"], one: "Removed project" },
  "linear.cycle.create": { when: ["a cycle", "is created"], one: "New cycle" },
  "linear.cycle.update": { when: ["a cycle", "is updated"], one: "Updated cycle" },
  "linear.cycle.remove": { when: ["a cycle", "is removed"], one: "Removed cycle" },
  "linear.issuelabel.create": { when: ["a label", "is created"], one: "New label" },
  "linear.issuelabel.update": { when: ["a label", "is updated"], one: "Updated label" },
  "linear.issuelabel.remove": { when: ["a label", "is removed"], one: "Removed label" },
  "linear.reaction.create": { when: ["someone", "adds a reaction"], one: "Added reaction" },
  "linear.reaction.update": { when: ["a reaction", "is updated"], one: "Updated reaction" },
  "linear.reaction.remove": { when: ["someone", "removes a reaction"], one: "Removed reaction" },
};

/**
 * The events the What step lists first, per service, in order. The rest of
 * the service's events sit under `More events`.
 */
export const COMMON_EVENTS: Readonly<Record<SentenceService, readonly string[]>> = {
  slack: ["slack.app_mention", "slack.message"],
  github: [
    "github.pull_request.opened",
    "github.pull_request_review.submitted",
    "github.check_run.completed",
    "github.issues.opened",
  ],
  linear: ["linear.issue.create", "linear.issue.update"],
};

/** "github.workflow_run.completed" → "Workflow run completed". */
function keyInWords(key: string): string {
  const rest = key.includes(".") ? key.slice(key.indexOf(".") + 1) : key;
  const words = rest.replace(/[._*]+/g, " ").trim();
  if (words.length === 0) return key;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function lowerFirst(words: string): string {
  return words.charAt(0).toLowerCase() + words.slice(1);
}

function upperFirst(words: string): string {
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Object names in event keys that read better as other words. */
const OBJECT_WORDS: Readonly<Record<string, string>> = {
  issues: "issue",
  pull_request_review_comment: "review comment",
  pull_request_review_thread: "review thread",
  issuelabel: "label",
};

/** Two-part keys whose object has its own verb. */
const BARE_KEY_WORDS: Readonly<Record<string, string>> = {
  push: "a push lands",
};

function article(noun: string): string {
  return /^[aeiou]/i.test(noun) ? `an ${noun}` : `a ${noun}`;
}

/** An action word as a past participle: `closed`, `update` → `updated`, `open` → `opened`. */
function participle(action: string): string {
  const words = action.replace(/_/g, " ");
  if (words.includes(" ") || words.endsWith("ed")) return words;
  return words.endsWith("e") ? `${words}d` : `${words}ed`;
}

/**
 * Words for a key no table names, derived from the key itself:
 * `<service>.<object>.<action>` reads `a <object> is <action as a participle>`
 * (`github.pull_request.closed` → `a pull request is closed`). A comment
 * that is created is posted. A key with no action reads `<object> happens`,
 * except for the objects with their own verb (`github.push` → `a push lands`).
 */
export function derivedClause(key: string): string {
  const segments = key.split(".");
  const [, object = "", action] = segments;
  if (segments.length < 3 || action === undefined || action.length === 0 || action === "*") {
    const bare = BARE_KEY_WORDS[object];
    if (bare !== undefined) return bare;
    return `${lowerFirst(keyInWords(key))} happens`;
  }
  const noun = OBJECT_WORDS[object] ?? object.replace(/_/g, " ");
  const done = noun.endsWith("comment") && action === "created" ? "posted" : participle(action);
  return `${article(noun)} is ${done}`;
}

/** The event picker's description for a key, when it already reads as a sentence that starts with "When". */
function catalogClause(key: string, catalog: EventDescriptions | undefined): string | undefined {
  for (const service of catalog ?? []) {
    const entry = service.entries.find((e) => e.key === key);
    if (entry && hasText(entry.description) && /^when\s+/i.test(entry.description)) {
      return lowerFirst(entry.description.replace(/^when\s+/i, "").replace(/\.$/, ""));
    }
  }
  return undefined;
}

/** The event as a label for the event picker: `A pull request is opened`. */
export function eventLabel(key: string, catalog?: EventDescriptions): string {
  const known = EVENT_WORDS[key]?.when;
  if (known) return upperFirst(`${known[0]} ${known[1]}`);
  return upperFirst(catalogClause(key, catalog) ?? derivedClause(key));
}

/**
 * Who a mention line listens to: `you`, a named person, or `someone`
 * (spec Part C step 2). A personal line hears only its owner. An org or
 * workflow line carries the creator's unlabeled `user` filter that the
 * server adds (api events/mention-scope.ts), so it hears only its creator.
 * A team line hears its team.
 */
type MentionActor = { kind: "you" } | { kind: "person"; name: string } | { kind: "unnamed" } | { kind: "someone" };

function isMentionKey(key: string): boolean {
  return key === "slack.app_mention" || key === "slack.*";
}

function hasCreatorScope(filters: readonly EventSubscriptionFilterWire[]): boolean {
  return filters.some((f) => f.field === "user" && (f.op === "eq" || f.op === "in") && !hasText(f.label) && !(f.labels?.some(hasText) ?? false));
}

function mentionActor(sub: Pick<EventSubscriptionWire, "target" | "filters" | "createdBy">, names: SentenceNames): MentionActor {
  const target = sub.target;
  if (target.kind === "assistant" && target.assistant === "team") return { kind: "someone" };
  if (target.kind === "assistant" && (target.assistant ?? "user") === "user") return { kind: "you" };
  if (!hasCreatorScope(sub.filters)) return { kind: "someone" };
  if (names.me !== undefined && names.me === sub.createdBy) return { kind: "you" };
  const name = names.members?.[sub.createdBy];
  return hasText(name) ? { kind: "person", name } : { kind: "unnamed" };
}

/** One event clause: its actor (as parts), its actor's words for matching, and its verb. */
interface Clause {
  actor: readonly SentencePart[];
  verb: string;
}

function clauseKey(clause: Clause): string {
  return `${partsText(clause.actor)}\u0000${clause.verb}`;
}

/** One event as an actor and a verb. Derived words are one clause with no verb to share. */
function eventClause(key: string, catalog: Catalog | undefined, actor: MentionActor): Clause {
  const known = EVENT_WORDS[key]?.when;
  if (known && isMentionKey(key) && actor.kind !== "someone") {
    if (actor.kind === "you") return { actor: [text("you")], verb: "mention Valet" };
    if (actor.kind === "person") return { actor: [{ kind: "person", text: actor.name }], verb: "mentions Valet" };
    return { actor: [text("the person who set this up")], verb: "mentions Valet" };
  }
  if (known) return { actor: [text(known[0])], verb: known[1] };
  return { actor: [text(catalogClause(key, catalog) ?? derivedClause(key))], verb: "" };
}

/**
 * The events after "When": each a clause, joined by "or". An event drops its
 * verb when the next event has the same verb, so the verb is said once.
 */
function eventsInParts(keys: readonly string[], catalog: Catalog | undefined, actor: MentionActor): SentencePart[] {
  const clauses: Clause[] = [];
  for (const key of keys) {
    const clause = eventClause(key, catalog, actor);
    if (!clauses.some((c) => clauseKey(c) === clauseKey(clause))) clauses.push(clause);
  }
  const groups = clauses.map((clause, i) => {
    const next = clauses[i + 1];
    const shared = clause.verb.length > 0 && next !== undefined && next.verb === clause.verb;
    return shared || clause.verb.length === 0 ? clause.actor : [...clause.actor, text(` ${clause.verb}`)];
  });
  return joinPartsOr(groups);
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

function serviceOf(keys: readonly string[]): SentenceService | null {
  for (const key of keys) {
    if (key.startsWith("slack.")) return "slack";
    if (key.startsWith("github.")) return "github";
    if (key.startsWith("linear.")) return "linear";
  }
  return null;
}

/**
 * The filter fields a sentence reads as its `<place>`, per service, most
 * specific first. Linear's `identifier` names one issue, so a sentence can
 * say `in ENG-12`, though no overview row exists for an issue.
 */
const SENTENCE_PLACE_FIELDS: Readonly<Record<SentenceService, readonly string[]>> = {
  slack: ["channel"],
  github: ["repo"],
  linear: ["identifier", "team"],
};

/** Every filter field a sentence reads as its place, across services. */
export const SENTENCE_PLACE_FIELD_SET: ReadonlySet<string> = new Set(Object.values(SENTENCE_PLACE_FIELDS).flat());

/** The place a line listens in when no filter names one. */
const ANY_PLACE: Readonly<Record<SentenceService, string>> = {
  slack: "any channel",
  github: "any repository",
  linear: "any team",
};

/** Filter fields that name who sent the event. */
const SENDER_FIELDS: readonly string[] = ["user", "sender", "creator"];

/** Each value of a filter with the words a reader sees for it. */
function filterEntries(filter: EventSubscriptionFilterWire): { value: string; label: string }[] {
  if (Array.isArray(filter.value)) {
    return filter.value.map((v, i) => {
      const label = filter.labels?.[i];
      return { value: v, label: hasText(label) ? label : v };
    });
  }
  return [{ value: filter.value, label: hasText(filter.label) ? filter.label : filter.value }];
}

/**
 * The place key the places API reads for a filter value. A Slack channel
 * filter carries no Slack workspace id, so its key is `slack:<channel>`, and
 * the places API resolves it, as it does for a thread's channel.
 */
function placeSubject(field: string, value: string): string {
  if (field === "channel") return `slack:${value}`;
  if (field === "repo") return `github:${value.toLowerCase()}`;
  if (field === "team") return `linear:team/${value}`;
  return `linear:${value}`;
}

/** A place filter's values as place tokens joined by "or". */
export function placeParts(service: SentenceService, filter: EventSubscriptionFilterWire): SentencePart[] {
  return joinPartsOr(
    filterEntries(filter).map(({ value, label }) => [
      { kind: "place", text: label, service, subject: placeSubject(filter.field, value) },
    ]),
  );
}

function presencePlace(service: SentenceService | null, filters: readonly EventSubscriptionFilterWire[]): SentencePart[] | null {
  if (service === null) return null;
  for (const field of SENTENCE_PLACE_FIELDS[service]) {
    const filter = filters.find((f) => f.field === field && (f.op === "eq" || f.op === "in"));
    if (filter && filterEntries(filter).length > 0) return placeParts(service, filter);
  }
  return [text(ANY_PLACE[service])];
}

function senderFilter(keys: readonly string[], filters: readonly EventSubscriptionFilterWire[]): string | null {
  // The server adds an unlabeled `user` filter with the creator's Slack id
  // to a personal or org mention line (api events/mention-scope.ts). That
  // filter is the line's scope, not a sender the reader chose, so skip it.
  // The actor of the mention clause names the creator instead.
  const mention = keys.some(isMentionKey);
  const filter = filters.find(
    (f) => SENDER_FIELDS.includes(f.field) && f.op === "eq" && !(mention && f.field === "user" && !hasText(f.label)),
  );
  if (!filter) return null;
  const entries = filterEntries(filter);
  return entries.length === 1 ? (entries[0]?.label ?? null) : null;
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

function pinnedThreadParts(threads: ThreadTitles, policy: { sessionId: string; threadId: string }): SentencePart[] {
  const title = threadTitle(threads, policy.threadId);
  if (title === undefined) return [text("the pinned thread")];
  return [text("the "), { kind: "thread", text: title, sessionId: policy.sessionId, threadId: policy.threadId }, text(" thread")];
}

function workflowParts(workflows: WorkflowNames, workflowId: string | undefined): SentencePart[] {
  const name = workflowName(workflows, workflowId);
  if (name === undefined || workflowId === undefined) return [text("run a workflow")];
  return [text("run "), { kind: "workflow", text: name, id: workflowId }];
}

/** The `<do>` of a line (spec Part C step 2) as parts. */
export function presenceDoesParts(sub: EventSubscriptionWire, workflows: WorkflowNames, threads: ThreadTitles): SentencePart[] {
  const target = sub.target;
  if (target.kind === "workflow") return workflowParts(workflows, target.workflowId);
  // An absent policy on conversational keys replies in a new thread per
  // delivery (delivery threads spec Part A).
  if ((target.thread === undefined || target.thread === null) && isConversational(sub.eventKeys)) {
    return [text("reply in a new thread")];
  }
  const policy = displayThreadPolicy(target, sub.eventKeys);
  switch (policy.mode) {
    case "new":
      return [text(isConversational(sub.eventKeys) ? "reply in a new thread" : "work in a new thread each time")];
    case "subject":
      return [text(`work in one thread per ${subjectKindForKeys(sub.eventKeys) ?? "place"}`)];
    case "own":
      return [text("work in its own thread")];
    case "existing":
      return [text("work in "), ...pinnedThreadParts(threads, policy)];
  }
}

/** The `<do>` of a line (spec Part C step 2), such as `reply in a new thread`. */
export function presenceDoes(sub: EventSubscriptionWire, workflows: WorkflowNames, threads: ThreadTitles): string {
  return partsText(presenceDoesParts(sub, workflows, threads));
}

function appearanceParts(appearance: Appearance | undefined): SentencePart[] {
  return hasText(appearance?.displayName) ? [text(", as "), { kind: "person", text: appearance.displayName }] : [];
}

/**
 * True when a line follows one Slack thread: every key is a Slack message
 * and a `thread_ts` filter names the thread (the wizard's `Follow a Slack
 * thread` outcome).
 */
export function followsSlackThread(sub: Pick<EventSubscriptionWire, "eventKeys" | "filters">): boolean {
  return (
    sub.eventKeys.length > 0 &&
    sub.eventKeys.every((k) => k === "slack.message" || k.startsWith("slack.message.")) &&
    sub.filters.some((f) => f.field === "thread_ts")
  );
}

export interface PresenceSentenceOptions {
  /** False omits the `<in|on> <place>` clause. Default true. */
  place?: boolean;
  /** False omits the `, as <appearance>` clause. Default true. */
  appearance?: boolean;
}

/**
 * The `When` half of a line, after the word `When`: `<events>[ from
 * <sender>][ <in|on> <place>]`, or the Slack thread form. The review step and
 * the fact strip read it as the line's When.
 */
export function presenceWhenParts(
  sub: EventSubscriptionWire,
  catalog: Catalog | undefined,
  names: SentenceNames = {},
  options: PresenceSentenceOptions = {},
): SentencePart[] {
  const withPlace = options.place ?? true;
  if (followsSlackThread(sub)) {
    const channel = sub.filters.find((f) => f.field === "channel" && (f.op === "eq" || f.op === "in"));
    const where = channel === undefined || !withPlace ? [] : [text(" in "), ...placeParts("slack", channel)];
    return tidy([text("someone replies in the Slack thread"), ...where]);
  }
  const service = serviceOf(sub.eventKeys);
  const place = withPlace ? presencePlace(service, sub.filters) : null;
  const where = place === null ? [] : [text(` ${service === "github" ? "on" : "in"} `), ...place];
  const sender = senderFilter(sub.eventKeys, sub.filters);
  const from: SentencePart[] = sender === null ? [] : [text(" from "), { kind: "person", text: sender }];
  const actor = sub.eventKeys.some(isMentionKey) ? mentionActor(sub, names) : { kind: "someone" as const };
  return tidy([...eventsInParts(sub.eventKeys, catalog, actor), ...from, ...where]);
}

/**
 * A line of presence as parts of one sentence:
 * `When <events>[ from <sender>] <in|on> <place>, <do>[, as <appearance>].`
 * `in` for Slack and Linear, `on` for GitHub. Without a place:
 * `When <events>[ from <sender>], <do>[, as <appearance>].`
 * A line that follows one Slack thread reads
 * `When someone replies in the Slack thread[ in <channel>], <do>[, as <appearance>].`
 *
 * A mention line names who it listens to: `When you mention Valet` for a
 * personal line or a line the viewer created, `When <creator> mentions
 * Valet` for an org or workflow line someone else created, and `When
 * someone mentions Valet` for a team line.
 *
 * With `{ place: false }` the sentence omits its `<in|on> <place>` clause
 * (and a followed thread's `in <channel>`), because the overview's place
 * block already names the place (spec Part B step 5). With `{ appearance:
 * false }` it omits `, as <appearance>`, because the place's `Appears as`
 * line already names it. The rest stays.
 */
export function presenceSentenceParts(
  sub: EventSubscriptionWire,
  catalog: Catalog | undefined,
  workflows: WorkflowNames,
  threads: ThreadTitles,
  names: SentenceNames = {},
  options: PresenceSentenceOptions = {},
): SentencePart[] {
  const as = (options.appearance ?? true) ? appearanceParts(sub.target.appearance) : [];
  return tidy([
    text("When "),
    ...presenceWhenParts(sub, catalog, names, options),
    text(", "),
    ...presenceDoesParts(sub, workflows, threads),
    ...as,
    text("."),
  ]);
}

/** A line of presence as one sentence. See `presenceSentenceParts`. */
export function presenceSentence(
  sub: EventSubscriptionWire,
  catalog: Catalog | undefined,
  workflows: WorkflowNames,
  threads: ThreadTitles,
  names: SentenceNames = {},
  options: PresenceSentenceOptions = {},
): string {
  return partsText(presenceSentenceParts(sub, catalog, workflows, threads, names, options));
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

function intIn(value: string, min: number, max: number): number | null {
  if (!/^\d+$/.test(value)) return null;
  const n = Number(value);
  return n >= min && n <= max ? n : null;
}

/** Joins words as `a`, `a and b`, or `a, b, and c`. */
function joinAnd(items: readonly string[]): string {
  if (items.length <= 2) return items.join(" and ");
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

/** A day-of-week list (`1,3,5`) as day names from Monday, or null when it is not one. */
function dayList(dow: string): string | null {
  const days = dow.split(",").map((d) => intIn(d, 0, 7));
  if (days.length < 2 || days.some((d) => d === null)) return null;
  const unique = [...new Set(days.map((d) => (d ?? 0) % 7))].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7));
  return joinAnd(unique.map((d) => DAYS[d] ?? ""));
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
    if (d !== null) return `Every ${DAYS[d % 7]} at ${at}`;
    const list = dayList(dow);
    return list === null ? fallback : `Every ${list} at ${at}`;
  }
  const day = intIn(dom, 1, 31);
  if (day !== null && dow === "*") return `On day ${day} of every month at ${at}`;
  return fallback;
}

/** The `<do>` of a routine (spec Part E step 1) as parts. */
export function routineDoesParts(routine: RoutineLike, workflows: WorkflowNames, threads: ThreadTitles): SentencePart[] {
  if (routine.detail.targetKind === "workflow") return workflowParts(workflows, routine.workflowId);
  const policy = routine.detail.thread ?? { mode: "own" };
  switch (policy.mode) {
    case "new":
      return [text("work in a new thread each time")];
    case "existing":
      return [text("work in "), ...pinnedThreadParts(threads, policy)];
    // A routine has no subject; the server refuses `subject`, so it reads as `own`.
    case "subject":
    case "own":
      return [text("work in its own thread")];
  }
}

/** The `<do>` of a routine (spec Part E step 1). */
export function routineDoes(routine: RoutineLike, workflows: WorkflowNames, threads: ThreadTitles): string {
  return partsText(routineDoesParts(routine, workflows, threads));
}

/** The timezone a schedule names, or undefined when it is UTC or absent. */
export function scheduleZone(timezone: string | undefined): string | undefined {
  return timezone === undefined || timezone === "UTC" || timezone === "Etc/UTC" ? undefined : timezone;
}

/** The schedule in words, with the timezone in parentheses when it is not UTC. */
export function scheduleInWords(cron: string, timezone: string | undefined): string {
  const words = cronInWords(cron);
  const zone = scheduleZone(timezone);
  return zone === undefined ? words : `${words} (${zone})`;
}

/** A routine as parts of one sentence: `<schedule in words>, <name>: <do>.` */
export function routineSentenceParts(routine: RoutineLike, workflows: WorkflowNames, threads: ThreadTitles): SentencePart[] {
  return tidy([
    text(`${scheduleInWords(routine.detail.cron, routine.detail.timezone)}, ${routine.name}: `),
    ...routineDoesParts(routine, workflows, threads),
    text("."),
  ]);
}

/** A routine as one sentence: `<schedule in words>, <name>: <do>.` */
export function routineSentence(routine: RoutineLike, workflows: WorkflowNames, threads: ThreadTitles): string {
  return partsText(routineSentenceParts(routine, workflows, threads));
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
  // Reuse the delivery list's wording, without its leading "Skipped" and
  // the dash that older skip text carries after it.
  const line = deliveryStatusLine(delivery, 0).replace(/^skipped(,| by)?\s*(\u2014\s*)?/i, "");
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
