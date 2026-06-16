import { z } from 'zod';
import type { ActionContext, ActionDefinition, ActionResult, ActionSource } from '@valet/sdk';
import { isRevokedError, notConnectedError, reconnectError, slackFetch, slackGet } from './api.js';

// ─── Token + revocation handling ────────────────────────────────────────────

/**
 * Hook the worker invokes (via context) to clear a revoked user credential.
 * Optional — exposed so the worker can pass a callback. When absent we still
 * surface the structured reconnect error; the worker also independently
 * revokes user credentials on 401 paths via its credentials service.
 *
 * The hook is provided by setting `ctx.guardConfig.onRevoked` to an async
 * `() => Promise<void>` from the action invocation site, but in practice the
 * worker's per-user credential resolver also clears tokens on `not_authed`.
 */
async function maybeClearCredential(ctx: ActionContext): Promise<void> {
  const guard = ctx.guardConfig as
    | { onRevoked?: () => Promise<void> | void }
    | undefined;
  if (guard?.onRevoked) {
    try {
      await guard.onRevoked();
    } catch {
      // Non-fatal — the agent still gets the reconnect error.
    }
  }
}

function getUserToken(ctx: ActionContext): string {
  return ctx.credentials.access_token || '';
}

async function readSlackError(
  res: Response,
  ctx: ActionContext,
): Promise<ActionResult> {
  let data: { ok?: boolean; error?: string } | undefined;
  try {
    data = (await res.json()) as { ok?: boolean; error?: string };
  } catch {
    /* fall through */
  }
  if (data && data.error && isRevokedError(data.error)) {
    await maybeClearCredential(ctx);
    return { success: false, error: reconnectError() };
  }
  if (data && data.error) {
    return { success: false, error: `Slack API error: ${data.error}` };
  }
  return { success: false, error: `Slack API ${res.status}: ${res.statusText}` };
}

// ─── Timestamp helpers ──────────────────────────────────────────────────────

export function resolveToSlackTimestamp(input: string): string {
  const trimmed = input.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) return trimmed;
  const date = new Date(trimmed);
  if (isNaN(date.getTime())) {
    throw new Error(`Cannot parse timestamp "${trimmed}" — use ISO-8601 (e.g. "2026-05-19T00:00:00Z") or Unix seconds`);
  }
  return (date.getTime() / 1000).toFixed(6);
}

// ─── Phase 1 read action definitions ────────────────────────────────────────

const searchMessages: ActionDefinition = {
  id: 'slack_user.search_messages',
  name: 'Search Messages (as user)',
  description:
    'Search Slack messages across the full surface visible to YOUR Slack account (public + private channels, DMs, group DMs you are a member of). Uses search.messages with your personal token. Returns slim results plus next_cursor.',
  riskLevel: 'low',
  params: z.object({
    query: z.string().describe('Slack search query. Supports operators like in:#channel, from:@user, before:, after:, has:link.'),
    sort: z.enum(['score', 'timestamp']).optional().describe('Sort order (default score).'),
    sort_dir: z.enum(['asc', 'desc']).optional().describe('Sort direction (default desc).'),
    count: z.number().int().min(1).max(100).optional().describe('Results per page (1-100, default 20).'),
    cursor: z.string().optional().describe('Pagination cursor from a previous response (next_cursor).'),
    highlight: z.boolean().optional().describe('Whether to highlight matched terms (default false).'),
  }),
};

const listChannels: ActionDefinition = {
  id: 'slack_user.list_channels',
  name: 'List Channels (as user)',
  description:
    'List channels visible to YOU on Slack (public, private, DMs, group DMs you are a member of). Uses your personal token, so private channels you are in are included. Optional name prefix filter.',
  riskLevel: 'low',
  params: z.object({
    types: z
      .string()
      .optional()
      .describe(
        'Comma-separated Slack channel types: public_channel,private_channel,im,mpim. Default: public_channel,private_channel,mpim,im.',
      ),
    prefix: z.string().optional().describe('Filter channels whose name starts with this prefix (case-insensitive).'),
    exclude_archived: z.boolean().optional().describe('Default true.'),
    limit: z.number().int().min(1).max(200).optional().describe('Max channels per Slack page (default 200).'),
  }),
};

