import { Type } from "typebox";
import type { Static, TSchema } from "typebox";
import type {
  ActionPlugin,
  PluginAction,
  PluginActionContext,
  PluginActionResult,
} from "@valet/engine";
import { slimMessage } from "@valet/plugin-slack/actions";
import { isRevokedError, notConnectedError, reconnectError, slackFetch, slackGet } from "./api.js";

/**
 * Curried action builder. The first call binds T from the parameters
 * schema; the second call types `execute`'s args via Static<T>. Splitting
 * the inference into two phases sidesteps TS's contextual-inference depth
 * limit, which otherwise gives up once the file gets long.
 */
function action<TParams extends TSchema>(parameters: TParams) {
  return (rest: {
    id: string;
    name: string;
    description: string;
    riskLevel: PluginAction["riskLevel"];
    execute: (args: Static<TParams>, ctx: PluginActionContext) => Promise<PluginActionResult>;
  }): PluginAction<TParams> => ({ ...rest, parameters });
}

// ─── Token + revocation handling ────────────────────────────────────────────

/** Resolve the user's xoxp token from the connected credential. */
async function getUserToken(ctx: PluginActionContext): Promise<string> {
  const cred = await ctx.credentials.get();
  return cred?.accessToken ?? "";
}

/**
 * Parse a Slack error `Response`. On the "credential is permanently invalid"
 * cases (`token_revoked`, `invalid_auth`, `not_authed`, `account_inactive`),
 * return the reconnect error so the agent tells the user to reconnect.
 */
async function readSlackError(res: Response): Promise<PluginActionResult> {
  let data: { ok?: boolean; error?: string } | undefined;
  try {
    data = (await res.json()) as { ok?: boolean; error?: string };
  } catch {
    /* fall through */
  }
  if (data && data.error && isRevokedError(data.error)) {
    return { success: false, error: reconnectError() };
  }
  if (data && data.error) {
    return { success: false, error: `Slack API error: ${data.error}` };
  }
  return { success: false, error: `Slack API ${res.status}: ${res.statusText}` };
}

/** Map a Slack JSON `error` string to the right failure result. */
function slackDataError(err: string | undefined): PluginActionResult {
  if (isRevokedError(err)) return { success: false, error: reconnectError() };
  return { success: false, error: `Slack API error: ${err || "unknown"}` };
}

// ─── Timestamp helpers ──────────────────────────────────────────────────────

export function resolveToSlackTimestamp(input: string): string {
  const trimmed = input.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) return trimmed;
  const date = new Date(trimmed);
  if (isNaN(date.getTime())) {
    throw new Error(
      `Cannot parse timestamp "${trimmed}" — use ISO-8601 (e.g. "2026-05-19T00:00:00Z") or Unix seconds`,
    );
  }
  return (date.getTime() / 1000).toFixed(6);
}

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
    score: typeof m.score === "number" ? m.score : undefined,
  };
}

// `slimMessage` is shared with plugin-slack — importing keeps file-attachment
// and reaction extraction consistent across bot + user views.

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

// ─── Read / search actions ──────────────────────────────────────────────────

