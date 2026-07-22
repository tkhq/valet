import type {
  ChannelGatePrompt,
  ChannelGateResolution,
  ChannelTransport,
  ChannelTransportFactory,
  FetchedChannelMedia,
  GatePromptRef,
  InboundChannelEvent,
  InboundChannelMedia,
  OutboundChannelAttachment,
  OutboundChannelMessage,
  RawChannelUpdate,
  SendRef,
  TransportContext,
} from "@valet/engine";
import { buildContentBlocks, SLACK_MAX_BLOCKS, SLACK_TEXT_LIMIT } from "../message-chunking.js";
import { SlackApi } from "./api.js";
import { markdownToSlackMrkdwn } from "./format.js";
import { verifySlackSignatureSync } from "./verify.js";

const MAX_IMAGE_DOWNLOAD_BYTES = 10 * 1024 * 1024; // 10 MB (images prefer thumbnails anyway)
const MAX_FILE_DOWNLOAD_BYTES = 25 * 1024 * 1024; // 25 MB (PDFs, documents)

/** Cap the in-memory url_private / gate-text maps. */
const MAX_TRACKED_ENTRIES = 500;

/** Legacy SKIP_SUBTYPES, ported from origin/main `src/channels/transport.ts`.
 * Exported so the events TriggerDef applies the exact same noise filter as the
 * channel path (edits/deletes/system messages), rather than a blunter one. */
export const SKIP_SUBTYPES = new Set([
  "message_changed",
  "message_deleted",
  "bot_message",
  "channel_join",
  "channel_leave",
  "channel_topic",
  "channel_purpose",
  "channel_name",
  "channel_archive",
  "channel_unarchive",
  "group_join",
  "group_leave",
  "group_topic",
  "group_purpose",
  "group_name",
  "group_archive",
  "group_unarchive",
  "file_comment",
  "file_mention",
  "pinned_item",
  "unpinned_item",
]);

// ─── Conversation-key codec ─────────────────────────────────────────────────
//
// conversationKey: "slack:{teamId}:{channelId}" | "slack:{teamId}:{channelId}:{threadTs}"
// engine threadKey: "slack:{channelId}"         | "slack:{channelId}:{threadTs}"

export interface SlackConversationRef {
  teamId: string;
  channelId: string;
  threadTs?: string;
}

export function conversationKeyFor(teamId: string, channelId: string, threadTs?: string): string {
  return threadTs !== undefined ? `slack:${teamId}:${channelId}:${threadTs}` : `slack:${teamId}:${channelId}`;
}

export function parseConversationKey(key: string): SlackConversationRef | null {
  if (!key.startsWith("slack:")) return null;
  const parts = key.slice("slack:".length).split(":");
  if (parts.length < 2 || parts.length > 3 || parts.some((p) => p === "")) return null;
  return { teamId: parts[0], channelId: parts[1], threadTs: parts[2] };
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}