const readHistory: ActionDefinition = {
  id: 'slack_user.read_history',
  name: 'Read History (as user)',
  description:
    'Read recent messages from any channel/DM/MPIM YOU can see on Slack (using your personal token). Same shape as the bot equivalent but operates on your full visible surface.',
  riskLevel: 'low',
  params: z.object({
    channel: z.string().describe('Channel ID (C…/G…/D…).'),
    limit: z.number().int().min(1).max(200).optional(),
    cursor: z.string().optional(),
    oldest: z.string().optional().describe('ISO-8601 datetime or Unix seconds.'),
    latest: z.string().optional().describe('ISO-8601 datetime or Unix seconds.'),
  }),
};

const readThread: ActionDefinition = {
  id: 'slack_user.read_thread',
  name: 'Read Thread (as user)',
  description: 'Read replies in a thread visible to YOU on Slack.',
  riskLevel: 'low',
  params: z.object({
    channel: z.string().describe('Channel ID (C…/G…/D…).'),
    thread_ts: z.string().describe('Parent message timestamp.'),
    limit: z.number().int().min(1).max(200).optional(),
    cursor: z.string().optional(),
  }),
};

// ─── Phase 2 write action definitions ──────────────────────────────────────
//
// All Phase 2 actions are framed "on behalf of the user" and use riskLevel
// 'high' so the existing action-policy / per-user / per-session approval
// overrides gate them automatically. Switching them to require_approval at
// org level is one policy edit away.

const setStatus: ActionDefinition = {
  id: 'slack_user.set_status',
  name: 'Set Status (as user)',
  description:
    "Set YOUR Slack status text + emoji (acts as the user via users.profile.set). Use this only when the user has explicitly delegated a status change — this writes to the user's profile.",
  riskLevel: 'high',
  params: z.object({
    status_text: z.string().describe('Status text shown next to your name (max 100 chars per Slack).'),
    status_emoji: z.string().optional().describe('Emoji with colons (e.g. ":coffee:"). Default empty.'),
    status_expiration: z
      .number()
      .int()
      .optional()
      .describe('Unix timestamp (seconds) when status should clear; 0 = no expiration.'),
  }),
};

const setDnd: ActionDefinition = {
  id: 'slack_user.set_dnd',
  name: 'Snooze DND (as user)',
  description: "Turn on Do-Not-Disturb on YOUR Slack account for N minutes (dnd.setSnooze).",
  riskLevel: 'high',
  params: z.object({
    num_minutes: z.number().int().min(1).describe('Number of minutes to snooze notifications.'),
  }),
};

const endDnd: ActionDefinition = {
  id: 'slack_user.end_dnd',
  name: 'End DND (as user)',
  description: "Turn off Do-Not-Disturb on YOUR Slack account (dnd.endDnd).",
  riskLevel: 'high',
  params: z.object({}),
};

const sendDm: ActionDefinition = {
  id: 'slack_user.send_dm',
  name: 'Send DM (as user)',
  description:
    "Send a DM to a Slack user from YOUR account (chat.postMessage to a user DM). Use only for explicit user-delegated tasks; the agent's OWN outbound communication should continue to use the bot integration.",
  riskLevel: 'high',
  params: z.object({
    user: z.string().describe('Slack user ID (U…/W…) to DM.'),
    text: z.string().describe('Message text.'),
  }),
};

