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
import { TelegramApi } from "./api.js";
import { markdownToTelegramHtml } from "./format.js";

const MAX_FILE_BYTES = 20 * 1024 * 1024; // Bot API getFile limit
const COMMAND_RE = /^\/(\w+)(?:@\w+)?(?:\s+([\s\S]*))?$/;

export function conversationKeyForChat(chatId: number | string): string {
  return `telegram:dm:${chatId}`;
}

export function chatIdFromConversationKey(key: string): string {
  const prefix = "telegram:dm:";
  if (!key.startsWith(prefix)) throw new Error(`not a telegram dm conversation key: ${key}`);
  return key.slice(prefix.length);
}

interface TgChat { id: number; type: string }
interface TgFrom { id: number; first_name?: string; last_name?: string; username?: string }
interface TgPhotoSize { file_id: string; file_size?: number }
interface TgMessage {
  message_id: number;
  chat: TgChat;
  from?: TgFrom;
  text?: string;
  caption?: string;
  photo?: TgPhotoSize[];
  document?: { file_id: string; mime_type?: string; file_name?: string; file_size?: number };
  voice?: { file_id: string; mime_type?: string; file_size?: number };
  audio?: { file_id: string; mime_type?: string; file_name?: string; file_size?: number };
}
interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  callback_query?: { id: string; from: TgFrom; message?: TgMessage; data?: string };
}

function displayName(from: TgFrom): string | undefined {
  const name = [from.first_name, from.last_name].filter(Boolean).join(" ");
  return name !== "" ? name : from.username;
}

function mediaOf(m: TgMessage): InboundChannelMedia[] | undefined {
  const media: InboundChannelMedia[] = [];
  if (m.photo && m.photo.length > 0) {
    const largest = m.photo[m.photo.length - 1];
    media.push({ kind: "photo", fileId: largest.file_id, fileSize: largest.file_size });
  }
  if (m.document) {
    media.push({
      kind: "document", fileId: m.document.file_id, mimeType: m.document.mime_type,
      fileName: m.document.file_name, fileSize: m.document.file_size,
    });
  }
  if (m.voice) {
    media.push({ kind: "voice", fileId: m.voice.file_id, mimeType: m.voice.mime_type, fileSize: m.voice.file_size });
  }
  if (m.audio) {
    media.push({
      kind: "audio", fileId: m.audio.file_id, mimeType: m.audio.mime_type,
      fileName: m.audio.file_name, fileSize: m.audio.file_size,
    });
  }
  return media.length > 0 ? media : undefined;
}

const ACTION_EMOJI: Record<string, string> = { approve: "✅ ", deny: "❌ " };

export class TelegramTransport implements ChannelTransport {
  readonly channelType = "telegram";

  constructor(private readonly api: TelegramApi) {}

  verifyWebhook(
    req: { headers: Record<string, string>; rawBody: Uint8Array },
    secrets: Record<string, string>,
  ): RawChannelUpdate[] | null {
    const token = req.headers["x-telegram-bot-api-secret-token"];
    if (!secrets.webhookSecret || token !== secrets.webhookSecret) return null;
    try {
      const parsed: unknown = JSON.parse(new TextDecoder().decode(req.rawBody));
      return [parsed];
    } catch {
      return null;
    }
  }

  async *poll(signal: AbortSignal): AsyncIterable<RawChannelUpdate> {
    let offset: number | undefined;
    let backoffMs = 1000;
    while (!signal.aborted) {
      let updates: unknown[];
      try {
        updates = await this.api.getUpdates({ offset, timeoutSeconds: 30, signal });
        backoffMs = 1000;
      } catch {
        // An abort during the in-flight getUpdates request rejects fetch
        // with an AbortError — exit the generator cleanly rather than
        // falling into the backoff/retry path below.
        if (signal.aborted) return;
        await new Promise((r) => setTimeout(r, backoffMs));
        backoffMs = Math.min(backoffMs * 2, 60_000);
        continue;
      }
      for (const raw of updates) {
        const u = raw as TgUpdate;
        if (typeof u.update_id === "number") offset = u.update_id + 1;
        yield raw;
        if (signal.aborted) return;
      }
    }
  }

  parseUpdate(update: RawChannelUpdate): InboundChannelEvent | null {
    const u = update as TgUpdate;
    if (typeof u.update_id !== "number") return null;
    const dispatchId = `telegram:${u.update_id}`;

    if (u.callback_query) {
      const cb = u.callback_query;
      const msg = cb.message;
      if (!msg || msg.chat.type !== "private" || typeof cb.data !== "string") return null;
      const [tag, actionId] = cb.data.split("|");
      if (tag !== "g" || !actionId) return null;
      return {
        dispatchId,
        conversationKey: conversationKeyForChat(msg.chat.id),
        sender: { externalId: String(cb.from.id), displayName: displayName(cb.from) },
        kind: "gate_callback",
        gateCallback: {
          actionId,
          callbackId: cb.id,
          ref: { conversationKey: conversationKeyForChat(msg.chat.id), messageId: String(msg.message_id) },
        },
        raw: update,
      };
    }

    const m = u.message;
    if (!m || !m.from || m.chat.type !== "private") return null;
    const base = {
      dispatchId,
      conversationKey: conversationKeyForChat(m.chat.id),
      sender: { externalId: String(m.from.id), displayName: displayName(m.from) },
      raw: update,
    };
    const text = m.text ?? m.caption;
    const media = mediaOf(m);
    if (m.text !== undefined) {
      const cmd = COMMAND_RE.exec(m.text);
      if (cmd) {
        return { ...base, kind: "command", text: m.text, command: { name: cmd[1], args: cmd[2]?.trim() || undefined } };
      }
    }
    if (text === undefined && media === undefined) return null;
    return { ...base, kind: "message", text, media };
  }

