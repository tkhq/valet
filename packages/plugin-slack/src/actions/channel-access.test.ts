// packages/plugin-slack/src/actions/channel-access.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const slackGetMock = vi.hoisted(() => vi.fn());
vi.mock('./api.js', () => ({ slackGet: slackGetMock }));

import { checkPrivateChannelAccess } from './channel-access.js';

function mockSlackResponse(data: Record<string, unknown>) {
  return { ok: true, json: () => Promise.resolve({ ok: true, ...data }) };
}

function mockSlackError(error: string) {
  return { ok: true, json: () => Promise.resolve({ ok: false, error }) };
}

describe('checkPrivateChannelAccess', () => {
  beforeEach(() => vi.clearAllMocks());

  it('allows public channels without membership check', async () => {
    slackGetMock.mockResolvedValueOnce(
      mockSlackResponse({ channel: { id: 'C123', is_private: false, is_im: false, is_mpim: false } }),
    );

    const result = await checkPrivateChannelAccess('xoxb-token', 'C123', 'U999');
    expect(result).toEqual({ allowed: true, isPrivate: false });
    expect(slackGetMock).toHaveBeenCalledTimes(1);
    expect(slackGetMock).toHaveBeenCalledWith('conversations.info', 'xoxb-token', { channel: 'C123' });
  });

  it('allows DMs (is_im) without membership check', async () => {
    slackGetMock.mockResolvedValueOnce(
      mockSlackResponse({ channel: { id: 'D123', is_private: false, is_im: true, is_mpim: false } }),
    );

    const result = await checkPrivateChannelAccess('xoxb-token', 'D123', 'U999');
    expect(result).toEqual({ allowed: true, isPrivate: false, direct: 'im' });
    expect(slackGetMock).toHaveBeenCalledTimes(1);
  });

  it('allows group DMs (is_mpim) without membership check', async () => {
    slackGetMock.mockResolvedValueOnce(
      mockSlackResponse({ channel: { id: 'G123', is_private: false, is_im: false, is_mpim: true } }),
    );

    const result = await checkPrivateChannelAccess('xoxb-token', 'G123', 'U999');
    expect(result).toEqual({ allowed: true, isPrivate: false, direct: 'mpim' });
    expect(slackGetMock).toHaveBeenCalledTimes(1);
  });

  it('checks a group DM by membership when the caller treats DMs as private', async () => {
    slackGetMock
      .mockResolvedValueOnce(mockSlackResponse({ channel: { id: 'G123', is_private: true, is_im: false, is_mpim: true } }))
      .mockResolvedValueOnce(mockSlackResponse({ members: ['U111'] }));

    const result = await checkPrivateChannelAccess('xoxb-token', 'G123', 'U999', { directIsPrivate: true });
    expect(result).toMatchObject({ allowed: false, isPrivate: true });
  });

  it('denies private channels when ownerSlackUserId is undefined', async () => {
    slackGetMock.mockResolvedValueOnce(
      mockSlackResponse({ channel: { id: 'C123', is_private: true, is_im: false, is_mpim: false } }),
    );

    const result = await checkPrivateChannelAccess('xoxb-token', 'C123', undefined);
    expect(result).toEqual({
      allowed: false,
      isPrivate: true,
      error: 'Owner has not linked their Slack identity. Link Slack in Settings → Connected accounts.',
    });
    expect(slackGetMock).toHaveBeenCalledTimes(1);
  });

  it.each(['team', 'org'] as const)('allows invited private channels for %s owners without borrowing member identity', async (ownerType) => {
    slackGetMock.mockResolvedValueOnce(mockSlackResponse({ channel: { id: 'C123', is_private: true, is_member: true } }));
    const result = await checkPrivateChannelAccess('xoxb-token', 'C123', undefined, { ownerType });
    expect(result).toEqual({ allowed: true, isPrivate: true });
    expect(slackGetMock).toHaveBeenCalledTimes(1);
  });

  it.each([false])('denies shared private access without verified bot membership (%s)', async (is_member) => {
    slackGetMock.mockResolvedValueOnce(mockSlackResponse({ channel: { id: 'C123', is_private: true, is_member } }));
    const result = await checkPrivateChannelAccess('xoxb-token', 'C123', 'UMEMBER', { ownerType: 'team' });
    expect(result).toMatchObject({ allowed: false, isPrivate: true });
    expect(result.error).toContain('Invite Valet');
  });

  it('verifies missing is_member using the bot joined list, including pagination', async () => {
    slackGetMock.mockResolvedValueOnce(mockSlackResponse({ channel: { id: 'C123', is_private: true } }))
      .mockResolvedValueOnce(mockSlackResponse({ channels: [], response_metadata: { next_cursor: 'page2' } }))
      .mockResolvedValueOnce(mockSlackResponse({ channels: [{ id: 'C123' }] }));
    expect(await checkPrivateChannelAccess('xoxb-token', 'C123', undefined, { ownerType: 'team' })).toMatchObject({ allowed: true, isPrivate: true });
    expect(slackGetMock).toHaveBeenLastCalledWith('users.conversations', 'xoxb-token', { types: 'private_channel', limit: 200, cursor: 'page2' });
  });
  it('fails closed when bot membership cannot be verified', async () => {
    slackGetMock.mockResolvedValueOnce(mockSlackResponse({ channel: { id: 'C123', is_private: true } }))
      .mockResolvedValueOnce(mockSlackError('missing_scope'));
    expect(await checkPrivateChannelAccess('xoxb-token', 'C123', undefined, { ownerType: 'team' })).toMatchObject({ allowed: false, error: expect.stringContaining('groups:read') });
  });

  it.each((['team', 'org'] as const).flatMap((ownerType) =>
    ['im', 'mpim'].map((direct) => ({ ownerType, direct })),
  ))('denies $direct for $ownerType even with linked member metadata', async ({ ownerType, direct }) => {
    slackGetMock.mockResolvedValueOnce(mockSlackResponse({ channel: {
      id: 'D123', is_private: true, is_im: direct === 'im', is_mpim: direct === 'mpim',
    } }));
    const result = await checkPrivateChannelAccess('xoxb-token', 'D123', 'UMEMBER', { ownerType });
    expect(result).toMatchObject({ allowed: false, isPrivate: true });
    expect(slackGetMock).toHaveBeenCalledTimes(1);
  });

  it('allows private channels when owner is a member', async () => {
    slackGetMock
      .mockResolvedValueOnce(
        mockSlackResponse({ channel: { id: 'C123', is_private: true, is_im: false, is_mpim: false } }),
      )
      .mockResolvedValueOnce(
        mockSlackResponse({ members: ['U001', 'U999', 'U002'], response_metadata: {} }),
      );

    const result = await checkPrivateChannelAccess('xoxb-token', 'C123', 'U999');
    expect(result).toEqual({ allowed: true, isPrivate: true });
  });

  it('denies private channels when owner is not a member', async () => {
    slackGetMock
      .mockResolvedValueOnce(
        mockSlackResponse({ channel: { id: 'C123', is_private: true, is_im: false, is_mpim: false } }),
      )
      .mockResolvedValueOnce(
        mockSlackResponse({ members: ['U001', 'U002'], response_metadata: {} }),
      );

    const result = await checkPrivateChannelAccess('xoxb-token', 'C123', 'U999');
    expect(result).toEqual({
      allowed: false,
      isPrivate: true,
      error: 'Access denied: you are not a member of this private channel',
    });
  });

  it('paginates conversations.members to find owner', async () => {
    slackGetMock
      .mockResolvedValueOnce(
        mockSlackResponse({ channel: { id: 'C123', is_private: true, is_im: false, is_mpim: false } }),
      )
      .mockResolvedValueOnce(
        mockSlackResponse({ members: ['U001', 'U002'], response_metadata: { next_cursor: 'cursor1' } }),
      )
      .mockResolvedValueOnce(
        mockSlackResponse({ members: ['U999', 'U003'], response_metadata: {} }),
      );

    const result = await checkPrivateChannelAccess('xoxb-token', 'C123', 'U999');
    expect(result).toEqual({ allowed: true, isPrivate: true });
    expect(slackGetMock).toHaveBeenCalledTimes(3);
  });

  it('returns the channel name for a public channel', async () => {
    slackGetMock.mockResolvedValueOnce(
      mockSlackResponse({
        channel: { id: 'C123', name: 'general', is_private: false, is_im: false, is_mpim: false },
      }),
    );

    const result = await checkPrivateChannelAccess('xoxb-token', 'C123', 'U999');
    expect(result).toEqual({ allowed: true, isPrivate: false, name: 'general' });
  });

  it('returns the channel name for a private channel the owner is in', async () => {
    slackGetMock
      .mockResolvedValueOnce(
        mockSlackResponse({
          channel: { id: 'C123', name: 'secret-plans', is_private: true, is_im: false, is_mpim: false },
        }),
      )
      .mockResolvedValueOnce(mockSlackResponse({ members: ['U999'], response_metadata: {} }));

    const result = await checkPrivateChannelAccess('xoxb-token', 'C123', 'U999');
    expect(result).toEqual({ allowed: true, isPrivate: true, name: 'secret-plans' });
  });

  it('handles conversations.info API error gracefully', async () => {
    slackGetMock.mockResolvedValueOnce(mockSlackError('channel_not_found'));

    const result = await checkPrivateChannelAccess('xoxb-token', 'C123', 'U999');
    expect(result).toEqual({
      allowed: false,
      isPrivate: false,
      error: 'Slack API error checking channel: channel_not_found',
    });
  });

  it('handles conversations.members API error gracefully', async () => {
    slackGetMock
      .mockResolvedValueOnce(
        mockSlackResponse({ channel: { id: 'C123', is_private: true, is_im: false, is_mpim: false } }),
      )
      .mockResolvedValueOnce(mockSlackError('not_in_channel'));

    const result = await checkPrivateChannelAccess('xoxb-token', 'C123', 'U999');
    expect(result).toEqual({
      allowed: false,
      isPrivate: true,
      error: 'Slack API error checking membership: not_in_channel',
    });
  });
});
