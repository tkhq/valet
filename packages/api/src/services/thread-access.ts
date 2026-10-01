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
 * only after it goes stale. When Slack cannot answer, the stored answer
 * stands: a public channel stays readable after a disconnect, and a private
 * one stays hidden. A channel never classified, with no bot credential to ask,
 * reads as shared, the rule before private channels were checked.
 */
import { and, eq, sql, type SQL } from "drizzle-orm";
import type { StoredCredential, ThreadAccessCheck } from "@valet/engine";
import { checkPrivateChannelAccess } from "@valet/plugin-slack/actions";
import { identityForUser } from "../channels/identity-links.js";
import type { RequestPrincipal } from "../lib/request-principal.js";
import type { Providers } from "../providers/types.js";
import { slackChannelPrivacy } from "../schema/index.js";
import { slackConversationFromThreadKey } from "./channel-messages.js";
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

/** A channel's privacy is rechecked after this long; it rarely changes. */
const PRIVACY_TTL_MS = 60 * 60_000;
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
  let isPrivate = stored?.isPrivate;
  if (!stored || stored.checkedAt + PRIVACY_TTL_MS <= now) {
    const bot = await token();
    // Privacy comes from `conversations.info`, which answers before any
    // membership check, so no viewer is needed here.
    const info = bot ? await checkPrivateChannelAccess(bot, channelId, undefined).catch(() => null) : null;
    const answered = info && (!info.error || info.isPrivate);
    if (answered) {
      isPrivate = info.isPrivate;
      await deps.db.insert(slackChannelPrivacy).values({ orgId, channelId, isPrivate, checkedAt: now })
        .onConflictDoUpdate({ target: [slackChannelPrivacy.orgId, slackChannelPrivacy.channelId], set: { isPrivate, checkedAt: now } });
    }
  }
  setCapped(privacyCache, cacheKey, { isPrivate, expiresAt: now + (isPrivate === undefined ? MEMBERSHIP_TTL_MS : PRIVACY_TTL_MS) });
  return isPrivate;
}

/** Forgets what this process remembers about channel privacy and membership. Tests only. */
export function resetThreadAccessCache(): void {
  privacyCache.clear();
  membershipCache.clear();
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
    if (isPrivate !== true) return true;
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
    const access = await checkPrivateChannelAccess(token, channelId, member).catch(() => null);
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
 */
export function threadVisibility(deps: AccessDeps, session: { ownerType: string }, viewer: ThreadViewer): ThreadVisibility {
  if (session.ownerType !== "team") return async () => true;
  const canSee = channelVisibility(deps, viewer);
  return async (key) => {
    if (isPersonalThreadKey(key)) {
      const owner = privateThreadOwner(key);
      return owner !== undefined && owner === viewer.userId;
    }
    const conversation = slackConversationFromThreadKey(key ?? null);
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
    AND (${key} NOT LIKE 'slack:%' OR ${key} LIKE 'slack:D%' OR EXISTS (SELECT 1 FROM slack_channel_privacy p
      WHERE p.org_id = ${orgId} AND p.channel_id = split_part(${key}, ':', 2) AND p.is_private = false))))`;
}

/** Of the given threads, the ones (`<session>:<thread>`) the viewer may see. */
export async function visibleThreadIds(
  deps: AccessDeps, session: { ownerType: string }, viewer: ThreadViewer,
  threads: ReadonlyArray<{ sessionId: string; threadId: string }>,
): Promise<Set<string>> {
  const pairs = new Map(threads.map((t) => [`${t.sessionId}:${t.threadId}`, t]));
  if (session.ownerType !== "team" || pairs.size === 0) return new Set(pairs.keys());
  const result = await deps.db.execute(sql`SELECT session_id, id, key FROM engine_threads
    WHERE (session_id, id) IN (${sql.join([...pairs.values()].map((t) => sql`(${t.sessionId}, ${t.threadId})`), sql`, `)})`) as {
    rows: Array<{ session_id: string; id: string; key: string | null }>;
  };
  const keys = new Map(result.rows.map((row) => [`${row.session_id}:${row.id}`, row.key]));
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
 * - Any thread reads what the whole team may see.
 */
export function threadReadAccess(deps: AccessDeps): ThreadAccessCheck {
  return async ({ owner, orgId, reader, target }) => {
    if (owner.type !== "team") return true;
    const person = privateThreadOwner(reader.key);
    if (person) return threadVisibility(deps, { ownerType: "team" }, { orgId, userId: person })(target.key);
    if (isPersonalThreadKey(target.key)) return false;
    const targetChannel = slackConversationFromThreadKey(target.key)?.channelId;
    if (!targetChannel || targetChannel === slackConversationFromThreadKey(reader.key)?.channelId) return true;
    let token: Promise<string | null> | undefined;
    const isPrivate = await slackChannelIsPrivate(deps, orgId, targetChannel,
      () => (token ??= orgSlackCredential(deps, orgId).then(botToken)));
    return isPrivate !== true;
  };
}
