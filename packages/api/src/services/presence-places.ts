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
import { eventHeadColumns, type EventHead } from "./event-columns.js";
import { mapBounded } from "../lib/bounded-map.js";
import { channelFilterIds, runtimeSessionId, type ChannelNames, type ChannelVisibility, type ThreadPairsShown } from "./channels.js";
import type {
  ChannelConversation, ListPresencePlacesResponse, ListThreadFeedersResponse, PresencePlaceService, PresencePlaceWire,
  ThreadFeederWire,
} from "../wire/types.js";

type SubscriptionRow = typeof eventSubscriptions.$inferSelect;
/** A stored event as the places read selects it: no payload (`event-columns.ts`). */
type EventRow = EventHead;

const SERVICES: readonly PresencePlaceService[] = ["slack", "github", "linear"];
/** How many Slack channel checks the places read runs at once. */
const CHANNEL_CHECK_CONCURRENCY = 5;
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

/** The services with places that a listener's event keys name, in key order. */
function listenerServices(rule: { eventKeys: unknown }): PresencePlaceService[] {
  const keys = Array.isArray(rule.eventKeys) ? rule.eventKeys.filter((key): key is string => typeof key === "string") : [];
  return [...new Set(keys.map(serviceOf).filter((service): service is PresencePlaceService => service !== null))];
}

/** The filter fields that name a place, by service. `subject` names a place in every service. */
const PLACE_FIELDS: Readonly<Record<PresencePlaceService, readonly string[]>> = {
  slack: ["channel", "channel_name"],
  github: ["repo", "pr_number"],
  linear: ["team", "identifier"],
};

/** The ops whose values the gate can list as places. */
const EXACT_OPS: Readonly<Record<string, readonly string[]>> = {
  subject: ["eq", "prefix"], channel: ["eq", "in"], repo: ["eq", "in"], pr_number: ["eq", "in"], team: ["eq", "in"], identifier: ["eq", "in"],
};

/**
 * The services on which a line's filters put a condition the gate cannot
 * list as places: a pattern op (`prefix`, `contains`, `regex`) on a place
 * field, a channel name, a subject that names no place, or a repository
 * without its owner. `anyCondition` is true when any filter is on a place
 * field at all.
 */
function placeConditions(filters: unknown): { anyCondition: boolean; unlisted: Set<PresencePlaceService> } {
  const unlisted = new Set<PresencePlaceService>();
  let anyCondition = false;
  if (!Array.isArray(filters)) return { anyCondition, unlisted };
  for (const filter of filters) {
    if (typeof filter !== "object" || filter === null || !("field" in filter) || typeof filter.field !== "string") continue;
    const field = filter.field;
    const services = field === "subject" ? [...SERVICES] : SERVICES.filter((service) => PLACE_FIELDS[service].includes(field));
    if (services.length === 0) continue;
    anyCondition = true;
    const op = "op" in filter && typeof filter.op === "string" ? filter.op : "";
    const value: unknown = "value" in filter ? filter.value : undefined;
    const values = Array.isArray(value) ? value : [value];
    if (field === "subject") {
      // A subject of one service is a condition on that service only. One
      // that names no place is a condition the gate cannot list.
      const places = values.map((item) => typeof item === "string" ? placeOfSubject(item) : null);
      const exact = (EXACT_OPS.subject ?? []).includes(op) && places.length > 0 && places.every((place) => place !== null);
      if (exact) continue;
      const own = values.map((item) => typeof item === "string" ? serviceOf(item) : null);
      const bears = own.some((service) => service === null) ? services : own.filter((service): service is PresencePlaceService => service !== null);
      for (const service of bears.length > 0 ? bears : services) unlisted.add(service);
      continue;
    }
    const exactOp = (EXACT_OPS[field] ?? []).includes(op);
    const listable = exactOp && values.length > 0
      && values.every((item) => field === "repo" ? typeof item === "string" && item.includes("/") : typeof item === "string" || typeof item === "number");
    if (!listable) for (const service of services) unlisted.add(service);
  }
  return { anyCondition, unlisted };
}

