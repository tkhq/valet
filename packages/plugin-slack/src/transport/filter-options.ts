/**
 * Filter-option resolvers for the event-filter picker.
 *
 * The catalog marks the `user` and `channel` filter fields with an option
 * source (`slack.users`, `slack.channels`; see ../triggers.ts). The
 * filter-options endpoint calls these resolvers to turn a source name and a
 * typeahead query into a list the picker shows.
 *
 * Each resolver reuses the transport's bounded-scan directory calls
 * (`listWorkspaceMembers`, `listWorkspaceChannels`) so a large workspace
 * cannot hang the picker. A missing or token-less credential yields an empty
 * list, never a throw — the endpoint turns an empty list into a free-text
 * fallback.
 */
import type { FilterOption, FilterOptionContext, FilterOptionResolver, StoredCredential } from "@valet/engine";
import { SlackApi } from "./api.js";
import { SlackTransport } from "./transport.js";

/**
 * Build a transport bound to `credential` for directory lookups only.
 *
 * The filter-option path needs `listWorkspaceMembers`/`listWorkspaceChannels`,
 * which read from the bot token alone. teamId, signing secret, and bot user id
 * do not scope a directory read, so a placeholder teamId is passed rather than
 * forcing the credential to carry one — unlike the ingress/egress path, which
 * embeds teamId in every conversation key. `apiBaseUrl` lets a test point the
 * client at a fake server.
 */
function directoryTransport(credential: StoredCredential, apiBaseUrl?: string): SlackTransport {
  return new SlackTransport(new SlackApi(credential.accessToken ?? "", apiBaseUrl), "filter-options");
}

/** True when the credential can drive a bot-token directory read. */
function hasToken(credential: StoredCredential | null): credential is StoredCredential {
  return credential !== null && typeof credential.accessToken === "string" && credential.accessToken !== "";
}

/**
 * List workspace members matching `ctx.q`. The label prefers the real name and
 * falls back to the handle; the handle rides along as a hint when it differs,
 * so two people with the same display name stay distinguishable.
 */
async function resolveUsers(ctx: FilterOptionContext, apiBaseUrl?: string): Promise<FilterOption[]> {
  if (!hasToken(ctx.credential)) return [];
  const transport = directoryTransport(ctx.credential, apiBaseUrl);
  try {
    const members = await transport.listWorkspaceMembers(ctx.q ?? "");
    return members.map((member) => {
      const label = member.realName ?? member.name;
      const option: FilterOption = { id: member.id, label };
      if (member.realName !== undefined && member.realName !== member.name) option.hint = `@${member.name}`;
      return option;
    });
  } catch {
    // Contract: a provider error is an empty list, not a throw — the endpoint
    // turns it into a free-text fallback.
    return [];
  }
}

/** List public and private channels matching `ctx.q`, labeled `#name`. */
async function resolveChannels(ctx: FilterOptionContext, apiBaseUrl?: string): Promise<FilterOption[]> {
  if (!hasToken(ctx.credential)) return [];
  const transport = directoryTransport(ctx.credential, apiBaseUrl);
  try {
    const channels = await transport.listWorkspaceChannels(ctx.q ?? "");
    return channels.map((channel) => ({ id: channel.id, label: `#${channel.name}` }));
  } catch {
    return [];
  }
}

/** Source name → resolver, as registered on the Slack plugin manifest. */
export const slackFilterOptionResolvers: Record<string, FilterOptionResolver> = {
  "slack.users": (ctx) => resolveUsers(ctx),
  "slack.channels": (ctx) => resolveChannels(ctx),
};

/**
 * Test seam: the same resolvers, bound to a fake Slack API base URL. The
 * production `slackFilterOptionResolvers` receive no config, so they cannot
 * carry a base URL through the `FilterOptionResolver` signature.
 */
export function slackFilterOptionResolversForApi(apiBaseUrl: string): Record<string, FilterOptionResolver> {
  return {
    "slack.users": (ctx) => resolveUsers(ctx, apiBaseUrl),
    "slack.channels": (ctx) => resolveChannels(ctx, apiBaseUrl),
  };
}
