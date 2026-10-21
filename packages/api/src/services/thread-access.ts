/**
 * Who may see a thread of a team runtime. Team members share one runtime, so
 * session access alone would show every thread to every member. Three kinds
 * of thread are narrower:
 *
 * - A member's helper thread (`app-assistant:<user>:<conversation>`, or
 *   `app-assistant:<user>` from before per-conversation keys) is that
 *   member's alone.
 * - A workflow editor conversation (`workflow:<id>:<user>`) is that member's
 *   alone.
 * - A thread that holds content from a private Slack channel shows only to
 *   the channel's members, by the viewer's linked Slack account, the rule
 *   Slack actions follow
 *   (docs/specs/2026-03-16-slack-private-channel-auth-design.md). The bot
 *   reads the channel for everyone, so team membership is not enough. The
 *   channels come from the thread's key and from the channels its deliveries
 *   recorded (`metadata.slackChannels`), so a rule thread (`sub:`,
 *   `subject:`, `schedule:`) is gated by its content, not by its key shape.
 *   A thread with content from two private channels needs membership in both.
 *
 * Every route, stream, and list that addresses a team thread asks this one
 * predicate. A personal runtime has one viewer, who sees all of its threads.
 *
 * Whether a channel is private is the channel's state, not the viewer's, so it
 * is stored once per org (`slack_channel_privacy`) and Slack is asked again
 * once it goes stale: after five minutes for "public", an hour for
 * "private". When Slack cannot answer (an outage or a disconnect), the stored
 * answer stands, so a public channel stays readable and a private one stays
 * hidden; a channel made private during the outage shows until Slack
 * answers again. A channel never classified, when Slack cannot answer,
 * stays hidden: it may be private. The first thread list after a channel's
 * first message classifies it, while the bot's token still works there.
 */
import { randomUUID } from "node:crypto";
import { and, eq, sql, type SQL } from "drizzle-orm";
import { Thread, type StoredCredential, type ThreadAccessCheck, type ThreadData } from "@valet/engine";
import type { WorkflowRunOrigin } from "@valet/workflow";
import { checkPrivateChannelAccess, isPermanentSlackAccessError } from "@valet/plugin-slack/actions";
import { identityForUser } from "../channels/identity-links.js";
import type { RequestPrincipal } from "../lib/request-principal.js";
import type { Providers } from "../providers/types.js";
import { agentSessions, slackChannelPrivacy } from "../schema/index.js";
import { mapBounded } from "../lib/bounded-map.js";
/** The Slack conversation a thread key names, DMs and group DMs included,
 * legacy channel-only keys, a channel's events thread (`slackEventsThreadKey`),
 * and a channel's subject thread (`subject:slack:<team>/<channel>`). */
function slackConversation(key: string | null | undefined): { channelId: string } | null {
  const match = /^slack:([^:]+)(?::[^:]+)?$|^slack-events:([^:]+)(?::.+)?$|^subject:slack:[^/]+\/([^/:]+)/.exec(key ?? "");
  return match ? { channelId: (match[1] ?? match[2] ?? match[3])! } : null;
}

/** The engine thread metadata key that lists the Slack channels whose
 * content a thread holds. Assistant delivery writes it
 * (`events/assistant-delivery.ts`); the read gate here reads it. */
export const SLACK_CHANNELS_METADATA_KEY = "slackChannels";

/** The Slack channels a thread's metadata records. */
export function recordedSlackChannels(metadata: Record<string, unknown> | null | undefined): string[] {
  const value = metadata?.[SLACK_CHANNELS_METADATA_KEY];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item !== "") : [];
}

/** Every Slack channel whose privacy gates a thread: its key's conversation and its recorded channels. */
function gatingChannels(key: string | null | undefined, recorded: readonly string[]): string[] {
  const channels = new Set(recorded);
  const conversation = slackConversation(key);
  if (conversation) channels.add(conversation.channelId);
  return [...channels];
}

/**
 * SQL: the Slack channels recorded on a thread and on every thread above it
 * (the threads that started its child sessions), as `text[]`. A child of a
 * thread with private content carries that content too.
 */
export function threadSlackChannelsSql(sessionId: SQL, threadId: SQL): SQL {
  return slackChannelsWalkSql(sessionId, threadId, 0);
}

/** A thread's own recorded Slack channels, as `text[]`, read the way `threadSlackChannelsSql` reads each thread. */
function ownSlackChannelsSql(metadata: SQL): SQL {
  return sql`(SELECT COALESCE(array_agg(DISTINCT c.value), '{}'::text[]) FROM jsonb_array_elements_text(CASE
      WHEN ${metadata} IS NOT NULL AND jsonb_typeof(${metadata}::jsonb -> ${SLACK_CHANNELS_METADATA_KEY}) = 'array'
      THEN ${metadata}::jsonb -> ${SLACK_CHANNELS_METADATA_KEY} ELSE '[]'::jsonb END) AS c(value))`;
}

/**
 * `threadSlackChannelsSql` from a start row at `startDepth`. The walk stops
 * at depth 8, so a walk that starts at a parent thread (depth 1) reads the
 * same rows as the child thread's walk reads above it.
 */
