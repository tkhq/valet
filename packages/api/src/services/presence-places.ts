/**
 * Places for the presence hub (spec 2026-10-16: presence hub, Parts B and G).
 * A place is a Slack channel, a repository, a pull request or issue, or a
 * Linear team or issue, keyed by its subject. A workspace's places come from
 * five sources: its listeners' filters, its subject threads (`subject:<key>`),
 * its follow bindings, its running event waiters, and the events from the
 * last 30 days that reached its listeners. A place is derived, never stored.
 *
 * This module also lists the listeners and routines that feed one thread.
 */
import { and, desc, eq, gte, or, sql } from "drizzle-orm";
import type { Principal } from "@valet/engine";
import { readThreadPolicy, type AssistantThreadPolicy } from "@valet/shared";
import type { Providers } from "../providers/types.js";
import { eventSubscriptions, events, followedThreads, workflowSchedules } from "../schema/index.js";
import { workspaceSessionIds } from "../assistants/service.js";
import { eventNaturalSubject } from "../events/dispatcher.js";
import { EVENT_LOG_WINDOW_MS } from "./event-log.js";
import { isAssistantKind, readScheduleTargetKind, readStoredTarget } from "../events/target-names.js";
import { slackMessageUrl } from "./channel-messages.js";
import { channelFilterIds, runtimeSessionId, type ChannelNames, type ChannelVisibility, type ThreadsShown } from "./channels.js";
import type {
  ChannelConversation, ListPresencePlacesResponse, ListThreadFeedersResponse, PresencePlaceService, PresencePlaceWire,
  ThreadFeederWire,
} from "../wire/types.js";

type SubscriptionRow = typeof eventSubscriptions.$inferSelect;
type EventRow = typeof events.$inferSelect;

const SERVICES: readonly PresencePlaceService[] = ["slack", "github", "linear"];
/** The top row of a service whose listeners name no repository or team. Slack's top row is its workspace, `slack:<team>`. */
const GITHUB_ROOT = "github:*";
const LINEAR_ROOT = "linear:*";
/** The most events one read takes from the activity window. */
const EVENT_SCAN_LIMIT = 2000;
/** The most events a place page lists. */
const ACTIVITY_LIMIT = 50;