/**
 * The exact places a listener's filters name, for each service its event
 * keys name (spec Part D step 4). Unlike `listenerPlaces`, several places
 * never collapse to their parent, so a gate on these places admits no place
 * the line does not name.
 *
 * A pattern op on a place field (`repo prefix acme/`) reaches places no list
 * can name, so that service gives no place. A service gives its top row only
 * when the line carries no condition on any place field of any service: a
 * Slack and GitHub line with a channel filter gives its channel and nothing
 * for GitHub. An empty list admits no skipped entry for a member.
 */
export function lineNamedPlaces(rule: { eventKeys: unknown; filters: unknown }, slackTeam: string): string[] {
  const services = listenerServices(rule);
  const { anyCondition, unlisted } = placeConditions(rule.filters);
  if (!anyCondition) return services.map((service) => rootOf(service, slackTeam));
  return services.flatMap((service) => unlisted.has(service) ? [] : namedPlaces(service, rule.filters, slackTeam));
}

/**
 * Where a listener lists, one place for each service its event keys name
 * (spec Part B step 2). A listener whose filters name one place lists there.
 * One that names several places of one parent lists at that parent, and any
 * other listener lists at its service's top row.
 */
export function listenerPlaces(rule: { eventKeys: unknown; filters: unknown }, slackTeam: string): string[] {
  return listenerServices(rule).map((service) => {
    const named = namedPlaces(service, rule.filters, slackTeam);
    if (named.length === 1) return named[0]!;
    const parents = new Set(named.map(parentPlace));
    const [parent] = parents;
    return named.length > 1 && parents.size === 1 && parent ? parent : rootOf(service, slackTeam);
  });
}

/** Whether a place is a service's top row: `github:*`, `linear:*`, or a Slack workspace. */
export function isServiceRoot(place: string): boolean {
  return place === GITHUB_ROOT || place === LINEAR_ROOT || /^slack:[^/]+$/.test(place);
}

/** Whether a place is a mid-grain row: a Slack channel, a repository, or a Linear team. */
function isMidGrain(place: string): boolean {
  if (SLACK_RE.exec(place)?.[2]) return true;
  const github = GITHUB_RE.exec(place);
  return (github !== null && !github[3]) || LINEAR_TEAM_RE.test(place);
}

/**
 * The overview row a listener lists at (spec Part B steps 2 and 3): the
 * place `listenerPlaces` gives for one of its services, rolled up the parent
 * chain to a mid-grain row or a service's top row. A pull request lists at
 * its repository and a Linear issue at its team. Null for a listener whose
 * event keys name no service with places.
 *
 * A line with keys of several services takes the first service in the fixed
 * order Slack, GitHub, Linear (`SERVICES`), never the order of its keys, so
 * a write that reorders the keys does not move the line's row.
 */
export function listenerRowPlace(rule: { eventKeys: unknown; filters: unknown }, slackTeam: string): string | null {
  const services = listenerServices(rule);
  const places = listenerPlaces(rule, slackTeam);
  // Each service's row, in the fixed order slack, github, linear. A service
  // whose filters name a concrete place wins over one that names only its
  // root, so a Slack+GitHub line with a repo filter lists at the repository.
  const rows = SERVICES.filter((service) => services.includes(service))
    .map((service) => places[services.indexOf(service)])
    .filter((place): place is string => place !== undefined)
    .map((place) => {
      let row = place;
      while (!isServiceRoot(row) && !isMidGrain(row)) {
        const parent = parentPlace(row);
        if (parent === null) break;
        row = parent;
      }
      return row;
    });
  return rows.find((row) => !isServiceRoot(row)) ?? rows[0] ?? null;
}

/** The one name of each service-wide place: its label, its scope label,
 * and its page title (spec Part B step 3). */
const SERVICE_WIDE_NAMES: Readonly<Record<PresencePlaceService, string>> = {
  slack: "Everywhere in Slack",
  github: "Across GitHub",
  linear: "Across Linear",
};

/** A place's concrete name. `names` maps Slack channel ids to names. A
 * service-wide place has one name everywhere (`SERVICE_WIDE_NAMES`). */