const postMessage: ActionDefinition = {
  id: 'slack_user.post_message',
  name: 'Post Message (as user)',
  description:
    'Post a message to a Slack channel from YOUR account (chat.postMessage). Only use when the user explicitly delegates "post this as me."',
  riskLevel: 'high',
  params: z.object({
    channel: z.string().describe('Channel ID (C…/G…) or user ID (U…) for a DM.'),
    text: z.string().describe('Message text. Supports Slack mrkdwn formatting.'),
    thread_ts: z.string().optional().describe('Post as a threaded reply.'),
    blocks: z.string().optional().describe('Block Kit JSON array as a string for rich formatting.'),
  }),
};

const addReaction: ActionDefinition = {
  id: 'slack_user.add_reaction',
  name: 'Add Reaction (as user)',
  description: "Add a reaction to a message as YOU on Slack (reactions.add).",
  riskLevel: 'high',
  params: z.object({
    channel: z.string(),
    timestamp: z.string(),
    name: z.string().describe('Emoji name without colons (e.g. "thumbsup").'),
  }),
};

const uploadFile: ActionDefinition = {
  id: 'slack_user.upload_file',
  name: 'Upload File (as user)',
  description:
    'Upload a small file to a Slack channel as YOU (files.upload). Accepts text content inline; for binary uploads provide base64 in `content_base64` and a mimetype.',
  riskLevel: 'high',
  params: z.object({
    channels: z.string().describe('Comma-separated channel IDs to share the upload in.'),
    filename: z.string(),
    title: z.string().optional(),
    initial_comment: z.string().optional(),
    content: z.string().optional().describe('Text content (use either content or content_base64).'),
    content_base64: z.string().optional().describe('Base64-encoded content for non-text uploads.'),
    filetype: z.string().optional().describe('Slack filetype short code (e.g. "txt", "png").'),
  }),
};

const addPin: ActionDefinition = {
  id: 'slack_user.add_pin',
  name: 'Pin Message (as user)',
  description: "Pin a message to a channel as YOU (pins.add).",
  riskLevel: 'high',
  params: z.object({
    channel: z.string(),
    timestamp: z.string(),
  }),
};

const addBookmark: ActionDefinition = {
  id: 'slack_user.add_bookmark',
  name: 'Add Bookmark (as user)',
  description: "Add a link bookmark to a channel as YOU (bookmarks.add).",
  riskLevel: 'high',
  params: z.object({
    channel_id: z.string(),
    title: z.string(),
    link: z.string().url(),
    emoji: z.string().optional(),
  }),
};

const addReminder: ActionDefinition = {
  id: 'slack_user.add_reminder',
  name: 'Add Reminder (as user)',
  description:
    'Create a Slack reminder for YOU (reminders.add). `time` is a Slack-style natural string like "in 20 minutes" or a Unix timestamp.',
  riskLevel: 'high',
  params: z.object({
    text: z.string(),
    time: z.string().describe('Slack natural-language time string ("in 20 minutes") or Unix seconds.'),
  }),
};

const allActions: ActionDefinition[] = [
  // Phase 1
  searchMessages,
  listChannels,
  readHistory,
  readThread,
  // Phase 2
  setStatus,
  setDnd,
  endDnd,
  sendDm,
  postMessage,
  addReaction,
  uploadFile,
  addPin,
  addBookmark,
  addReminder,
];

// ─── Slimming helpers ───────────────────────────────────────────────────────

function slimSearchMatch(m: Record<string, unknown>): Record<string, unknown> {
  const channel = m.channel as Record<string, unknown> | undefined;
  return {
    channel: channel?.id ?? channel?.name ?? undefined,
    channel_name: channel?.name ?? undefined,
    user: m.user,
    ts: m.ts,
    text: m.text,
    permalink: m.permalink,
    thread_ts: m.thread_ts || undefined,
    score: typeof m.score === 'number' ? m.score : undefined,
  };
}