function slackChannelsWalkSql(sessionId: SQL, threadId: SQL, startDepth: 0 | 1): SQL {
  return sql`(WITH RECURSIVE up(sid, tid, depth) AS (
      SELECT ${sessionId}::text, ${threadId}::text, ${sql.raw(String(startDepth))}
      UNION ALL
      SELECT es.parent_session_id, es.parent_thread_id, up.depth + 1 FROM up
      JOIN engine_sessions es ON es.id = up.sid
      WHERE es.parent_session_id IS NOT NULL AND es.parent_thread_id IS NOT NULL AND up.depth < 8
    ) SELECT COALESCE(array_agg(DISTINCT c.value), '{}'::text[]) FROM up
    JOIN engine_threads et ON et.session_id = up.sid AND et.id = up.tid
    CROSS JOIN LATERAL jsonb_array_elements_text(CASE
      WHEN et.metadata IS NOT NULL AND jsonb_typeof(et.metadata::jsonb -> ${SLACK_CHANNELS_METADATA_KEY}) = 'array'
      THEN et.metadata::jsonb -> ${SLACK_CHANNELS_METADATA_KEY} ELSE '[]'::jsonb END) AS c(value))`;
}

/** `threadSlackChannelsSql` for one thread. */
export async function threadSlackChannels(db: Providers["db"], sessionId: string, threadId: string): Promise<string[]> {
  const result = await db.execute(sql`SELECT ${threadSlackChannelsSql(sql`${sessionId}`, sql`${threadId}`)} AS channels`) as { rows: Array<{ channels: string[] | null }> };
  return result.rows[0]?.channels ?? [];
}

/** Where a Slack event with no thread to reply into lands for a team: a
 * bot message, a reaction, a join. Keyed by its channel, so the channel's
 * privacy governs it, not the shared events thread every member reads. A
 * `suffix` keeps one such thread per item, such as a workflow run. */
export function slackEventsThreadKey(channelId: string, suffix?: string): string {
  return suffix ? `slack-events:${channelId}:${suffix}` : `slack-events:${channelId}`;
}
import type { ChannelVisibility } from "./channels.js";
import { resolveOrgCredentialRead } from "./credential-resolution.js";
import { OnePasswordAuthError } from "./onepassword.js";

/** What the read gate reads: the database and the org's Slack credential. */
export type AccessDeps = Pick<Providers, "db" | "engineCredentials"> & { onePassword?: Providers["onePassword"] };

/** Caps a TTL cache: past `max` entries it drops the expired ones, then the
 * oldest, so a long-lived process does not keep every key it has seen. */
export function setCapped<V extends { expiresAt: number }>(cache: Map<string, V>, key: string, value: V, max = 5000): void {
  if (cache.size >= max) {
    const now = Date.now();
    for (const [old, entry] of cache) if (entry.expiresAt <= now) cache.delete(old);
    if (cache.size >= max) cache.delete(cache.keys().next().value!);
  }
  cache.set(key, value);
}

/** The organization's Slack bot credential, or null when none is connected. */
export async function orgSlackCredential(deps: AccessDeps, orgId: string): Promise<StoredCredential | null> {
  try {
    return await resolveOrgCredentialRead({ credentials: deps.engineCredentials, onePassword: deps.onePassword }, { orgId, scopes: ["org"] }, "slack");
  } catch (err) {
    if (!(err instanceof OnePasswordAuthError)) throw err;
    return null;
  }
}

const botToken = (credential: StoredCredential | null) => credential?.accessToken ?? credential?.apiKey ?? null;

/** A "public" answer grants access, so it is trusted only this long: a
 * channel made private stops showing within the same window as a removed
 * member. A "private" answer only denies, so it is kept longer. */
const PUBLIC_TTL_MS = 5 * 60_000;
const PRIVATE_TTL_MS = 60 * 60_000;
/** A viewer's membership of a private channel is rechecked after this long. */
const MEMBERSHIP_TTL_MS = 5 * 60_000;
const privacyCache = new Map<string, { isPrivate: boolean | undefined; expiresAt: number }>();
const membershipCache = new Map<string, { allowed: boolean; expiresAt: number }>();

class SlackChannelDenied extends Error {}

/**
 * Whether a Slack channel is private: from memory, then the stored answer
 * while it is fresh, then Slack, with the stored answer standing when Slack
 * cannot answer. Undefined only for a channel never classified.
 */
