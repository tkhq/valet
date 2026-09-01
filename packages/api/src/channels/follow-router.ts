/**
 * The follow-router: the third consumer of a Slack webhook update, beside the
 * channel (DM) and event-trigger consumers. A threaded channel message on a
 * thread the assistant follows routes to the bound assistant's per-thread valet
 * thread as an OVERHEARD signal — the assistant reads it and answers only if it
 * chooses to (via reply_to_origin / react_to_origin), or stays silent. A
 * message on an unfollowed thread is ignored and never stored.
 */
import type { AppDb } from "../lib/drizzle.js";
import type { EngineHost } from "../engine/host.js";
import { deliverToAssistantThread } from "../events/assistant-delivery.js";
import { findFollowedThread, touchFollowedThread } from "../events/followed-threads.js";

export interface FollowRouterDeps {
  db: AppDb;
  engineHost: EngineHost;
  /**
   * Resolve the sender's display name and clean the message text, so an
   * overheard line names the person and drops raw ids / Slack markup. Wired from
   * `channelHost` (`channelMessageNormalizer`). Absent → raw text and id.
   */
  normalizeChannelMessage?: (
    service: string,
    msg: { userId?: string; text: string },
  ) => Promise<{ senderName?: string; text: string }>;
  /**
   * The thread's messages strictly between the follow's last delivered ts and
   * the current message's ts, to re-hydrate a gap (api downtime, another bot's
   * posts). Wired from `channelThreadWindowFetcher`. Absent → no re-hydration.
   */
  fetchThreadWindow?: (
    service: string,
    args: { channelId: string; threadTs: string; afterTs: string; beforeTs: string },
  ) => Promise<string | null>;
}

interface SlackMessageFields {
  channel: string;
  threadTs: string;
  ts: string;
  user?: string;
  text: string;
  eventId: string;
}

/**
 * The message fields the follow-router reads from a raw Slack `event_callback`
 * envelope, or `null` when the update is not a routable threaded human message.
 * Drops the bot's own posts (`bot_id`) so a follow cannot self-loop, and the
 * noise subtypes (edits, joins) the channel transport also drops.
 */
export function slackMessageFields(raw: unknown): SlackMessageFields | null {
  if (typeof raw !== "object" || raw === null) return null;
  const env = raw as Record<string, unknown>;
  const eventId = typeof env.event_id === "string" ? env.event_id : undefined;
  const event = env.event;
  if (typeof event !== "object" || event === null) return null;
  const e = event as Record<string, unknown>;
  if (e.type !== "message") return null;
  if (typeof e.bot_id === "string") return null;
  if (typeof e.subtype === "string") return null;
  const channel = typeof e.channel === "string" ? e.channel : undefined;
  const threadTs = typeof e.thread_ts === "string" ? e.thread_ts : undefined; // threaded only
  const ts = typeof e.ts === "string" ? e.ts : undefined;
  if (channel === undefined || threadTs === undefined || ts === undefined || eventId === undefined) return null;
  const user = typeof e.user === "string" ? e.user : undefined;
  const text = typeof e.text === "string" ? e.text : "";
  return { channel, threadTs, ts, user, text, eventId };
}

/**
 * Route a raw Slack update to the bound assistant when its thread is followed.
 * A no-op for a non-message, a bot post, a top-level message, or an unfollowed
 * thread. `dispatchId` makes a redelivery idempotent.
 */
export async function handleFollowedMessage(
  deps: FollowRouterDeps,
  args: { orgId: string; raw: unknown },
): Promise<void> {
  const f = slackMessageFields(args.raw);
  if (!f) return;

  const follow = await findFollowedThread(deps.db, {
    orgId: args.orgId,
    channelType: "slack",
    channelId: f.channel,
    threadTs: f.threadTs,
  });
  if (!follow) return;

  const threadKey = `slack:${f.channel}:${f.threadTs}`;
  const normalized = (await deps.normalizeChannelMessage?.("slack", { userId: f.user, text: f.text })) ?? {
    text: f.text,
  };
  const attributes: Record<string, string> = { channel: f.channel };
  const sender = normalized.senderName ?? f.user;
  if (sender) attributes.sender = sender;
  let body = normalized.text === "" ? "(message)" : normalized.text;
  // Gap re-hydration: messages between the follow's last delivered ts and this
  // one (another bot's posts, or human messages missed during api downtime)
  // never reached the assistant — prepend them so the overheard line lands
  // with its context. A null follow.lastSeenTs (a pre-column row) starts
  // tracking at this delivery instead of guessing a window.
  // Numeric ts compare — a Slack ts is `seconds.micros`, not a fixed-width string.
  if (deps.fetchThreadWindow && follow.lastSeenTs !== null && Number.parseFloat(follow.lastSeenTs) < Number.parseFloat(f.ts)) {
    const missed = await deps.fetchThreadWindow("slack", {
      channelId: f.channel,
      threadTs: f.threadTs,
      afterTs: follow.lastSeenTs,
      beforeTs: f.ts,
    });
    if (missed !== null) {
      body = `Messages in this thread since you last saw it:\n${missed}\n\n---\n\n${body}`;
    }
  }
  await deliverToAssistantThread(deps, {
    orgId: args.orgId,
    owner: { type: follow.ownerType, id: follow.ownerId },
    actorUserId: follow.createdBy,
    threadKey,
    signal: {
      kind: "signal",
      signalType: "slack.message",
      body,
      attributes,
      // Overheard: the assistant observes it and replies only if it acts.
      origin: { channelType: "slack", threadKey, reply: "manual", messageTs: f.ts },
    },
    dispatchId: `slack:follow:${f.eventId}`,
    mismatchReason: "followed_target_mismatch",
  });
  await touchFollowedThread(deps.db, follow.id, f.ts);
}
