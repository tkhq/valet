import { slackGet } from './api.js';

export interface ChannelAccessResult {
  allowed: boolean;
  isPrivate: boolean;
  /** Set for a direct message (`im`) or a group direct message (`mpim`). */
  direct?: "im" | "mpim";
  /** The channel name from `conversations.info`. Absent for a direct message,
   *  which Slack gives no name, and when the check fails. */
  name?: string;
  error?: string;
}

/**
 * Check if a user has access to a Slack channel.
 * Public channels are allowed. Shared owners cannot access DMs or group DMs.
 * Private channels require the user to be a member (via conversations.members).
 *
 * Team and organization runs use the connected bot’s channel membership.
 */
export async function checkPrivateChannelAccess(
  token: string,
  channelId: string,
  ownerSlackUserId: string | undefined,
  /** Treat a direct or group direct message like a private channel: only its
   * members pass. Shared owners always treat DMs as private, regardless of
   * this option. Personal callers can require a membership check too. */
  opts: { directIsPrivate?: boolean; ownerType?: "user" | "team" | "org" } = {},
): Promise<ChannelAccessResult> {
  // 1. Get channel info
  const infoRes = await slackGet('conversations.info', token, { channel: channelId });
  const infoData = (await infoRes.json()) as {
    ok: boolean;
    error?: string;
    channel?: { name?: string; is_private?: boolean; is_im?: boolean; is_mpim?: boolean; is_member?: boolean };
  };

  if (!infoData.ok) {
    return { allowed: false, isPrivate: false, error: `Slack API error checking channel: ${infoData.error}` };
  }

  const channel = infoData.channel;
  if (!channel) {
    return { allowed: false, isPrivate: false, error: 'Slack API error checking channel: no channel data' };
  }

  const name = typeof channel.name === 'string' ? channel.name : undefined;

  // 2. Shared owners cannot use the bot token to read personal conversations.
  const sharedOwner = opts.ownerType === "team" || opts.ownerType === "org";
  const direct = channel.is_im ? "im" : channel.is_mpim ? "mpim" : undefined;
  if (direct && !opts.directIsPrivate && !sharedOwner) {
    return { allowed: true, isPrivate: false, name, direct };
  }

  // 3. Public channels are always allowed
  if (!direct && !channel.is_private) {
    return { allowed: true, isPrivate: false, name };
  }

  // Shared channel access belongs to the bot, not a member's personal token.
  // DMs remain personal even if the bot belongs to them.
  if (sharedOwner) {
    if (direct) return { allowed: false, isPrivate: true,
      error: 'Shared runs cannot read direct messages. Use a personal run owned by a linked conversation member.' };
    let member = channel.is_member === true;
    if (channel.is_member === undefined) {
      // Some conversation objects omit is_member. This endpoint lists only
      // conversations belonging to the token's bot; never supply a user id.
      let cursor: string | undefined;
      do {
        const response = await slackGet('users.conversations', token, { types: 'private_channel', limit: 200, ...(cursor ? { cursor } : {}) });
        const body: unknown = await response.json();
        if (!response.ok || typeof body !== 'object' || body === null || !('ok' in body) || body.ok !== true) {
          const reason = typeof body === 'object' && body !== null && 'error' in body && typeof body.error === 'string'
            ? body.error : String(response.status);
          return { allowed: false, isPrivate: true, error: `Slack API error checking bot membership: ${reason}. ${reason === 'missing_scope'
            ? 'Ask a workspace administrator to reinstall the Slack app with groups:read.'
            : 'Check the Slack integration, then retry.'}` };
        }
        member = 'channels' in body && Array.isArray(body.channels) && body.channels.some((item: unknown) =>
          typeof item === 'object' && item !== null && 'id' in item && item.id === channelId);
        cursor = 'response_metadata' in body && typeof body.response_metadata === 'object' && body.response_metadata !== null &&
          'next_cursor' in body.response_metadata && typeof body.response_metadata.next_cursor === 'string'
          ? body.response_metadata.next_cursor : undefined;
      } while (!member && cursor);
    }
    return member ? { allowed: true, isPrivate: true, name } : { allowed: false, isPrivate: true,
      error: 'Valet is not a verified member of this private channel. Invite Valet to the channel, then retry.' };
  }

  // Private channel — need owner's Slack identity
  if (!ownerSlackUserId) {
    return {
      allowed: false,
      isPrivate: true,
      error: 'Owner has not linked their Slack identity. Link Slack in Settings → Connected accounts.',
    };
  }

  // 5. Check membership via paginated conversations.members
  let cursor: string | undefined;
  do {
    const params: Record<string, unknown> = { channel: channelId, limit: 200 };
    if (cursor) params.cursor = cursor;

    const membersRes = await slackGet('conversations.members', token, params);
    const membersData = (await membersRes.json()) as {
      ok: boolean;
      error?: string;
      members?: string[];
      response_metadata?: { next_cursor?: string };
    };

    if (!membersData.ok) {
      return { allowed: false, isPrivate: true, error: `Slack API error checking membership: ${membersData.error}` };
    }

    if (membersData.members?.includes(ownerSlackUserId)) {
      return { allowed: true, isPrivate: true, name };
    }

    cursor = membersData.response_metadata?.next_cursor || undefined;
  } while (cursor);

  return {
    allowed: false,
    isPrivate: true,
    error: 'Access denied: you are not a member of this private channel',
  };
}
