/**
 * Host side of the Slack app contract. The Slack plugin owns scopes, bot
 * events, and the manifest shape (`@valet/plugin-slack/app-manifest`). The
 * host owns the URLs that the manifest names, because the host mounts them.
 */
import {
  buildSlackAppManifest as buildPluginManifest,
  type SlackManifestOptions,
} from "@valet/plugin-slack/app-manifest";
import { SLACK_USER_SCOPES } from "@valet/plugin-slack-user/oauth";
import type { SlackAppManifestWire } from "../wire/types.js";

export {
  SLACK_BOT_EVENTS,
  SLACK_OPTIONAL_BOT_SCOPES,
  SLACK_REQUIRED_BOT_SCOPES,
  missingScopes,
  parseGrantedScopes,
} from "@valet/plugin-slack/app-manifest";

/**
 * Compatibility path for Slack Events API and interactivity deliveries.
 * Installed Slack apps call this URL, so it must not change. The host maps
 * it to the plugin's `events` route (`plugins/http-routes.ts`).
 */
export const SLACK_WEBHOOK_MOUNT = "/api/channels/slack";
export const SLACK_WEBHOOK_PATH = "/webhook";

/** Full ingress URL for a deployment, or `null` in Socket Mode. */
export function slackRequestUrl(publicUrl: string | null): string | null {
  if (!publicUrl) return null;
  return `${publicUrl.replace(/\/+$/, "")}${SLACK_WEBHOOK_MOUNT}${SLACK_WEBHOOK_PATH}`;
}

/** Slack (personal) user-OAuth callback for a deployment, or `null` without a public URL. */
export function slackOAuthRedirectUrl(publicUrl: string | null): string | null {
  if (!publicUrl) return null;
  return `${publicUrl.replace(/\/+$/, "")}/api/credentials/oauth/callback`;
}

/** Endpoint configuration that the host gives to the Slack plugin's manifest builder. */
export function slackManifestEndpoints(publicUrl: string | null): Omit<SlackManifestOptions, "appName"> {
  return { requestUrl: slackRequestUrl(publicUrl), oauthRedirectUrl: slackOAuthRedirectUrl(publicUrl), userScopes: SLACK_USER_SCOPES };
}

export function buildSlackAppManifest(opts: { appName?: string; publicUrl: string | null }): SlackAppManifestWire {
  return buildPluginManifest({ appName: opts.appName, ...slackManifestEndpoints(opts.publicUrl) });
}
