/**
 * Who may see a thread of a team runtime. Team members share one runtime, so
 * session access alone would show every thread to every member. Three kinds
 * of thread are narrower:
 *
 * - A member's helper thread (`app-assistant:<user>`) is that member's alone.
 * - A workflow editor conversation (`workflow:<id>:<user>`) is that member's
 *   alone.
 * - A thread from a private Slack channel shows only to the channel's members,
 *   by the viewer's linked Slack account, the rule Slack actions follow
 *   (docs/specs/2026-03-16-slack-private-channel-auth-design.md). The bot
 *   reads the channel for everyone, so team membership is not enough.
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
import { and, eq, sql, type SQL } from "drizzle-orm";
import type { StoredCredential, ThreadAccessCheck } from "@valet/engine";
import type { WorkflowRunOrigin } from "@valet/workflow";
import { checkPrivateChannelAccess } from "@valet/plugin-slack/actions";
import { identityForUser } from "../channels/identity-links.js";
import type { RequestPrincipal } from "../lib/request-principal.js";
import type { Providers } from "../providers/types.js";
import { agentSessions, slackChannelPrivacy } from "../schema/index.js";
/** The Slack conversation a thread key names, DMs and group DMs included. */
function slackConversation(key: string | null | undefined): { channelId: string } | null {
  const match = /^slack:([^:]+):[^:]+$/.exec(key ?? "");
  return match ? { channelId: match[1]! } : null;
}
import type { ChannelVisibility } from "./channels.js";
import { resolveOrgCredentialRead } from "./credential-resolution.js";
import { OnePasswordAuthError } from "./onepassword.js";

type AccessDeps = Pick<Providers, "db" | "engineCredentials"> & { onePassword?: Providers["onePassword"] };

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

/**
 * Whether a Slack channel is private: from memory, then the stored answer
 * while it is fresh, then Slack, with the stored answer standing when Slack
 * cannot answer. Undefined only for a channel never classified.
 */
