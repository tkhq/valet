/**
 * `GET /api/workspaces/:workspace/channels` and `.../channel?key=` — the
 * channels a workspace talks and listens in.
 */
import { Hono, type Context } from "hono";
import { credentialSecret } from "@valet/engine";
import { slackGet } from "@valet/plugin-slack/actions";
import type { AppEnv } from "../env.js";
import { mapBounded } from "../lib/bounded-map.js";
import { getChannel, listChannels, type ChannelNames } from "../services/channels.js";
import { orgSlackCredential, setCapped } from "../services/thread-access.js";
import { channelsVisibleTo, keepVisibleThreads } from "./_thread-access.js";
import type { ThreadPairsShown, ThreadsShown } from "../services/channels.js";
import { authorizedWorkspaceOwner } from "./workspace-runtime.js";

export const workspaceChannelsRouter = new Hono<AppEnv>();

const NAMES_TTL_MS = 5 * 60_000;
const namesCache = new Map<string, { names: Map<string, string>; expiresAt: number }>();

/**
 * Slack channel names through the Slack plugin's channel option resolver, with
 * the org's credential. No credential, or a provider error, leaves the ids.
 */
export function slackChannelNames(c: Context<AppEnv>): ChannelNames {
  return async () => {
    const orgId = c.var.user.orgId;
    const cached = namesCache.get(orgId);
    if (cached && cached.expiresAt > Date.now()) return cached.names;
    const plugin = c.var.providers.plugins.find((candidate) => candidate.filterOptionResolvers?.["slack.channels"]);
    const resolver = plugin?.filterOptionResolvers?.["slack.channels"];
    if (!plugin || !resolver) return new Map();
    const credential = await orgSlackCredential(c.var.providers, c.var.user.orgId);
    if (!credential) return new Map();
    const options = await resolver({ orgId, deps: {}, credential });
    const names = new Map(options.map((option) => [option.id, option.label]));
    setCapped(namesCache, orgId, { names, expiresAt: Date.now() + NAMES_TTL_MS });
    return names;
  };
}

/** The most channels one lookup asks Slack about. A later lookup asks about the rest. */
const LOOKUP_LIMIT = 20;
const LOOKUP_CONCURRENCY = 5;
/**
 * What `conversations.info` answered, by `<org>:<channel>`. A null name
 * records a channel Slack did not name, such as one the bot cannot read, so a
 * lookup asks Slack again only after the entry expires.
 */
const lookupCache = new Map<string, { name: string | null; expiresAt: number }>();

/**
 * A channel's name from `conversations.info`, or null when Slack gives no
 * name or the call fails. It reads Slack on every call: `lookupCache` is the
 * only cache, so a renamed channel shows its new name when the entry expires.
 */
async function conversationName(token: string, channelId: string): Promise<string | null> {
  try {
    const res = await slackGet("conversations.info", token, { channel: channelId });
    const body: unknown = res.ok ? await res.json() : null;
    if (typeof body !== "object" || body === null || !("ok" in body) || body.ok !== true) return null;
    const channel = "channel" in body ? body.channel : undefined;
    const name = typeof channel === "object" && channel !== null && "name" in channel ? channel.name : undefined;
    return typeof name === "string" && name !== "" ? name : null;
  } catch {
    return null;
  }
}

/**
 * Slack channel names from `conversations.info` with the org's bot
 * credential, one channel at a time. It names a channel that the bot's
 * channel list (`slackChannelNames`) leaves out: that list stops at the
 * picker's limit, and it holds only channels the bot has joined. One lookup
 * asks Slack about at most `LOOKUP_LIMIT` channels with no current answer.
 * An expired answer still names its channel when the lookup has no room to
 * ask about it again. No credential leaves the ids.
 */
export function slackChannelLookup(c: Context<AppEnv>): ChannelNames {
  return async (channelIds) => {
    const orgId = c.var.user.orgId;
    const now = Date.now();
    const names = new Map<string, string>();
    const ask: string[] = [];
    for (const id of new Set(channelIds)) {
      const known = lookupCache.get(`${orgId}:${id}`);
      if ((known === undefined || known.expiresAt <= now) && ask.length < LOOKUP_LIMIT) ask.push(id);
      else if (known?.name) names.set(id, known.name);
    }
    if (ask.length === 0) return names;
    const token = credentialSecret(await orgSlackCredential(c.var.providers, orgId));
    if (!token) return names;
    const found = await mapBounded(ask, LOOKUP_CONCURRENCY, (id) => conversationName(token, id));
    ask.forEach((id, index) => {
      const name = found[index] ?? null;
      setCapped(lookupCache, `${orgId}:${id}`, { name, expiresAt: now + NAMES_TTL_MS });
      if (name) names.set(id, name);
    });
    return names;
  };
}

/** Forgets the channel names that `slackChannelNames` and `slackChannelLookup` hold. Tests only. */
export function resetChannelNameCaches(): void {
  namesCache.clear();
  lookupCache.clear();
}

workspaceChannelsRouter.get("/:workspace/channels", async (c) => {
  const owner = await authorizedWorkspaceOwner(c);
  if (!owner) return c.json({ error: "Workspace not found." }, 404);
  return c.json(await listChannels(c.var.providers.db, c.var.user.orgId, owner, slackChannelNames(c), channelsVisibleTo(c), threadsShownTo(c, owner)));
});

workspaceChannelsRouter.get("/:workspace/channel", async (c) => {
  const owner = await authorizedWorkspaceOwner(c);
  if (!owner) return c.json({ error: "Workspace not found." }, 404);
  const key = c.req.query("key");
  if (!key) return c.json({ error: "Send the channel key, such as ?key=slack:C123." }, 400);
  const detail = await getChannel(c.var.providers.db, c.var.user.orgId, owner, key, slackChannelNames(c), channelsVisibleTo(c), threadsShownTo(c, owner));
  if (!detail) return c.json({ error: "This workspace has no conversation in that channel. Open Channels to see the channels it uses." }, 404);
  return c.json(detail);
});

/** Of threads from several runtimes, the ones (`<session>:<thread>`) this request may see, in one pass (`thread-access.ts`). */
export function threadPairsShownTo(c: Context<AppEnv>, owner: { type: string }): ThreadPairsShown {
  return async (threads) => new Set((await keepVisibleThreads(c, owner, [...threads])).map((row) => `${row.sessionId}:${row.threadId}`));
}

/** Of a runtime's threads, the ones this request may see (`thread-access.ts`). */
export function threadsShownTo(c: Context<AppEnv>, owner: { type: string }): ThreadsShown {
  return async (sessionId, threadIds) => new Set((await keepVisibleThreads(c, owner,
    threadIds.map((threadId) => ({ sessionId, threadId })))).map((row) => row.threadId));
}
