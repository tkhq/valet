/**
 * `GET /api/workspaces/:workspace/channels` and `.../channel?key=` — the
 * channels a workspace talks and listens in.
 */
import { Hono, type Context } from "hono";
import type { AppEnv } from "../env.js";
import { resolveOrgCredentialRead } from "../services/credential-resolution.js";
import { OnePasswordAuthError } from "../services/onepassword.js";
import { checkPrivateChannelAccess } from "@valet/plugin-slack/actions";
import type { StoredCredential } from "@valet/engine";
import { getChannel, listChannels, type ChannelNames, type ChannelVisibility } from "../services/channels.js";
import { parseChannelKey } from "../services/channel-messages.js";
import { identityForUser } from "../channels/identity-links.js";
import { authorizedWorkspaceOwner } from "./workspace-runtime.js";

export const workspaceChannelsRouter = new Hono<AppEnv>();

const NAMES_TTL_MS = 5 * 60_000;
const namesCache = new Map<string, { names: Map<string, string>; expiresAt: number }>();

/** Caps a TTL cache: past `max` entries it drops the expired ones, then the
 * oldest, so a long-lived process does not keep every key it has seen. */
function setCapped<V extends { expiresAt: number }>(cache: Map<string, V>, key: string, value: V, max = 5000): void {
  if (cache.size >= max) {
    const now = Date.now();
    for (const [old, entry] of cache) if (entry.expiresAt <= now) cache.delete(old);
    if (cache.size >= max) cache.delete(cache.keys().next().value!);
  }
  cache.set(key, value);
}

/** The organization's Slack bot credential, or null when none is connected. */
async function orgSlackCredential(c: Context<AppEnv>): Promise<StoredCredential | null> {
  const { engineCredentials, onePassword } = c.var.providers;
  try {
    return await resolveOrgCredentialRead({ credentials: engineCredentials, onePassword }, { orgId: c.var.user.orgId, scopes: ["org"] }, "slack");
  } catch (err) {
    if (!(err instanceof OnePasswordAuthError)) throw err;
    return null;
  }
}

/**
 * Slack channel names through the Slack plugin's channel option resolver, with
 * the org's credential. No credential, or a provider error, leaves the ids.
 */
function slackChannelNames(c: Context<AppEnv>): ChannelNames {
  return async () => {
    const orgId = c.var.user.orgId;
    const cached = namesCache.get(orgId);
    if (cached && cached.expiresAt > Date.now()) return cached.names;
    const plugin = c.var.providers.plugins.find((candidate) => candidate.filterOptionResolvers?.["slack.channels"]);
    const resolver = plugin?.filterOptionResolvers?.["slack.channels"];
    if (!plugin || !resolver) return new Map();
    const credential = await orgSlackCredential(c);
    if (!credential) return new Map();
    const options = await resolver({ orgId, deps: {}, credential });
    const names = new Map(options.map((option) => [option.id, option.label]));
    setCapped(namesCache, orgId, { names, expiresAt: Date.now() + NAMES_TTL_MS });
    return names;
  };
}

const ACCESS_TTL_MS = 5 * 60_000;
const accessCache = new Map<string, { allowed: boolean; expiresAt: number }>();

/**
 * Who may see a channel: a pull request or a public Slack channel, anyone in
 * the workspace. A private Slack channel only its members, by the viewer's
 * linked Slack account, the rule Slack actions follow
 * (docs/specs/2026-03-16-slack-private-channel-auth-design.md). Team
 * membership alone is not enough: the bot reads the channel for everyone.
 * Without a link, a bot credential, or an answer from Slack, it stays hidden.
 */
function channelVisibility(c: Context<AppEnv>): ChannelVisibility {
  let token: Promise<string | null> | undefined;
  let slackUserId: Promise<string | undefined> | undefined;
  return async (key) => {
    const parsed = parseChannelKey(key);
    if (parsed?.provider !== "slack") return true;
    const cacheKey = `${c.var.user.orgId}:${c.var.user.id}:${parsed.channelId}`;
    const cached = accessCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.allowed;
    token ??= orgSlackCredential(c).then((credential) => credential?.accessToken ?? credential?.apiKey ?? null);
    slackUserId ??= identityForUser(c.var.providers.db, "slack", c.var.user.id).then((link) => link?.externalId);
    const botToken = await token;
    if (!botToken) return false;
    const access = await checkPrivateChannelAccess(botToken, parsed.channelId, await slackUserId).catch(() => null);
    const allowed = access?.allowed === true;
    // A Slack error is not cached, so the next request asks again.
    if (access && !access.error) setCapped(accessCache, cacheKey, { allowed, expiresAt: Date.now() + ACCESS_TTL_MS });
    return allowed;
  };
}

workspaceChannelsRouter.get("/:workspace/channels", async (c) => {
  const owner = await authorizedWorkspaceOwner(c);
  if (!owner) return c.json({ error: "Workspace not found." }, 404);
  return c.json(await listChannels(c.var.providers.db, c.var.user.orgId, owner, slackChannelNames(c), channelVisibility(c)));
});

workspaceChannelsRouter.get("/:workspace/channel", async (c) => {
  const owner = await authorizedWorkspaceOwner(c);
  if (!owner) return c.json({ error: "Workspace not found." }, 404);
  const key = c.req.query("key");
  if (!key) return c.json({ error: "Send the channel key, such as ?key=slack:C123." }, 400);
  const detail = await getChannel(c.var.providers.db, c.var.user.orgId, owner, key, slackChannelNames(c), channelVisibility(c));
  if (!detail) return c.json({ error: "This workspace has no conversation in that channel. Open Channels to see the channels it uses." }, 404);
  return c.json(detail);
});