const SLACK_RE = /^slack:([^/]+)(?:\/([^/]+)(?:\/[^/]+)?)?$/;
const GITHUB_RE = /^github:([^/#@]+)\/([^/#@]+)(?:#(\d+)|@[0-9a-f]+)?$/i;
const LINEAR_TEAM_RE = /^linear:team\/([A-Za-z0-9_-]+)$/;
const LINEAR_ISSUE_RE = /^linear:(?!team\/)([A-Za-z0-9_-]+)$/;

function isService(value: string): value is PresencePlaceService {
  return (SERVICES as readonly string[]).includes(value);
}

/** The service a subject or event key belongs to, or null for a service with no places. */
export function serviceOf(subjectOrKey: string): PresencePlaceService | null {
  const prefix = subjectOrKey.split(/[:.]/, 1)[0] ?? "";
  return isService(prefix) ? prefix : null;
}

/**
 * The place a subject belongs to, or null when it names none. A Slack thread
 * belongs to its channel and a commit to its repository. A GitHub owner is
 * not a place.
 */
export function placeOfSubject(subject: string): string | null {
  if (subject === GITHUB_ROOT || subject === LINEAR_ROOT) return subject;
  const slack = SLACK_RE.exec(subject);
  if (slack) return slack[2] ? `slack:${slack[1]}/${slack[2]}` : `slack:${slack[1]}`;
  const github = GITHUB_RE.exec(subject);
  if (github) {
    const repo = `github:${github[1]!.toLowerCase()}/${github[2]!.toLowerCase()}`;
    return github[3] ? `${repo}#${github[3]}` : repo;
  }
  if (LINEAR_TEAM_RE.test(subject) || LINEAR_ISSUE_RE.test(subject)) return subject;
  return null;
}

/** The parent of a place by the subject grammar: a channel's Slack workspace, a pull request's repository, an issue's Linear team. */
export function parentPlace(place: string): string | null {
  const slack = SLACK_RE.exec(place);
  if (slack) return slack[2] ? `slack:${slack[1]}` : null;
  const github = GITHUB_RE.exec(place);
  if (github) return github[3] ? `github:${github[1]}/${github[2]}` : null;
  const issue = LINEAR_ISSUE_RE.exec(place);
  if (issue) {
    const dash = issue[1]!.lastIndexOf("-");
    return dash > 0 ? `linear:team/${issue[1]!.slice(0, dash)}` : null;
  }
  return null;
}

/** Whether `cover` is `place`, one of its parents, or the top row of its service. */
export function placeCovers(cover: string, place: string): boolean {
  if (cover === place) return true;
  if (cover === GITHUB_ROOT || cover === LINEAR_ROOT) return serviceOf(cover) === serviceOf(place);
  for (let parent = parentPlace(place); parent !== null; parent = parentPlace(parent)) {
    if (parent === cover) return true;
  }
  return false;
}

function rootOf(service: PresencePlaceService, slackTeam: string): string {
  if (service === "slack") return `slack:${slackTeam}`;
  return service === "github" ? GITHUB_ROOT : LINEAR_ROOT;
}

/** An exact filter's values: `eq` gives one, `in` gives a list. Other ops name no single value. */
function exactValues(filters: unknown, field: string, ops: readonly string[] = ["eq", "in"]): string[] {
  if (!Array.isArray(filters)) return [];
  const values: string[] = [];
  for (const filter of filters) {
    if (typeof filter !== "object" || filter === null) continue;
    if (!("field" in filter) || filter.field !== field) continue;
    if (!("op" in filter) || typeof filter.op !== "string" || !ops.includes(filter.op)) continue;
    const value = "value" in filter ? filter.value : undefined;
    for (const item of Array.isArray(value) ? value : [value]) {
      if (typeof item === "string" && item !== "") values.push(item);
      else if (typeof item === "number" && Number.isInteger(item)) values.push(String(item));
    }
  }
  return values;
}

/** The places one listener's filters name for one service. */
function namedPlaces(service: PresencePlaceService, filters: unknown, slackTeam: string): string[] {
  const named: string[] = [];
  for (const value of exactValues(filters, "subject", ["eq", "prefix"])) {
    const place = serviceOf(value) === service ? placeOfSubject(value) : null;
    if (place) named.push(place);
  }
  if (service === "slack") {
    for (const id of channelFilterIds(filters).ids) named.push(`slack:${slackTeam}/${id}`);
  } else if (service === "github") {
    const repos = exactValues(filters, "repo").filter((repo) => repo.includes("/")).map((repo) => `github:${repo.toLowerCase()}`);
    const numbers = exactValues(filters, "pr_number").filter((n) => /^\d+$/.test(n));
    // One repository and one number name one pull request.
    if (repos.length === 1 && numbers.length === 1) named.push(`${repos[0]}#${numbers[0]}`);
    else named.push(...repos);
  } else {
    for (const team of exactValues(filters, "team")) named.push(`linear:team/${team}`);
    for (const identifier of exactValues(filters, "identifier")) named.push(`linear:${identifier}`);
  }
  return [...new Set(named)];
}

/**
 * Where a listener lists, one place for each service its event keys name
 * (spec Part B step 2). A listener whose filters name one place lists there.
 * One that names several places of one parent lists at that parent, and any
 * other listener lists at its service's top row.
 */
export function listenerPlaces(rule: { eventKeys: unknown; filters: unknown }, slackTeam: string): string[] {
  const keys = Array.isArray(rule.eventKeys) ? rule.eventKeys.filter((key): key is string => typeof key === "string") : [];
  const services = [...new Set(keys.map(serviceOf).filter((service): service is PresencePlaceService => service !== null))];
  return services.map((service) => {
    const named = namedPlaces(service, rule.filters, slackTeam);
    if (named.length === 1) return named[0]!;
    const parents = new Set(named.map(parentPlace));
    const [parent] = parents;
    return named.length > 1 && parents.size === 1 && parent ? parent : rootOf(service, slackTeam);
  });
}

/** A place's label: the concrete name, or the reach of a parent row. `names` maps Slack channel ids to names. */
export function placeLabel(place: string, names: ReadonlyMap<string, string>): string {
  if (place === GITHUB_ROOT) return "Everywhere in GitHub";
  if (place === LINEAR_ROOT) return "Everywhere in Linear";
  const slack = SLACK_RE.exec(place);
  if (slack) {
    if (!slack[2]) return "Everywhere in Slack";
    const name = names.get(slack[2]);
    return name ? `#${name.replace(/^#/, "")}` : slack[2];
  }
  const github = GITHUB_RE.exec(place);
  if (github) return github[3] ? `${github[1]}/${github[2]}#${github[3]}` : `Across ${github[1]}/${github[2]}`;
  const team = LINEAR_TEAM_RE.exec(place);
  if (team) return `Across ${team[1]}`;
  return place.startsWith("linear:") ? place.slice("linear:".length) : place;
}

/** The Slack channel id of a channel place, or null. */
function slackChannelOf(place: string): string | null {
  return SLACK_RE.exec(place)?.[2] ?? null;
}

/** The Slack workspace id a subject names, or null. */
function slackTeamOf(subject: string): string | null {
  const team = SLACK_RE.exec(subject)?.[1];
  return team && team !== "?" ? team : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** What the place reads see of the request: names, channel access, thread access, and the org's Slack workspace. */
export interface PresenceAccess {
  names: ChannelNames;
  canSee: ChannelVisibility;
  threadsShown: ThreadsShown;
  /** The org's Slack workspace id, from its bot credential, or null. */
  slackTeamId: () => Promise<string | null>;
}

export type PresenceDeps = Pick<Providers, "db" | "engineStore" | "plugins">;

interface PlaceState {
  wire: PresencePlaceWire;
  listeners: SubscriptionRow[];
  subjectThreads: ChannelConversation[];
  following: ChannelConversation[];
  /** By `<session>:<thread>`. */
  active: Map<string, ChannelConversation>;
  /** Newest first. */
  events: EventRow[];
}

interface ThreadRow {
  id: string;
  key: string | null;
  updatedAt: number;
  title: string | null;
  archived: boolean;
}

/** The workspace's rules and the org's: the rows that every workspace's listener list shows. */
function ownedBy(owner: Principal) {
  return or(and(eq(eventSubscriptions.ownerType, owner.type), eq(eventSubscriptions.ownerId, owner.id)), eq(eventSubscriptions.ownerType, "org"));
}

/** Listeners are rules with an assistant or a workflow target. */
function isListener(row: SubscriptionRow): boolean {
  const target = readStoredTarget(row.target);
  return isRecord(target) && (isAssistantKind(target.kind) || target.kind === "workflow");
}

async function loadPlaces(deps: PresenceDeps, orgId: string, owner: Principal, access: PresenceAccess, now: number): Promise<Map<string, PlaceState>> {
  const { db } = deps;
  const root = await runtimeSessionId(db, orgId, owner);
  const sessions = root ? await workspaceSessionIds(db, orgId, root) : [];
  const seenSubjects: string[] = [];

  // The threads of each session that this request may see.
  const threads = new Map<string, Map<string, ThreadRow>>();
  for (const sessionId of sessions) {
    const result = await db.execute(sql`
      SELECT et.id, et.key, et.updated_at, st.title, (st.archived_at IS NOT NULL) AS archived FROM engine_threads et
      LEFT JOIN session_threads st ON st.session_id = et.session_id AND st.id = et.id
      WHERE et.session_id = ${sessionId}`) as {
      // Raw SQL rows are untyped; the SELECT names these columns.
      rows: Array<{ id: string; key: string | null; updated_at: string | number; title: string | null; archived: boolean | null }>;
    };
    const shown = await access.threadsShown(sessionId, result.rows.map((row) => row.id));
    const visible = new Map<string, ThreadRow>();
    for (const row of result.rows) {
      if (!shown.has(row.id)) continue;
      visible.set(row.id, { id: row.id, key: row.key, updatedAt: Number(row.updated_at), title: row.title, archived: row.archived === true });
      if (row.key?.startsWith("subject:")) seenSubjects.push(row.key.slice("subject:".length));
    }
    threads.set(sessionId, visible);
  }
  const conversation = (sessionId: string, thread: ThreadRow, fallbackTitle: string, url?: string): ChannelConversation => ({
    sessionId, threadId: thread.id, title: thread.title || fallbackTitle, ...(url ? { url } : {}), lastActivityAt: thread.updatedAt,
  });

  const waiters = [];
  for (const sessionId of sessions) {
    for (const wakeup of await deps.engineStore.listWakeups(sessionId, ["running"])) {
      const thread = threads.get(sessionId)?.get(wakeup.threadId);
      if (wakeup.kind !== "event" || !thread) continue;
      // A waiter that also holds a wider subject for a derived key waits on its primary one.
      const subjects = wakeup.eventMatch?.primarySubject ? [wakeup.eventMatch.primarySubject] : wakeup.subjects ?? [];
      seenSubjects.push(...subjects);
      waiters.push({ sessionId, thread, subjects });
    }
  }

  const recentEvents = await db.select().from(events).where(and(
    eq(events.orgId, orgId),
    gte(events.receivedAt, now - EVENT_LOG_WINDOW_MS),
    // Only events that reached this workspace's rules (or the org's), as the Activity log reads them.
    sql`EXISTS (SELECT 1 FROM event_deliveries d JOIN event_subscriptions s ON s.id = d.subscription_id
      WHERE d.event_id = ${events.id} AND s.org_id = ${orgId}
        AND ((s.owner_type = ${owner.type} AND s.owner_id = ${owner.id}) OR s.owner_type = 'org'))`,
  )).orderBy(desc(events.receivedAt)).limit(EVENT_SCAN_LIMIT);
  for (const row of recentEvents) seenSubjects.push(...(row.subjects ?? []));

  // Filters and follow bindings name a channel without its Slack workspace.
  const slackTeam = await access.slackTeamId().catch(() => null)
    ?? seenSubjects.map(slackTeamOf).find((team): team is string => team !== null) ?? "?";

  const places = new Map<string, PlaceState>();
  const placeFor = (subject: string): PlaceState | null => {
    const existing = places.get(subject);
    if (existing) return existing;
    const service = serviceOf(subject);
    if (!service) return null;
    const created: PlaceState = {
      wire: { subject, label: subject, service, parent: parentPlace(subject), listenerCount: 0, activeThreadCount: 0, lastActivityAt: null },
      listeners: [], subjectThreads: [], following: [], active: new Map(), events: [],
    };
    places.set(subject, created);
    return created;
  };
  const touch = (state: PlaceState, at: number) => {
    if (state.wire.lastActivityAt === null || at > state.wire.lastActivityAt) state.wire.lastActivityAt = at;
  };
  const channelNames = new Map<string, string>();

  const rules = (await db.select().from(eventSubscriptions).where(and(eq(eventSubscriptions.orgId, orgId), ownedBy(owner))))
    .filter(isListener);
  for (const rule of rules) {
    for (const [id, label] of channelFilterIds(rule.filters).labels) channelNames.set(id, label);
    for (const place of listenerPlaces(rule, slackTeam)) placeFor(place)?.listeners.push(rule);
  }

  for (const [sessionId, rows] of threads) {
    for (const thread of rows.values()) {
      if (!thread.key?.startsWith("subject:") || thread.archived) continue;
      const place = placeOfSubject(thread.key.slice("subject:".length));
      const state = place ? placeFor(place) : null;
      if (!state || !place) continue;
      state.subjectThreads.push(conversation(sessionId, thread, placeLabel(place, channelNames)));
      touch(state, thread.updatedAt);
    }
  }

  const follows = await db.select().from(followedThreads).where(and(eq(followedThreads.orgId, orgId), eq(followedThreads.channelType, "slack"),
    eq(followedThreads.ownerType, owner.type), eq(followedThreads.ownerId, owner.id)));
  for (const follow of follows) {
    const state = placeFor(`slack:${slackTeam}/${follow.channelId}`);
    if (!state) continue;
    touch(state, follow.lastActivityAt);
    // A follow bound before the thread columns names no Valet thread.
    const thread = follow.sessionId && follow.threadId ? threads.get(follow.sessionId)?.get(follow.threadId) : undefined;
    if (follow.sessionId && thread) {
      state.following.push({
        ...conversation(follow.sessionId, thread, "Slack thread", slackMessageUrl(follow.channelId, follow.threadTs)),
        lastActivityAt: Math.max(thread.updatedAt, follow.lastActivityAt),
      });
    }
  }

  for (const waiter of waiters) {
    const placeKeys = new Set(waiter.subjects.map(placeOfSubject).filter((place): place is string => place !== null));
    for (const place of placeKeys) {
      placeFor(place)?.active.set(`${waiter.sessionId}:${waiter.thread.id}`, conversation(waiter.sessionId, waiter.thread, "Thread"));
    }
  }

  for (const row of recentEvents) {
    const natural = eventNaturalSubject(deps.plugins, row);
    const place = natural ? placeOfSubject(natural.subject) : null;
    const state = place ? placeFor(place) : null;
    if (!natural || !place || !state) continue;
    state.events.push(row);
    touch(state, row.receivedAt);
    const channelId = slackChannelOf(place);
    if (channelId && natural.label.startsWith("#")) channelNames.set(channelId, natural.label.slice(1));
  }

  // A private Slack channel's place shows only to its members.
  for (const place of [...places.keys()]) {
    const channelId = slackChannelOf(place);
    if (channelId && !(await access.canSee(`slack:${channelId}`))) places.delete(place);
  }

  const channelIds = [...places.keys()].map(slackChannelOf).filter((id): id is string => id !== null);
  const resolved = channelIds.length > 0 ? await access.names(channelIds).catch(() => new Map<string, string>()) : new Map<string, string>();
  for (const [id, name] of resolved) channelNames.set(id, name);
  for (const state of places.values()) {
    state.wire.label = placeLabel(state.wire.subject, channelNames);
    state.wire.listenerCount = state.listeners.length;
    state.wire.activeThreadCount = state.active.size;
  }
  return places;
}

function compareConversations(a: ChannelConversation, b: ChannelConversation): number {
  return b.lastActivityAt - a.lastActivityAt;
}

/** The workspace's places: Slack, then GitHub, then Linear, each newest activity first. */
export async function listPresencePlaces(
  deps: PresenceDeps, orgId: string, owner: Principal, access: PresenceAccess, now = Date.now(),
): Promise<ListPresencePlacesResponse> {
  const rows = [...(await loadPlaces(deps, orgId, owner, access, now)).values()].map((state) => state.wire);
  rows.sort((a, b) => SERVICES.indexOf(a.service) - SERVICES.indexOf(b.service)
    || (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0) || a.label.localeCompare(b.label));
  return { places: rows };
}

/** One place with the rows its page shows. The route maps the rows to their wire shapes. */
export interface PresencePlaceDetail {
  place: PresencePlaceWire;
  listeners: SubscriptionRow[];
  threads: { subject: ChannelConversation[]; following: ChannelConversation[]; active: ChannelConversation[] };
  /** Newest first. */
  activity: EventRow[];
}

/**
 * One place: its listeners, and the threads and recent events of the place
 * and its child places. Null when the workspace is not present there, or the
 * viewer may not see it.
 */
export async function getPresencePlace(
  deps: PresenceDeps, orgId: string, owner: Principal, access: PresenceAccess, subject: string, now = Date.now(),
): Promise<PresencePlaceDetail | null> {
  const places = await loadPlaces(deps, orgId, owner, access, now);
  const state = places.get(subject);
  if (!state) return null;
  const covered = [...places.values()].filter((candidate) => placeCovers(subject, candidate.wire.subject));
  const active = new Map<string, ChannelConversation>();
  for (const candidate of covered) for (const [id, row] of candidate.active) active.set(id, row);
  return {
    place: state.wire,
    listeners: [...state.listeners].sort((a, b) => a.name.localeCompare(b.name)),
    threads: {
      subject: covered.flatMap((candidate) => candidate.subjectThreads).sort(compareConversations),
      following: covered.flatMap((candidate) => candidate.following).sort(compareConversations),
      active: [...active.values()].sort(compareConversations),
    },
    activity: covered.flatMap((candidate) => candidate.events)
      .sort((a, b) => b.receivedAt - a.receivedAt || (a.id < b.id ? 1 : -1)).slice(0, ACTIVITY_LIMIT),
  };
}

/** A stored thread policy, or null when the rule stores none. */
function storedPolicy(value: unknown): AssistantThreadPolicy | null {
  return value === undefined || value === null ? null : readThreadPolicy(value);
}

/** Whether a policy pins this thread. */
function pins(policy: AssistantThreadPolicy | null, thread: { sessionId: string; threadId: string }): boolean {
  return policy?.mode === "existing" && policy.sessionId === thread.sessionId && policy.threadId === thread.threadId;
}

function byName(a: ThreadFeederWire, b: ThreadFeederWire): number {
  return a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
}

/**
 * The listeners and routines that deliver into one thread of `owner`'s
 * assistant (spec Part G step 1): a rule whose own thread it is (`sub:<id>`,
 * `schedule:<id>`), a rule pinned to it, and a listener with the `subject`
 * policy whose place covers the thread's subject. The caller checks that the
 * viewer may read the thread.
 */
export async function listThreadFeeders(
  db: Providers["db"], orgId: string, owner: Principal, thread: { sessionId: string; threadId: string; key: string | null },
): Promise<ListThreadFeedersResponse> {
  const key = thread.key ?? "";
  const subject = key.startsWith("subject:") ? key.slice("subject:".length) : null;
  const threadPlace = subject ? placeOfSubject(subject) : null;
  const slackTeam = subject ? slackTeamOf(subject) ?? "?" : "?";

  const listeners: ThreadFeederWire[] = [];
  const rules = await db.select().from(eventSubscriptions).where(and(eq(eventSubscriptions.orgId, orgId), ownedBy(owner)));
  for (const rule of rules) {
    const target = readStoredTarget(rule.target);
    if (!isRecord(target) || !isAssistantKind(target.kind)) continue;
    const policy = storedPolicy(target.thread);
    // A rule with no stored policy works in its own thread for an event with no channel origin.
    const own = key === `sub:${rule.id}` && (policy === null || policy.mode === "own");
    const perSubject = policy?.mode === "subject" && threadPlace !== null
      && listenerPlaces(rule, slackTeam).some((place) => placeCovers(place, threadPlace));
    if (own || pins(policy, thread) || perSubject) listeners.push({ id: rule.id, name: rule.name });
  }

  const routines: ThreadFeederWire[] = [];
  const schedules = await db.select().from(workflowSchedules).where(and(eq(workflowSchedules.orgId, orgId),
    eq(workflowSchedules.ownerType, owner.type), eq(workflowSchedules.ownerId, owner.id)));
  for (const schedule of schedules) {
    if (readScheduleTargetKind(schedule.targetKind) !== "assistant") continue;
    const policy = storedPolicy(schedule.threadPolicy);
    const own = key === `schedule:${schedule.id}` && (policy === null || policy.mode === "own");
    if (own || pins(policy, thread)) routines.push({ id: schedule.id, name: schedule.name });
  }
  return { listeners: listeners.sort(byName), routines: routines.sort(byName) };
}
