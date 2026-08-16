/**
 * Connect-time validation for the org Slack credential.
 *
 * A Slack integration fails silently when it is configured wrong. A bad
 * signing secret shows up only as 401s on an unauthenticated webhook nobody
 * watches. A user token instead of a bot token posts as a human. A workspace
 * that never granted `assistant:write` fails on the first
 * `assistant.threads.*` call, hours after the operator left the settings
 * page. So the connect route pays one round trip to `auth.test` and turns
 * every one of those into an error the operator reads immediately.
 *
 * `auth.test` also returns the identity the rest of the integration needs:
 * `team_id` pins which workspace this deployment answers (the webhook route
 * drops every other workspace), and `user_id` is the bot user the transport
 * echo-suppresses on.
 */
import { SLACK_REQUIRED_BOT_SCOPES, missingScopes, parseGrantedScopes } from "./slack-app.js";

/** Overridable so tests point at a fixture server instead of Slack. */
const DEFAULT_API_BASE = "https://slack.com/api";

/** A hung request must not hold the connect route open. */
const AUTH_TEST_TIMEOUT_MS = 10_000;

export interface SlackWorkspaceIdentity {
  teamId: string;
  teamName?: string;
  botUserId?: string;
  /**
   * Scopes the installed app granted, from Slack's `x-oauth-scopes`
   * response header. `null` when the header was absent — that is "unknown",
   * not "none", and callers must not fail a connection on it.
   */
  grantedScopes: string[] | null;
}

export type SlackConnectCheck = { ok: true; identity: SlackWorkspaceIdentity } | { ok: false; error: string };

function slackApiBase(env: NodeJS.ProcessEnv): string {
  return env.VALET_SLACK_API_BASE ?? DEFAULT_API_BASE;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringField(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * Calls `auth.test` with the pasted token and turns the answer into either
 * the workspace identity or one error message that names the fix.
 */
export async function verifySlackBotToken(token: string, env: NodeJS.ProcessEnv = process.env): Promise<SlackConnectCheck> {
  let response: Response;
  try {
    response = await fetch(`${slackApiBase(env)}/auth.test`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(AUTH_TEST_TIMEOUT_MS),
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Could not reach Slack to check the token: ${detail}. Check network access, then try again.` };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return { ok: false, error: "Slack returned a response that is not JSON. Check that the token is a Slack bot token, then try again." };
  }
  if (!isRecord(payload)) {
    return { ok: false, error: "Slack returned an unexpected response. Check that the token is a Slack bot token, then try again." };
  }
  if (payload.ok !== true) {
    const code = stringField(payload, "error") ?? "auth_test_failed";
    return {
      ok: false,
      error: `Slack rejected the token (${code}). Copy the bot token again from OAuth & Permissions in your Slack app settings.`,
    };
  }

  // A bot token must be used. `auth.test` succeeds for a user token too, but
  // then the app posts as that person, and `assistant:write` is a bot-only
  // scope so the agent surface never works. Slack returns `bot_id` for a bot
  // token and omits it for a user token.
  if (stringField(payload, "bot_id") === undefined) {
    return {
      ok: false,
      error: "That is a user token. Paste the Bot User OAuth Token (it starts with xoxb-) from OAuth & Permissions.",
    };
  }

  const teamId = stringField(payload, "team_id");
  if (teamId === undefined) {
    // The webhook route answers exactly one workspace and drops every other
    // one, so a credential with no workspace id could never receive an
    // event. This is what an Enterprise Grid org-wide install looks like.
    return {
      ok: false,
      error: "Slack did not report a workspace for this token. Install the app on a single workspace, not an Enterprise Grid organization.",
    };
  }

  return {
    ok: true,
    identity: {
      teamId,
      teamName: stringField(payload, "team"),
      botUserId: stringField(payload, "user_id"),
      grantedScopes: parseGrantedScopes(response.headers.get("x-oauth-scopes")),
    },
  };
}

/**
 * Rejects an install that cannot run the agent. Returns `null` when the
 * scopes are sufficient, or unknown because Slack sent no scope header.
 */
export function requiredScopeError(grantedScopes: string[] | null): string | null {
  if (grantedScopes === null) return null;
  const missing = missingScopes(grantedScopes, SLACK_REQUIRED_BOT_SCOPES);
  if (missing.length === 0) return null;
  return (
    `The Slack app has not granted ${missing.join(", ")}. ` +
    "Enable the agent feature in your Slack app settings. " +
    "Add the missing scopes under OAuth & Permissions. " +
    "Reinstall the app to the workspace. " +
    "Then paste the new bot token."
  );
}