export async function slackChannelIsPrivate(
  deps: Pick<AccessDeps, "db">, orgId: string, channelId: string, token: () => Promise<string | null>, retryUnknownAccess = false,
): Promise<boolean | undefined> {
  const cacheKey = `${orgId}:${channelId}`;
  const now = Date.now();
  const cached = privacyCache.get(cacheKey);
  if (cached && cached.expiresAt > now) return cached.isPrivate;
  const [stored] = await deps.db.select().from(slackChannelPrivacy)
    .where(and(eq(slackChannelPrivacy.orgId, orgId), eq(slackChannelPrivacy.channelId, channelId))).limit(1);
  let isPrivate: boolean | undefined = stored?.isPrivate;
  const ttl = (value: boolean | undefined) => (value === false ? PUBLIC_TTL_MS : value === true ? PRIVATE_TTL_MS : MEMBERSHIP_TTL_MS);
  if (!stored || stored.checkedAt + ttl(stored.isPrivate) <= now) {
    const bot = await token();
    // Privacy comes from `conversations.info`, which answers before any
    // membership check, so no viewer is needed here.
    // A DM or group DM counts as private: one person's conversation with the
    // bot is not the team's.
    const info = bot ? await checkPrivateChannelAccess(bot, channelId, undefined, { directIsPrivate: true, ...(retryUnknownAccess ? { timeoutMs: 10_000 } : {}) }).catch(() => null) : null;
    if (retryUnknownAccess && isPermanentSlackAccessError(info?.errorCode)) throw new SlackChannelDenied();
    const answered = info && (!info.error || info.isPrivate);
    if (answered) {
      isPrivate = info.isPrivate;
      await deps.db.insert(slackChannelPrivacy).values({ orgId, channelId, isPrivate, checkedAt: now })
        .onConflictDoUpdate({ target: [slackChannelPrivacy.orgId, slackChannelPrivacy.channelId], set: { isPrivate, checkedAt: now } });
    }
  }
  setCapped(privacyCache, cacheKey, { isPrivate, expiresAt: now + ttl(isPrivate) });
  return isPrivate;
}

/**
 * Whether recording Slack `channelId` on a thread would hide the thread from
 * someone who can read it today. Only a team thread gates on its channels
 * (`threadVisibility`), so no other thread narrows. A personal session also
 * has one reader. A team thread narrows unless it already gates on the
 * channel (by its key, or by channels recorded on it or the threads above
 * it), or the channel is public. A channel Slack cannot classify counts as
 * private, as the read gate treats it.
 */
export async function recordingNarrowsThread(
  deps: Pick<AccessDeps, "db"> & Partial<AccessDeps>,
  orgId: string,
  thread: { ownerType: string; sessionId: string; threadId: string; key: string | null; recorded?: readonly string[] },
  channelId: string,
): Promise<boolean> {
  if (thread.ownerType !== "team") return false;
  const recorded = [...(thread.recorded ?? []), ...(await threadSlackChannels(deps.db, thread.sessionId, thread.threadId))];
  if (gatingChannels(thread.key, recorded).includes(channelId)) return false;
  const credentials = deps.engineCredentials;
  // Without a credential store, Slack cannot answer: only a stored answer counts.
  const bot = async () => credentials ? botToken(await orgSlackCredential({ ...deps, engineCredentials: credentials }, orgId)) : null;
  return (await slackChannelIsPrivate(deps, orgId, channelId, bot)) !== false;
}

/** Forgets what this process remembers about channel privacy and membership. Tests only. */
export function resetThreadAccessCache(): void {
  privacyCache.clear();
  membershipCache.clear();
}

/** A personal key that names nobody, so nobody else may see the thread. It
 * stands in for a child's starting thread that no longer exists. */
const UNKNOWN_THREAD_KEY = "app-assistant:";

/**
 * SQL: the key of the thread that decides who may see a thread. A child
 * session's threads take the access of the thread that started the child,
 * followed up to the workspace runtime, so work spawned from a private thread
 * stays private. Any other thread decides by its own key. When the thread a
 * child names as its start is gone, nobody can tell who it was shared with,
 * so the answer is `UNKNOWN_THREAD_KEY`.
 */
export function governingThreadKeySql(sessionId: SQL, threadId: SQL, from: "thread" | "parent link" = "thread"): SQL {
  return governingKeyWalkSql(sessionId, threadId, from === "parent link" ? 1 : 0);
}

/**
 * `governingThreadKeySql` from a start row at `startDepth`. The walk stops at
 * depth 8, so a walk that starts at a child's parent link (depth 2) reads
 * the same rows as the walk of each thread of the child reads above it.
 */
function governingKeyWalkSql(sessionId: SQL, threadId: SQL, startDepth: 0 | 1 | 2): SQL {
  return sql`(WITH RECURSIVE up(sid, tid, depth) AS (
      SELECT ${sessionId}::text, ${threadId}::text, ${sql.raw(String(startDepth))}
      UNION ALL
      SELECT es.parent_session_id, es.parent_thread_id, up.depth + 1 FROM up
      JOIN engine_sessions es ON es.id = up.sid
      WHERE es.parent_session_id IS NOT NULL AND es.parent_thread_id IS NOT NULL AND up.depth < 8
    ) SELECT CASE WHEN (up.depth > 0 AND et.id IS NULL) OR (up.sid LIKE 'execution:%' AND NOT EXISTS (
      SELECT 1 FROM engine_sessions es WHERE es.id = up.sid AND es.parent_session_id IS NOT NULL AND es.parent_thread_id IS NOT NULL
    )) THEN ${UNKNOWN_THREAD_KEY} ELSE et.key END
    FROM up LEFT JOIN engine_threads et ON et.session_id = up.sid AND et.id = up.tid
    ORDER BY up.depth DESC LIMIT 1)`;
}

/** `governingThreadKeySql` for one thread. Pass "parent link" when the ids
 * are a child's starting thread, so a missing one reads as private. */