function rec(v: unknown): Record<string, unknown> | undefined {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

/**
 * Clean Slack-specific markup from message text. Simplified port of the
 * legacy cleanSlackText: the bot's own mention is stripped entirely, other
 * user mentions fall back to "@USERID", channel links `<#C…|name>` → #name,
 * URL links `<url|label>` → label / `<url>` → url.
 */
export function cleanSlackText(text: string, selfUserId?: string): string {
  let cleaned = text;
  if (selfUserId) cleaned = cleaned.split(`<@${selfUserId}>`).join("");
  cleaned = cleaned.replace(/<@([A-Z0-9]+)>/g, "@$1");
  cleaned = cleaned.replace(/<#[A-Z0-9]+\|([^>]+)>/g, "#$1");
  cleaned = cleaned.replace(/<(https?:\/\/[^|>]+)\|([^>]+)>/g, "$2");
  cleaned = cleaned.replace(/<(https?:\/\/[^>]+)>/g, "$1");
  return cleaned.trim();
}

interface SlackFileRef {
  urlPrivate: string;
  thumb?: string;
  mimeType: string;
  name?: string;
  size?: number;
}

export class SlackTransport implements ChannelTransport {
  readonly channelType = "slack";
  /** Socket Mode ingress; only present when the credential carries an app token. */
  readonly poll?: (signal: AbortSignal) => AsyncIterable<RawChannelUpdate>;

  /** fileId → private download URLs captured at parseUpdate time. */
  private readonly fileRefs = new Map<string, SlackFileRef>();
  /** `${conversationKey}#${messageId}` → gate-prompt mrkdwn text, for updateGatePrompt. */
  private readonly gateTexts = new Map<string, string>();

  constructor(
    private readonly api: SlackApi,
    private readonly teamId: string,
    private readonly botUserId?: string,
    appToken?: string,
  ) {
    if (appToken !== undefined) {
      this.poll = (signal) => this.socketModePoll(appToken, signal);
    }
  }

  // ─── Ingress ──────────────────────────────────────────────────────────

  verifyWebhook(
    req: { headers: Record<string, string>; rawBody: Uint8Array },
    secrets: Record<string, string>,
  ): RawChannelUpdate[] | null {
    if (!secrets.webhookSecret) return null;
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers)) headers[key.toLowerCase()] = value;
    const bodyText = new TextDecoder().decode(req.rawBody);
    if (!verifySlackSignatureSync(headers, bodyText, secrets.webhookSecret)) return null;
    try {
      if (bodyText.startsWith("payload=")) {
        // Interactivity: form-encoded with a single `payload` JSON param.
        const payload = new URLSearchParams(bodyText).get("payload");
        if (payload === null) return null;
        return [JSON.parse(payload) as unknown];
      }
      return [JSON.parse(bodyText) as unknown];
    } catch {
      return null;
    }
  }

  parseUpdate(update: RawChannelUpdate): InboundChannelEvent | null {
    const u = rec(update);
    if (!u) return null;
    if (u.type === "block_actions") return this.parseBlockActions(u, update);
    if (u.type !== "event_callback") return null;

    const eventId = str(u.event_id);
    const event = rec(u.event);
    if (!eventId || !event) return null;
    const teamId = str(u.team_id) ?? this.teamId;
    const eventType = str(event.type);

    if (eventType !== "message" && eventType !== "app_mention") return null;

    // Bot-echo suppression + legacy subtype skips (allow null subtype and file_share).
    if (event.bot_id !== undefined && event.bot_id !== null) return null;
    const subtype = str(event.subtype);
    if (subtype !== undefined && SKIP_SUBTYPES.has(subtype)) return null;
    if (subtype !== undefined && subtype !== "file_share") return null;

    // Plain channel messages are event-system territory; the channel only
    // routes DMs and explicit @mentions (spec decision 4).
    const channelType = str(event.channel_type);
    if (eventType === "message" && channelType !== "im") return null;

    const channel = str(event.channel);
    const user = str(event.user);
    const ts = str(event.ts) ?? str(event.event_ts);
    if (!channel || !user || !ts) return null;

    const threadTs = str(event.thread_ts) ?? ts;
    const conversationKey = conversationKeyFor(teamId, channel, threadTs);
    const text = cleanSlackText(str(event.text) ?? "", this.botUserId);
    const media = this.mediaOf(event);
    if (text === "" && media === undefined) return null;

    const inbound: InboundChannelEvent = {
      dispatchId: `slack:${eventId}`,
      conversationKey,
      sender: { externalId: user },
      kind: "message",
      text: text !== "" ? text : undefined,
      media,
      raw: update,
    };
    if (eventType === "app_mention") {
      const channelName = str(event.channel_name);
      inbound.context = { mention: true, channelLabel: `#${channelName ?? channel}` };
    }
    return inbound;
  }

  private parseBlockActions(u: Record<string, unknown>, raw: RawChannelUpdate): InboundChannelEvent | null {
    const triggerId = str(u.trigger_id);
    if (!triggerId) return null;
    const actions = Array.isArray(u.actions) ? u.actions : [];
    const action = rec(actions[0]);
    if (!action) return null;
    const value = str(action.value);
    if (!value) return null;
    const parts = value.split("|");
    if (parts.length < 3 || parts[0] !== "g" || parts[1] === "") return null;
    const gateId = parts[1];
    const actionId = parts.slice(2).join("|");
    if (actionId === "") return null;

    const container = rec(u.container);
    const messageTs = str(container?.message_ts);
    const channelId = str(rec(u.channel)?.id) ?? str(container?.channel_id);
    const userRec = rec(u.user);
    const userId = str(userRec?.id);
    if (!messageTs || !channelId || !userId) return null;

    const teamId = str(rec(u.team)?.id) ?? this.teamId;
    const threadTs = str(container?.thread_ts) ?? messageTs;
    const conversationKey = conversationKeyFor(teamId, channelId, threadTs);

    return {
      dispatchId: `slack:ia:${triggerId}`,
      conversationKey,
      sender: { externalId: userId, displayName: str(userRec?.username) ?? str(userRec?.name) },
      kind: "gate_callback",
      gateCallback: {
        actionId,
        gateId,
        callbackId: triggerId,
        ref: { conversationKey, messageId: messageTs },
      },
      raw,
    };
  }

  private mediaOf(event: Record<string, unknown>): InboundChannelMedia[] | undefined {
    const files = Array.isArray(event.files) ? event.files : [];
    const media: InboundChannelMedia[] = [];
    for (const item of files) {
      const file = rec(item);
      if (!file) continue;
      const fileId = str(file.id);
      const urlPrivate = str(file.url_private);
      if (!fileId || !urlPrivate) continue;
      const mimeType = str(file.mimetype) ?? "application/octet-stream";
      const name = str(file.name);
      const size = num(file.size);
      const thumb = str(file.thumb_1024) ?? str(file.thumb_720) ?? str(file.thumb_480) ?? str(file.thumb_360);
      this.remember(this.fileRefs, fileId, { urlPrivate, thumb, mimeType, name, size });
      media.push({
        kind: mimeType.startsWith("image/") ? "photo" : "document",
        fileId,
        mimeType,
        fileName: name,
        fileSize: size,
      });
    }
    return media.length > 0 ? media : undefined;
  }

  private remember<V>(map: Map<string, V>, key: string, value: V): void {
    map.set(key, value);
    if (map.size > MAX_TRACKED_ENTRIES) {
      const oldest = map.keys().next().value;
      if (oldest !== undefined) map.delete(oldest);
    }
  }

  // ─── Socket Mode (local-dev ingress) ──────────────────────────────────

  private async *socketModePoll(appToken: string, signal: AbortSignal): AsyncIterable<RawChannelUpdate> {
    // Reconnect backoff is only reset after a connection that STAYED UP for at
    // least this long. Otherwise a connect→immediate-disconnect storm (Slack
    // refusing/rotating the socket) would reset the backoff to the floor on
    // every accept and spin at ~1 reconnect/sec against connections.open.
    const MIN_HEALTHY_DWELL_MS = 30_000;
    let backoffMs = 1000;
    while (!signal.aborted) {
      let ws: WebSocket;
      let connectedAt = 0;
      try {
        const url = await this.api.connectionsOpen(appToken);
        ws = await openWebSocket(url, signal);
        connectedAt = Date.now();
      } catch {
        if (signal.aborted) return;
        await sleep(backoffMs);
        backoffMs = Math.min(backoffMs * 2, 60_000);
        continue;
      }

      const queue: RawChannelUpdate[] = [];
      let closed = false;
      let notify: (() => void) | null = null;
      const wake = (): void => {
        notify?.();
        notify = null;
      };
      const onAbort = (): void => ws.close();
      signal.addEventListener("abort", onAbort);
      ws.addEventListener("close", () => {
        closed = true;
        wake();
      });
      ws.addEventListener("error", () => {
        closed = true;
        wake();
      });
      ws.addEventListener("message", (ev: MessageEvent) => {
        const data: unknown = ev.data;
        if (typeof data !== "string") return;
        let msg: Record<string, unknown> | undefined;
        try {
          msg = rec(JSON.parse(data));
        } catch {
          return;
        }
        if (!msg) return;
        if (msg.type === "disconnect") {
          // Slack asks us to reconnect (deploys, connection rotation).
          ws.close();
          return;
        }
        const envelopeId = str(msg.envelope_id);
        if (envelopeId !== undefined) ws.send(JSON.stringify({ envelope_id: envelopeId }));
        // events_api payloads are event_callback bodies; interactive payloads
        // are block_actions objects — both are parseUpdate inputs. Slash
        // command envelopes are acked but not yielded.
        if ((msg.type === "events_api" || msg.type === "interactive") && msg.payload !== undefined) {
          queue.push(msg.payload);
          wake();
        }
      });

      try {
        while (true) {
          while (queue.length > 0) {
            yield queue.shift() as RawChannelUpdate;
            if (signal.aborted) return;
          }
          if (closed) break;
          await new Promise<void>((resolve) => {
            notify = resolve;
            if (closed || queue.length > 0) wake();
          });
        }
      } finally {
        signal.removeEventListener("abort", onAbort);
        try {
          ws.close();
        } catch {
          // already closed
        }
      }

      if (signal.aborted) return;
      // A connection that stayed up is healthy — reset so the next reconnect
      // is prompt. A short-lived one keeps escalating the backoff.
      if (Date.now() - connectedAt >= MIN_HEALTHY_DWELL_MS) backoffMs = 1000;
      await sleep(backoffMs);
      backoffMs = Math.min(backoffMs * 2, 60_000);
    }
  }

  // ─── Outbound ─────────────────────────────────────────────────────────

  async send(conversationKey: string, message: OutboundChannelMessage): Promise<SendRef> {
    const target = this.mustParse(conversationKey);
    const formatted = markdownToSlackMrkdwn(message.markdown);
    let text = formatted;
    let blocks: Record<string, unknown>[] | undefined;
    if (message.markdown.length > SLACK_TEXT_LIMIT) {
      // Single API call with blocks — never split into multiple messages
      // (1 msg/sec/channel rate limit; see message-chunking.ts).
      blocks = buildContentBlocks(message.markdown, formatted, SLACK_MAX_BLOCKS);
      text = formatted.slice(0, SLACK_TEXT_LIMIT); // notification fallback
    }
    const res = await this.api.postMessage({ channel: target.channelId, text, threadTs: target.threadTs, blocks });
    return { conversationKey, messageId: res.ts };
  }

  async sendMedia(conversationKey: string, attachment: OutboundChannelAttachment): Promise<SendRef> {
    const target = this.mustParse(conversationKey);
    const name =
      attachment.type === "file" ? attachment.name : (attachment.name ?? `image-${Date.now()}.png`);
    const { uploadUrl, fileId } = await this.api.getUploadUrlExternal(name, attachment.data.byteLength);
    await this.api.uploadToUrl(uploadUrl, attachment.data, attachment.mimeType);
    await this.api.completeUploadExternal({
      fileId,
      channelId: target.channelId,
      threadTs: target.threadTs,
      initialComment: attachment.caption,
    });
    // files.completeUploadExternal doesn't return a message ts; the file id is
    // the only stable handle for what was shared.
    return { conversationKey, messageId: fileId };
  }

  async sendGatePrompt(conversationKey: string, gate: ChannelGatePrompt): Promise<GatePromptRef> {
    const target = this.mustParse(conversationKey);
    const text = markdownToSlackMrkdwn(gate.body ? `**${gate.title}**\n\n${gate.body}` : `**${gate.title}**`);
    const blocks: Record<string, unknown>[] = [
      { type: "section", text: { type: "mrkdwn", text } },
      {
        type: "actions",
        elements: gate.actions.map((action) => ({
          type: "button",
          text: { type: "plain_text", text: action.label },
          action_id: action.id,
          // Slack allows 2000-char values, so the real gate id rides along —
          // gates survive api restarts (unlike Telegram's 64-byte callback_data).
          value: `g|${gate.gateId}|${action.id}`,
          ...(action.style !== undefined ? { style: action.style } : {}),
        })),
      },
    ];
    const res = await this.api.postMessage({ channel: target.channelId, text, threadTs: target.threadTs, blocks });
    this.remember(this.gateTexts, `${conversationKey}#${res.ts}`, text);
    return { conversationKey, messageId: res.ts };
  }

  async updateGatePrompt(ref: GatePromptRef, resolution: ChannelGateResolution): Promise<void> {
    const target = this.mustParse(ref.conversationKey);
    const key = `${ref.conversationKey}#${ref.messageId}`;
    const original = this.gateTexts.get(key);
    const text = original !== undefined ? `${original}\n\n${resolution.label}` : resolution.label;
    // Keep a single section block (clears the buttons) and pin parse: "none" —
    // chat.update defaults parse to "client" and would re-render link markup.
    await this.api.updateMessage({
      channel: target.channelId,
      ts: ref.messageId,
      text,
      blocks: [{ type: "section", text: { type: "mrkdwn", text } }],
      parse: "none",
    });
    this.gateTexts.delete(key);
  }

  async sendTyping(conversationKey: string): Promise<void> {
    // Slack bots have no typing indicator; assistant DM threads support the
    // "is thinking…" shimmer. Attempt it and swallow failures (non-assistant
    // surfaces reject the call).
    const target = parseConversationKey(conversationKey);
    if (!target?.threadTs) return;
    try {
      await this.api.setThreadStatus(target.channelId, target.threadTs, "is thinking...");
    } catch {
      // Not an assistant thread (or missing scope) — nothing to show.
    }
  }

  async fetchMedia(media: InboundChannelMedia): Promise<FetchedChannelMedia | null> {
    let ref = this.fileRefs.get(media.fileId);
    if (!ref) {
      // Re-derive url_private via files.info (e.g. after an api restart).
      try {
        const file = await this.api.filesInfo(media.fileId);
        const urlPrivate = str(file.url_private);
        if (!urlPrivate) return null;
        ref = {
          urlPrivate,
          thumb: str(file.thumb_1024) ?? str(file.thumb_720) ?? str(file.thumb_480) ?? str(file.thumb_360),
          mimeType: str(file.mimetype) ?? media.mimeType ?? "application/octet-stream",
          name: str(file.name) ?? media.fileName,
          size: num(file.size) ?? media.fileSize,
        };
      } catch {
        return null;
      }
    }
    const isImage = ref.mimeType.startsWith("image/");
    const maxBytes = isImage ? MAX_IMAGE_DOWNLOAD_BYTES : MAX_FILE_DOWNLOAD_BYTES;
    // Prefer a Slack-generated thumbnail for images over the full-size file.
    const url = isImage && ref.thumb !== undefined ? ref.thumb : ref.urlPrivate;
    if (url === ref.urlPrivate && ref.size !== undefined && ref.size > maxBytes) return null;
    let data: Uint8Array | null;
    try {
      data = await this.api.downloadFile(url, maxBytes);
    } catch {
      return null;
    }
    if (data === null) return null;
    // When we served a Slack-generated thumbnail (images), the bytes are a
    // JPEG/PNG derivative, not the original encoding — report a matching
    // mimeType so a downstream decoder/vision API isn't handed e.g. image/heic
    // bytes that are actually JPEG. Full-file downloads keep the real mime.
    const servedThumb = isImage && ref.thumb !== undefined && url === ref.thumb;
    const mimeType = servedThumb ? "image/jpeg" : ref.mimeType;
    return { data, mimeType, name: ref.name };
  }

  // ─── Key mappings ─────────────────────────────────────────────────────

  threadKeyFromConversationKey(conversationKey: string): string {
    const target = parseConversationKey(conversationKey);
    if (!target) return conversationKey;
    return target.threadTs !== undefined
      ? `slack:${target.channelId}:${target.threadTs}`
      : `slack:${target.channelId}`;
  }

  conversationKeyFromThreadKey(threadKey: string): string | null {
    if (!threadKey.startsWith("slack:")) return null;
    const parts = threadKey.slice("slack:".length).split(":");
    if (parts.length < 1 || parts.length > 2 || parts.some((p) => p === "")) return null;
    return conversationKeyFor(this.teamId, parts[0], parts[1]);
  }

  // ─── Feature-detected extras (not part of ChannelTransport) ───────────

  /** Workspace-member typeahead for the identity-link flow (users.list, bot token). */
  async listWorkspaceMembers(query: string): Promise<Array<{ id: string; name: string; realName?: string }>> {
    const q = query.trim().toLowerCase();
    const out: Array<{ id: string; name: string; realName?: string }> = [];
    let cursor: string | undefined;
    // Bound the SCAN, not just the match count: a selective query that matches
    // few/no members would otherwise page through the entire directory (~250
    // users.list calls in a 50k-member workspace), hanging the typeahead and
    // hammering rate limits. Cap pages regardless of how many matches accrue.
    const MAX_PAGES = 10;
    let pages = 0;
    do {
      const page = await this.api.listUsers(cursor);
      pages += 1;
      for (const member of page.members) {
        if (member.isBot || member.deleted || member.id === "USLACKBOT") continue;
        if (
          q !== "" &&
          !member.name.toLowerCase().includes(q) &&
          !(member.realName ?? "").toLowerCase().includes(q)
        ) {
          continue;
        }
        out.push({ id: member.id, name: member.name, realName: member.realName });
        if (out.length >= 20) return out;
      }
      cursor = page.nextCursor;
      if (pages >= MAX_PAGES) break;
    } while (cursor !== undefined);
    return out;
  }

  /** Open (or fetch) the bot↔user IM and return its conversationKey. */
  async openDirectConversation(slackUserId: string): Promise<string> {
    const channelId = await this.api.openConversation(slackUserId);
    return conversationKeyFor(this.teamId, channelId);
  }

  private mustParse(conversationKey: string): SlackConversationRef {
    const target = parseConversationKey(conversationKey);
    if (!target) throw new Error(`not a slack conversation key: ${conversationKey}`);
    return target;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function openWebSocket(url: string, signal: AbortSignal): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const ws = new WebSocket(url);
    const onAbort = (): void => {
      ws.close();
      reject(new Error("aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    ws.addEventListener("open", () => {
      signal.removeEventListener("abort", onAbort);
      resolve(ws);
    });
    ws.addEventListener("error", () => {
      signal.removeEventListener("abort", onAbort);
      reject(new Error(`websocket connect failed: ${url}`));
    });
  });
}

