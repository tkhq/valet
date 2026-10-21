/**
 * `GET /api/workspaces/:workspace/channels` and `.../channel?key=` — the
 * channels a workspace talks and listens in.
 */
import { Hono, type Context } from "hono";
import { joinedChannelDirectory } from "@valet/plugin-slack/actions";
import type { AppEnv } from "../env.js";
import { getChannel, listChannels, type ChannelDirectory, type ChannelNames, type DirectoryChannel } from "../services/channels.js";
import { orgSlackCredential, setCapped } from "../services/thread-access.js";
import { channelsVisibleTo, keepVisibleThreads } from "./_thread-access.js";
import type { ThreadPairsShown, ThreadsShown } from "../services/channels.js";
import { authorizedWorkspaceOwner } from "./workspace-runtime.js";

export const workspaceChannelsRouter = new Hono<AppEnv>();

const NAMES_TTL_MS = 5 * 60_000;
/** How long a failed scan answers with no channels, so a read does not wait on a rate-limited Slack again. */
const FAILED_SCAN_TTL_MS = 60_000;
const directoryCache = new Map<string, { channels: ReadonlyMap<string, DirectoryChannel>; expiresAt: number }>();

/**
 * Every live Slack channel the org's bot has joined, by channel id, with its
 * name and privacy. It reads the Slack plugin's joined-channel scan, which
 * has no picker limit. No Slack plugin or no credential gives an empty list.
 * A provider error propagates, and the next minute's reads get an empty list
 * without asking Slack.
 */
export function slackChannelDirectory(c: Context<AppEnv>): ChannelDirectory {
  return async () => {
    const orgId = c.var.user.orgId;
    const cached = directoryCache.get(orgId);
    if (cached && cached.expiresAt > Date.now()) return cached.channels;
    if (!c.var.providers.plugins.some((candidate) => candidate.filterOptionResolvers?.["slack.channels"])) return new Map();
    const credential = await orgSlackCredential(c.var.providers, orgId);
    if (!credential) return new Map();
    let joined: Awaited<ReturnType<typeof joinedChannelDirectory>>;
    try {
      joined = await joinedChannelDirectory(credential);
    } catch (err) {
      setCapped(directoryCache, orgId, { channels: new Map(), expiresAt: Date.now() + FAILED_SCAN_TTL_MS });
      throw err;
    }
    const channels = new Map(joined.map(({ id, name, isPrivate }) => [id, { name, isPrivate }]));
    setCapped(directoryCache, orgId, { channels, expiresAt: Date.now() + NAMES_TTL_MS });
    return channels;
  };
}

/**
 * Slack channel names as `#name`, from the channels the org's bot has joined
 * (`slackChannelDirectory`). No credential, or a provider error, leaves the ids.
 */
export function slackChannelNames(c: Context<AppEnv>): ChannelNames {
  const directory = slackChannelDirectory(c);
  return async () => new Map([...await directory()].map(([id, channel]) => [id, `#${channel.name}`]));
}

/** Forgets the joined channels that `slackChannelDirectory` holds. Tests only. */
export function resetChannelNameCaches(): void {
  directoryCache.clear();
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
