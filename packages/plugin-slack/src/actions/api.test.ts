import { afterEach, expect, it, vi } from "vitest";
import { SLACK_REQUEST_TIMEOUT_MS, slackFetch, slackGet } from "./api.js";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

it.each(["post", "get"])("aborts a blackholed %s request", async method => {
  vi.useFakeTimers();
  const controller = new AbortController();
  vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => {
    setTimeout(() => controller.abort(new Error("request timed out")), ms);
    return controller.signal;
  });
  const fetchMock = vi.fn((_url: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
  }));
  vi.stubGlobal("fetch", fetchMock);
  const request = method === "post" ? slackFetch("chat.postMessage", "test", undefined, undefined, AbortSignal.timeout(SLACK_REQUEST_TIMEOUT_MS)) : slackGet("conversations.info", "test", undefined, undefined, AbortSignal.timeout(SLACK_REQUEST_TIMEOUT_MS));
  const outcome = expect(request).rejects.toThrow("request timed out");
  await vi.advanceTimersByTimeAsync(SLACK_REQUEST_TIMEOUT_MS);
  await outcome;
  expect(fetchMock).toHaveBeenCalledOnce();
});

it("bounds Retry-After waits with the same request deadline", async () => {
  vi.useFakeTimers();
  const controller = new AbortController();
  vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => {
    setTimeout(() => controller.abort(new Error("request timed out")), ms);
    return controller.signal;
  });
  const fetchMock = vi.fn(async () => new Response("{}", { status: 429, headers: { "Retry-After": "300" } }));
  vi.stubGlobal("fetch", fetchMock);
  const outcome = expect(slackFetch("chat.postMessage", "test", undefined, undefined, AbortSignal.timeout(SLACK_REQUEST_TIMEOUT_MS))).rejects.toThrow("request timed out");
  await vi.advanceTimersByTimeAsync(SLACK_REQUEST_TIMEOUT_MS);
  await outcome;
  expect(fetchMock).toHaveBeenCalledOnce();
});

it.each(["post", "get"])("preserves long Retry-After waits for ordinary %s callers", async method => {
  vi.useFakeTimers();
  const fetchMock = vi.fn().mockResolvedValueOnce(new Response("{}", { status: 429, headers: { "Retry-After": "15" } }))
    .mockResolvedValueOnce(new Response('{"ok":true}'));
  vi.stubGlobal("fetch", fetchMock);
  const request = method === "post" ? slackFetch("chat.postMessage", "test") : slackGet("conversations.info", "test");
  await vi.advanceTimersByTimeAsync(15_000);
  expect((await request).status).toBe(200);
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(fetchMock.mock.calls.every(([, init]) => init.signal === undefined)).toBe(true);
});
