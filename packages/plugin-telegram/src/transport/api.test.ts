import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startFakeBotApi, type FakeBotApi } from "../../test/fake-bot-api.js";
import { TelegramApi } from "./api.js";

describe("TelegramApi", () => {
  let fake: FakeBotApi;
  let api: TelegramApi;
  beforeEach(async () => {
    fake = await startFakeBotApi();
    api = new TelegramApi("TESTTOKEN", fake.baseUrl);
  });
  afterEach(async () => {
    await fake.close();
  });

  it("getMe returns the bot user", async () => {
    const me = await api.getMe();
    expect(me.username).toBe("valet_test_bot");
  });

  it("sendMessage posts HTML text and returns message id", async () => {
    const res = await api.sendMessage({ chatId: 7, html: "<b>hi</b>" });
    expect(res.messageId).toBeGreaterThan(0);
    const call = fake.calls.find((c) => c.method === "sendMessage");
    expect(call?.body.parse_mode).toBe("HTML");
    expect(call?.body.chat_id).toBe(7);
  });

  it("getUpdates passes offset and timeout", async () => {
    fake.pushUpdates([{ update_id: 1 }]);
    const updates = await api.getUpdates({ offset: 5, timeoutSeconds: 1 });
    expect(updates).toHaveLength(1);
    const call = fake.calls.find((c) => c.method === "getUpdates");
    expect(call?.body.offset).toBe(5);
  });

  it("getFile + downloadFile round-trips bytes", async () => {
    fake.addFile("f1", "photos/p.jpg", new Uint8Array([1, 2, 3]));
    const file = await api.getFile("f1");
    const bytes = await api.downloadFile(file.filePath);
    expect(Array.from(bytes)).toEqual([1, 2, 3]);
  });

  it("throws a descriptive error on ok:false", async () => {
    await expect(api.getFile("missing")).rejects.toThrow(/file not found/);
  });
});
