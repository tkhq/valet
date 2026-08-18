/**
 * The Slack app contract in one place: the bot scopes Valet needs, the bot
 * events it subscribes to, the ingress path those events arrive on, and the
 * app manifest built from all three.
 *
 * Three call sites must agree or the integration breaks with no visible
 * error. `routes/slack-app.ts` hands the manifest to an org admin, who
 * creates the Slack app from it. `routes/credentials.ts` checks at save
 * time that the installed app really granted the scopes. The webhook route
 * `routes/slack-webhook.ts` only ever receives the events declared here. A
 * scope that is in the manifest but not in the save-time check surfaces
 * weeks later as an opaque `missing_scope` from one API method.
 *
 * This targets Slack's agent messaging experience, not the legacy assistant
 * one. Two differences drive the whole shape:
 *
 * - The manifest feature is `agent_view`. The older `assistant_view` is
 *   deprecated, and the nested `assistant_description` is renamed
 *   `agent_description`.
 * - The "a user opened the agent" signal is `app_home_opened` with
 *   `tab === "messages"`. The legacy `assistant_thread_started` is not
 *   subscribed and must not be relied on.
 *
 * Reference: https://docs.slack.dev/ai/developing-agents/ and
 * https://docs.slack.dev/reference/app-manifest/
 */
import type { SlackAppManifestWire } from "../wire/types.js";
import { SLACK_USER_SCOPES } from "@valet/plugin-slack-user/oauth";

/**
 * Mount prefix for the dedicated Slack ingress, and the router path below
 * it. The manifest builder composes the same two constants into
 * `request_url`, so the URL an operator installs can never drift from the
 * URL `app.ts` actually serves.
 */
export const SLACK_WEBHOOK_MOUNT = "/api/channels/slack";
export const SLACK_WEBHOOK_PATH = "/webhook";

/**
 * Scopes without which the agent cannot work at all. `PUT
 * /api/credentials/slack?scope=org` refuses a token that is missing any of
 * them.
 */
export const SLACK_REQUIRED_BOT_SCOPES: readonly string[] = [
  // Slack adds this scope when the agent feature is enabled in app
  // settings. Its absence therefore means the installed app is not an agent
  // app, and every `assistant.threads.*` call fails.
  "assistant:write",
  // `chat.postMessage` and the three `chat.*Stream` methods.
  "chat:write",
  // Delivery of `message.im`, which is the user's turn. Without it the
  // agent never receives a prompt.
  "im:history",
];

/**
 * Scopes the manifest requests but the save-time check only warns about. A
 * workspace that withholds them loses one feature each; the agent still
 * holds a conversation.
 */
export const SLACK_OPTIONAL_BOT_SCOPES: readonly string[] = [
  // Sender display names, and the workspace-member list the account-link
  // flow searches.
  "users:read",
  // `conversations.open`, which turns a Slack user id into the DM channel to
  // answer on. Valet needs it to start a conversation the person did not
  // start: the attention router DMs a user about a session they are not
  // looking at. Without it that call fails with `missing_scope` and the
  // notification is lost, while replies to an existing DM keep working.
  "im:write",
  // Inbound file attachments (`files.info`, then the download).
  "files:read",
  // Outbound file attachments.
  "files:write",

  // ── slack.* action surface (plugin-slack/src/actions) ──────────────
  // `slack.read_history` / `slack.read_thread` (`conversations.history`,
  // `conversations.replies`) per channel type: public, private, group DM.
  // DMs ride the required `im:history`.
  "channels:history",
  "groups:history",
  "mpim:history",
  // `slack.list_channels` / `slack.get_channel_info` (`conversations.list`,
  // `conversations.info`) and the private-channel membership check
  // (`conversations.members`, channel-access.ts) per channel type.
  "channels:read",
  "groups:read",
  "im:read",
  "mpim:read",
  // `slack.add_reaction` (`reactions.add`).
  "reactions:write",
  // `slack.get_reactions` (`reactions.get`).
  "reactions:read",
  // `slack.get_pins` (`pins.list`).
  "pins:read",
  // Bot-sender enrichment (`bots.info`) rides `users:read` above. There is
  // no granular `bots:read` scope — Slack rejects a manifest that asks for
  // one.

  // ── V1 parity, held for surfaces that are ported next ───────────────
  // The scopes below have no v2 consumer yet. They ride along so an
  // installed app does not need a reinstall when each surface lands —
  // Slack grants only what the installed manifest declared.
  // `app_mention` channel triggers (V1 mention routing).
  "app_mentions:read",
  // Persona posting: `chat.postMessage` username/icon overrides.
  "chat:write.customize",
  // Posting into public channels the bot has not joined.
  "chat:write.public",
  // Email-based workspace-member lookup in the account-link search.
  "users:read.email",
  // Usergroup read/manage tools.
  "usergroups:read",
  "usergroups:write",
];

/**
 * Bot events the agent surface needs. Order is not significant.
 *
 * Workflow triggers over channel activity (reactions, membership, files)
 * are a different surface: add those event names here when it lands. The
 * scopes they read with are already declared in
 * `SLACK_OPTIONAL_BOT_SCOPES`, so landing the surface does not force a
 * reinstall of every workspace app.
 */
export const SLACK_BOT_EVENTS: readonly string[] = [
  // Replaces `assistant_thread_started`. The handler gates on
  // `tab === "messages"`.
  "app_home_opened",
  // Subscribing is what makes Slack inject `context` into the other two
  // events. An app that never reads the context still needs the
  // subscription for that side effect.
  "app_context_changed",
  // The user's turn.
  "message.im",
];

/** Slack's own limits. A manifest that exceeds one of them is rejected whole. */
const MAX_APP_NAME_CHARS = 35;
const MAX_DESCRIPTION_CHARS = 140;
const MAX_AGENT_DESCRIPTION_CHARS = 300;

