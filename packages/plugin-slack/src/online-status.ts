/**
 * Online status: whether a Slack user is active or away right now, read
 * with the bot token. The `slack.get_user_status` tool and the api's
 * online-status watcher (packages/api/src/services/online-status-watch.ts)
 * share this read, so both report the same answer and the same errors.
 *
 * "Online status" is the Slack `users.getPresence` value. Valet's own
 * "Presence" names the places Valet watches (packages/api/src/routes/presence.ts),
 * so this module avoids that word for the feature.
 *
 * Privacy: only a member of the connected workspace is reported. A user
 * from another workspace (a Slack Connect guest the bot can see) is refused,
 * and nothing here stores what it reads.
 *
 * Slack's Events API does not deliver `presence_change`; that needs RTM or
 * Socket Mode presence subscriptions. The "comes online" trigger therefore
 * polls this read, and `onlineEvent` builds the event a detected away to
 * active change feeds into the normal event pipeline.
 */
import type { EventCatalogEntry, NormalizedEvent, TriggerDef } from "@valet/engine";
import { slackGet } from "./actions/api.js";

/** The event key of the "comes online" trigger. */
export const USER_ONLINE_EVENT_KEY = "slack.user_online";

export interface SlackOnlineStatus {
  user: string;
  name?: string;
  real_name?: string;
  /** Slack's `users.getPresence` value. */
  presence: "active" | "away";
  online: boolean;
  status_text?: string;
  status_emoji?: string;
  /** ISO time the custom status expires. Absent when it does not expire. */
  status_expires_at?: string;
  timezone?: string;
  /** The user's wall clock, such as "Tue 14:05". Only when asked for. */
  local_time?: string;
}

export type OnlineStatusResult =
  | { ok: true; status: SlackOnlineStatus }
  | { ok: false; code: string; error: string; retryAfterSeconds?: number };

function rec(v: unknown): Record<string, unknown> | undefined {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/** The error text for a Slack error code. Each one names the fix. */
export function onlineStatusError(code: string, user: string): string {
  switch (code) {
    case "missing_scope":
      return "Reading online status needs the users:read bot scope. Ask a Slack admin to reinstall the Slack app from Settings → Organization → Slack to grant it.";
    case "user_not_found":
      return `No Slack user ${user} in this workspace. Use slack.list_users to find the user ID (U...).`;
    case "user_not_visible":
    case "other_workspace":
      return `Slack user ${user} is not a member of the connected workspace. Online status is shown only for members of this workspace.`;
    case "deleted_user":
      return `Slack user ${user} is deactivated, so they have no online status.`;
    case "not_authed":
    case "invalid_auth":
    case "account_inactive":
    case "token_revoked":
      return "The Slack bot token is not valid. Reconnect Slack in Settings → Organization → Slack.";
    case "missing_token":
      return "Slack is not connected. Connect Slack in Settings → Organization → Slack.";
    case "ratelimited":
    case "rate_limited":
      return "Slack is rate limiting online status reads. Try again in a minute.";
    default:
      return `Slack could not read the online status (${code}). Check the Slack connection, then try again.`;
  }
}

function localTime(timezone: string, now: Date): string | undefined {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(now);
  } catch {
    return undefined;
  }
}

/** True when the user belongs to the connected workspace (`teamId`). */
function inWorkspace(user: Record<string, unknown>, teamId: string | undefined): boolean {
  if (user.is_stranger === true) return false;
  if (teamId === undefined) return true;
  if (str(user.team_id) === teamId) return true;
  // Enterprise Grid: a user's home team can differ from the installed one.
  const teams = rec(user.enterprise_user)?.teams;
  return Array.isArray(teams) && teams.includes(teamId);
}

async function slackJson(
  method: string,
  token: string,
  params: Record<string, unknown>,
  baseUrl: string | undefined,
  signal: AbortSignal | undefined,
): Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; code: string; retryAfterSeconds?: number }> {
  const res = await slackGet(method, token, params, baseUrl, signal);
  if (res.status === 429) {
    const retry = Number(res.headers.get("Retry-After"));
    await res.body?.cancel();
    return { ok: false, code: "ratelimited", ...(Number.isFinite(retry) && retry > 0 ? { retryAfterSeconds: retry } : {}) };
  }
  let data: Record<string, unknown> | undefined;
  try { data = rec(await res.json()); } catch { data = undefined; }
  if (!data) return { ok: false, code: `http_${res.status}` };
  if (data.ok !== true) return { ok: false, code: str(data.error) ?? "unknown_error" };
  return { ok: true, data };
}

/**
 * Reads one user's online status: `users.info` for the profile and the
 * workspace check, then `users.getPresence`. Both need `users:read`.
 * `teamId` is the connected workspace; a user outside it is refused.
 */
