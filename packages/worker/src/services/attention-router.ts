import type { Principal } from '@valet/shared';
import type { Env } from '../env.js';
import type { AppDb } from '../lib/drizzle.js';
import {
  enqueueNotificationsBatch,
  filterWebEnabledUsers,
  listChannelBindingsByOwner,
  listTeamMembers,
} from '../lib/db.js';
import { channelRegistry } from '../channels/registry.js';
import { getSlackBotToken } from './slack.js';

/**
 * Attention routing: one place answers "who should be told" when something
 * needs a human — a notification, a question, an escalation, an approval.
 * See docs/specs/2026-07-05-teams-design.md §6.
 *
 * v1 scope: audience resolution + delivery (notification queue rows per
 * recipient, preference-gated; a post into the team's bound channel for
 * urgent kinds). Approval *response* eligibility is enforced at response
 * time by the resolve paths (membership re-check for team-owned sessions).
 * Timed tier-2 escalation is a noted follow-up.
 */

export type AttentionKind = 'notification' | 'question' | 'escalation' | 'approval';

export interface AttentionEvent {
  kind: AttentionKind;
  /** Fine-grained event type for preference matching (e.g. 'session.lifecycle'). */
  eventType?: string;
  /** Owning principal of the resource that raised the event. */
  owner: Principal;
  /** The user whose action caused the event, when there is one. */
  actorUserId?: string;
  /** Session the event came from (becomes the notification's fromSessionId). */
  fromSessionId?: string;
  content: string;
  contextSessionId?: string;
  contextTaskId?: string;
}

export interface AudiencePolicy {
  /** Whether the event also posts into the team's bound channel (team owners only). */
  channelPost: boolean;
}

/** Per-kind policy registry — new event kinds add a row, not a routing path. */
export const AUDIENCE_POLICIES: Record<AttentionKind, AudiencePolicy> = {
  notification: { channelPost: false },
  question: { channelPost: true },
  escalation: { channelPost: true },
  approval: { channelPost: true },
};

export interface ResolvedAudience {
  /** Users whose notification queues receive the event (before preference gating). */
  queueUserIds: string[];
  /** Post into the owning team's bound channel (if one exists). */
  postToTeamChannel: boolean;
}

/**
 * Pure audience resolution. User-owned events go to the owner — today's
 * behavior, unchanged. Team-owned events go to every current member's queue,
 * plus the team channel for urgent kinds; membership is resolved by the
 * caller at event time (instant revocation).
 */
export function resolveAudience(
  event: Pick<AttentionEvent, 'kind' | 'owner'>,
  teamMemberIds: string[],
  policies: Record<AttentionKind, AudiencePolicy> = AUDIENCE_POLICIES
): ResolvedAudience {
  const policy = policies[event.kind] ?? { channelPost: false };
  if (event.owner.type === 'user') {
    return { queueUserIds: [event.owner.id], postToTeamChannel: false };
  }
  return { queueUserIds: teamMemberIds, postToTeamChannel: policy.channelPost };
}

/**
 * Route an attention event: enqueue a notification row per recipient (gated
 * by each recipient's web preferences) and, for team-owned urgent kinds,
 * post into the team's bound Slack channel. All delivery is best-effort —
 * a delivery failure never fails the emitter.
 */
export async function routeAttentionEvent(env: Env, appDb: AppDb, event: AttentionEvent): Promise<void> {
  const content = event.content.trim().slice(0, 10_000);
  if (!content) return;

  let teamMemberIds: string[] = [];
  if (event.owner.type === 'team') {
    try {
      teamMemberIds = (await listTeamMembers(appDb, event.owner.id)).map((m) => m.userId);
    } catch (err) {
      console.warn('[AttentionRouter] Failed to resolve team members:', err);
    }
  }

  const audience = resolveAudience(event, teamMemberIds);

  // Fan out in two subrequests total (not O(N)): one preference query for the
  // whole audience, one multi-row insert. Keeps a large team's notification
  // well under the Workers subrequest cap.
  try {
    const enabled = await filterWebEnabledUsers(env.DB, audience.queueUserIds, event.kind, event.eventType);
    await enqueueNotificationsBatch(
      appDb,
      audience.queueUserIds
        .filter((userId) => enabled.has(userId))
        .map((userId) => ({
          fromSessionId: event.fromSessionId,
          toUserId: userId,
          messageType: event.kind,
          content,
          contextSessionId: event.contextSessionId,
          contextTaskId: event.contextTaskId,
        })),
    );
  } catch (err) {
    console.warn('[AttentionRouter] Failed to enqueue team notifications:', err);
  }

  if (audience.postToTeamChannel && event.owner.type === 'team') {
    try {
      await postToTeamChannel(env, appDb, event.owner.id, content, event.actorUserId);
    } catch (err) {
      console.warn('[AttentionRouter] Team channel post failed:', err);
    }
  }
}

async function postToTeamChannel(
  env: Env,
  appDb: AppDb,
  teamId: string,
  content: string,
  actorUserId?: string
): Promise<void> {
  const bindings = await listChannelBindingsByOwner(appDb, { type: 'team', id: teamId });
  const slackBinding = bindings.find((b) => b.channelType === 'slack');
  if (!slackBinding) return;

  const transport = channelRegistry.getTransport('slack');
  const token = await getSlackBotToken(env);
  if (!transport || !token) return;

  await transport.sendMessage(
    { channelType: 'slack', channelId: slackBinding.slackChannelId || slackBinding.channelId },
    { markdown: content },
    { token, userId: actorUserId ?? '' }
  );
}
