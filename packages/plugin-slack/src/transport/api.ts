/**
 * Thin typed client over the Slack Web API for the channel transport.
 * Reuses the action-side `slackFetch`/`slackGet` (429-retrying) rather than
 * duplicating them; adds the transport-specific methods (chat.postMessage,
 * chat.update, conversations.open, v2 external file uploads,
 * assistant.threads.setStatus, auth.test, users.list, apps.connections.open,
 * files.info, url_private downloads).
 */
import { SLACK_API, slackFetch, slackGet } from "../actions/api.js";

export class SlackApiError extends Error {
  constructor(method: string, detail: string) {
    super(`slack ${method} failed: ${detail}`);
  }
}

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

  // ─── Assistant surface ────────────────────────────────────────────────

  async setThreadStatus(channelId: string, threadTs: string, status: string): Promise<void> {
    await this.call("assistant.threads.setStatus", { channel_id: channelId, thread_ts: threadTs, status });
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