export function placeLabel(place: string, names: ReadonlyMap<string, string>): string {
  if (place === GITHUB_ROOT) return SERVICE_WIDE_NAMES.github;
  if (place === LINEAR_ROOT) return SERVICE_WIDE_NAMES.linear;
  const slack = SLACK_RE.exec(place);
  if (slack) {
    if (!slack[2]) return SERVICE_WIDE_NAMES.slack;
    const name = names.get(slack[2]);
    return name ? `#${name.replace(/^#/, "")}` : slack[2];
  }
  const github = GITHUB_RE.exec(place);
  if (github) return github[3] ? `${github[1]}/${github[2]}#${github[3]}` : `${github[1]}/${github[2]}`;
  const team = LINEAR_TEAM_RE.exec(place);
  if (team) return team[1]!;
  return place.startsWith("linear:") ? place.slice("linear:".length) : place;
}

/**
 * The place an event happened in, as its concrete name (`#incidents`,
 * `acme/api#12`, `ENG-42`), or null when its plugin names no place. It reads
 * the stored event's subjects through the plugin's `naturalSubject`. A Slack
 * thread names its channel.
 */
export function eventPlaceName(plugins: PresenceDeps["plugins"], row: EventRow): string | null {
  return eventPlace(plugins, row)?.label ?? null;
}

/** The place an event happened in, as its key (`slack:T1/C900`) and its
 * concrete name, or null. See `eventPlaceName`. */
export function eventPlace(plugins: PresenceDeps["plugins"], row: EventRow): { key: string; label: string } | null {
  const natural = eventNaturalSubject(plugins, row);
  const place = natural ? placeOfSubject(natural.subject) : null;
  if (!natural || !place) return null;
  const channelId = slackChannelOf(place);
  const names = new Map<string, string>();
  if (channelId && natural.label.startsWith("#")) names.set(channelId, natural.label.slice(1));
  return { key: place, label: placeLabel(place, names) };
}

/** Whether `place` is a place key as Presence lists it (`slack:T1/C1`,
 * `github:acme/api`, `github:*`), not a thread or a commit inside one. */
export function isPlaceKey(place: string): boolean {
  return placeOfSubject(place) === place;
}

/**
 * Whether an event happened in `place` or inside it: its natural subject's
 * place is `place`, or `place` covers it (`placeCovers`). An event whose
 * plugin names no place is in no place. The Activity place filter reads this.
 */
export function eventInPlace(plugins: PresenceDeps["plugins"], row: EventRow, place: string): boolean {
  const natural = eventNaturalSubject(plugins, row);
  const own = natural ? placeOfSubject(natural.subject) : null;
  return own !== null && placeCovers(place, own);
}

/**
 * The reach of a parent row, the place a listener lists when its filters
 * name no single place (spec Part B step 2), or undefined for a row that is
 * no parent: a channel, a pull request or issue, a Linear issue.
 */
export function placeScopeLabel(place: string): string | undefined {
  if (place === GITHUB_ROOT) return SERVICE_WIDE_NAMES.github;
  if (place === LINEAR_ROOT) return SERVICE_WIDE_NAMES.linear;
  const slack = SLACK_RE.exec(place);
  if (slack) return slack[2] ? undefined : SERVICE_WIDE_NAMES.slack;
  const github = GITHUB_RE.exec(place);
  if (github) return github[3] ? undefined : `Across ${github[1]}/${github[2]}`;
  const team = LINEAR_TEAM_RE.exec(place);
  return team ? `Across ${team[1]}` : undefined;
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
  /** Names from the bot's channel list. */
  names: ChannelNames;
  /** Names one channel at a time, for a channel that no other source names. */
  lookupNames: ChannelNames;
  canSee: ChannelVisibility;
  threadsShown: ThreadPairsShown;
  /** The org's Slack workspace id, from its bot credential, or null. */
  slackTeamId: () => Promise<string | null>;
}

export type PresenceDeps = Pick<Providers, "db" | "engineStore" | "plugins">;

