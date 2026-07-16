/** Thin typed client over the Telegram Bot API. All payloads narrowed from unknown. */

export interface TgUser { id: number; is_bot?: boolean; username?: string; first_name?: string }
export interface TgFile { fileId: string; filePath: string; fileSize?: number }

export class TelegramApiError extends Error {
  constructor(method: string, description: string, readonly errorCode?: number) {
    super(`telegram ${method} failed: ${description}`);
  }
}

interface TgResponse { ok: boolean; result?: unknown; description?: string; error_code?: number }

/** Copy into a plain ArrayBuffer-backed view — Blob's BlobPart type rejects the wider ArrayBufferLike. */
function toArrayBuffer(data: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(data.byteLength);
  new Uint8Array(buffer).set(data);
  return buffer;
}

export class TelegramApi {
  constructor(
    private readonly token: string,
    private readonly baseUrl = "https://api.telegram.org",
  ) {}

  private async call(method: string, body: Record<string, unknown>): Promise<unknown> {
    const res = await fetch(`${this.baseUrl}/bot${this.token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const parsed = (await res.json()) as TgResponse;
    if (!parsed.ok) throw new TelegramApiError(method, parsed.description ?? `http ${res.status}`, parsed.error_code);
    return parsed.result;
  }

  private async callMultipart(method: string, form: FormData): Promise<unknown> {
    const res = await fetch(`${this.baseUrl}/bot${this.token}/${method}`, { method: "POST", body: form });
    const parsed = (await res.json()) as TgResponse;
    if (!parsed.ok) throw new TelegramApiError(method, parsed.description ?? `http ${res.status}`, parsed.error_code);
    return parsed.result;
  }

  async getMe(): Promise<TgUser> {
    return (await this.call("getMe", {})) as TgUser;
  }

  async getUpdates(opts: { offset?: number; timeoutSeconds?: number }): Promise<unknown[]> {
    const result = await this.call("getUpdates", {
      offset: opts.offset,
      timeout: opts.timeoutSeconds ?? 30,
      allowed_updates: ["message", "callback_query"],
    });
    return Array.isArray(result) ? result : [];
  }

  async sendMessage(opts: {
    chatId: number | string;
    html: string;
    replyMarkup?: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };
  }): Promise<{ messageId: number }> {
    const result = (await this.call("sendMessage", {
      chat_id: opts.chatId,
      text: opts.html,
      parse_mode: "HTML",
      reply_markup: opts.replyMarkup,
    })) as { message_id: number };
    return { messageId: result.message_id };
  }

  async sendPhoto(opts: { chatId: number | string; data: Uint8Array; mimeType: string; caption?: string; name?: string }): Promise<{ messageId: number }> {
    const form = new FormData();
    form.set("chat_id", String(opts.chatId));
    if (opts.caption !== undefined) form.set("caption", opts.caption);
    form.set("photo", new Blob([toArrayBuffer(opts.data)], { type: opts.mimeType }), opts.name ?? "photo");
    const result = (await this.callMultipart("sendPhoto", form)) as { message_id: number };
    return { messageId: result.message_id };
  }

  async sendDocument(opts: { chatId: number | string; data: Uint8Array; mimeType: string; caption?: string; name: string }): Promise<{ messageId: number }> {
    const form = new FormData();
    form.set("chat_id", String(opts.chatId));
    if (opts.caption !== undefined) form.set("caption", opts.caption);
    form.set("document", new Blob([toArrayBuffer(opts.data)], { type: opts.mimeType }), opts.name);
    const result = (await this.callMultipart("sendDocument", form)) as { message_id: number };
    return { messageId: result.message_id };
  }

  async editMessageText(opts: { chatId: number | string; messageId: number; html: string }): Promise<void> {
    await this.call("editMessageText", {
      chat_id: opts.chatId, message_id: opts.messageId, text: opts.html, parse_mode: "HTML",
    });
  }

  async editMessageReplyMarkup(opts: { chatId: number | string; messageId: number }): Promise<void> {
    await this.call("editMessageReplyMarkup", {
      chat_id: opts.chatId, message_id: opts.messageId, reply_markup: { inline_keyboard: [] },
    });
  }

  async answerCallbackQuery(opts: { callbackQueryId: string; text?: string }): Promise<void> {
    await this.call("answerCallbackQuery", { callback_query_id: opts.callbackQueryId, text: opts.text });
  }

  async sendChatAction(chatId: number | string, action: "typing"): Promise<void> {
    await this.call("sendChatAction", { chat_id: chatId, action });
  }

  async setWebhook(opts: { url: string; secretToken: string }): Promise<void> {
    await this.call("setWebhook", {
      url: opts.url, secret_token: opts.secretToken, allowed_updates: ["message", "callback_query"],
    });
  }

  async getFile(fileId: string): Promise<TgFile> {
    const result = (await this.call("getFile", { file_id: fileId })) as {
      file_id: string; file_path: string; file_size?: number;
    };
    return { fileId: result.file_id, filePath: result.file_path, fileSize: result.file_size };
  }

  async downloadFile(filePath: string): Promise<Uint8Array> {
    const res = await fetch(`${this.baseUrl}/file/bot${this.token}/${filePath}`);
    if (!res.ok) throw new TelegramApiError("downloadFile", `http ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  }
}