export const slackTransportFactory: ChannelTransportFactory = {
  channelType: "slack",
  // Slack's webhook URL is app-level config; verification uses the signing
  // secret from credential metadata in a dedicated route.
  ingress: "external-webhook",
  create(ctx: TransportContext): ChannelTransport {
    const token = ctx.credential.accessToken;
    if (!token) throw new Error("slack transport requires a bot token credential (accessToken)");
    const metadata = ctx.credential.metadata ?? {};
    const webhookSecret = metadata.webhookSecret;
    if (typeof webhookSecret !== "string" || webhookSecret === "") {
      throw new Error("slack transport requires metadata.webhookSecret (the app signing secret)");
    }
    // teamId is load-bearing for outbound: conversation keys embed it, and an
    // empty one makes every send/gate/attention key unparseable. Fail fast
    // like webhookSecret rather than silently becoming inbound-only. The
    // credential-save route populates it via auth.test.
    const teamId = typeof metadata.teamId === "string" ? metadata.teamId : "";
    if (teamId === "") {
      throw new Error("slack transport requires metadata.teamId (set via auth.test at connect time)");
    }
    const botUserId = typeof metadata.botUserId === "string" ? metadata.botUserId : undefined;
    const appToken =
      typeof metadata.appToken === "string" && metadata.appToken !== "" ? metadata.appToken : undefined;
    return new SlackTransport(new SlackApi(token, ctx.config.apiBaseUrl), teamId, botUserId, appToken);
  },
};