/**
 * The org's Slack workspace id, as every Presence read picks it (spec Part B
 * step 10): the bot credential's team, else the team of the org's newest
 * Slack subject thread, else the team of its newest Slack event in the
 * Activity window. The org connects one Slack workspace, so any of them
 * names the same one. Null when none is known. A failed credential read
 * reads as none.
 */
export async function resolveSlackTeam(
  db: Providers["db"], orgId: string, credentialTeam: () => Promise<string | null>, now = Date.now(),
): Promise<string | null> {
  const credential = await credentialTeam().catch((err: unknown) => {
    console.error("[presence] reading the org's Slack credential failed", err);
    return null;
  });
  if (credential) return credential;
  const thread = await db.execute(sql`
    SELECT et.key FROM engine_threads et JOIN engine_sessions es ON es.id = et.session_id
    WHERE es.org_id = ${orgId} AND et.key LIKE 'subject:slack:%' AND et.key NOT LIKE 'subject:slack:?%'
    ORDER BY et.updated_at DESC LIMIT 1`) as { rows: Array<{ key: string }> };
  const fromThread = thread.rows[0] ? slackTeamOf(thread.rows[0].key.slice("subject:".length)) : null;
  if (fromThread) return fromThread;
  const event = await db.execute(sql`
    SELECT s.subject FROM events e CROSS JOIN LATERAL unnest(e.subjects) AS s(subject)
    WHERE e.org_id = ${orgId} AND e.received_at >= ${now - EVENT_LOG_WINDOW_MS} AND s.subject LIKE 'slack:%' AND s.subject NOT LIKE 'slack:?%'
    ORDER BY e.received_at DESC LIMIT 1`) as { rows: Array<{ subject: string }> };
  return event.rows[0] ? slackTeamOf(event.rows[0].subject) : null;
}

