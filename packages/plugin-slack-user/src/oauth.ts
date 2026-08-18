import { OAuthInterpretError, type TokenInterpretation } from "@valet/engine";

/**
 * Full user-scope bundle for the `slack-user` integration.
 *
 * A single scope set covering both read/search and write/act-as on behalf of
 * the user:
 *   - read / search:  read history across the user's full visible surface
 *                     (public + private channels, DMs, group DMs), plus
 *                     search.messages, user/team metadata.
 *   - write / act-as: post on behalf of the user, set status / DND,
 *                     reactions, files, pins, bookmarks, stars, reminders,
 *                     usergroups, emoji.
 *
 * EXCLUDED on purpose:
 *   - bot-only scopes (e.g. chat:write.customize)
 *   - search:read.enterprise
 *   - admin.* scopes
 *
 * Requested in a single consent at connect time so the full surface is
 * available without a re-consent round trip. The Slack app workspace install
 * MUST be refreshed for these to take effect — see the org bot plugin's app
 * manifest (packages/plugin-slack).
 */
export const SLACK_USER_SCOPES: readonly string[] = [
  // ── read / search ──
  "search:read",
  "channels:history",
  "groups:history",
  "im:history",
  "mpim:history",
  "channels:read",
  "groups:read",
  "im:read",
  "mpim:read",
  "users:read",
  "users.profile:read",
  "team:read",

  // ── write / act-as ──
  "chat:write",
  // conversations.open (send_dm) needs write scope to open the IM/MPIM channel
  // before chat.postMessage can deliver to it.
  "im:write",
  "mpim:write",
  "users.profile:write",
  "reactions:write",
  "reactions:read",
  "dnd:write",
  "dnd:read",
  "files:read",
  "files:write",
  "pins:read",
  "pins:write",
  "bookmarks:read",
  "bookmarks:write",
  "stars:read",
  "stars:write",
  "reminders:read",
  "reminders:write",
  "usergroups:read",
  "usergroups:write",
  "emoji:read",
] as const;

/**
 * Interpret Slack's `oauth.v2.access` response for the user (xoxp) flow.
 * Slack nests the user token under `authed_user.access_token` (not the
 * top-level `access_token`, which is the bot xoxb token). Throws
 * OAuthInterpretError with a corrective action when the response is not a
 * usable user grant.
 */
export function interpretSlackUserTokenResponse(raw: unknown): TokenInterpretation {
  const r = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  if (r.ok !== true) {
    const err = typeof r.error === "string" ? r.error : "unknown_error";
    throw new OAuthInterpretError(
      `Slack rejected the authorization (${err}). Try connecting again from /integrations.`,
    );
  }
  const authed = (typeof r.authed_user === "object" && r.authed_user !== null ? r.authed_user : {}) as Record<
    string,
    unknown
  >;
  const token = authed.access_token;
  const userId = authed.user_id ?? authed.id;
  if (typeof token !== "string" || token === "" || typeof userId !== "string" || userId === "") {
    throw new OAuthInterpretError(
      "Slack returned no user token. Enable user scopes on the Slack app, then connect again.",
    );
  }
  const granted = typeof authed.scope === "string" ? authed.scope.split(",").filter((s) => s !== "") : [];
  const grantedSet = new Set(granted);
  const missing = SLACK_USER_SCOPES.filter((s) => !grantedSet.has(s));
  if (missing.length > 0) {
    throw new OAuthInterpretError(
      `Slack granted fewer scopes than Valet requested (missing: ${missing.join(", ")}). ` +
        "Reinstall the Slack app for this workspace, then connect again.",
    );
  }
  const team = (typeof r.team === "object" && r.team !== null ? r.team : {}) as Record<string, unknown>;
  const teamId = typeof team.id === "string" ? team.id : "";
  return {
    accessToken: token,
    grantedScopes: granted,
    metadata: {
      slack_user_id: userId,
      team_id: teamId,
      team_name: typeof team.name === "string" ? team.name : "",
    },
    identity: { provider: "slack", externalId: userId, ...(teamId ? { teamId } : {}) },
  };
}
