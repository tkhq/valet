/**
 * The conversation binding of one owner for one event (spec
 * 2026-10-16-delivery-threads-and-claims-design.md, Terminology and Part B
 * step 1). The dispatcher reads it at delivery, and ingest reads it when it
 * resolves claims (Part C step 4), so both use the same answer.
 */
import type { ChannelOrigin, Principal } from "@valet/engine";
import type { AppDb } from "../lib/drizzle.js";
import { pullRequestComment, threadForPullRequest } from "../services/channel-messages.js";
import { isDeliverableTarget } from "./assistant-delivery.js";
import { findFollowedThread } from "./followed-threads.js";

/** A binding to a known assistant thread. */
export interface ThreadBinding {
  sessionId: string;
  threadId: string;
  via: "follow" | "pull_request";
}

/**
 * A follow bound before follows stored their thread. It keeps the Slack
 * thread key it has always used (spec Deviations, "Follows store their thread").
 */
export interface LegacyFollowBinding {
  via: "legacy_follow";
  key: string;
}

export type ConversationBinding = ThreadBinding | LegacyFollowBinding;

/** The event fields the binding lookup reads. */
export interface BindingEvent {
  key: string;
  payload: unknown;
}

/**
 * The follow binding of `owner` for a channel event's Slack thread. A bound
 * thread that can no longer receive deliveries is no binding: the policy
 * decides, and a follow mention re-binds the Slack thread where it lands.
 */
async function followBinding(
  db: AppDb,
  orgId: string,
  owner: Principal,
  origin: ChannelOrigin,
): Promise<ConversationBinding | null> {
  const [, channelId, threadTs] = origin.threadKey.split(":");
  if (!channelId || !threadTs) return null;
  const bound = await findFollowedThread(db, { orgId, channelType: origin.channelType, channelId, threadTs });
  if (!bound || bound.ownerType !== owner.type || bound.ownerId !== owner.id) return null;
  if (bound.sessionId === null || bound.threadId === null) return { via: "legacy_follow", key: origin.threadKey };
  const target = { sessionId: bound.sessionId, threadId: bound.threadId };
  return await isDeliverableTarget({ db }, orgId, owner, target) ? { ...target, via: "follow" } : null;
}

/**
 * The thread an external conversation already maps to for `owner`, or
 * null. A channel event looks for a follow binding. A human comment or
 * review on a pull request looks for the thread that opened the pull
 * request, for a user or team owner only.
 */
export async function conversationBinding(
  db: AppDb,
  orgId: string,
  owner: Principal,
  event: BindingEvent,
  origin: ChannelOrigin | null,
): Promise<ConversationBinding | null> {
  if (origin) return followBinding(db, orgId, owner, origin);
  if (owner.type === "org") return null;
  const comment = pullRequestComment(event.key, event.payload);
  if (!comment) return null;
  const thread = await threadForPullRequest(db, orgId, owner, comment.pullRequestUrl);
  return thread ? { sessionId: thread.sessionId, threadId: thread.threadId, via: "pull_request" } : null;
}

/** A Slack direct message: a conversational event (spec Terminology). */
function isDirectMessage(payload: unknown): boolean {
  return typeof payload === "object" && payload !== null && "channel_type" in payload && payload.channel_type === "im";
}

/**
 * Whether the dispatcher delivers `event` as an inbound message with a reply
 * route (spec Terminology, "conversational event"). Every other event is
 * ambient. A legacy follow counts as a binding.
 */
export function isConversationalEvent(
  event: BindingEvent,
  origin: ChannelOrigin | null,
  binding: ConversationBinding | null,
): boolean {
  return binding !== null || event.key === "slack.app_mention" || (origin !== null && isDirectMessage(event.payload));
}