export async function governingThreadKey(
  db: Providers["db"], sessionId: string, threadId: string, from: "thread" | "parent link" = "thread",
): Promise<string | null> {
  const result = await db.execute(sql`SELECT ${governingThreadKeySql(sql`${sessionId}`, sql`${threadId}`, from)} AS key`) as { rows: Array<{ key: string | null }> };
  return result.rows[0]?.key ?? null;
}

/** The thread that started a child session, or null for any other session. */
async function spawningThread(db: Providers["db"], sessionId: string): Promise<{ sessionId: string; threadId: string } | null> {
  const result = await db.execute(sql`SELECT parent_session_id, parent_thread_id FROM engine_sessions WHERE id = ${sessionId}`) as {
    rows: Array<{ parent_session_id: string | null; parent_thread_id: string | null }>;
  };
  const row = result.rows[0];
  if (row?.parent_session_id && row.parent_thread_id) return { sessionId: row.parent_session_id, threadId: row.parent_thread_id };
  // An isolated execution with missing ancestry has no verifiable audience.
  if (sessionId.startsWith("execution:") || row?.parent_session_id || row?.parent_thread_id) return { sessionId, threadId: "" };
  return null;
}

/** Conversations whose readers need not be on the team. */
const OUTSIDE_THREAD_KEY = /^(slack(?:-events)?|telegram|github):/;

/** Whether people outside the team read this conversation (Slack, Telegram, GitHub). */
export function isOutsideThreadKey(key: string | null | undefined): boolean {
  return OUTSIDE_THREAD_KEY.test(key ?? "");
}

/** Whether a reader has readers outside the team: a Slack, Telegram, or
 * GitHub key, or recorded Slack content (`metadata.slackChannels`). */
export function isOutsideReader(key: string | null | undefined, recordedChannels: readonly string[]): boolean {
  return isOutsideThreadKey(key) || recordedChannels.length > 0;
}

/** Whether a conversation people outside the team read may reach a target
 * thread, work the whole team may see when `targetShared`: its own
 * conversation, a target whose Slack channels it already holds, or public
 * Slack channels from a Slack conversation. Each side's channels come from
 * its key and its recorded channels. `threadReadAccess` applies the same
 * rule with a live privacy check. */
export function outsideReaderMayReach(
  reader: { key: string | null; channels: readonly string[] },
  target: { key: string | null; channels: readonly string[] },
  targetShared: boolean,
): boolean {
  const readerChannels = gatingChannels(reader.key, reader.channels);
  const targetChannels = gatingChannels(target.key, target.channels);
  const foreign = targetChannels.filter((channel) => !readerChannels.includes(channel));
  if (targetChannels.length > 0 && foreign.length === 0) return true;
  if (readerChannels.length === 0 || targetChannels.length === 0) return reader.key === target.key;
  return targetShared;
}

/** Whether a key names one person's thread: a helper or a workflow editor
 * conversation. Such a thread is never shared, even when the key names no
 * person, as an editor key from before per-person keys (`workflow:<id>`) does. */
export function isPersonalThreadKey(key: string | null | undefined): boolean {
  return !!key && (key.startsWith("app-assistant:") || key.startsWith("workflow:"));
}

/** The person a helper or workflow editor thread belongs to, from its key, or
 * undefined when the key names nobody. */
export function privateThreadOwner(key: string | null | undefined): string | undefined {
  if (!key) return undefined;
  if (key.startsWith("app-assistant:")) return key.split(":")[1] || undefined;
  if (key.startsWith("workflow:")) return key.split(":")[2] || undefined;
  return undefined;
}

/** The key of a new Ask Valet conversation for one person. */
export function assistantConversationKey(userId: string): string {
  return `app-assistant:${userId}:${randomUUID()}`;
}

/** Whether a key names one of the person's Ask Valet conversations, including
 * the one conversation each person had before per-conversation keys. */
export function isAssistantConversationOf(key: string | null | undefined, userId: string): boolean {
  return key === `app-assistant:${userId}` || !!key?.startsWith(`app-assistant:${userId}:`);
}

/** A thread to judge: its key alone, or the engine thread with its metadata.
 * Pass the thread when you have it, so its recorded Slack channels count. */
export type ThreadRef = string | null | undefined | { key: string | null; metadata?: Record<string, unknown> | null };
export interface ThreadVisibility {
  (thread: ThreadRef): Promise<boolean>;
  /** The sorted Slack channels recorded on the live thread that started this
   * child session, or "" when unknown. A change means the inherited answer
   * is stale (`cachedThreadVisibility`). */
  inheritedSignature?: () => string;
}

/** How long a child's inherited parent answer stands when the parent thread
 * is not live in this process, so its recorded channels cannot be compared. */
const INHERITED_TTL_MS = 5 * 60_000;

/** A thread ref's recorded channels, sorted and joined: equal lists compare equal. */
function channelSignature(ref: { metadata?: Record<string, unknown> | null } | undefined): string {
  return ref ? [...recordedSlackChannels(ref.metadata)].sort().join(",") : "";
}

type ThreadRefObject = Exclude<ThreadRef, string | null | undefined>;

/**
 * A per-connection thread visibility check that caches each answer for
 * `ttlMs`. A delivery can record a new Slack channel on a live thread and so
 * shrink its audience (`events/assistant-delivery.ts`). Each call compares
 * the live thread's recorded channels with the ones the cached answer used,
 * and a difference discards the answer at once. `stored` is read only on a
 * miss; an unresolved thread is not shown and not cached.
 */
