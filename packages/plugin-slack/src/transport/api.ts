/**
 * Thin typed client over the Slack Web API for the channel transport.
 * Reuses the action-side `slackFetch`/`slackGet` (429-retrying) rather than
 * duplicating them; adds the transport-specific methods (chat.postMessage,
 * chat.update, conversations.open, v2 external file uploads, the streaming
 * triple, the assistant thread methods, auth.test, users.list,
 * apps.connections.open, files.info, url_private downloads).
 */
import { SLACK_API, slackFetch, slackGet } from "../actions/api.js";

export class SlackApiError extends Error {
  constructor(
    readonly method: string,
    readonly detail: string,
  ) {
    super(`slack ${method} failed: ${detail}`);
    this.name = "SlackApiError";
  }
}

/** Slack rejects a `markdown_text` longer than this. */
export const SLACK_MARKDOWN_TEXT_LIMIT = 12_000;

/** Slack renders at most four suggested prompts. */
export const MAX_SUGGESTED_PROMPTS = 4;

interface SlackResponse {
  ok: boolean;
  error?: string;
  [key: string]: unknown;
}

function rec(v: unknown): Record<string, unknown> | undefined {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/** Copy into a plain ArrayBuffer-backed view — Blob's BlobPart type rejects the wider ArrayBufferLike. */
function toArrayBuffer(data: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(data.byteLength);
  new Uint8Array(buffer).set(data);
  return buffer;
}

export interface SlackMember {
  id: string;
  name: string;
  realName?: string;
  isBot: boolean;
  deleted: boolean;
}

export interface SlackChannel {
  id: string;
  name: string;
  isArchived: boolean;
}

export class SlackApi {
  constructor(
    private readonly token: string,
    readonly baseUrl: string = SLACK_API,
  ) {}

  private async call(method: string, body: Record<string, unknown>): Promise<SlackResponse> {
    const res = await slackFetch(method, this.token, body, this.baseUrl);
    const parsed = (await res.json()) as SlackResponse;
    if (!parsed.ok) throw new SlackApiError(method, parsed.error ?? `http ${res.status}`);
    return parsed;
  }

  private async get(method: string, params: Record<string, unknown>): Promise<SlackResponse> {
    const res = await slackGet(method, this.token, params, this.baseUrl);
    const parsed = (await res.json()) as SlackResponse;
    if (!parsed.ok) throw new SlackApiError(method, parsed.error ?? `http ${res.status}`);
    return parsed;
  }

  /** Form-encoded POST — files.getUploadURLExternal rejects JSON bodies. */
  private async callForm(method: string, body: Record<string, string | number>): Promise<SlackResponse> {
    const form = new URLSearchParams();
    for (const [key, value] of Object.entries(body)) form.set(key, String(value));
    const res = await fetch(`${this.baseUrl}/${method}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
      },
      body: form.toString(),
    });
    const parsed = (await res.json()) as SlackResponse;
    if (!parsed.ok) throw new SlackApiError(method, parsed.error ?? `http ${res.status}`);
    return parsed;
  }

  async authTest(): Promise<{ teamId?: string; userId?: string; botId?: string }> {
    const res = await this.call("auth.test", {});
    return { teamId: str(res.team_id), userId: str(res.user_id), botId: str(res.bot_id) };
  }

  async postMessage(opts: {
    channel: string;
    text: string;
    threadTs?: string;
    blocks?: Record<string, unknown>[];
  }): Promise<{ ts: string }> {
    const body: Record<string, unknown> = {
      channel: opts.channel,
      text: opts.text,
      unfurl_links: false,
    };
    if (opts.threadTs !== undefined) body.thread_ts = opts.threadTs;
    if (opts.blocks !== undefined) body.blocks = opts.blocks;
    const res = await this.call("chat.postMessage", body);
    const ts = str(res.ts);
    if (!ts) throw new SlackApiError("chat.postMessage", "response missing ts");
    return { ts };
  }

  async updateMessage(opts: {
    channel: string;
    ts: string;
    text: string;
    blocks?: Record<string, unknown>[];
    parse?: "none" | "full";
  }): Promise<void> {
    const body: Record<string, unknown> = { channel: opts.channel, ts: opts.ts, text: opts.text };
    if (opts.blocks !== undefined) body.blocks = opts.blocks;
    if (opts.parse !== undefined) body.parse = opts.parse;
    await this.call("chat.update", body);
  }

  /** conversations.open with a user id → the IM channel id. */
  async openConversation(userId: string): Promise<string> {
    const res = await this.call("conversations.open", { users: userId });
    const channelId = str(rec(res.channel)?.id);
    if (!channelId) throw new SlackApiError("conversations.open", "response missing channel.id");
    return channelId;
  }

  // ─── v2 external file upload flow ─────────────────────────────────────

  async getUploadUrlExternal(filename: string, length: number): Promise<{ uploadUrl: string; fileId: string }> {
    const res = await this.callForm("files.getUploadURLExternal", { filename, length });
    const uploadUrl = str(res.upload_url);
    const fileId = str(res.file_id);
    if (!uploadUrl || !fileId) throw new SlackApiError("files.getUploadURLExternal", "response missing upload_url/file_id");
    return { uploadUrl, fileId };
  }

  async uploadToUrl(uploadUrl: string, data: Uint8Array, mimeType: string): Promise<void> {
    const res = await fetch(uploadUrl, {
      method: "POST",
      body: new Blob([toArrayBuffer(data)], { type: mimeType }),
    });
    if (!res.ok) throw new SlackApiError("upload", `http ${res.status}`);
  }

  async completeUploadExternal(opts: {
    fileId: string;
    channelId: string;
    threadTs?: string;
    initialComment?: string;
  }): Promise<void> {
    const body: Record<string, unknown> = {
      files: [{ id: opts.fileId }],
      channel_id: opts.channelId,
    };
    if (opts.threadTs !== undefined) body.thread_ts = opts.threadTs;
    if (opts.initialComment !== undefined) body.initial_comment = opts.initialComment;
    await this.call("files.completeUploadExternal", body);
  }

  // ─── Streaming ────────────────────────────────────────────────────────
  //
  // The timestamp argument is `ts` on all three methods. The method
  // references (chat.startStream / chat.appendStream / chat.stopStream) name
  // it `ts`, while the "Developing an agent" guide's worked examples use
  // `message_ts`. The references win: they document the raw HTTP API, which
  // is what this client speaks, and the guide's examples run through an SDK
  // that renames it. A wrong name here fails as `invalid_arguments` rather
  // than silently, so the first live call proves it either way.

  /** Open a stream in a thread. Returns the streaming message's `ts`. */
  async startStream(opts: {
    channel: string;
    threadTs: string;
    markdownText?: string;
    /** Omitted for DMs; Slack requires it only when streaming into channels. */
    recipientUserId?: string;
    recipientTeamId?: string;
  }): Promise<{ ts: string }> {
    const body: Record<string, unknown> = { channel: opts.channel, thread_ts: opts.threadTs };
    if (opts.markdownText !== undefined) body.markdown_text = opts.markdownText;
    if (opts.recipientUserId !== undefined) body.recipient_user_id = opts.recipientUserId;
    if (opts.recipientTeamId !== undefined) body.recipient_team_id = opts.recipientTeamId;
    const res = await this.call("chat.startStream", body);
    const ts = str(res.ts);
    if (!ts) throw new SlackApiError("chat.startStream", "response missing ts");
    return { ts };
  }

  async appendStream(opts: { channel: string; ts: string; markdownText: string }): Promise<void> {
    await this.call("chat.appendStream", {
      channel: opts.channel,
      ts: opts.ts,
      markdown_text: opts.markdownText,
    });
  }

  async stopStream(opts: {
    channel: string;
    ts: string;
    markdownText?: string;
    blocks?: Record<string, unknown>[];
  }): Promise<void> {
    const body: Record<string, unknown> = { channel: opts.channel, ts: opts.ts };
    if (opts.markdownText !== undefined) body.markdown_text = opts.markdownText;
    if (opts.blocks !== undefined) body.blocks = opts.blocks;
    await this.call("chat.stopStream", body);
  }

  // ─── Assistant threads ────────────────────────────────────────────────

  async setThreadStatus(channelId: string, threadTs: string, status: string): Promise<void> {
    await this.call("assistant.threads.setStatus", { channel_id: channelId, thread_ts: threadTs, status });
  }

  /**
   * Suggested prompts for a conversation. `threadTs` is optional under
   * `agent_view`: omitting it puts the prompts at the top of the Messages
   * tab, which is where a conversation with no turns yet needs them.
   * Slack accepts at most four, so the caller's excess is dropped here
   * rather than failing the whole call.
   */
  async setSuggestedPrompts(opts: {
    channelId: string;
    prompts: Array<{ title: string; message: string }>;
    threadTs?: string;
    title?: string;
  }): Promise<void> {
    const body: Record<string, unknown> = {
      channel_id: opts.channelId,
      prompts: opts.prompts.slice(0, MAX_SUGGESTED_PROMPTS),
    };
    if (opts.threadTs !== undefined) body.thread_ts = opts.threadTs;
    if (opts.title !== undefined) body.title = opts.title;
    await this.call("assistant.threads.setSuggestedPrompts", body);
  }

  async setThreadTitle(channelId: string, threadTs: string, title: string): Promise<void> {
    await this.call("assistant.threads.setTitle", {
      channel_id: channelId,
      thread_ts: threadTs,
      title,
    });
  }

  // ─── Directory ────────────────────────────────────────────────────────

  async listUsers(cursor?: string): Promise<{ members: SlackMember[]; nextCursor?: string }> {
    const params: Record<string, unknown> = { limit: 200 };
    if (cursor) params.cursor = cursor;
    const res = await this.get("users.list", params);
    const raw = Array.isArray(res.members) ? res.members : [];
    const members: SlackMember[] = [];
    for (const item of raw) {
      const m = rec(item);
      if (!m) continue;
      const id = str(m.id);
      const name = str(m.name);
      if (!id || !name) continue;
      const profile = rec(m.profile);
      members.push({
        id,
        name,
        realName: str(m.real_name) ?? str(profile?.real_name),
        isBot: m.is_bot === true,
        deleted: m.deleted === true,
      });
    }
    const nextCursor = str(rec(res.response_metadata)?.next_cursor);
    return { members, nextCursor: nextCursor !== undefined && nextCursor !== "" ? nextCursor : undefined };
  }

  /**
   * conversations.list page of public and private channels. `types` is
   * fixed to `public_channel,private_channel`; DMs and group DMs are not
   * subscribable channels. Excludes archived channels — a filter that names
   * a dead channel never matches.
   */
  async listChannels(cursor?: string): Promise<{ channels: SlackChannel[]; nextCursor?: string }> {
    const params: Record<string, unknown> = {
      limit: 200,
      types: "public_channel,private_channel",
      exclude_archived: true,
    };
    if (cursor) params.cursor = cursor;
    const res = await this.get("conversations.list", params);
    const raw = Array.isArray(res.channels) ? res.channels : [];
    const channels: SlackChannel[] = [];
    for (const item of raw) {
      const c = rec(item);
      if (!c) continue;
      const id = str(c.id);
      const name = str(c.name);
      if (!id || !name) continue;
      channels.push({ id, name, isArchived: c.is_archived === true });
    }
    const nextCursor = str(rec(res.response_metadata)?.next_cursor);
    return { channels, nextCursor: nextCursor !== undefined && nextCursor !== "" ? nextCursor : undefined };
  }

  /**
   * users.lookupByEmail → the member, or null when the email names nobody in
   * the workspace (Slack's `users_not_found`). Needs the `users:read.email`
   * bot scope; without it Slack answers `missing_scope`, which surfaces as a
   * SlackApiError for the transport to classify.
   */
  async lookupUserByEmail(email: string): Promise<{ id: string; displayName: string } | null> {
    let res: SlackResponse;
    try {
      res = await this.get("users.lookupByEmail", { email });
    } catch (err) {
      if (err instanceof SlackApiError && err.detail === "users_not_found") return null;
      throw err;
    }
    const user = rec(res.user);
    const id = str(user?.id);
    if (!id) throw new SlackApiError("users.lookupByEmail", "response missing user.id");
    const profile = rec(user?.profile);
    const displayName =
      str(profile?.display_name) || str(profile?.real_name) || str(user?.real_name) || str(user?.name) || id;
    return { id, displayName };
  }

  /** conversations.replies → the thread's messages (parent first). Empty when
   *  the thread is gone or the bot cannot read the channel. */
  async conversationsReplies(channel: string, threadTs: string, limit = 100): Promise<Record<string, unknown>[]> {
    const res = await this.get("conversations.replies", { channel, ts: threadTs, limit });
    return Array.isArray(res.messages) ? (res.messages as Record<string, unknown>[]) : [];
  }

  /** users.info → the member's display name, or null when the id names nobody. */
  async usersInfo(userId: string): Promise<{ id: string; displayName: string } | null> {
    let res: SlackResponse;
    try {
      res = await this.get("users.info", { user: userId });
    } catch {
      return null;
    }
    const user = rec(res.user);
    if (!user) return null;
    const profile = rec(user.profile);
    const displayName =
      str(profile?.display_name) || str(profile?.real_name) || str(user.real_name) || str(user.name) || userId;
    return { id: userId, displayName };
  }

  async filesInfo(fileId: string): Promise<Record<string, unknown>> {
    const res = await this.get("files.info", { file: fileId });
    return rec(res.file) ?? {};
  }

  /**
   * Bot-token download of a url_private (or thumbnail) URL. Enforces
   * `maxBytes` via Content-Length and the actual body size; null when over.
   */
  async downloadFile(url: string, maxBytes: number): Promise<Uint8Array | null> {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${this.token}` } });
    if (!res.ok) return null;
    const contentLength = res.headers.get("Content-Length");
    if (contentLength !== null && Number.parseInt(contentLength, 10) > maxBytes) return null;
    const buffer = await res.arrayBuffer();
    if (buffer.byteLength > maxBytes) return null;
    return new Uint8Array(buffer);
  }

  // ─── Socket Mode ──────────────────────────────────────────────────────

  /** POST apps.connections.open with the app-level (xapp) token → wss URL. */
  async connectionsOpen(appToken: string): Promise<string> {
    const res = await fetch(`${this.baseUrl}/apps.connections.open`, {
      method: "POST",
      headers: { Authorization: `Bearer ${appToken}` },
    });
    const parsed = (await res.json()) as SlackResponse;
    if (!parsed.ok) throw new SlackApiError("apps.connections.open", parsed.error ?? `http ${res.status}`);
    const url = str(parsed.url);
    if (!url) throw new SlackApiError("apps.connections.open", "response missing url");
    return url;
  }
}
