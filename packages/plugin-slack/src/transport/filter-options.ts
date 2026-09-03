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
 * list — the endpoint turns that into a free-text fallback. A Slack failure
 * propagates instead, so the endpoint can tell the user the lookup broke
 * rather than showing "No matches".
 */
import type { FilterOption, FilterOptionContext, FilterOptionResolver, StoredCredential } from "@valet/engine";
import { credentialSecret } from "@valet/engine";
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
  return new SlackTransport(new SlackApi(credentialSecret(credential) ?? "", apiBaseUrl), "filter-options");
}

/** True when the credential can drive a bot-token directory read. */
function hasToken(credential: StoredCredential | null): credential is StoredCredential {
  return credentialSecret(credential) !== undefined;
}

/**
 * List workspace members matching `ctx.q`. The label prefers the real name and
 * falls back to the handle; the handle rides along as a hint when it differs,
 * so two people with the same display name stay distinguishable.
 */
async function resolveUsers(ctx: FilterOptionContext, apiBaseUrl?: string): Promise<FilterOption[]> {
  if (!hasToken(ctx.credential)) return [];
  const transport = directoryTransport(ctx.credential, apiBaseUrl);
  const members = await transport.listWorkspaceMembers(ctx.q ?? "");
  return members.map((member) => {
    const label = member.realName ?? member.name;
    const option: FilterOption = { id: member.id, label };
    if (member.realName !== undefined && member.realName !== member.name) option.hint = `@${member.name}`;
    return option;
  });
}

/**
 * List the channels the bot has joined matching `ctx.q`, labeled `#name`.
 *
 * A Slack failure propagates. The endpoint turns a throw into a `reason` and a
 * free-text input; swallowing it here returned an empty list that the picker
 * showed as "No matches" — a rate-limited lookup and a channel that truly does
 * not exist looked identical, and the endpoint cached the lie for a minute.
 */
async function resolveChannels(ctx: FilterOptionContext, apiBaseUrl?: string): Promise<FilterOption[]> {
  if (!hasToken(ctx.credential)) return [];
  const transport = directoryTransport(ctx.credential, apiBaseUrl);
  const channels = await transport.listWorkspaceChannels(ctx.q ?? "");
  return channels.map((channel) => ({ id: channel.id, label: `#${channel.name}` }));
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