  async send(conversationKey: string, message: OutboundChannelMessage): Promise<SendRef> {
    const chatId = chatIdFromConversationKey(conversationKey);
    const res = await this.api.sendMessage({ chatId, html: markdownToTelegramHtml(message.markdown) });
    return { conversationKey, messageId: String(res.messageId) };
  }

  async sendMedia(conversationKey: string, attachment: OutboundChannelAttachment): Promise<SendRef> {
    const chatId = chatIdFromConversationKey(conversationKey);
    const res =
      attachment.type === "image"
        ? await this.api.sendPhoto({ chatId, data: attachment.data, mimeType: attachment.mimeType, caption: attachment.caption, name: attachment.name })
        : await this.api.sendDocument({ chatId, data: attachment.data, mimeType: attachment.mimeType, caption: attachment.caption, name: attachment.name });
    return { conversationKey, messageId: String(res.messageId) };
  }

  async sendGatePrompt(conversationKey: string, gate: ChannelGatePrompt): Promise<GatePromptRef> {
    const chatId = chatIdFromConversationKey(conversationKey);
    // Telegram has no field layout; render the host's pre-digested fields as
    // label/value lines so the card shows the same facts Slack's does.
    const fieldLines = (gate.fields ?? []).map((f) => `**${f.label}:** ${f.value}`).join("\n");
    const md = [`**${gate.title}**`, gate.body, fieldLines].filter((part) => part).join("\n\n");
    const html = markdownToTelegramHtml(md);
    const buttons = gate.actions.map((a) => ({
      text: `${ACTION_EMOJI[a.id] ?? ""}${a.label}`,
      callback_data: `g|${a.id}`,
    }));
    const res = await this.api.sendMessage({ chatId, html, replyMarkup: { inline_keyboard: [buttons] } });
    return { conversationKey, messageId: String(res.messageId) };
  }

  async updateGatePrompt(ref: GatePromptRef, resolution: ChannelGateResolution): Promise<void> {
    const chatId = chatIdFromConversationKey(ref.conversationKey);
    const messageId = Number(ref.messageId);
    try {
      // Telegram's omission semantics for reply_markup on editMessageText are
      // ambiguous (community reports disagree), so clear the keyboard
      // explicitly rather than relying on it being dropped implicitly.
      await this.api.editMessageText({
        chatId, messageId, html: markdownToTelegramHtml(resolution.label),
        replyMarkup: { inline_keyboard: [] },
      });
    } catch (err) {
      // Best-effort: make sure the buttons don't stay live even if the text edit failed.
      try {
        await this.api.editMessageReplyMarkup({ chatId, messageId });
      } catch {
        // Swallow — we're already about to rethrow the original failure.
      }
      throw err;
    }
  }

  async fetchMedia(media: InboundChannelMedia): Promise<FetchedChannelMedia | null> {
    if (media.fileSize !== undefined && media.fileSize > MAX_FILE_BYTES) return null;
    let file;
    try {
      file = await this.api.getFile(media.fileId);
    } catch {
      return null;
    }
    if (file.fileSize !== undefined && file.fileSize > MAX_FILE_BYTES) return null;
    let data: Uint8Array;
    try {
      data = await this.api.downloadFile(file.filePath);
    } catch {
      return null;
    }
    const ext = file.filePath.split(".").pop()?.toLowerCase();
    const mimeType =
      media.mimeType ??
      (media.kind === "photo"
        ? ext === "png" ? "image/png" : "image/jpeg"
        : media.kind === "voice" ? "audio/ogg" : "application/octet-stream");
    return { data, mimeType, name: media.fileName };
  }

  async sendTyping(conversationKey: string): Promise<void> {
    await this.api.sendChatAction(chatIdFromConversationKey(conversationKey), "typing");
  }

  async answerCallback(callbackId: string, text?: string): Promise<void> {
    await this.api.answerCallbackQuery({ callbackQueryId: callbackId, text });
  }

  async registerWebhook(url: string, secretToken: string): Promise<void> {
    await this.api.setWebhook({ url, secretToken });
  }

  /** Exposed for the host's deep-link + boot check. Not part of ChannelTransport. */
  getMe(): ReturnType<TelegramApi["getMe"]> {
    return this.api.getMe();
  }
}

export const telegramTransportFactory: ChannelTransportFactory = {
  channelType: "telegram",
  create(ctx: TransportContext): ChannelTransport {
    const token = ctx.credential.accessToken ?? ctx.credential.apiKey;
    if (!token) throw new Error("telegram transport requires a bot token credential");
    return new TelegramTransport(new TelegramApi(token, ctx.config.apiBaseUrl));
  },
};