const DEFAULT_APP_NAME = "Valet";
const APP_DESCRIPTION = "Your Valet assistant, in Slack.";
const AGENT_DESCRIPTION =
  "Valet runs coding and research work for you. Send it a message here and it answers in this thread, " +
  "with the same session you see in the Valet web app.";

/**
 * Static fallback prompts, shown before the app can call
 * `assistant.threads.setSuggestedPrompts`. The runtime call overrides them.
 */
const SUGGESTED_PROMPTS: { title: string; message: string }[] = [
  { title: "Start a task", message: "What can you do for me?" },
  { title: "Check my work", message: "What are my sessions doing right now?" },
];

export interface SlackManifestOptions {
  /**
   * Display name for the app and its bot user. Clamped to Slack's 35
   * characters — a truncated name is recoverable in app settings, a
   * rejected manifest gives the operator nothing to work with.
   */
  appName?: string;
  /**
   * Public `https` base URL of this deployment, with no trailing slash.
   * `null` selects Socket Mode: a local deployment has no URL Slack can
   * reach, so events arrive over a socket the transport opens instead.
   */
  publicUrl: string | null;
}

/** Full ingress URL for a deployment, or `null` in Socket Mode. */
export function slackRequestUrl(publicUrl: string | null): string | null {
  if (!publicUrl) return null;
  return `${publicUrl.replace(/\/+$/, "")}${SLACK_WEBHOOK_MOUNT}${SLACK_WEBHOOK_PATH}`;
}

/** Deduplicates while keeping first-seen order, so the manifest is stable. */
function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

/**
 * Builds the app manifest an operator pastes into Slack's app-creation
 * form. Slack's `apps.manifest.create` method needs an app-configuration
 * token that this deployment does not hold, so the flow is paste-in rather
 * than API-driven.
 */
export function buildSlackAppManifest(opts: SlackManifestOptions): SlackAppManifestWire {
  const name = (opts.appName ?? DEFAULT_APP_NAME).slice(0, MAX_APP_NAME_CHARS) || DEFAULT_APP_NAME;
  const requestUrl = slackRequestUrl(opts.publicUrl);
  const botEvents = unique(SLACK_BOT_EVENTS);
  const botScopes = unique([...SLACK_REQUIRED_BOT_SCOPES, ...SLACK_OPTIONAL_BOT_SCOPES]);
  // The Slack (personal) user-OAuth flow (`/api/credentials/slack-user/connect`)
  // runs against this same Slack app: `SLACK_CLIENT_ID` is one app. Slack
  // grants a user token only the scopes this manifest declares, so the user
  // bundle must ride along or every personal connect fails with a
  // scope-shortfall error telling the user to reinstall.
  const userScopes = unique([...SLACK_USER_SCOPES]);

  return {
    display_information: {
      name,
      description: APP_DESCRIPTION.slice(0, MAX_DESCRIPTION_CHARS),
    },
    features: {
      agent_view: {
        agent_description: AGENT_DESCRIPTION.slice(0, MAX_AGENT_DESCRIPTION_CHARS),
        // Copied, so a caller that edits the returned manifest cannot change
        // what the next call builds.
        suggested_prompts: SUGGESTED_PROMPTS.map((prompt) => ({ ...prompt })),
      },
      app_home: {
        // The agent lives in the Messages tab. A Home tab would be a second,
        // empty surface.
        home_tab_enabled: false,
        messages_tab_enabled: true,
        // Slack's own scaffolding defaults this to true. Left true, the
        // composer is disabled, the user cannot type, and nothing anywhere
        // reports why.
        messages_tab_read_only_enabled: false,
      },
      bot_user: {
        display_name: name,
        always_online: true,
      },
    },
    oauth_config: {
      // The user-OAuth callback must be a registered redirect URL or Slack
      // rejects the authorize request. No public URL → nothing to register;
      // the operator adds their reachable callback by hand (e.g.
      // http://localhost:8788/api/credentials/oauth/callback in dev).
      ...(opts.publicUrl
        ? { redirect_urls: [`${opts.publicUrl.replace(/\/+$/, "")}/api/credentials/oauth/callback`] }
        : {}),
      scopes: { bot: botScopes, user: userScopes },
    },
    settings: {
      event_subscriptions: {
        ...(requestUrl ? { request_url: requestUrl } : {}),
        bot_events: botEvents,
      },
      // Approval gates are Block Kit buttons, so interactivity must be on.
      // In Socket Mode the button payloads arrive over the socket and no
      // request URL is needed.
      interactivity: {
        is_enabled: true,
        ...(requestUrl ? { request_url: requestUrl } : {}),
      },
      // Valet resolves one workspace per deployment (see the webhook
      // route's team gate). An org-wide Enterprise Grid install delivers
      // events for many workspaces and is not supported.
      org_deploy_enabled: false,
      socket_mode_enabled: requestUrl === null,
      token_rotation_enabled: false,
    },
  };
}

/**
 * Reads the granted scopes Slack returns on every Web API response.
 *
 * Returns `null` when the header is absent. That is "unknown", not "nothing
 * granted" — a caller must not fail a connection on a missing header, or a
 * proxy that strips it would break every save.
 */
export function parseGrantedScopes(header: string | null | undefined): string[] | null {
  if (typeof header !== "string" || header.trim() === "") return null;
  return header
    .split(",")
    .map((scope) => scope.trim())
    .filter((scope) => scope !== "");
}

/** Required scopes the token does not carry, in the order they are declared. */
export function missingScopes(granted: readonly string[], required: readonly string[]): string[] {
  const held = new Set(granted);
  return required.filter((scope) => !held.has(scope));
}