export function cachedThreadVisibility(
  visible: ThreadVisibility,
  live: (threadId: string) => ThreadRefObject | undefined,
  stored: (threadId: string) => Promise<ThreadRefObject | null | undefined>,
  ttlMs: number,
  now: () => number = Date.now,
): (threadId: string) => Promise<boolean> {
  // The thread's own channels and, for a child session, its live parent's.
  const signature = (ref: ThreadRefObject) => `${channelSignature(ref)}|${visible.inheritedSignature?.() ?? ""}`;
  const checked = new Map<string, { shown: Promise<boolean>; at: number; channels: string }>();
  return async (threadId) => {
    const current = live(threadId);
    const hit = checked.get(threadId);
    if (hit && now() - hit.at < ttlMs && (!current || signature(current) === hit.channels)) return hit.shown;
    const ref = current ?? await stored(threadId);
    if (!ref) return false;
    const shown = visible(ref);
    // The check resolves the child's parent first, so read the signature after it.
    await shown.catch(() => false);
    checked.set(threadId, { shown, at: now(), channels: signature(ref) });
    return shown;
  };
}

/** The `ThreadRef` of a live engine thread or a stored one. */
export function threadRef(thread: Thread | ThreadData): ThreadRefObject {
  return thread instanceof Thread ? thread.toThreadData() : thread;
}

/** The `ThreadRef` of a thread known by ids and key, with its recorded channels from the store. */
export async function storedThreadRef(db: Providers["db"], sessionId: string, threadId: string, key: string | null): Promise<ThreadRef> {
  return { key, metadata: { [SLACK_CHANNELS_METADATA_KEY]: await threadSlackChannels(db, sessionId, threadId) } };
}

export interface ThreadViewer {
  orgId: string;
  /** The person asking, or undefined for a team key, which sees only what
   * the whole team shares. */
  userId: string | undefined;
}

/** The viewer of a request: the signed-in person, or no person for a team key. */
export function requestViewer(orgId: string, principal: RequestPrincipal, userId: string): ThreadViewer {
  return { orgId, userId: principal.type === "team" ? undefined : userId };
}

/**
 * Whether the viewer may see a Slack channel (`slack:<id>`): a public channel
 * anyone may, a private one only its members. Other channel keys are open.
 * One instance per request or connection shares its credential and identity
 * lookups.
 */
export function channelVisibility(deps: AccessDeps, viewer: ThreadViewer, retryUnknownAccess = false): ChannelVisibility {
  let token: Promise<string | null> | undefined;
  let slackUserId: Promise<string | undefined> | undefined;
  const bot = () => (token ??= orgSlackCredential(deps, viewer.orgId).then(botToken));
  return async (channelKey) => {
    const channelId = /^slack:([^:]+)$/.exec(channelKey)?.[1];
    if (!channelId) return true;
    let isPrivate: boolean | undefined;
    try {
      isPrivate = await slackChannelIsPrivate(deps, viewer.orgId, channelId, bot, retryUnknownAccess);
    } catch (err) {
      if (err instanceof SlackChannelDenied) return false;
      throw err;
    }
    if (isPrivate === false) return true;
    // A channel never classified, with Slack unable to answer, may be
    // private: it stays hidden until Slack says otherwise.
    if (isPrivate === undefined) {
      if (retryUnknownAccess) throw new Error("Slack channel privacy is unknown. Retry the attention delivery.");
      return false;
    }
    if (!viewer.userId) return false;
    slackUserId ??= identityForUser(deps.db, "slack", viewer.userId).then((link) => link?.externalId);
    // Without a linked Slack account nobody can vouch for membership.
    const member = await slackUserId;
    if (!member) return false;
    const cacheKey = `${viewer.orgId}:${member}:${channelId}`;
    const cached = membershipCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.allowed;
    const token = await bot();
    if (!token) {
      if (retryUnknownAccess) throw new Error("Slack membership cannot be checked without credentials. Restore the Slack integration.");
      return false;
    }
    const access = await checkPrivateChannelAccess(token, channelId, member, { directIsPrivate: true, ...(retryUnknownAccess ? { timeoutMs: 10_000 } : {}) }).catch(() => null);
    if (isPermanentSlackAccessError(access?.errorCode)) return false;
    if (retryUnknownAccess && (!access || access.error?.startsWith("Slack API error"))) {
      throw new Error("Slack membership lookup failed. Retry the attention delivery.");
    }
    const allowed = access?.allowed === true;
    // A Slack error is not cached, so the next request asks again. "Not a
    // member" is an answer and is cached.
    if (access && !access.error?.startsWith("Slack API error")) {
      setCapped(membershipCache, cacheKey, { allowed, expiresAt: Date.now() + MEMBERSHIP_TTL_MS });
    }
    return allowed;
  };
}

/**
 * Whether the viewer may see a thread, by its key, in a session they may
 * already view. A personal session's threads are all visible to its owner.
 * With the session's id, a child session's threads are judged by the thread
 * that started the child (`governingThreadKeySql`).
 */
