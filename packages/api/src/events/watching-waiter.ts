/**
 * Incident mention routing (spec 2026-10-15: incident mention routing,
 * Part A). A `slack.app_mention` in a channel that an assistant already
 * watches belongs to the watching thread. This module finds that thread.
 */
import type { EventMatchSpec, Principal, SessionStore } from "@valet/engine";
import { eventKeyMatches, resolvePath } from "./match.js";

export interface WatchingWaiterDeps {
  engineStore: Pick<SessionStore, "findEventWaiters">;
  /** The session's org and owner, or null when the session is gone. */
  sessionOwner(sessionId: string): Promise<{ orgId: string; ownerType: string; ownerId: string } | null>;
  /**
   * True when `target` would resolve for `deliverToAssistantThread`: a live,
   * non-archived assistant or execution session of the owner, with a
   * non-archived thread. A candidate waiter that fails this check would
   * dead-letter the mention, so Part A skips it (reuses
   * `assistant-delivery.ts`'s `isDeliverableTarget`, the same gate the
   * delivery itself enforces).
   */
  isDeliverableTarget(target: { sessionId: string; threadId: string }): Promise<boolean>;
}

/** The channel subject of a Slack channel (`slack:<team>/<channel>`). */
export function slackChannelSubject(team: string, channel: string): string {
  return `slack:${team}/${channel}`;
}

/**
 * The Slack team of a channel event. The ingest-time channel subject names
 * it first, because the waiter subjects come from the same builder. The
 * payload's `team` is the fallback. Undefined when neither names one.
 */
export function slackEventTeam(subjects: readonly string[] | null | undefined, payload: unknown, channel: string): string | undefined {
  for (const subject of subjects ?? []) {
    const match = /^slack:([^/]+)\/([^/]+)$/.exec(subject);
    if (match && match[2] === channel && match[1] !== "?") return match[1];
  }
  const team = resolvePath(payload, "team");
  return typeof team === "string" && team ? team : undefined;
}

/**
 * True when `spec` receives every later message in the channel: one direct
 * clause matches `slack.message` with no actor, status, or previous-status
 * filter. A primary subject, when set, must be the channel subject. Part B
 * depends on this, because the routed mention binds no follow.
 */
export function watchesEveryChannelMessage(spec: EventMatchSpec, channelSubject: string): boolean {
  if (spec.primarySubject !== undefined && spec.primarySubject !== channelSubject) return false;
  return spec.clauses.some((clause) => eventKeyMatches("slack.message", [clause.key])
    && clause.actor === undefined && clause.status === undefined && clause.from_status === undefined);
}

/**
 * The thread of the newest watching waiter on the channel, or null (Part A,
 * steps 2 to 6). A watching waiter is a running stream waiter (`once:
 * false`) whose subjects contain the channel subject itself and that
 * receives every channel message (`watchesEveryChannelMessage`). Its session
 * must be in the event's org and owned by `owner` (INV-M3). Its target must
 * resolve for delivery. Otherwise the delivery throws and the mention
 * dead-letters.
 */
export async function findWatchingWaiter(
  deps: WatchingWaiterDeps,
  orgId: string,
  owner: Principal,
  team: string,
  channel: string,
): Promise<{ sessionId: string; threadId: string } | null> {
  const subject = slackChannelSubject(team, channel);
  const candidates = (await deps.engineStore.findEventWaiters([subject]))
    .filter((w) => w.status === "running" && w.eventMatch?.once === false && (w.subjects ?? []).includes(subject)
      && watchesEveryChannelMessage(w.eventMatch, subject))
    .sort((a, b) => b.createdAt - a.createdAt);
  // Owners are checked newest first, so the first qualifying match is the
  // newest one that would actually deliver.
  for (const waiter of candidates) {
    const session = await deps.sessionOwner(waiter.sessionId);
    if (!session || session.orgId !== orgId || session.ownerType !== owner.type || session.ownerId !== owner.id) continue;
    const target = { sessionId: waiter.sessionId, threadId: waiter.threadId };
    if (await deps.isDeliverableTarget(target)) return target;
  }
  return null;
}