interface PlaceState {
  wire: PresencePlaceWire;
  /** Lines whose filters list them here (`listenerPlaces`). */
  listeners: SubscriptionRow[];
  /** Lines that list at a child place and roll up to this row (`listenerRowPlace`), such as a pull request line on its repository. */
  rolledUp: SubscriptionRow[];
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

/** The workspace's places, and the Slack workspace id that completed channel filters (`?` when none is known). */
interface LoadedPlaces {
  places: Map<string, PlaceState>;
  slackTeam: string;
  /** How many sessions the workspace has: its runtime and its team conversations. */
  sessionCount: number;
  /** The names of the channels the workspace's lines name, by channel id (`ListPresencePlacesResponse.channelNames`). */
  channelNames: Record<string, string>;
}

async function loadPlaces(deps: PresenceDeps, orgId: string, owner: Principal, access: PresenceAccess, now: number): Promise<LoadedPlaces> {
  const { db } = deps;
  const root = await runtimeSessionId(db, orgId, owner);
  const sessions = root ? await workspaceSessionIds(db, orgId, root) : [];
  const inWorkspace = new Set(sessions);

  // Each read below covers every session of the workspace at once, so the
  // number of queries does not grow with the workspace's conversations.
  const wakeups = sessions.length === 0 ? [] : (await deps.engineStore.listWakeupsForSessions(sessions, ["running"]))
    .filter((wakeup) => wakeup.kind === "event");
  const follows = await db.select().from(followedThreads).where(and(eq(followedThreads.orgId, orgId), eq(followedThreads.channelType, "slack"),
    eq(followedThreads.ownerType, owner.type), eq(followedThreads.ownerId, owner.id)));

  // The threads a place can show: a subject thread (`subject:<key>`), and a
  // thread that a follow binding or a running waiter names. A team runtime
  // holds thousands of other threads, and none of them is a place's.
  const named = new Map<string, { sessionId: string; threadId: string }>();
  for (const ref of [...follows.map((follow) => ({ sessionId: follow.sessionId, threadId: follow.threadId })), ...wakeups]) {
    if (ref.sessionId && ref.threadId && inWorkspace.has(ref.sessionId)) named.set(`${ref.sessionId}:${ref.threadId}`, { sessionId: ref.sessionId, threadId: ref.threadId });
  }
  const threadRows = sessions.length === 0 ? [] : (await db.execute(sql`
    SELECT et.session_id, et.id, et.key, et.updated_at, st.title, (st.archived_at IS NOT NULL) AS archived FROM engine_threads et
    LEFT JOIN session_threads st ON st.session_id = et.session_id AND st.id = et.id
    WHERE et.session_id IN (${sql.join(sessions.map((id) => sql`${id}`), sql`, `)})
      AND ((et.key LIKE 'subject:%' AND st.archived_at IS NULL)${named.size === 0 ? sql`` : sql`
        OR (et.session_id, et.id) IN (${sql.join([...named.values()].map((ref) => sql`(${ref.sessionId}, ${ref.threadId})`), sql`, `)})`})`) as {
    // Raw SQL rows are untyped; the SELECT names these columns.
    rows: Array<{ session_id: string; id: string; key: string | null; updated_at: string | number; title: string | null; archived: boolean | null }>;
  }).rows;

  // Of those threads, the ones this request may see, in one visibility pass.
  const shown = await access.threadsShown(threadRows.map((row) => ({ sessionId: row.session_id, threadId: row.id })));
  const threads = new Map<string, Map<string, ThreadRow>>();
  for (const row of threadRows) {
    if (!shown.has(`${row.session_id}:${row.id}`)) continue;
    const visible = threads.get(row.session_id) ?? new Map<string, ThreadRow>();
    visible.set(row.id, { id: row.id, key: row.key, updatedAt: Number(row.updated_at), title: row.title, archived: row.archived === true });
    threads.set(row.session_id, visible);
  }
  const conversation = (sessionId: string, thread: ThreadRow, fallbackTitle: string, url?: string): ChannelConversation => ({
    sessionId, threadId: thread.id, title: thread.title || fallbackTitle, ...(url ? { url } : {}), lastActivityAt: thread.updatedAt,
  });

  const waiters = [];
  for (const wakeup of wakeups) {
    const thread = threads.get(wakeup.sessionId)?.get(wakeup.threadId);
    if (!thread) continue;
    // A waiter that also holds a wider subject for a derived key waits on its primary one.
    const subjects = wakeup.eventMatch?.primarySubject ? [wakeup.eventMatch.primarySubject] : wakeup.subjects ?? [];
    waiters.push({ sessionId: wakeup.sessionId, thread, subjects });
  }

  // The payload is most of an event row's size, and no place reads it.
  const recentEvents = await db.select(eventHeadColumns).from(events).where(and(
    eq(events.orgId, orgId),
    gte(events.receivedAt, now - EVENT_LOG_WINDOW_MS),
    // Only events that reached this workspace's rules (or the org's), as the Activity log reads them.
    sql`EXISTS (SELECT 1 FROM event_deliveries d JOIN event_subscriptions s ON s.id = d.subscription_id
      WHERE d.event_id = ${events.id} AND s.org_id = ${orgId}
        AND ((s.owner_type = ${owner.type} AND s.owner_id = ${owner.id}) OR s.owner_type = 'org'))`,
  )).orderBy(desc(events.receivedAt)).limit(EVENT_SCAN_LIMIT);

  // Filters and follow bindings name a channel without its Slack workspace.
  const slackTeam = await resolveSlackTeam(db, orgId, access.slackTeamId, now) ?? "?";

  const places = new Map<string, PlaceState>();
  const placeFor = (subject: string): PlaceState | null => {
    const existing = places.get(subject);
    if (existing) return existing;
    const service = serviceOf(subject);
    if (!service) return null;
    const created: PlaceState = {
      wire: { subject, label: subject, service, parent: parentPlace(subject), listenerCount: 0, activeThreadCount: 0, lastActivityAt: null },
      listeners: [], rolledUp: [], subjectThreads: [], following: [], active: new Map(), events: [],
    };
    places.set(subject, created);
    return created;
  };
  const touch = (state: PlaceState, at: number) => {
    if (state.wire.lastActivityAt === null || at > state.wire.lastActivityAt) state.wire.lastActivityAt = at;
  };
  const channelNames = new Map<string, string>();
  // Every channel a line's exact channel filter names. A line over several
  // channels lists at the Slack workspace, so its channels need not be places.
  const lineChannels = new Set<string>();

  const rules = (await db.select().from(eventSubscriptions).where(and(eq(eventSubscriptions.orgId, orgId), ownedBy(owner))))
    .filter(isListener);
  for (const rule of rules) {
    const filtered = channelFilterIds(rule.filters);
    for (const id of filtered.ids) lineChannels.add(id);
    for (const [id, label] of filtered.labels) channelNames.set(id, label);
    const own = listenerPlaces(rule, slackTeam);
    for (const place of own) placeFor(place)?.listeners.push(rule);
    // A pull request or issue line also lists at its overview row
    // (`placeKey`), so the row's place page lists the lines the row shows.
    const row = listenerRowPlace(rule, slackTeam);
    if (row !== null && !own.includes(row)) placeFor(row)?.rolledUp.push(rule);
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

  for (const follow of follows) {
    // A follow bound before the thread columns names no Valet thread, and
    // still marks its channel. A bound follow counts only when this request
    // may see its thread in this workspace's sessions.
    const bound = follow.sessionId !== null && follow.threadId !== null;
    const thread = follow.sessionId && follow.threadId ? threads.get(follow.sessionId)?.get(follow.threadId) : undefined;
    if (bound && !thread) continue;
    const state = placeFor(`slack:${slackTeam}/${follow.channelId}`);
    if (!state) continue;
    touch(state, follow.lastActivityAt);
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

  // A private Slack channel's place and name show only to its members. A
  // check that fails hides both, as an unknown audience does.
  const channelPlaces = [...places.keys()].flatMap((place) => {
    const channelId = slackChannelOf(place);
    return channelId ? [{ place, channelId }] : [];
  });
  const checked = [...new Set([...channelPlaces.map(({ channelId }) => channelId), ...lineChannels])];
  const seen = await mapBounded(checked, CHANNEL_CHECK_CONCURRENCY,
    (channelId) => access.canSee(`slack:${channelId}`).catch(() => false));
  const visible = new Set(checked.filter((_, index) => seen[index] === true));
  for (const { place, channelId } of channelPlaces) if (!visible.has(channelId)) places.delete(place);

  // Every parent a row names is a row. A parent that only its children name
  // has no counts of its own and takes its children's newest activity.
  const synthesized = new Set<string>();
  for (let pending = [...places.values()]; pending.length > 0;) {
    const next: PlaceState[] = [];
    for (const child of pending) {
      const parent = child.wire.parent;
      if (parent === null || (places.has(parent) && !synthesized.has(parent))) continue;
      const created = !places.has(parent);
      const state = placeFor(parent);
      if (!state) continue;
      if (created) { synthesized.add(parent); next.push(state); }
      if (child.wire.lastActivityAt !== null) touch(state, child.wire.lastActivityAt);
    }
    pending = next;
  }

  const channelIds = [...new Set([
    ...[...places.keys()].map(slackChannelOf).filter((id): id is string => id !== null),
    ...[...lineChannels].filter((id) => visible.has(id)),
  ])];
  const resolved = channelIds.length > 0 ? await access.names(channelIds).catch(() => new Map<string, string>()) : new Map<string, string>();
  for (const [id, name] of resolved) channelNames.set(id, name);
  // The bot's channel list stops at the picker's limit and holds only the
  // channels the bot has joined. Slack names the rest one at a time.
  const unnamed = channelIds.filter((id) => !channelNames.has(id));
  const looked = unnamed.length > 0 ? await access.lookupNames(unnamed).catch(() => new Map<string, string>()) : new Map<string, string>();
  for (const [id, name] of looked) channelNames.set(id, name);
  const lineNames = Object.fromEntries([...lineChannels].flatMap((id) => {
    const name = visible.has(id) ? channelNames.get(id)?.replace(/^#/, "") : undefined;
    return name && name !== id ? [[id, name]] : [];
  }));
  for (const state of places.values()) {
    state.wire.label = placeLabel(state.wire.subject, channelNames);
    // The reach describes listeners that list here or roll up here, so a row
    // with none (such as a parent only its children name) carries no reach.
    const scopeLabel = state.listeners.length + state.rolledUp.length > 0 ? placeScopeLabel(state.wire.subject) : undefined;
    if (scopeLabel !== undefined) state.wire.scopeLabel = scopeLabel;
    state.wire.listenerCount = state.listeners.length + state.rolledUp.length;
    state.wire.activeThreadCount = state.active.size;
  }
  return { places, slackTeam, sessionCount: sessions.length, channelNames: lineNames };
}

function compareConversations(a: ChannelConversation, b: ChannelConversation): number {
  return b.lastActivityAt - a.lastActivityAt;
}

/** The workspace's places, and how many sessions the read covered. The route sends only the places. */
export interface PresencePlacesList extends ListPresencePlacesResponse {
  sessionCount: number;
}

/** The workspace's places: Slack, then GitHub, then Linear, each newest activity first. */
export async function listPresencePlaces(
  deps: PresenceDeps, orgId: string, owner: Principal, access: PresenceAccess, now = Date.now(),
): Promise<PresencePlacesList> {
  const loaded = await loadPlaces(deps, orgId, owner, access, now);
  const rows = [...loaded.places.values()].map((state) => state.wire);
  rows.sort((a, b) => SERVICES.indexOf(a.service) - SERVICES.indexOf(b.service)
    || (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0) || a.label.localeCompare(b.label));
  return { places: rows, channelNames: loaded.channelNames, sessionCount: loaded.sessionCount };
}

/** One place with the rows its page shows. The route maps the rows to their wire shapes. */
export interface PresencePlaceDetail {
  place: PresencePlaceWire;
  /** The Slack workspace id the place rows used for channel filters, `?` when none is known. */
  slackTeam: string;
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
  const { places, slackTeam } = await loadPlaces(deps, orgId, owner, access, now);
  const state = places.get(subject);
  if (!state) return null;
  const covered = [...places.values()].filter((candidate) => placeCovers(subject, candidate.wire.subject));
  const active = new Map<string, ChannelConversation>();
  for (const candidate of covered) for (const [id, row] of candidate.active) active.set(id, row);
  return {
    place: state.wire,
    slackTeam,
    listeners: [...state.listeners, ...state.rolledUp].sort((a, b) => a.name.localeCompare(b.name)),
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
 * policy whose place covers the thread's subject. Only enabled rules of
 * `owner` count: a rule delivers into its own owner's assistant, so an org
 * rule feeds only an org thread. The caller checks that the viewer may read
 * the thread.
 */
export async function listThreadFeeders(
  db: Providers["db"], orgId: string, owner: Principal, thread: { sessionId: string; threadId: string; key: string | null },
): Promise<ListThreadFeedersResponse> {
  const key = thread.key ?? "";
  const subject = key.startsWith("subject:") ? key.slice("subject:".length) : null;
  const threadPlace = subject ? placeOfSubject(subject) : null;
  const slackTeam = subject ? slackTeamOf(subject) ?? "?" : "?";

  const listeners: ThreadFeederWire[] = [];
  const rules = await db.select().from(eventSubscriptions).where(and(eq(eventSubscriptions.orgId, orgId),
    eq(eventSubscriptions.ownerType, owner.type), eq(eventSubscriptions.ownerId, owner.id), eq(eventSubscriptions.enabled, true)));
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
    eq(workflowSchedules.ownerType, owner.type), eq(workflowSchedules.ownerId, owner.id), eq(workflowSchedules.enabled, true)));
  for (const schedule of schedules) {
    if (readScheduleTargetKind(schedule.targetKind) !== "assistant") continue;
    const policy = storedPolicy(schedule.threadPolicy);
    const own = key === `schedule:${schedule.id}` && (policy === null || policy.mode === "own");
    if (own || pins(policy, thread)) routines.push({ id: schedule.id, name: schedule.name });
  }
  return { listeners: listeners.sort(byName), routines: routines.sort(byName) };
}