export function threadVisibility(
  deps: AccessDeps,
  session: { ownerType: string; id?: string },
  viewer: ThreadViewer,
  opts: {
    /** Durable sends retry unknown access instead of treating it as a permanent denial. */
    retryUnknownAccess?: boolean;
    /** The live engine thread for ids, when this process holds it. A child
     * then rechecks its parent's recorded channels on every call. */
    liveThread?: (sessionId: string, threadId: string) => ThreadRefObject | undefined;
    now?: () => number;
  } = {},
): ThreadVisibility {
  if (session.ownerType !== "team") return async () => true;
  const canSee = channelVisibility(deps, viewer, opts.retryUnknownAccess);
  const now = opts.now ?? Date.now;
  // The thread that started this child session: undefined until read, null for none.
  let parentIds: { sessionId: string; threadId: string } | null | undefined;
  let memo: { at: number; signature: string | undefined; value: { key: string | null; channels: string[] } | undefined } | undefined;
  const liveParentSignature = (): string | undefined => {
    if (!parentIds || !parentIds.threadId || !opts.liveThread) return undefined;
    const live = opts.liveThread(parentIds.sessionId, parentIds.threadId);
    return live ? channelSignature(live) : undefined;
  };
  // A child takes its parent's audience. A delivery can record a new private
  // channel on the parent at any time, so the inherited answer is recomputed
  // when the live parent's channels differ from the ones it used, and after
  // INHERITED_TTL_MS when the parent is not live here.
  const governing = async () => {
    const live = liveParentSignature();
    if (memo && now() - memo.at < INHERITED_TTL_MS && (live === undefined || live === memo.signature)) return memo.value;
    if (parentIds === undefined) parentIds = session.id ? await spawningThread(deps.db, session.id) : null;
    const parent = parentIds;
    const value = parent ? {
      key: await governingThreadKey(deps.db, parent.sessionId, parent.threadId, "parent link"),
      channels: parent.threadId ? await threadSlackChannels(deps.db, parent.sessionId, parent.threadId) : [],
    } : undefined;
    memo = { at: now(), signature: liveParentSignature(), value };
    return value;
  };
  const visible: ThreadVisibility = async (thread) => {
    const ownKey = typeof thread === "object" && thread !== null ? thread.key : thread;
    const ownChannels = typeof thread === "object" && thread !== null ? recordedSlackChannels(thread.metadata) : [];
    const parent = await governing();
    const key = parent === undefined ? ownKey : parent.key;
    if (isPersonalThreadKey(key)) {
      const owner = privateThreadOwner(key);
      return owner !== undefined && owner === viewer.userId;
    }
    // Every channel the thread holds content from must be visible.
    for (const channelId of gatingChannels(key, [...ownChannels, ...(parent?.channels ?? [])])) {
      if (!(await canSee(`slack:${channelId}`))) return false;
    }
    return true;
  };
  visible.inheritedSignature = () => liveParentSignature() ?? "";
  return visible;
}

/**
 * SQL: whether a team thread may appear in content every member sees at once,
 * such as shared workflow outcomes. Not a person's own thread, and not a Slack
 * channel thread unless its public classification is fresh: nobody's access is
 * checked when the content is read. A channel is classified the first time
 * any member's thread list shows it.
 */
export function sharedWithWholeTeamSql(orgId: string, key: SQL, channels?: SQL): SQL {
  const freshPublic = Date.now() - PUBLIC_TTL_MS;
  // A `subject:slack:<team>/<channel>` key names its channel after the slash.
  const subjectChannel = sql`split_part(split_part(${key}, '/', 2), ':', 1)`;
  const keyShared = sql`(${key} IS NULL OR (${key} NOT LIKE 'app-assistant:%' AND ${key} NOT LIKE 'workflow:%'
    AND ((${key} NOT LIKE 'slack:%' AND ${key} NOT LIKE 'slack-events:%' AND ${key} NOT LIKE 'subject:slack:%') OR EXISTS (SELECT 1 FROM slack_channel_privacy p
      WHERE p.org_id = ${orgId} AND p.channel_id = CASE WHEN ${key} LIKE 'subject:slack:%' THEN ${subjectChannel} ELSE split_part(${key}, ':', 2) END
        AND p.is_private = false AND p.checked_at > ${freshPublic}))))`;
  if (!channels) return keyShared;
  // Every recorded channel must also be freshly public.
  return sql`(${keyShared} AND NOT EXISTS (SELECT 1 FROM unnest(${channels}) AS rc(channel_id)
    WHERE NOT EXISTS (SELECT 1 FROM slack_channel_privacy p WHERE p.org_id = ${orgId} AND p.channel_id = rc.channel_id
      AND p.is_private = false AND p.checked_at > ${freshPublic})))`;
}

/** How many Slack channel checks one batch runs at once. */
const CHANNEL_CHECK_CONCURRENCY = 5;

/**
 * SQL: one row per given thread, with the inputs `visibleThreadIds` decides
 * from. Each distinct session walks its parent chain once. Pass at least one
 * thread.
 */
