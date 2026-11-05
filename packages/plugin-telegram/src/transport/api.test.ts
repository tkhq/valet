import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startFakeBotApi, type FakeBotApi } from "../../test/fake-bot-api.js";
import { ChannelDeliveryRejectedError } from "@valet/engine";
import { TelegramApi, TelegramApiError } from "./api.js";

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

describe("attention-only Telegram deadlines and rejections", () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

  it.each(["message", "photo", "document", "download"])("lets ordinary %s operations take longer than ten seconds", async operation => {
    vi.useFakeTimers();
    const timeout = vi.spyOn(AbortSignal, "timeout");
    vi.stubGlobal("fetch", vi.fn((_url: unknown, _init?: RequestInit) => new Promise<Response>(resolve => {
      setTimeout(() => resolve(new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }))), 15_000);
    })));
    const api = new TelegramApi("test");
    const media = { chatId: 7, data: new Uint8Array([1]), mimeType: "text/plain", name: "file" };
    const work = operation === "message" ? api.sendMessage({ chatId: 7, html: "Ordinary" })
      : operation === "photo" ? api.sendPhoto(media)
      : operation === "document" ? api.sendDocument(media) : api.downloadFile("file");
    await vi.advanceTimersByTimeAsync(15_000);
    await work;
    expect(timeout).not.toHaveBeenCalled();
  });

  it("aborts a blackholed attention send after ten seconds", async () => {
    vi.useFakeTimers();
    vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException("Request timed out", "TimeoutError")), ms);
      return controller.signal;
    });
    vi.stubGlobal("fetch", vi.fn((_url: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    })));
    const work = new TelegramApi("test").sendMessage({ chatId: 7, html: "Attention", attention: true });
    const outcome = expect(work).rejects.toMatchObject({ name: "TimeoutError" });
    await vi.advanceTimersByTimeAsync(10_000);
    await outcome;
  });

  it.each(["Forbidden: bot was blocked by the user", "Forbidden: user is deactivated"])("classifies %s only on attention sends", async description => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: false, error_code: 403, description }))));
    const api = new TelegramApi("test");
    await expect(api.sendMessage({ chatId: 7, html: "Attention", attention: true })).rejects.toBeInstanceOf(ChannelDeliveryRejectedError);
    await expect(api.sendMessage({ chatId: 7, html: "Ordinary" })).rejects.toBeInstanceOf(TelegramApiError);
  });

  it.each([429, 500, 403])("keeps unknown HTTP %s attention errors retryable", async code => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: false, error_code: code, description: "Provider unavailable" }))));
    await expect(new TelegramApi("test").sendMessage({ chatId: 7, html: "Attention", attention: true })).rejects.toBeInstanceOf(TelegramApiError);
  });

  it("keeps the long-poll deadline and caller cancellation", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const controller = new AbortController();
    const fetchMock = vi.fn(async (_url: unknown, _init?: RequestInit) => new Response(JSON.stringify({ ok: true, result: [] })));
    vi.stubGlobal("fetch", fetchMock);
    await new TelegramApi("test").getUpdates({ signal: controller.signal });
    expect(timeout).toHaveBeenCalledWith(40_000);
    const signal = fetchMock.mock.calls[0]?.[1]?.signal;
    controller.abort();
    expect(signal?.aborted).toBe(true);
  });
});
