/**
 * Private Slack channel access for a request's viewer, shared by the
 * Channels routes and the thread and message routes. A team runtime's bot
 * reads every channel it is in, so team membership alone must not show a
 * private channel's content.
 */
import type { Context } from "hono";
import type { StoredCredential } from "@valet/engine";
import { checkPrivateChannelAccess } from "@valet/plugin-slack/actions";
import type { AppEnv } from "../env.js";
import { identityForUser } from "../channels/identity-links.js";
import { resolveOrgCredentialRead } from "../services/credential-resolution.js";
import { OnePasswordAuthError } from "../services/onepassword.js";
import { parseChannelKey, slackConversationFromThreadKey } from "../services/channel-messages.js";
import type { ChannelVisibility } from "../services/channels.js";

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
export async function orgSlackCredential(c: Context<AppEnv>): Promise<StoredCredential | null> {
  const { engineCredentials, onePassword } = c.var.providers;
  try {
    return await resolveOrgCredentialRead({ credentials: engineCredentials, onePassword }, { orgId: c.var.user.orgId, scopes: ["org"] }, "slack");
  } catch (err) {
    if (!(err instanceof OnePasswordAuthError)) throw err;
    return null;
  }
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
export function channelVisibility(c: Context<AppEnv>): ChannelVisibility {
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


/** Whether the viewer may see a thread: a thread from a private Slack channel
 * only for that channel's members, any other thread for anyone who may see
 * the session. */
export function threadVisibility(c: Context<AppEnv>): (threadKey: string | undefined) => Promise<boolean> {
  const canSee = channelVisibility(c);
  return async (threadKey) => {
    const conversation = slackConversationFromThreadKey(threadKey ?? null);
    return conversation ? canSee(`slack:${conversation.channelId}`) : true;
  };
}