export function visibleThreadRowsSql(threads: ReadonlyArray<{ sessionId: string; threadId: string }>): SQL {
  const values = sql.join(threads.map((t) => sql`(${t.sessionId}::text, ${t.threadId}::text)`), sql`, `);
  // `linked`: the session names the thread that started it. Its chain is the
  // governing key and the recorded channels from that thread up.
  // `walked` is MATERIALIZED because PostgreSQL inlines a CTE that is read
  // once. Inlined, the two recursive walks run again for each thread row.
  return sql`WITH t(session_id, thread_id) AS (VALUES ${values}),
    chain AS (
      SELECT s.session_id, (es.parent_session_id IS NOT NULL AND es.parent_thread_id IS NOT NULL) AS linked,
        es.parent_session_id, es.parent_thread_id
      FROM (SELECT DISTINCT session_id FROM t) s LEFT JOIN engine_sessions es ON es.id = s.session_id
    ),
    walked AS MATERIALIZED (
      SELECT chain.session_id, chain.linked,
        CASE WHEN chain.linked THEN ${governingKeyWalkSql(sql`chain.parent_session_id`, sql`chain.parent_thread_id`, 2)} END AS chain_key,
        CASE WHEN chain.linked THEN ${slackChannelsWalkSql(sql`chain.parent_session_id`, sql`chain.parent_thread_id`, 1)} END AS chain_channels
      FROM chain
    )
    SELECT t.session_id, t.thread_id, (et.id IS NOT NULL) AS found, et.key, walked.linked, walked.chain_key, walked.chain_channels,
      CASE WHEN et.id IS NULL THEN NULL ELSE ${ownSlackChannelsSql(sql`et.metadata`)} END AS own_channels
    FROM t JOIN walked ON walked.session_id = t.session_id
    LEFT JOIN engine_threads et ON et.session_id = t.session_id AND et.id = t.thread_id`;
}

/**
 * Of the given threads, the ones (`<session>:<thread>`) the viewer may see.
 * The answer for each thread is the answer `threadVisibility` gives for the
 * thread's governing key and recorded channels. The batch reads them in one
 * query, and walks each child session's parent chain once, not once per
 * thread: every thread of a child shares the chain above it. Then each
 * distinct Slack channel is checked once. A thread that cannot be resolved,
 * or whose channel check fails, is not shown.
 */
export async function visibleThreadIds(
  deps: AccessDeps, session: { ownerType: string }, viewer: ThreadViewer,
  threads: ReadonlyArray<{ sessionId: string; threadId: string }>,
): Promise<Set<string>> {
  const pairs = new Map(threads.map((t) => [`${t.sessionId}:${t.threadId}`, t]));
  if (session.ownerType !== "team" || pairs.size === 0) return new Set(pairs.keys());
  const result = await deps.db.execute(visibleThreadRowsSql([...pairs.values()])) as {
    // Raw SQL rows are untyped; the SELECT names these columns.
    rows: Array<{
      session_id: string; thread_id: string; found: boolean; key: string | null; linked: boolean | null;
      chain_key: string | null; chain_channels: string[] | null; own_channels: string[] | null;
    }>;
  };
  const decided = new Map<string, boolean>();
  const gated = new Map<string, string[]>();
  for (const row of result.rows) {
    const id = `${row.session_id}:${row.thread_id}`;
    if (!pairs.has(id)) continue;
    // As `governingThreadKeySql` reads it from the thread up: the top of a
    // child's chain, else the thread's own key. A missing thread, or an
    // execution with no parent link, has an unknown audience.
    const linked = row.linked === true;
    const key = linked ? row.chain_key
      : !row.found || row.session_id.startsWith("execution:") ? UNKNOWN_THREAD_KEY : row.key;
    if (isPersonalThreadKey(key)) {
      const owner = privateThreadOwner(key);
      decided.set(id, owner !== undefined && owner === viewer.userId);
      continue;
    }
    const recorded = recordedSlackChannels({
      [SLACK_CHANNELS_METADATA_KEY]: [...(row.own_channels ?? []), ...(linked ? row.chain_channels ?? [] : [])],
    });
    gated.set(id, gatingChannels(key, recorded));
  }
  const canSee = channelVisibility(deps, viewer);
  const channels = [...new Set([...gated.values()].flat())];
  // A failed check is an unknown audience: the channel counts as hidden.
  const seen = await mapBounded(channels, CHANNEL_CHECK_CONCURRENCY, (channelId) => canSee(`slack:${channelId}`).catch(() => false));
  const visibleChannel = new Map(channels.map((channelId, index) => [channelId, seen[index] === true]));
  for (const [id, gating] of gated) decided.set(id, gating.every((channelId) => visibleChannel.get(channelId) === true));
  const shown = new Set<string>();
  // A missing source is an unknown audience, never evidence of shared access.
  for (const [id, visible] of decided) if (visible) shown.add(id);
  return shown;
}

/**
 * Which threads a team runtime's thread may read with `thread_read` and
 * `list_threads`: what its audience may see, so the agent cannot repeat a
 * private thread to people outside it.
 *
 * - A helper or workflow editor thread reads what its person may see.
 * - A Slack channel thread reads its own channel's threads.
 * - A Slack, Telegram, or GitHub thread has readers who need not be on the
 *   team. Beyond its own conversation, it reads only public Slack channels.
 * - Any other thread reads what the whole team may see.
 */