export async function readOnlineStatus(
  token: string,
  user: string,
  opts: { teamId?: string; includeLocalTime?: boolean; profile?: boolean; now?: Date; baseUrl?: string; signal?: AbortSignal } = {},
): Promise<OnlineStatusResult> {
  if (!token) return { ok: false, code: "missing_token", error: onlineStatusError("missing_token", user) };
  const fail = (code: string, retryAfterSeconds?: number): OnlineStatusResult => ({
    ok: false, code, error: onlineStatusError(code, user), ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
  });

  const status: Partial<SlackOnlineStatus> = { user };
  if (opts.profile !== false) {
    const info = await slackJson("users.info", token, { user }, opts.baseUrl, opts.signal);
    if (!info.ok) return fail(info.code, info.retryAfterSeconds);
    const u = rec(info.data.user) ?? {};
    if (!inWorkspace(u, opts.teamId)) return fail("other_workspace");
    if (u.deleted === true) return fail("deleted_user");
    const profile = rec(u.profile) ?? {};
    status.name = str(u.name);
    status.real_name = str(profile.real_name) ?? str(u.real_name);
    status.status_text = str(profile.status_text);
    status.status_emoji = str(profile.status_emoji);
    const expiration = typeof profile.status_expiration === "number" ? profile.status_expiration : 0;
    if (expiration > 0) status.status_expires_at = new Date(expiration * 1000).toISOString();
    status.timezone = str(u.tz);
    if (opts.includeLocalTime && status.timezone) status.local_time = localTime(status.timezone, opts.now ?? new Date());
  }

  const presence = await slackJson("users.getPresence", token, { user }, opts.baseUrl, opts.signal);
  if (!presence.ok) return fail(presence.code, presence.retryAfterSeconds);
  const value = presence.data.presence === "active" ? "active" : "away";
  const result: SlackOnlineStatus = { ...status, user, presence: value, online: value === "active" };
  for (const key of Object.keys(result) as (keyof SlackOnlineStatus)[]) {
    if (result[key] === undefined) delete result[key];
  }
  return { ok: true, status: result };
}

const onlineCatalog: EventCatalogEntry[] = [
  {
    key: USER_ONLINE_EVENT_KEY,
    description: "When a chosen person comes back online in Slack after being away. Valet checks about once a minute, so it can fire up to a minute or two late",
    filters: [
      {
        field: "user",
        path: "user",
        description: "Slack user id of the person to watch. Required: Valet checks only the people a line names",
        options: { source: "slack.users" },
      },
    ],
  },
];

/**
 * The "comes online" trigger. Slack sends no webhook for it, so `verify`
 * accepts nothing; the api's watcher builds the event with `onlineEvent`
 * and ingests it directly. The def exists for the catalog: the builder,
 * `list_event_types` and the write validator read the key and its fields
 * from here. It is not part of `slackTriggerEventTypes`, so the app
 * manifest subscribes to no extra bot event.
 */
export const slackOnlineTriggerDef: TriggerDef = {
  id: "slack.online_status",
  service: "slack",
  description: "A Slack user comes back online (polled with users.getPresence)",
  verify: () => null,
  toEvent: (event) => onlineEvent({
    user: String(rec(event.payload)?.user ?? ""),
    ...(event.context?.teamId ? { teamId: event.context.teamId } : {}),
    awayMs: Number(rec(event.payload)?.away_minutes ?? 0) * 60_000,
    observedAt: Date.now(),
    dedupeKey: event.deliveryId,
  }),
  catalog: onlineCatalog,
};

/** The normalized event for one detected away to active change. */
export function onlineEvent(args: { user: string; teamId?: string; awayMs: number; observedAt: number; dedupeKey: string; status?: SlackOnlineStatus }): NormalizedEvent {
  const awayMinutes = Math.max(0, Math.round(args.awayMs / 60_000));
  const payload: Record<string, unknown> = {
    type: "user_online",
    user: args.user,
    presence: "active",
    away_minutes: awayMinutes,
    ...(args.teamId ? { team: args.teamId } : {}),
    ...(args.status?.status_text ? { status_text: args.status.status_text } : {}),
    ...(args.status?.status_emoji ? { status_emoji: args.status.status_emoji } : {}),
  };
  return {
    key: USER_ONLINE_EVENT_KEY,
    dedupeKey: args.dedupeKey,
    occurredAt: new Date(args.observedAt).toISOString(),
    actor: { externalId: args.user, bot: false },
    refs: { user: args.user, ...(args.teamId ? { team: args.teamId } : {}) },
    summary: `${args.user} came online after ${awayMinutes} min away`,
    payload,
  };
}
