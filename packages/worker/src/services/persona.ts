/**
 * Persona resolution — looks up orchestrator identity for channel reply attribution.
 *
 * Returns a generic persona shape that any channel transport can consume
 * via `ChannelContext.persona`.
 */

import type { AppDb } from '../lib/drizzle.js';
import { getUserSlackIdentityLink } from '../lib/db/channels.js';
import { getOrchestratorIdentity, getOrchestratorIdentityByOwner } from '../lib/db/orchestrator.js';

export interface Persona {
  name?: string;
  avatar?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Resolve the orchestrator persona for a given user.
 *
 * Looks up:
 * 1. Slack identity link → provides `slackUserId` for attribution
 * 2. Orchestrator identity → provides display name and avatar
 *
 * Returns a generic Persona shape. Channel transports map this to their
 * wire format (e.g., Slack username/icon_url, Telegram ignores it).
 *
 * Throws if the user has no linked Slack account (required for Slack attribution).
 */
export async function resolveOrchestratorPersona(
  appDb: AppDb,
  userId: string,
): Promise<Persona> {
  const slackLink = await getUserSlackIdentityLink(appDb, userId);
  if (!slackLink) {
    throw new Error(
      `User ${userId} has not linked their Slack account — orchestrator cannot post to Slack without a linked identity`,
    );
  }

  const persona: Persona = {
    metadata: { slackUserId: slackLink.externalId },
  };

  try {
    const identity = await getOrchestratorIdentity(appDb, userId);
    if (identity) {
      if (identity.name) persona.name = identity.name;
      if (identity.avatar) persona.avatar = identity.avatar;
    }
  } catch (err) {
    console.warn('[persona] Failed to resolve orchestrator identity:', err);
  }

  return persona;
}
/**
 * Resolve the persona for a team orchestrator. Unlike the personal resolver,
 * no Slack identity link is required — the team identity's name/avatar drive
 * the outbound username/icon override, and per-message attribution of the
 * acting member is a later refinement.
 */
export async function resolveTeamOrchestratorPersona(appDb: AppDb, teamId: string): Promise<Persona> {
  const identity = await getOrchestratorIdentityByOwner(appDb, { type: 'team', id: teamId });
  if (!identity) {
    throw new Error(`Team ${teamId} has no orchestrator identity`);
  }
  const persona: Persona = {};
  if (identity.name) persona.name = identity.name;
  if (identity.avatar) persona.avatar = identity.avatar;
  return persona;
}
