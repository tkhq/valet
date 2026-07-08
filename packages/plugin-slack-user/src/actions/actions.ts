import { z } from 'zod';
import type { ActionContext, ActionDefinition, ActionResult, ActionSource } from '@valet/sdk';
import { slimMessage } from '@valet/plugin-slack/actions';
import { isRevokedError, notConnectedError, reconnectError, slackFetch, slackGet } from './api.js';

// ─── Token + revocation handling ────────────────────────────────────────────

function getUserToken(ctx: ActionContext): string {
  return ctx.credentials.access_token || '';
}

/**
 * Parse a Slack error response. On the "credential is permanently invalid"
 * cases (`token_revoked`, `invalid_auth`, `not_authed`, `account_inactive`),
 * set `revokeCredential: true` so the executor clears the stored xoxp token
 * and marks the integration for reconnect — otherwise the row would linger
 * as `connected: true` in the UI forever.
 */
async function readSlackError(
  res: Response,
  _ctx: ActionContext,
): Promise<ActionResult> {
  let data: { ok?: boolean; error?: string } | undefined;
  try {
    data = (await res.json()) as { ok?: boolean; error?: string };
  } catch {
    /* fall through */
  }
  if (data && data.error && isRevokedError(data.error)) {
    return { success: false, error: reconnectError(), revokeCredential: true };
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

// ─── Read action definitions ────────────────────────────────────────────────

const searchMessages: ActionDefinition = {
  id: 'slack_user.search_messages',
  name: 'Search Messages (as user)',
  description:
    'Search Slack messages across the full surface visible to YOUR Slack account (public + private channels, DMs, group DMs you are a member of). Uses search.messages with your personal token. Returns slim results plus next_cursor.',
  // Reads the OWNER's private DMs / private-channel history. In a shared or
  // agent-driven session anything that reaches the agent (prompt injection,
  // another participant, a workflow node) could otherwise exfiltrate DMs
  // silently. `medium` → requires approval; orgs can loosen via policy override.
  riskLevel: 'medium',
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
  // Same exfiltration risk as search_messages — this reads the owner's
  // private DMs / channels. Approval-gated by default; policy override
  // lets trusted setups loosen it.
  riskLevel: 'medium',
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
  // Threads are just as sensitive as history — same treatment.
  riskLevel: 'medium',
  params: z.object({
    channel: z.string().describe('Channel ID (C…/G…/D…).'),
    thread_ts: z.string().describe('Parent message timestamp.'),
    limit: z.number().int().min(1).max(200).optional(),
    cursor: z.string().optional(),
  }),
};

// ─── Write / act-as action definitions ──────────────────────────────────────
//
// All write/act-as actions are framed "on behalf of the user" and use
// riskLevel 'high' so the existing action-policy / per-user / per-session
// approval overrides gate them automatically. Switching them to
// require_approval at org level is one policy edit away.

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
    'Upload a small file to a Slack channel as YOU (external upload flow). Accepts text content inline; for binary uploads provide base64 in `content_base64`.',
  riskLevel: 'high',
  params: z.object({
    channels: z.string().describe('Channel ID to share the upload in. If several are given (comma-separated) the file is shared to the first.'),
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
  // read / search
  searchMessages,
  listChannels,
  readHistory,
  readThread,
  // write / act-as
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

// `slimMessage` is shared with plugin-slack — importing keeps file-attachment
// and reaction extraction consistent across bot + user views. See
// packages/plugin-slack/src/actions/actions.ts for the definition.

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
      // ── read / search ───────────────────────────────────────────────────
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
            return { success: false, error: reconnectError(), revokeCredential: true };
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
              return { success: false, error: reconnectError(), revokeCredential: true };
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
            return { success: false, error: reconnectError(), revokeCredential: true };
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
            return { success: false, error: reconnectError(), revokeCredential: true };
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

      // ── write / act-as ──────────────────────────────────────────────────
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
            return { success: false, error: reconnectError(), revokeCredential: true };
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
            return { success: false, error: reconnectError(), revokeCredential: true };
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
            return { success: false, error: reconnectError(), revokeCredential: true };
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
            return { success: false, error: reconnectError(), revokeCredential: true };
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
            return { success: false, error: reconnectError(), revokeCredential: true };
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
            return { success: false, error: reconnectError(), revokeCredential: true };
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
            return { success: false, error: reconnectError(), revokeCredential: true };
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
        // files.upload was sunset by Slack. Current flow:
        //   1) files.getUploadURLExternal -> { upload_url, file_id }
        //   2) POST the raw bytes to upload_url
        //   3) files.completeUploadExternal -> publishes + shares the file
        // Uint8Array.from yields a fresh ArrayBuffer-backed array (not
        // ArrayBufferLike), so it satisfies BodyInit without a cast.
        const bytes = p.content_base64
          ? Uint8Array.from(atob(p.content_base64), (ch) => ch.charCodeAt(0))
          : Uint8Array.from(new TextEncoder().encode(p.content ?? ''));

        const urlRes = await slackGet('files.getUploadURLExternal', token, {
          filename: p.filename,
          length: bytes.length,
        });
        if (!urlRes.ok) return readSlackError(urlRes, ctx);
        const urlData = (await urlRes.json()) as {
          ok: boolean;
          error?: string;
          upload_url?: string;
          file_id?: string;
        };
        if (!urlData.ok || !urlData.upload_url || !urlData.file_id) {
          if (isRevokedError(urlData.error)) {
            return { success: false, error: reconnectError(), revokeCredential: true };
          }
          return { success: false, error: `Slack API error: ${urlData.error || 'get_upload_url_failed'}` };
        }

        const putRes = await fetch(urlData.upload_url, { method: 'POST', body: bytes });
        if (!putRes.ok) {
          return { success: false, error: `Slack upload failed: HTTP ${putRes.status}` };
        }

        const channelId = p.channels.split(',')[0]?.trim();
        const completeBody: Record<string, unknown> = {
          files: [p.title ? { id: urlData.file_id, title: p.title } : { id: urlData.file_id }],
        };
        if (channelId) completeBody.channel_id = channelId;
        if (p.initial_comment) completeBody.initial_comment = p.initial_comment;

        const doneRes = await slackFetch('files.completeUploadExternal', token, completeBody);
        if (!doneRes.ok) return readSlackError(doneRes, ctx);
        const doneData = (await doneRes.json()) as {
          ok: boolean;
          error?: string;
          files?: Array<{ id?: string; permalink?: string }>;
        };
        if (!doneData.ok) {
          if (isRevokedError(doneData.error)) {
            return { success: false, error: reconnectError(), revokeCredential: true };
          }
          return { success: false, error: `Slack API error: ${doneData.error || 'unknown'}` };
        }
        const uploaded = doneData.files?.[0];
        return {
          success: true,
          data: { ok: true, file_id: uploaded?.id, permalink: uploaded?.permalink },
        };
      }

      case 'slack_user.add_pin': {
        const p = addPin.params.parse(params);
        const res = await slackFetch('pins.add', token, { channel: p.channel, timestamp: p.timestamp });
        if (!res.ok) return readSlackError(res, ctx);
        const data = (await res.json()) as { ok: boolean; error?: string };
        if (!data.ok) {
          if (isRevokedError(data.error)) {
            return { success: false, error: reconnectError(), revokeCredential: true };
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
            return { success: false, error: reconnectError(), revokeCredential: true };
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
            return { success: false, error: reconnectError(), revokeCredential: true };
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