function slimMessage(msg: Record<string, unknown>): Record<string, unknown> {
  const reply_count = typeof msg.reply_count === 'number' ? msg.reply_count : undefined;
  return {
    user: msg.user,
    bot_id: msg.bot_id || undefined,
    subtype: msg.subtype || undefined,
    text: msg.text,
    ts: msg.ts,
    thread_ts: msg.thread_ts || undefined,
    reply_count,
  };
}

function slimChannel(ch: Record<string, unknown>): Record<string, unknown> {
  const topic = (ch.topic || {}) as Record<string, unknown>;
  const purpose = (ch.purpose || {}) as Record<string, unknown>;
  return {
    id: ch.id,
    name: ch.name,
    is_private: ch.is_private,
    is_im: ch.is_im,
    is_mpim: ch.is_mpim,
    is_member: ch.is_member,
    num_members: ch.num_members,
    topic: topic.value || undefined,
    purpose: purpose.value || undefined,
  };
}

// ─── Execution ──────────────────────────────────────────────────────────────

async function executeAction(
  actionId: string,
  params: unknown,
  ctx: ActionContext,
): Promise<ActionResult> {
  const token = getUserToken(ctx);
  if (!token) {
    return { success: false, error: notConnectedError() };
  }

  try {
    switch (actionId) {
      // ── Phase 1 ─────────────────────────────────────────────────────────
      case 'slack_user.search_messages': {
        const p = searchMessages.params.parse(params);
        const query: Record<string, unknown> = {
          query: p.query,
          count: p.count ?? 20,
        };
        if (p.sort) query.sort = p.sort;
        if (p.sort_dir) query.sort_dir = p.sort_dir;
        if (p.cursor) query.cursor = p.cursor;
        if (p.highlight !== undefined) query.highlight = p.highlight ? 1 : 0;

        const res = await slackGet('search.messages', token, query);
        if (!res.ok) return readSlackError(res, ctx);
        const data = (await res.json()) as {
          ok: boolean;
          error?: string;
          messages?: { matches?: unknown[]; total?: number; pagination?: { next_cursor?: string } };
          response_metadata?: { next_cursor?: string };
        };
        if (!data.ok) {
          if (isRevokedError(data.error)) {
            await maybeClearCredential(ctx);
            return { success: false, error: reconnectError() };
          }
          return { success: false, error: `Slack API error: ${data.error || 'unknown'}` };
        }
        const rawMatches = (data.messages?.matches || []) as Record<string, unknown>[];
        const matches = rawMatches.map(slimSearchMatch);
        const next_cursor =
          data.response_metadata?.next_cursor || data.messages?.pagination?.next_cursor || undefined;

        return {
          success: true,
          data: { total: data.messages?.total ?? matches.length, next_cursor, matches },
        };
      }

      case 'slack_user.list_channels': {
        const p = listChannels.params.parse(params);
        const types = p.types || 'public_channel,private_channel,mpim,im';
        const all: Record<string, unknown>[] = [];
        let cursor: string | undefined;
        do {
          const q: Record<string, unknown> = {
            types,
            limit: p.limit ?? 200,
            exclude_archived: p.exclude_archived !== false,
          };
          if (cursor) q.cursor = cursor;
          const res = await slackGet('users.conversations', token, q);
          if (!res.ok) return readSlackError(res, ctx);
          const data = (await res.json()) as {
            ok: boolean;
            error?: string;
            channels?: unknown[];
            response_metadata?: { next_cursor?: string };
          };
          if (!data.ok) {
            if (isRevokedError(data.error)) {
              await maybeClearCredential(ctx);
              return { success: false, error: reconnectError() };
            }
            return { success: false, error: `Slack API error: ${data.error || 'unknown'}` };
          }
          all.push(...((data.channels || []) as Record<string, unknown>[]));
          cursor = data.response_metadata?.next_cursor || undefined;
        } while (cursor);

        let channels = all.map(slimChannel);
        if (p.prefix) {
          const pfx = p.prefix.toLowerCase();
          channels = channels.filter(
            (ch) => typeof ch.name === 'string' && (ch.name as string).toLowerCase().startsWith(pfx),
          );
        }
        return { success: true, data: { total: channels.length, channels } };
      }

      case 'slack_user.read_history': {
        const p = readHistory.params.parse(params);
        const query: Record<string, unknown> = { channel: p.channel, limit: p.limit ?? 100 };
        if (p.cursor) query.cursor = p.cursor;
        try {
          if (p.oldest) query.oldest = resolveToSlackTimestamp(p.oldest);
          if (p.latest) query.latest = resolveToSlackTimestamp(p.latest);
        } catch (err) {
          return { success: false, error: String(err instanceof Error ? err.message : err) };
        }
        if (p.oldest || p.latest) query.inclusive = true;

        const res = await slackGet('conversations.history', token, query);
        if (!res.ok) return readSlackError(res, ctx);
        const data = (await res.json()) as {
          ok: boolean;
          error?: string;
          messages?: unknown[];
          has_more?: boolean;
          response_metadata?: { next_cursor?: string };
        };
        if (!data.ok) {
          if (isRevokedError(data.error)) {
            await maybeClearCredential(ctx);
            return { success: false, error: reconnectError() };
          }
          return { success: false, error: `Slack API error: ${data.error || 'unknown'}` };
        }
        const messages = (data.messages || []).map((m) => slimMessage(m as Record<string, unknown>));
        const next_cursor = data.response_metadata?.next_cursor || undefined;
        return {
          success: true,
          data: { has_more: data.has_more, next_cursor, total: messages.length, messages },
        };
      }

      case 'slack_user.read_thread': {
        const p = readThread.params.parse(params);
        const query: Record<string, unknown> = {
          channel: p.channel,
          ts: p.thread_ts,
          limit: p.limit ?? 100,
        };
        if (p.cursor) query.cursor = p.cursor;

        const res = await slackGet('conversations.replies', token, query);
        if (!res.ok) return readSlackError(res, ctx);
        const data = (await res.json()) as {
          ok: boolean;
          error?: string;
          messages?: unknown[];
          has_more?: boolean;
          response_metadata?: { next_cursor?: string };
        };
        if (!data.ok) {
          if (isRevokedError(data.error)) {
            await maybeClearCredential(ctx);
            return { success: false, error: reconnectError() };
          }
          return { success: false, error: `Slack API error: ${data.error || 'unknown'}` };
        }
        const messages = (data.messages || []).map((m) => slimMessage(m as Record<string, unknown>));
        const next_cursor = data.response_metadata?.next_cursor || undefined;
        return {
          success: true,
          data: { has_more: data.has_more, next_cursor, total: messages.length, messages },
        };
      }

      // ── Phase 2 ─────────────────────────────────────────────────────────
      case 'slack_user.set_status': {
        const p = setStatus.params.parse(params);
        const profile: Record<string, unknown> = {
          status_text: p.status_text,
          status_emoji: p.status_emoji ?? '',
        };
        if (typeof p.status_expiration === 'number') {
          profile.status_expiration = p.status_expiration;
        }
        const res = await slackFetch('users.profile.set', token, { profile });
        if (!res.ok) return readSlackError(res, ctx);
        const data = (await res.json()) as { ok: boolean; error?: string };
        if (!data.ok) {
          if (isRevokedError(data.error)) {
            await maybeClearCredential(ctx);
            return { success: false, error: reconnectError() };
          }
          return { success: false, error: `Slack API error: ${data.error || 'unknown'}` };
        }
        return { success: true, data: { ok: true } };
      }

      case 'slack_user.set_dnd': {
        const p = setDnd.params.parse(params);
        const res = await slackFetch('dnd.setSnooze', token, { num_minutes: p.num_minutes });
        if (!res.ok) return readSlackError(res, ctx);
        const data = (await res.json()) as { ok: boolean; error?: string; snooze_endtime?: number };
        if (!data.ok) {
          if (isRevokedError(data.error)) {
            await maybeClearCredential(ctx);
            return { success: false, error: reconnectError() };
          }
          return { success: false, error: `Slack API error: ${data.error || 'unknown'}` };
        }
        return { success: true, data: { ok: true, snooze_endtime: data.snooze_endtime } };
      }

      case 'slack_user.end_dnd': {
        endDnd.params.parse(params);
        const res = await slackFetch('dnd.endDnd', token);
        if (!res.ok) return readSlackError(res, ctx);
        const data = (await res.json()) as { ok: boolean; error?: string };
        if (!data.ok) {
          if (isRevokedError(data.error)) {
            await maybeClearCredential(ctx);
            return { success: false, error: reconnectError() };
          }
          return { success: false, error: `Slack API error: ${data.error || 'unknown'}` };
        }
        return { success: true, data: { ok: true } };
      }

      case 'slack_user.send_dm': {
        const p = sendDm.params.parse(params);
        const openRes = await slackFetch('conversations.open', token, { users: p.user });
        if (!openRes.ok) return readSlackError(openRes, ctx);
        const openData = (await openRes.json()) as {
          ok: boolean;
          error?: string;
          channel?: { id?: string };
        };
        if (!openData.ok || !openData.channel?.id) {
          if (isRevokedError(openData.error)) {
            await maybeClearCredential(ctx);
            return { success: false, error: reconnectError() };
          }
          return { success: false, error: `Slack API error: ${openData.error || 'open failed'}` };
        }
        const postRes = await slackFetch('chat.postMessage', token, {
          channel: openData.channel.id,
          text: p.text,
        });
        if (!postRes.ok) return readSlackError(postRes, ctx);
        const postData = (await postRes.json()) as {
          ok: boolean;
          error?: string;
          ts?: string;
          channel?: string;
        };
        if (!postData.ok) {
          if (isRevokedError(postData.error)) {
            await maybeClearCredential(ctx);
            return { success: false, error: reconnectError() };
          }
          return { success: false, error: `Slack API error: ${postData.error || 'unknown'}` };
        }
        return { success: true, data: { ok: true, ts: postData.ts, channel: postData.channel } };
      }

      case 'slack_user.post_message': {
        const p = postMessage.params.parse(params);
        const body: Record<string, unknown> = { channel: p.channel, text: p.text };
        if (p.thread_ts) body.thread_ts = p.thread_ts;
        if (p.blocks) {
          try {
            body.blocks = JSON.parse(p.blocks);
          } catch {
            return { success: false, error: 'blocks must be valid JSON' };
          }
        }
        const res = await slackFetch('chat.postMessage', token, body);
        if (!res.ok) return readSlackError(res, ctx);
        const data = (await res.json()) as {
          ok: boolean;
          error?: string;
          ts?: string;
          channel?: string;
        };
        if (!data.ok) {
          if (isRevokedError(data.error)) {
            await maybeClearCredential(ctx);
            return { success: false, error: reconnectError() };
          }
          return { success: false, error: `Slack API error: ${data.error || 'unknown'}` };
        }
        return { success: true, data: { ok: true, ts: data.ts, channel: data.channel } };
      }

      case 'slack_user.add_reaction': {
        const p = addReaction.params.parse(params);
        const res = await slackFetch('reactions.add', token, {
          channel: p.channel,
          timestamp: p.timestamp,
          name: p.name,
        });
        if (!res.ok) return readSlackError(res, ctx);
        const data = (await res.json()) as { ok: boolean; error?: string };
        if (!data.ok) {
          if (isRevokedError(data.error)) {
            await maybeClearCredential(ctx);
            return { success: false, error: reconnectError() };
          }
          return { success: false, error: `Slack API error: ${data.error || 'unknown'}` };
        }
        return { success: true, data: { ok: true } };
      }

      case 'slack_user.upload_file': {
        const p = uploadFile.params.parse(params);
        if (!p.content && !p.content_base64) {
          return { success: false, error: 'Provide either `content` (text) or `content_base64`.' };
        }
        if (p.content && p.content_base64) {
          return { success: false, error: 'Provide only one of `content` or `content_base64`.' };
        }
        const form = new FormData();
        form.append('channels', p.channels);
        form.append('filename', p.filename);
        if (p.title) form.append('title', p.title);
        if (p.initial_comment) form.append('initial_comment', p.initial_comment);
        if (p.filetype) form.append('filetype', p.filetype);
        if (p.content) {
          form.append('content', p.content);
        } else if (p.content_base64) {
          const bin = atob(p.content_base64);
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          form.append('file', new Blob([bytes]), p.filename);
        }
        const res = await fetch('https://slack.com/api/files.upload', {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
          body: form,
        });
        if (!res.ok) return readSlackError(res, ctx);
        const data = (await res.json()) as {
          ok: boolean;
          error?: string;
          file?: { id?: string; permalink?: string };
        };
        if (!data.ok) {
          if (isRevokedError(data.error)) {
            await maybeClearCredential(ctx);
            return { success: false, error: reconnectError() };
          }
          return { success: false, error: `Slack API error: ${data.error || 'unknown'}` };
        }
        return {
          success: true,
          data: { ok: true, file_id: data.file?.id, permalink: data.file?.permalink },
        };
      }

      case 'slack_user.add_pin': {
        const p = addPin.params.parse(params);
        const res = await slackFetch('pins.add', token, { channel: p.channel, timestamp: p.timestamp });
        if (!res.ok) return readSlackError(res, ctx);
        const data = (await res.json()) as { ok: boolean; error?: string };
        if (!data.ok) {
          if (isRevokedError(data.error)) {
            await maybeClearCredential(ctx);
            return { success: false, error: reconnectError() };
          }
          return { success: false, error: `Slack API error: ${data.error || 'unknown'}` };
        }
        return { success: true, data: { ok: true } };
      }

      case 'slack_user.add_bookmark': {
        const p = addBookmark.params.parse(params);
        const body: Record<string, unknown> = {
          channel_id: p.channel_id,
          title: p.title,
          type: 'link',
          link: p.link,
        };
        if (p.emoji) body.emoji = p.emoji;
        const res = await slackFetch('bookmarks.add', token, body);
        if (!res.ok) return readSlackError(res, ctx);
        const data = (await res.json()) as {
          ok: boolean;
          error?: string;
          bookmark?: { id?: string };
        };
        if (!data.ok) {
          if (isRevokedError(data.error)) {
            await maybeClearCredential(ctx);
            return { success: false, error: reconnectError() };
          }
          return { success: false, error: `Slack API error: ${data.error || 'unknown'}` };
        }
        return { success: true, data: { ok: true, bookmark_id: data.bookmark?.id } };
      }

      case 'slack_user.add_reminder': {
        const p = addReminder.params.parse(params);
        const res = await slackFetch('reminders.add', token, {
          text: p.text,
          time: p.time,
        });
        if (!res.ok) return readSlackError(res, ctx);
        const data = (await res.json()) as {
          ok: boolean;
          error?: string;
          reminder?: { id?: string };
        };
        if (!data.ok) {
          if (isRevokedError(data.error)) {
            await maybeClearCredential(ctx);
            return { success: false, error: reconnectError() };
          }
          return { success: false, error: `Slack API error: ${data.error || 'unknown'}` };
        }
        return { success: true, data: { ok: true, reminder_id: data.reminder?.id } };
      }

      default:
        return { success: false, error: `Unknown action: ${actionId}` };
    }
  } catch (error) {
    return { success: false, error: String(error instanceof Error ? error.message : error) };
  }
}

export const slackUserActions: ActionSource = {
  listActions: () => allActions,
  execute: executeAction,
};
