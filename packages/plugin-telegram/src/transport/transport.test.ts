import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startFakeBotApi, type FakeBotApi } from "../../test/fake-bot-api.js";
import { TelegramApi } from "./api.js";
import { chatIdFromConversationKey, conversationKeyForChat, TelegramTransport } from "./transport.js";

function msgUpdate(overrides: Record<string, unknown> = {}): unknown {
  return {
    update_id: 111,
    message: {
      message_id: 5,
      chat: { id: 99, type: "private" },
      from: { id: 77, first_name: "Ada", username: "ada" },
      text: "hello",
      ...overrides,
    },
  };
}

describe("TelegramTransport", () => {
  let fake: FakeBotApi;
  let transport: TelegramTransport;
  beforeEach(async () => {
    fake = await startFakeBotApi();
    transport = new TelegramTransport(new TelegramApi("T", fake.baseUrl));
  });
  afterEach(async () => {
    await fake.close();
  });

  it("conversationKey codec round-trips", () => {
    expect(conversationKeyForChat(99)).toBe("telegram:dm:99");
    expect(chatIdFromConversationKey("telegram:dm:99")).toBe("99");
    expect(() => chatIdFromConversationKey("slack:dm:1")).toThrow();
  });

  it("parses a text message", () => {
    const ev = transport.parseUpdate(msgUpdate());
    expect(ev).toMatchObject({
      dispatchId: "telegram:111",
      conversationKey: "telegram:dm:99",
      kind: "message",
      text: "hello",
      sender: { externalId: "77", displayName: "Ada" },
    });
  });

  it("parses /start with args as a command", () => {
    const ev = transport.parseUpdate(msgUpdate({ text: "/start abc123" }));
    expect(ev?.kind).toBe("command");
    expect(ev?.command).toEqual({ name: "start", args: "abc123" });
  });

  it("parses a photo with caption as message + media", () => {
    const ev = transport.parseUpdate(
      msgUpdate({
        text: undefined,
        caption: "look",
        photo: [
          { file_id: "small", width: 10, height: 10, file_size: 100 },
          { file_id: "big", width: 100, height: 100, file_size: 5000 },
        ],
      }),
    );
    expect(ev?.kind).toBe("message");
    expect(ev?.text).toBe("look");
    expect(ev?.media).toEqual([{ kind: "photo", fileId: "big", fileSize: 5000 }]);
  });

  it("parses a callback_query as gate_callback", () => {
    const ev = transport.parseUpdate({
      update_id: 222,
      callback_query: {
        id: "cb1",
        from: { id: 77, first_name: "Ada" },
        message: { message_id: 41, chat: { id: 99, type: "private" } },
        data: "g|approve",
      },
    });
    expect(ev?.kind).toBe("gate_callback");
    expect(ev?.gateCallback).toEqual({
      actionId: "approve",
      callbackId: "cb1",
      ref: { conversationKey: "telegram:dm:99", messageId: "41" },
    });
  });

  it("returns null for unsupported updates", () => {
    expect(transport.parseUpdate({ update_id: 3, edited_message: {} })).toBeNull();
  });

  it("returns null for a callback_query from a group chat", () => {
    const ev = transport.parseUpdate({
      update_id: 223,
      callback_query: {
        id: "cb2",
        from: { id: 77, first_name: "Ada" },
        message: { message_id: 41, chat: { id: -100, type: "group" } },
        data: "g|approve",
      },
    });
    expect(ev).toBeNull();
  });

  it("verifyWebhook checks the secret token header", () => {
    const body = new TextEncoder().encode(JSON.stringify(msgUpdate()));
    const good = transport.verifyWebhook(
      { headers: { "x-telegram-bot-api-secret-token": "s3cret" }, rawBody: body },
      { webhookSecret: "s3cret" },
    );
    expect(good).toHaveLength(1);
    const bad = transport.verifyWebhook(
      { headers: { "x-telegram-bot-api-secret-token": "wrong" }, rawBody: body },
      { webhookSecret: "s3cret" },
    );
    expect(bad).toBeNull();
  });

  it("send converts markdown to HTML", async () => {
    const ref = await transport.send("telegram:dm:99", { markdown: "**hi**" });
    expect(ref.conversationKey).toBe("telegram:dm:99");
    const call = fake.calls.find((c) => c.method === "sendMessage");
    expect(call?.body.text).toBe("<b>hi</b>");
  });

  it("sendGatePrompt builds an inline keyboard and updateGatePrompt edits it", async () => {
    const ref = await transport.sendGatePrompt("telegram:dm:99", {
      gateId: "gate:long:id",
      title: "Deploy?",
      body: "to prod",
      actions: [
        { id: "approve", label: "Approve", style: "primary" },
        { id: "deny", label: "Deny", style: "danger" },
      ],
    });
    const sent = fake.calls.find((c) => c.method === "sendMessage");
    const markup = sent?.body.reply_markup as {
      inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
    };
    expect(markup.inline_keyboard[0]).toEqual([
      { text: "✅ Approve", callback_data: "g|approve" },
      { text: "❌ Deny", callback_data: "g|deny" },
    ]);
    for (const btn of markup.inline_keyboard[0]) {
      expect(new TextEncoder().encode(btn.callback_data).length).toBeLessThanOrEqual(64);
    }
    await transport.updateGatePrompt(ref, { actionId: "approve", label: "✅ Approved by conner" });
    expect(fake.calls.some((c) => c.method === "editMessageText")).toBe(true);
  });

  it("updateGatePrompt clears the keyboard when editMessageText fails, then rethrows", async () => {
    const ref = await transport.sendGatePrompt("telegram:dm:99", {
      gateId: "gate:x",
      title: "Deploy?",
      actions: [{ id: "approve", label: "Approve", style: "primary" }],
    });
    fake.failNext("editMessageText");
    await expect(
      transport.updateGatePrompt(ref, { actionId: "approve", label: "✅ Approved" }),
    ).rejects.toThrow();
    expect(fake.calls.some((c) => c.method === "editMessageReplyMarkup")).toBe(true);
  });

  it("fetchMedia downloads within the 20MB cap and refuses beyond it", async () => {
    fake.addFile("f1", "photos/p.jpg", new Uint8Array([9, 9]));
    const ok = await transport.fetchMedia({ kind: "photo", fileId: "f1", fileSize: 2 });
    expect(ok?.mimeType).toBe("image/jpeg");
    const refused = await transport.fetchMedia({
      kind: "document", fileId: "f1", fileSize: 21 * 1024 * 1024, fileName: "big.bin",
    });
    expect(refused).toBeNull();
  });

  it("fetchMedia returns null when download fails despite a small size hint", async () => {
    fake.addFile("f2", "documents/d.bin", new Uint8Array([1, 2, 3]));
    fake.breakDownload("f2");
    const result = await transport.fetchMedia({ kind: "document", fileId: "f2", fileName: "d.bin" });
    expect(result).toBeNull();
  });

  it("fetchMedia returns null when getFile reports an oversize file with no inbound size hint", async () => {
    fake.addFile("f3", "documents/big.bin", new Uint8Array([1]), 21 * 1024 * 1024);
    const result = await transport.fetchMedia({ kind: "document", fileId: "f3", fileName: "big.bin" });
    expect(result).toBeNull();
  });

  it("poll yields updates and advances offset, stopping on abort", async () => {
    fake.pushUpdates([{ update_id: 1 }, { update_id: 2 }]);
    fake.pushUpdates([{ update_id: 3 }]);
    const ctrl = new AbortController();
    const seen: number[] = [];
    for await (const raw of transport.poll(ctrl.signal)) {
      seen.push((raw as { update_id: number }).update_id);
      if (seen.length === 3) ctrl.abort();
    }
    expect(seen).toEqual([1, 2, 3]);
    const calls = fake.calls.filter((c) => c.method === "getUpdates");
    expect(calls[1]?.body.offset).toBe(3); // last update_id + 1
  });
});