const searchMessages = action(
  Type.Object({
    query: Type.String({
      description:
        "Slack search query. Supports operators like in:#channel, from:@user, before:, after:, has:link.",
    }),
    sort: Type.Optional(
      Type.Union([Type.Literal("score"), Type.Literal("timestamp")], {
        description: "Sort order (default score).",
      }),
    ),
    sort_dir: Type.Optional(
      Type.Union([Type.Literal("asc"), Type.Literal("desc")], {
        description: "Sort direction (default desc).",
      }),
    ),
    count: Type.Optional(
      Type.Integer({ minimum: 1, maximum: 100, description: "Results per page (1-100, default 20)." }),
    ),
    cursor: Type.Optional(
      Type.String({ description: "Pagination cursor from a previous response (next_cursor)." }),
    ),
    highlight: Type.Optional(
      Type.Boolean({ description: "Whether to highlight matched terms (default false)." }),
    ),
  }),
)({
  id: "slack_user.search_messages",
  name: "Search Messages (as user)",
  description:
    "Search Slack messages across the full surface visible to YOUR Slack account (public + private channels, DMs, group DMs you are a member of). Uses search.messages with your personal token. Returns slim results plus next_cursor.",
  // Reads the OWNER's private DMs / private-channel history. In a shared or
  // agent-driven session anything that reaches the agent (prompt injection,
  // another participant, a workflow node) could otherwise exfiltrate DMs
  // silently. `medium` → requires approval; orgs can loosen via policy override.
  riskLevel: "medium",
  execute: async (p, ctx) => {
    const token = await getUserToken(ctx);
    if (!token) return { success: false, error: notConnectedError() };
    const query: Record<string, unknown> = { query: p.query, count: p.count ?? 20 };
    if (p.sort) query.sort = p.sort;
    if (p.sort_dir) query.sort_dir = p.sort_dir;
    if (p.cursor) query.cursor = p.cursor;
    if (p.highlight !== undefined) query.highlight = p.highlight ? 1 : 0;

    const res = await slackGet("search.messages", token, query);
    if (!res.ok) return readSlackError(res);
    const data = (await res.json()) as {
      ok: boolean;
      error?: string;
      messages?: { matches?: unknown[]; total?: number; pagination?: { next_cursor?: string } };
      response_metadata?: { next_cursor?: string };
    };
    if (!data.ok) return slackDataError(data.error);
    const rawMatches = (data.messages?.matches || []) as Record<string, unknown>[];
    const matches = rawMatches.map(slimSearchMatch);
    const next_cursor =
      data.response_metadata?.next_cursor || data.messages?.pagination?.next_cursor || undefined;

    return {
      success: true,
      data: { total: data.messages?.total ?? matches.length, next_cursor, matches },
    };
  },
});

const listChannels = action(
  Type.Object({
    types: Type.Optional(
      Type.String({
        description:
          "Comma-separated Slack channel types: public_channel,private_channel,im,mpim. Default: public_channel,private_channel,mpim,im.",
      }),
    ),
    prefix: Type.Optional(
      Type.String({
        description:
          "Filter channels whose name starts with this prefix (case-insensitive). Filter is applied after fetching, so results may be incomplete on large workspaces — check `truncated` and pass `next_cursor` back to keep scanning.",
      }),
    ),
    exclude_archived: Type.Optional(Type.Boolean({ description: "Default true." })),
    limit: Type.Optional(
      Type.Integer({ minimum: 1, maximum: 200, description: "Max channels per Slack page (default 200)." }),
    ),
    cursor: Type.Optional(
      Type.String({ description: "Pagination cursor from a prior call to fetch the next page." }),
    ),
  }),
)({
  id: "slack_user.list_channels",
  name: "List Channels (as user)",
  description:
    "List channels visible to YOU on Slack (public, private, DMs, group DMs you are a member of). Uses your personal token, so private channels you are in are included. Optional name prefix filter.",
  riskLevel: "low",
  execute: async (p, ctx) => {
    const token = await getUserToken(ctx);
    if (!token) return { success: false, error: notConnectedError() };
    const types = p.types || "public_channel,private_channel,mpim,im";
    // Cap server-side pagination to keep tool latency + subrequest budget
    // bounded on large workspaces (thousands of DMs). Callers pass the
    // returned `next_cursor` back to fetch the next batch.
    const MAX_PAGES = 5;
    const all: Record<string, unknown>[] = [];
    let cursor: string | undefined = p.cursor;
    let pages = 0;
    do {
      const q: Record<string, unknown> = {
        types,
        limit: p.limit ?? 200,
        exclude_archived: p.exclude_archived !== false,
      };
      if (cursor) q.cursor = cursor;
      const res = await slackGet("users.conversations", token, q);
      if (!res.ok) return readSlackError(res);
      const data = (await res.json()) as {
        ok: boolean;
        error?: string;
        channels?: unknown[];
        response_metadata?: { next_cursor?: string };
      };
      if (!data.ok) return slackDataError(data.error);
      all.push(...((data.channels || []) as Record<string, unknown>[]));
      cursor = data.response_metadata?.next_cursor || undefined;
      pages += 1;
    } while (cursor && pages < MAX_PAGES);

    let channels = all.map(slimChannel);
    if (p.prefix) {
      const pfx = p.prefix.toLowerCase();
      channels = channels.filter(
        (ch) => typeof ch.name === "string" && (ch.name as string).toLowerCase().startsWith(pfx),
      );
    }
    // `truncated` = we hit the per-call page cap and Slack still has more.
    // Callers must pass `next_cursor` back to see the rest; a prefix filter
    // returning empty with `truncated: true` is NOT authoritative.
    const truncated = !!cursor && pages >= MAX_PAGES;
    return {
      success: true,
      data: { total: channels.length, channels, next_cursor: cursor, truncated },
    };
  },
});

