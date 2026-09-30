/**
 * `GET /api/workspaces/:workspace/channels` and `.../channel?key=` — the
 * channels a workspace talks and listens in. See
 * docs/specs/2026-09-30-channels-design.md.
 */
import { Hono, type Context } from "hono";
import type { AppEnv } from "../env.js";
import { resolveOrgCredentialRead } from "../services/credential-resolution.js";
import { OnePasswordAuthError } from "../services/onepassword.js";
import { getChannel, listChannels, type ChannelNames } from "../services/channels.js";
import { authorizedWorkspaceOwner } from "./workspace-runtime.js";

export const workspaceChannelsRouter = new Hono<AppEnv>();

const NAMES_TTL_MS = 5 * 60_000;
const namesCache = new Map<string, { names: Map<string, string>; expiresAt: number }>();

/**
 * Slack channel names through the Slack plugin's channel option resolver, with
 * the org's credential. No credential, or a provider error, leaves the ids.
 */
function slackChannelNames(c: Context<AppEnv>): ChannelNames {
  return async () => {
    const orgId = c.var.user.orgId;
    const cached = namesCache.get(orgId);
    if (cached && cached.expiresAt > Date.now()) return cached.names;
    const { plugins, engineCredentials, onePassword } = c.var.providers;
    const plugin = plugins.find((candidate) => candidate.filterOptionResolvers?.["slack.channels"]);
    const resolver = plugin?.filterOptionResolvers?.["slack.channels"];
    if (!plugin || !resolver) return new Map();
    let credential;
    try {
      credential = await resolveOrgCredentialRead({ credentials: engineCredentials, onePassword }, { orgId, scopes: ["org"] }, plugin.name);
    } catch (err) {
      if (!(err instanceof OnePasswordAuthError)) throw err;
      credential = null;
    }
    if (!credential) return new Map();
    const options = await resolver({ orgId, deps: {}, credential });
    const names = new Map(options.map((option) => [option.id, option.label]));
    namesCache.set(orgId, { names, expiresAt: Date.now() + NAMES_TTL_MS });
    return names;
  };
}

workspaceChannelsRouter.get("/:workspace/channels", async (c) => {
  const owner = await authorizedWorkspaceOwner(c);
  if (!owner) return c.json({ error: "Workspace not found." }, 404);
  return c.json(await listChannels(c.var.providers.db, c.var.user.orgId, owner, slackChannelNames(c)));
});

workspaceChannelsRouter.get("/:workspace/channel", async (c) => {
  const owner = await authorizedWorkspaceOwner(c);
  if (!owner) return c.json({ error: "Workspace not found." }, 404);
  const key = c.req.query("key");
  if (!key) return c.json({ error: "Send the channel key, such as ?key=slack:C123." }, 400);
  const detail = await getChannel(c.var.providers.db, c.var.user.orgId, owner, key, slackChannelNames(c));
  if (!detail) return c.json({ error: "This workspace has no conversation in that channel. Open Channels to see the channels it uses." }, 404);
  return c.json(detail);
});