export async function slackChannelIsPrivate(
  deps: AccessDeps, orgId: string, channelId: string, token: () => Promise<string | null>,
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
    const info = bot ? await checkPrivateChannelAccess(bot, channelId, undefined, { directIsPrivate: true }).catch(() => null) : null;
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
  return sql`(WITH RECURSIVE up(sid, tid, depth) AS (
      SELECT ${sessionId}::text, ${threadId}::text, ${sql.raw(from === "parent link" ? "1" : "0")}
      UNION ALL
      SELECT es.parent_session_id, es.parent_thread_id, up.depth + 1 FROM up
      JOIN engine_sessions es ON es.id = up.sid
      WHERE es.parent_session_id IS NOT NULL AND es.parent_thread_id IS NOT NULL AND up.depth < 8
    ) SELECT CASE WHEN up.depth > 0 AND et.id IS NULL THEN ${UNKNOWN_THREAD_KEY} ELSE et.key END
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
  return row?.parent_session_id && row.parent_thread_id ? { sessionId: row.parent_session_id, threadId: row.parent_thread_id } : null;
}

/** Conversations whose readers need not be on the team. */
const OUTSIDE_THREAD_KEY = /^(slack|telegram|github):/;

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
  if (key.startsWith("app-assistant:")) return key.slice("app-assistant:".length) || undefined;
  if (key.startsWith("workflow:")) return key.split(":")[2] || undefined;
  return undefined;
}

export type ThreadVisibility = (threadKey: string | null | undefined) => Promise<boolean>;

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
export function channelVisibility(deps: AccessDeps, viewer: ThreadViewer): ChannelVisibility {
  let token: Promise<string | null> | undefined;
  let slackUserId: Promise<string | undefined> | undefined;
  const bot = () => (token ??= orgSlackCredential(deps, viewer.orgId).then(botToken));
  return async (channelKey) => {
    const channelId = /^slack:([^:]+)$/.exec(channelKey)?.[1];
    if (!channelId) return true;
    const isPrivate = await slackChannelIsPrivate(deps, viewer.orgId, channelId, bot);
    if (isPrivate === false) return true;
    // A channel never classified, with Slack unable to answer, may be
    // private: it stays hidden until Slack says otherwise.
    if (isPrivate === undefined) return false;
    if (!viewer.userId) return false;
    slackUserId ??= identityForUser(deps.db, "slack", viewer.userId).then((link) => link?.externalId);
    // Without a linked Slack account nobody can vouch for membership.
    const member = await slackUserId;
    if (!member) return false;
    const cacheKey = `${viewer.orgId}:${member}:${channelId}`;
    const cached = membershipCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.allowed;
    const token = await bot();
    if (!token) return false;
    const access = await checkPrivateChannelAccess(token, channelId, member, { directIsPrivate: true }).catch(() => null);
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
export function threadVisibility(deps: AccessDeps, session: { ownerType: string; id?: string }, viewer: ThreadViewer): ThreadVisibility {
  if (session.ownerType !== "team") return async () => true;
  const canSee = channelVisibility(deps, viewer);
  let inherited: Promise<string | null | undefined> | undefined;
  const governing = () => (inherited ??= session.id
    ? spawningThread(deps.db, session.id).then((parent) => parent ? governingThreadKey(deps.db, parent.sessionId, parent.threadId, "parent link") : undefined)
    : Promise.resolve(undefined));
  return async (ownKey) => {
    const parentKey = await governing();
    const key = parentKey === undefined ? ownKey : parentKey;
    if (isPersonalThreadKey(key)) {
      const owner = privateThreadOwner(key);
      return owner !== undefined && owner === viewer.userId;
    }
    const conversation = slackConversation(key ?? null);
    return conversation ? canSee(`slack:${conversation.channelId}`) : true;
  };
}

/**
 * SQL: whether a team thread may appear in content every member sees at once,
 * such as a cached briefing. Not a person's own thread, and not a Slack
 * channel thread unless the channel is stored as public: nobody's access is
 * checked when the content is read. A channel is classified the first time
 * any member's thread list shows it.
 */
export function sharedWithWholeTeamSql(orgId: string, key: SQL): SQL {
  return sql`(${key} IS NULL OR (${key} NOT LIKE 'app-assistant:%' AND ${key} NOT LIKE 'workflow:%'
    AND (${key} NOT LIKE 'slack:%' OR EXISTS (SELECT 1 FROM slack_channel_privacy p
      WHERE p.org_id = ${orgId} AND p.channel_id = split_part(${key}, ':', 2) AND p.is_private = false))))`;
}

/** Of the given threads, the ones (`<session>:<thread>`) the viewer may see. */
export async function visibleThreadIds(
  deps: AccessDeps, session: { ownerType: string }, viewer: ThreadViewer,
  threads: ReadonlyArray<{ sessionId: string; threadId: string }>,
): Promise<Set<string>> {
  const pairs = new Map(threads.map((t) => [`${t.sessionId}:${t.threadId}`, t]));
  if (session.ownerType !== "team" || pairs.size === 0) return new Set(pairs.keys());
  const result = await deps.db.execute(sql`SELECT t.session_id, t.thread_id, ${governingThreadKeySql(sql`t.session_id`, sql`t.thread_id`)} AS key
    FROM (VALUES ${sql.join([...pairs.values()].map((t) => sql`(${t.sessionId}::text, ${t.threadId}::text)`), sql`, `)}) AS t(session_id, thread_id)`) as {
    rows: Array<{ session_id: string; thread_id: string; key: string | null }>;
  };
  const keys = new Map(result.rows.map((row) => [`${row.session_id}:${row.thread_id}`, row.key]));
  const visible = threadVisibility(deps, session, viewer);
  const shown = new Set<string>();
  // A thread with no engine row has no key that narrows it.
  for (const id of pairs.keys()) if (await visible(keys.get(id))) shown.add(id);
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
    const person = privateThreadOwner(reader.key);
    if (person) return threadVisibility(deps, { ownerType: "team" }, { orgId, userId: person })(target.key);
    if (isPersonalThreadKey(target.key)) return false;
    const readerChannel = slackConversation(reader.key)?.channelId;
    const targetChannel = slackConversation(target.key)?.channelId;
    if (targetChannel && targetChannel === readerChannel) return true;
    if (OUTSIDE_THREAD_KEY.test(reader.key ?? "")) {
      if (!readerChannel || !targetChannel) return reader.key === target.key;
    } else if (!targetChannel) {
      return true;
    }
    let token: Promise<string | null> | undefined;
    const isPrivate = await slackChannelIsPrivate(deps, orgId, targetChannel,
      () => (token ??= orgSlackCredential(deps, orgId).then(botToken)));
    return isPrivate === false;
  };
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
  const [session] = await deps.db.select({ ownerType: agentSessions.ownerType }).from(agentSessions)
    .where(eq(agentSessions.id, run.origin.assistantSessionId)).limit(1);
  const thread = session && await deps.engineStore.getThread(run.origin.assistantSessionId, run.origin.threadId);
  if (!thread) return viewer.userId !== undefined && viewer.userId === run.actorUserId;
  return threadVisibility(deps, session, viewer)(thread.key);
}
