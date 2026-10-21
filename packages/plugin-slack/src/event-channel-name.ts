/**
 * The channel name on a Slack message event, for the `channel_name`
 * subscription filter.
 *
 * Slack message events (`message`, `app_mention`, and the bot-message form)
 * name their channel by ID only. The host calls `withEventChannelName` after a
 * trigger verifies an event and before `toEvent`, so the filter path
 * `channel_name` and `refs.channel_name` both see the name. A name that the
 * payload already carries stays. Otherwise the name comes from the channel
 * name cache (`actions/channel-names.ts`), which reads `conversations.info`
 * on a miss.
 *
 * A lookup that fails leaves the payload without a name. A `channel_name`
 * filter then fails closed: the line does not match, and its Activity shows
 * the failed condition.
 *
 * `channel_rename` and `channel_created` carry the new name, so this records
 * it. A renamed channel then stops matching its old name at once on this api
 * process. Slack sends `channel_rename` for public channels only. A private
 * channel rename, or a rename that another api process received, shows when
 * the cache entry expires (`CHANNEL_NAME_MAX_AGE_MS`).
 */
import type { VerifiedEvent } from "@valet/engine";
import { rememberChannelName, resolveChannelName } from "./actions/channel-names.js";

/** Verified event types whose catalog entries declare `channel_name` at the payload root. */
const MESSAGE_EVENT_TYPES: ReadonlySet<string> = new Set(["message", "app_mention", "bot_message"]);

/** Verified event types that carry a channel's current name at `channel.name`. */
const NAMING_EVENT_TYPES: ReadonlySet<string> = new Set(["channel_rename", "channel_created"]);

/** How long intake waits for `conversations.info` before it continues without a name. */
export const EVENT_CHANNEL_NAME_TIMEOUT_MS = 3_000;

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function rec(v: unknown): Record<string, unknown> | undefined {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

/**
 * The verified event with `channel_name` set on a message payload, or the
 * event unchanged when it needs no name or none is known. Never throws.
 * `token` is the org's Slack bot token. Without one, no lookup runs.
 */
export async function withEventChannelName(event: VerifiedEvent, token: string | undefined): Promise<VerifiedEvent> {
  const payload = rec(event.payload);
  if (!payload || !token) return event;
  if (NAMING_EVENT_TYPES.has(event.eventType)) {
    const channel = rec(payload.channel);
    const id = str(channel?.id);
    const name = str(channel?.name);
    if (id && name) rememberChannelName(token, id, name);
    return event;
  }
  if (!MESSAGE_EVENT_TYPES.has(event.eventType) || str(payload.channel_name)) return event;
  const channelId = str(payload.channel);
  // Slack gives a direct message no name.
  if (!channelId || payload.channel_type === "im") return event;
  const name = await resolveChannelName(token, channelId, { timeoutMs: EVENT_CHANNEL_NAME_TIMEOUT_MS });
  return name ? { ...event, payload: { ...payload, channel_name: name } } : event;
}