const readHistory = action(
  Type.Object({
    channel: Type.String({ description: "Channel ID (C…/G…/D…)." }),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
    cursor: Type.Optional(Type.String()),
    oldest: Type.Optional(Type.String({ description: "ISO-8601 datetime or Unix seconds." })),
    latest: Type.Optional(Type.String({ description: "ISO-8601 datetime or Unix seconds." })),
  }),
)({
  id: "slack_user.read_history",
  name: "Read History (as user)",
  description:
    "Read recent messages from any channel/DM/MPIM YOU can see on Slack (using your personal token). Same shape as the bot equivalent but operates on your full visible surface.",
  // Same exfiltration risk as search_messages — this reads the owner's
  // private DMs / channels. Approval-gated by default; policy override
  // lets trusted setups loosen it.
  riskLevel: "medium",
  execute: async (p, ctx) => {
    const token = await getUserToken(ctx);
    if (!token) return { success: false, error: notConnectedError() };
    const query: Record<string, unknown> = { channel: p.channel, limit: p.limit ?? 100 };
    if (p.cursor) query.cursor = p.cursor;
    try {
      if (p.oldest) query.oldest = resolveToSlackTimestamp(p.oldest);
      if (p.latest) query.latest = resolveToSlackTimestamp(p.latest);
    } catch (err) {
      return { success: false, error: String(err instanceof Error ? err.message : err) };
    }
    if (p.oldest || p.latest) query.inclusive = true;

    const res = await slackGet("conversations.history", token, query);
    if (!res.ok) return readSlackError(res);
    const data = (await res.json()) as {
      ok: boolean;
      error?: string;
      messages?: unknown[];
      has_more?: boolean;
      response_metadata?: { next_cursor?: string };
    };
    if (!data.ok) return slackDataError(data.error);
    const messages = (data.messages || []).map((m) => slimMessage(m as Record<string, unknown>));
    const next_cursor = data.response_metadata?.next_cursor || undefined;
    return {
      success: true,
      data: { has_more: data.has_more, next_cursor, total: messages.length, messages },
    };
  },
});

const readThread = action(
  Type.Object({
    channel: Type.String({ description: "Channel ID (C…/G…/D…)." }),
    thread_ts: Type.String({ description: "Parent message timestamp." }),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
    cursor: Type.Optional(Type.String()),
  }),
)({
  id: "slack_user.read_thread",
  name: "Read Thread (as user)",
  description: "Read replies in a thread visible to YOU on Slack.",
  // Threads are just as sensitive as history — same treatment.
  riskLevel: "medium",
  execute: async (p, ctx) => {
    const token = await getUserToken(ctx);
    if (!token) return { success: false, error: notConnectedError() };
    const query: Record<string, unknown> = { channel: p.channel, ts: p.thread_ts, limit: p.limit ?? 100 };
    if (p.cursor) query.cursor = p.cursor;

    const res = await slackGet("conversations.replies", token, query);
    if (!res.ok) return readSlackError(res);
    const data = (await res.json()) as {
      ok: boolean;
      error?: string;
      messages?: unknown[];
      has_more?: boolean;
      response_metadata?: { next_cursor?: string };
    };
    if (!data.ok) return slackDataError(data.error);
    const messages = (data.messages || []).map((m) => slimMessage(m as Record<string, unknown>));
    const next_cursor = data.response_metadata?.next_cursor || undefined;
    return {
      success: true,
      data: { has_more: data.has_more, next_cursor, total: messages.length, messages },
    };
  },
});

// ─── Write / act-as actions ──────────────────────────────────────────────────
//
// All write/act-as actions are framed "on behalf of the user" and use
// riskLevel 'high' so the existing action-policy / per-user / per-session
// approval overrides gate them automatically.