export function threadReadAccess(deps: AccessDeps): ThreadAccessCheck {
  return async ({ owner, orgId, reader, target }) => {
    if (owner.type !== "team") return true;
    const targetRecorded = await recordedChannelsById(deps.db, target.id);
    const person = privateThreadOwner(reader.key);
    if (person) {
      return threadVisibility(deps, { ownerType: "team" }, { orgId, userId: person })(
        { key: target.key, metadata: { [SLACK_CHANNELS_METADATA_KEY]: targetRecorded } });
    }
    if (isPersonalThreadKey(target.key)) return false;
    const readerChannels = gatingChannels(reader.key, await recordedChannelsById(deps.db, reader.id));
    const targetChannels = gatingChannels(target.key, targetRecorded);
    // Channels the reader's own audience already reads need no check.
    const foreign = targetChannels.filter((channel) => !readerChannels.includes(channel));
    if (targetChannels.length > 0 && foreign.length === 0) return true;
    // A thread with Slack content has readers outside the team, as a Slack key does.
    if (isOutsideReader(reader.key, readerChannels)) {
      if (readerChannels.length === 0 || targetChannels.length === 0) return reader.key === target.key;
    } else if (foreign.length === 0) {
      return true;
    }
    let token: Promise<string | null> | undefined;
    for (const channel of foreign) {
      const isPrivate = await slackChannelIsPrivate(deps, orgId, channel,
        () => (token ??= orgSlackCredential(deps, orgId).then(botToken)));
      if (isPrivate !== false) return false;
    }
    return true;
  };
}

/** The Slack channels recorded on a thread and the threads above it, by thread id. */
async function recordedChannelsById(db: Providers["db"], threadId: string): Promise<string[]> {
  const result = await db.execute(sql`SELECT ${threadSlackChannelsSql(sql`et.session_id`, sql`et.id`)} AS channels
    FROM engine_threads et WHERE et.id = ${threadId}`) as { rows: Array<{ channels: string[] | null }> };
  return result.rows[0]?.channels ?? [];
}

/** Whether the viewer may see the thread a team workflow run started from.
 * A run started from a private thread belongs to that thread's audience: its
 * record, input, and approvals (`workflows/run-attention.ts`). When the origin
 * thread is gone, nobody can tell who it was shared with, so only the member
 * who started the run sees it. A personal run has one viewer. */
export async function runOriginVisible(
  deps: AccessDeps & Pick<Providers, "engineStore">,
  viewer: ThreadViewer,
  run: { ownerType: string; origin?: WorkflowRunOrigin | null; actorUserId?: string | null },
): Promise<boolean> {
  if (run.ownerType !== "team" || !run.origin) return true;
  const [session] = await deps.db.select({ id: agentSessions.id, ownerType: agentSessions.ownerType }).from(agentSessions)
    .where(eq(agentSessions.id, run.origin.assistantSessionId)).limit(1);
  const thread = session && await deps.engineStore.getThread(run.origin.assistantSessionId, run.origin.threadId);
  if (!thread) return viewer.userId !== undefined && viewer.userId === run.actorUserId;
  return threadVisibility(deps, session, viewer)(thread);
}

/** The Slack channel an event came from. Ingest copies it to `refs.channel`
 * (`plugin-slack/src/triggers.ts`); an older row falls back to the payload,
 * where a reaction keeps it at `item.channel`. */
export function slackEventChannel(event: { service: string; refs: unknown; payload: unknown }): string | undefined {
  if (event.service !== "slack") return undefined;
  const str = (v: unknown) => typeof v === "string" && v ? v : undefined;
  const obj = (v: unknown) => v && typeof v === "object" ? v as Record<string, unknown> : undefined;
  const payload = obj(event.payload);
  return str(obj(event.refs)?.channel) ?? str(payload?.channel) ?? str(obj(payload?.channel)?.id)
    ?? str(payload?.channel_id) ?? str(obj(payload?.item)?.channel);
}

/** Whether the viewer may see a workflow run started by a Slack event. The
 * run's input carries the event's message, so a run from a private channel
 * shows only to that channel's members, the same as the event itself. */
export async function runEventVisible(deps: AccessDeps, viewer: ThreadViewer, params: { input?: unknown }): Promise<boolean> {
  const channel = runEventChannel(params);
  if (channel !== undefined) return channelVisibility(deps, viewer)(`slack:${channel}`);
  const input = params.input;
  if (input && typeof input === "object" && "type" in input && input.type === "event" && "data" in input) {
    const data = input.data;
    if (data && typeof data === "object" && "key" in data && typeof data.key === "string" && data.key.startsWith("slack.")) return false;
  }
  return true;
}

/** The Slack channel whose event started a workflow run, or undefined. The
 * run's thread and its attention stay with that channel's audience. */
export function runEventChannel(params: { input?: unknown }): string | undefined {
  const input = params.input && typeof params.input === "object" ? params.input as Record<string, unknown> : undefined;
  const data = input?.type === "event" && input.data && typeof input.data === "object" ? input.data as Record<string, unknown> : undefined;
  const key = typeof data?.key === "string" ? data.key : "";
  if (!key.startsWith("slack.")) return undefined;
  return slackEventChannel({ service: "slack", refs: data?.refs, payload: data?.payload });
}