const setStatus = action(
  Type.Object({
    status_text: Type.String({
      description: "Status text shown next to your name (max 100 chars per Slack).",
    }),
    status_emoji: Type.Optional(
      Type.String({ description: 'Emoji with colons (e.g. ":coffee:"). Default empty.' }),
    ),
    status_expiration: Type.Optional(
      Type.Integer({
        description: "Unix timestamp (seconds) when status should clear; 0 = no expiration.",
      }),
    ),
  }),
)({
  id: "slack_user.set_status",
  name: "Set Status (as user)",
  description:
    "Set YOUR Slack status text + emoji (acts as the user via users.profile.set). Use this only when the user has explicitly delegated a status change — this writes to the user's profile.",
  riskLevel: "high",
  execute: async (p, ctx) => {
    const token = await getUserToken(ctx);
    if (!token) return { success: false, error: notConnectedError() };
    const profile: Record<string, unknown> = {
      status_text: p.status_text,
      status_emoji: p.status_emoji ?? "",
    };
    if (typeof p.status_expiration === "number") profile.status_expiration = p.status_expiration;
    const res = await slackFetch("users.profile.set", token, { profile });
    if (!res.ok) return readSlackError(res);
    const data = (await res.json()) as { ok: boolean; error?: string };
    if (!data.ok) return slackDataError(data.error);
    return { success: true, data: { ok: true } };
  },
});

const setDnd = action(
  Type.Object({
    num_minutes: Type.Integer({ minimum: 1, description: "Number of minutes to snooze notifications." }),
  }),
)({
  id: "slack_user.set_dnd",
  name: "Snooze DND (as user)",
  description: "Turn on Do-Not-Disturb on YOUR Slack account for N minutes (dnd.setSnooze).",
  riskLevel: "high",
  execute: async (p, ctx) => {
    const token = await getUserToken(ctx);
    if (!token) return { success: false, error: notConnectedError() };
    const res = await slackFetch("dnd.setSnooze", token, { num_minutes: p.num_minutes });
    if (!res.ok) return readSlackError(res);
    const data = (await res.json()) as { ok: boolean; error?: string; snooze_endtime?: number };
    if (!data.ok) return slackDataError(data.error);
    return { success: true, data: { ok: true, snooze_endtime: data.snooze_endtime } };
  },
});

const endDnd = action(Type.Object({}))({
  id: "slack_user.end_dnd",
  name: "End DND (as user)",
  description: "Turn off Do-Not-Disturb on YOUR Slack account (dnd.endDnd).",
  riskLevel: "high",
  execute: async (_p, ctx) => {
    const token = await getUserToken(ctx);
    if (!token) return { success: false, error: notConnectedError() };
    const res = await slackFetch("dnd.endDnd", token);
    if (!res.ok) return readSlackError(res);
    const data = (await res.json()) as { ok: boolean; error?: string };
    if (!data.ok) return slackDataError(data.error);
    return { success: true, data: { ok: true } };
  },
});

const sendDm = action(
  Type.Object({
    user: Type.String({ description: "Slack user ID (U…/W…) to DM." }),
    text: Type.String({ description: "Message text." }),
  }),
)({
  id: "slack_user.send_dm",
  name: "Send DM (as user)",
  description:
    "Send a DM to a Slack user from YOUR account (chat.postMessage to a user DM). Use only for explicit user-delegated tasks; the agent's OWN outbound communication should continue to use the bot integration.",
  riskLevel: "high",
  execute: async (p, ctx) => {
    const token = await getUserToken(ctx);
    if (!token) return { success: false, error: notConnectedError() };
    const openRes = await slackFetch("conversations.open", token, { users: p.user });
    if (!openRes.ok) return readSlackError(openRes);
    const openData = (await openRes.json()) as { ok: boolean; error?: string; channel?: { id?: string } };
    if (!openData.ok || !openData.channel?.id) {
      if (isRevokedError(openData.error)) return { success: false, error: reconnectError() };
      return { success: false, error: `Slack API error: ${openData.error || "open failed"}` };
    }
    const postRes = await slackFetch("chat.postMessage", token, {
      channel: openData.channel.id,
      text: p.text,
    });
    if (!postRes.ok) return readSlackError(postRes);
    const postData = (await postRes.json()) as {
      ok: boolean;
      error?: string;
      ts?: string;
      channel?: string;
    };
    if (!postData.ok) return slackDataError(postData.error);
    return { success: true, data: { ok: true, ts: postData.ts, channel: postData.channel } };
  },
});

const postMessage = action(
  Type.Object({
    channel: Type.String({ description: "Channel ID (C…/G…) or user ID (U…) for a DM." }),
    text: Type.String({ description: "Message text. Supports Slack mrkdwn formatting." }),
    thread_ts: Type.Optional(Type.String({ description: "Post as a threaded reply." })),
    blocks: Type.Optional(
      Type.String({ description: "Block Kit JSON array as a string for rich formatting." }),
    ),
  }),
)({
  id: "slack_user.post_message",
  name: "Post Message (as user)",
  description:
    'Post a message to a Slack channel from YOUR account (chat.postMessage). Only use when the user explicitly delegates "post this as me."',
  riskLevel: "high",
  execute: async (p, ctx) => {
    const token = await getUserToken(ctx);
    if (!token) return { success: false, error: notConnectedError() };
    const body: Record<string, unknown> = { channel: p.channel, text: p.text };
    if (p.thread_ts) body.thread_ts = p.thread_ts;
    if (p.blocks) {
      try {
        body.blocks = JSON.parse(p.blocks);
      } catch {
        return { success: false, error: "blocks must be valid JSON" };
      }
    }
    const res = await slackFetch("chat.postMessage", token, body);
    if (!res.ok) return readSlackError(res);
    const data = (await res.json()) as { ok: boolean; error?: string; ts?: string; channel?: string };
    if (!data.ok) return slackDataError(data.error);
    return { success: true, data: { ok: true, ts: data.ts, channel: data.channel } };
  },
});

const addReaction = action(
  Type.Object({
    channel: Type.String(),
    timestamp: Type.String(),
    name: Type.String({ description: 'Emoji name without colons (e.g. "thumbsup").' }),
  }),
)({
  id: "slack_user.add_reaction",
  name: "Add Reaction (as user)",
  description: "Add a reaction to a message as YOU on Slack (reactions.add).",
  riskLevel: "high",
  execute: async (p, ctx) => {
    const token = await getUserToken(ctx);
    if (!token) return { success: false, error: notConnectedError() };
    const res = await slackFetch("reactions.add", token, {
      channel: p.channel,
      timestamp: p.timestamp,
      name: p.name,
    });
    if (!res.ok) return readSlackError(res);
    const data = (await res.json()) as { ok: boolean; error?: string };
    if (!data.ok) return slackDataError(data.error);
    return { success: true, data: { ok: true } };
  },
});

const uploadFile = action(
  Type.Object({
    channels: Type.String({
      description:
        "Channel ID to share the upload in. If several are given (comma-separated) the file is shared to the first.",
    }),
    filename: Type.String(),
    title: Type.Optional(Type.String()),
    initial_comment: Type.Optional(Type.String()),
    content: Type.Optional(
      Type.String({ description: "Text content (use either content or content_base64)." }),
    ),
    content_base64: Type.Optional(
      Type.String({ description: "Base64-encoded content for non-text uploads." }),
    ),
    filetype: Type.Optional(
      Type.String({ description: 'Slack filetype short code (e.g. "txt", "png").' }),
    ),
  }),
)({
  id: "slack_user.upload_file",
  name: "Upload File (as user)",
  description:
    "Upload a small file to a Slack channel as YOU (external upload flow). Accepts text content inline; for binary uploads provide base64 in `content_base64`.",
  riskLevel: "high",
  execute: async (p, ctx) => {
    const token = await getUserToken(ctx);
    if (!token) return { success: false, error: notConnectedError() };
    if (!p.content && !p.content_base64) {
      return { success: false, error: "Provide either `content` (text) or `content_base64`." };
    }
    if (p.content && p.content_base64) {
      return { success: false, error: "Provide only one of `content` or `content_base64`." };
    }
    // files.upload was sunset by Slack. Current flow:
    //   1) files.getUploadURLExternal -> { upload_url, file_id }
    //   2) POST the raw bytes to upload_url
    //   3) files.completeUploadExternal -> publishes + shares the file
    // Uint8Array.from yields a fresh ArrayBuffer-backed array (not
    // ArrayBufferLike), so it satisfies BodyInit without a cast.
    const bytes = p.content_base64
      ? Uint8Array.from(atob(p.content_base64), (ch) => ch.charCodeAt(0))
      : Uint8Array.from(new TextEncoder().encode(p.content ?? ""));

    const urlRes = await slackGet("files.getUploadURLExternal", token, {
      filename: p.filename,
      length: bytes.length,
    });
    if (!urlRes.ok) return readSlackError(urlRes);
    const urlData = (await urlRes.json()) as {
      ok: boolean;
      error?: string;
      upload_url?: string;
      file_id?: string;
    };
    if (!urlData.ok || !urlData.upload_url || !urlData.file_id) {
      if (isRevokedError(urlData.error)) return { success: false, error: reconnectError() };
      return { success: false, error: `Slack API error: ${urlData.error || "get_upload_url_failed"}` };
    }

    const putRes = await fetch(urlData.upload_url, { method: "POST", body: bytes });
    if (!putRes.ok) {
      return { success: false, error: `Slack upload failed: HTTP ${putRes.status}` };
    }

    const channelId = p.channels.split(",")[0]?.trim();
    const completeBody: Record<string, unknown> = {
      files: [p.title ? { id: urlData.file_id, title: p.title } : { id: urlData.file_id }],
    };
    if (channelId) completeBody.channel_id = channelId;
    if (p.initial_comment) completeBody.initial_comment = p.initial_comment;

    const doneRes = await slackFetch("files.completeUploadExternal", token, completeBody);
    if (!doneRes.ok) return readSlackError(doneRes);
    const doneData = (await doneRes.json()) as {
      ok: boolean;
      error?: string;
      files?: Array<{ id?: string; permalink?: string }>;
    };
    if (!doneData.ok) return slackDataError(doneData.error);
    const uploaded = doneData.files?.[0];
    return { success: true, data: { ok: true, file_id: uploaded?.id, permalink: uploaded?.permalink } };
  },
});

const addPin = action(
  Type.Object({
    channel: Type.String(),
    timestamp: Type.String(),
  }),
)({
  id: "slack_user.add_pin",
  name: "Pin Message (as user)",
  description: "Pin a message to a channel as YOU (pins.add).",
  riskLevel: "high",
  execute: async (p, ctx) => {
    const token = await getUserToken(ctx);
    if (!token) return { success: false, error: notConnectedError() };
    const res = await slackFetch("pins.add", token, { channel: p.channel, timestamp: p.timestamp });
    if (!res.ok) return readSlackError(res);
    const data = (await res.json()) as { ok: boolean; error?: string };
    if (!data.ok) return slackDataError(data.error);
    return { success: true, data: { ok: true } };
  },
});

const addBookmark = action(
  Type.Object({
    channel_id: Type.String(),
    title: Type.String(),
    link: Type.String({ format: "uri" }),
    emoji: Type.Optional(Type.String()),
  }),
)({
  id: "slack_user.add_bookmark",
  name: "Add Bookmark (as user)",
  description: "Add a link bookmark to a channel as YOU (bookmarks.add).",
  riskLevel: "high",
  execute: async (p, ctx) => {
    const token = await getUserToken(ctx);
    if (!token) return { success: false, error: notConnectedError() };
    const body: Record<string, unknown> = {
      channel_id: p.channel_id,
      title: p.title,
      type: "link",
      link: p.link,
    };
    if (p.emoji) body.emoji = p.emoji;
    const res = await slackFetch("bookmarks.add", token, body);
    if (!res.ok) return readSlackError(res);
    const data = (await res.json()) as { ok: boolean; error?: string; bookmark?: { id?: string } };
    if (!data.ok) return slackDataError(data.error);
    return { success: true, data: { ok: true, bookmark_id: data.bookmark?.id } };
  },
});

const addReminder = action(
  Type.Object({
    text: Type.String(),
    time: Type.String({
      description: 'Slack natural-language time string ("in 20 minutes") or Unix seconds.',
    }),
  }),
)({
  id: "slack_user.add_reminder",
  name: "Add Reminder (as user)",
  description:
    'Create a Slack reminder for YOU (reminders.add). `time` is a Slack-style natural string like "in 20 minutes" or a Unix timestamp.',
  riskLevel: "high",
  execute: async (p, ctx) => {
    const token = await getUserToken(ctx);
    if (!token) return { success: false, error: notConnectedError() };
    const res = await slackFetch("reminders.add", token, { text: p.text, time: p.time });
    if (!res.ok) return readSlackError(res);
    const data = (await res.json()) as { ok: boolean; error?: string; reminder?: { id?: string } };
    if (!data.ok) return slackDataError(data.error);
    return { success: true, data: { ok: true, reminder_id: data.reminder?.id } };
  },
});

const allActions: PluginAction[] = [
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

export const slackUserActionPlugin: ActionPlugin = {
  service: "slack-user",
  description: "Slack (personal) — acts AS the connected user (xoxp token)",
  requiresCredential: true,
  actions: allActions,
};
