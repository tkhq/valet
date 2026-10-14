/**
 * `client.ts` URL-building unit test — orchestrator and other session ids
 * contain colons (`orchestrator:user:{userId}`), so every path segment that
 * interpolates an id must be `encodeURIComponent`-ed or the colon collides
 * with Hono's own path-param parsing on some routes. Spies on global
 * `fetch` to assert the exact request URL without a real server.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { api, ApiError, ApiUnavailableError } from "./client";
import { useApiAvailability } from "~/stores/api-availability";

function stubFetchOk(body: unknown = {}): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const COLON_ID = "orchestrator:user:local-user";

describe("api client: colon-safe URL encoding", () => {
  it("getSession encodes a colon-bearing session id", async () => {
    const fetchMock = stubFetchOk();
    await api.getSession(COLON_ID);
    const url = fetchMock.mock.calls[0]?.[0] as string;
    expect(url).toBe(`/api/sessions/${encodeURIComponent(COLON_ID)}`);
    expect(url).not.toContain("orchestrator:user:local-user");
  });

  it("listThreads encodes the session id", async () => {
    const fetchMock = stubFetchOk();
    await api.listThreads(COLON_ID);
    const url = fetchMock.mock.calls[0]?.[0] as string;
    expect(url).toBe(`/api/sessions/${encodeURIComponent(COLON_ID)}/threads`);
  });

  it("patchThread encodes the thread id", async () => {
    const fetchMock = stubFetchOk();
    await api.patchThread("thread:1", { model: "claude-haiku-4-5" });
    const url = fetchMock.mock.calls[0]?.[0] as string;
    expect(url).toBe(
      `/api/threads/${encodeURIComponent("thread:1")}`,
    );
  });

  it("sendPrompt encodes the session id", async () => {
    const fetchMock = stubFetchOk();
    await api.sendPrompt(COLON_ID, { text: "hi" });
    const url = fetchMock.mock.calls[0]?.[0] as string;
    expect(url).toBe(`/api/sessions/${encodeURIComponent(COLON_ID)}/messages`);
  });

  it("addresses explicit message threads and preserves pagination", async () => {
    const fetchMock = stubFetchOk();
    await api.listMessages(COLON_ID, { threadId: "thread:1", cursor: "cursor:2", limit: 25 });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/threads/thread%3A1/messages?limit=25&cursor=cursor%3A2");
    await api.sendPrompt(COLON_ID, { text: "hello", threadId: "thread:1" });
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/threads/thread%3A1/messages");
  });

  it("resolveDecision encodes session id and gate id", async () => {
    const fetchMock = stubFetchOk();
    await api.resolveDecision(COLON_ID, "gate:1", { actionId: "approve" });
    const url = fetchMock.mock.calls[0]?.[0] as string;
    expect(url).toBe(
      `/api/sessions/${encodeURIComponent(COLON_ID)}/decisions/${encodeURIComponent("gate:1")}/resolve`,
    );
  });

  it("ensureWorkspaceRuntime posts to the workspace runtime route with no id to encode", async () => {
    const fetchMock = stubFetchOk({ sessionId: COLON_ID });
    const res = await api.ensureWorkspaceRuntime("user");
    const url = fetchMock.mock.calls[0]?.[0] as string;
    expect(url).toBe("/api/workspaces/user/runtime");
    expect(res.sessionId).toBe(COLON_ID);
  });

  it("abortThread encodes the thread id", async () => {
    const fetchMock = stubFetchOk();
    await api.abortThread("thread:1", { targetItemId: "item:1" });
    const url = fetchMock.mock.calls[0]?.[0] as string;
    expect(url).toBe(
      `/api/threads/${encodeURIComponent("thread:1")}/abort`,
    );
    const opts = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(opts.body).toBe(JSON.stringify({ targetItemId: "item:1" }));
  });

  it("resumeThread encodes the thread id", async () => {
    const fetchMock = stubFetchOk();
    await api.resumeThread("thread:1");
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      `/api/threads/${encodeURIComponent("thread:1")}/resume`,
    );
  });
});

describe("api client: notification preferences", () => {
  it("listNotificationPreferences GETs the preferences endpoint", async () => {
    const fetchMock = stubFetchOk({ preferences: [] });
    await api.listNotificationPreferences();
    const url = fetchMock.mock.calls[0]?.[0] as string;
    const opts = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(url).toBe("/api/notifications/preferences");
    expect(opts.method).toBe("GET");
  });

  it("setNotificationPreference PUTs the kind/web body", async () => {
    const fetchMock = stubFetchOk({ ok: true });
    await api.setNotificationPreference({ kind: "approval", web: false });
    const url = fetchMock.mock.calls[0]?.[0] as string;
    const opts = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(url).toBe("/api/notifications/preferences");
    expect(opts.method).toBe("PUT");
    expect(JSON.parse(opts.body as string)).toEqual({ kind: "approval", web: false });
  });
});

describe("api client: usage period URLs", () => {
  it("builds month and custom URLs with the selected scope", async () => {
    const fetchMock = stubFetchOk({});
    await api.usageBreakdown({ kind: "month", month: "2024-02" }, "org");
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/usage/breakdown?month=2024-02&scope=org");

    expect(api.usageExportCsvUrl(
      { kind: "custom", start: "2024-02-01", end: "2024-02-29" },
      "team",
      "turn",
      "team-x",
    )).toBe("/api/usage/export.csv?start=2024-02-01&end=2024-02-29&scope=team&teamId=team-x&granularity=turn");

    const validateFetch = stubFetchOk();
    await api.validateUsageExport({ kind: "lookback", window: "7d" }, "me", "day");
    expect(validateFetch.mock.calls[0]?.[0]).toBe(
      "/api/usage/export.csv?window=7d&scope=me&granularity=day&validate=1",
    );
  });
});

it("scopes child work and pagination to an encoded parent session", async () => {
  const fetchMock = stubFetchOk({ children: [], nextCursor: null, runningCount: 0 });
  await api.getChildWork("parent:team", { cursor: "cursor+/=", limit: 25 });
  const url = new URL(fetchMock.mock.calls[0]?.[0] as string, "https://example.test");
  expect(url.pathname).toBe("/api/sessions/parent%3Ateam/children");
  expect(url.searchParams.get("cursor")).toBe("cursor+/=");
  expect(url.searchParams.get("limit")).toBe("25");
});

it("dismisses a child under an explicit encoded parent", async () => {
  const fetchMock = stubFetchOk({ ok: true });
  await api.dismissChild("parent:team", "child:one");
  expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/sessions/parent%3Ateam/children/child%3Aone/dismiss");
});

it("encodes receipt search and page cursor", async () => {
  const fetchMock = stubFetchOk();
  await api.listEventReceipts({ q: "C123 + Ev456", cursor: "cursor+/=", limit: 25 });
  const url = new URL(fetchMock.mock.calls[0]?.[0] as string, "https://example.test");
  expect(url.pathname).toBe("/api/events/receipts");
  expect(url.searchParams.get("q")).toBe("C123 + Ev456");
  expect(url.searchParams.get("cursor")).toBe("cursor+/=");
  expect(url.searchParams.get("limit")).toBe("25");
});

describe("usage request cancellation", () => {
  beforeEach(() => {
    // Older browsers have AbortController but no AbortSignal.any.
    vi.stubGlobal("AbortSignal", { any: undefined });
  });

  it("completes requests and removes the caller listener without AbortSignal.any", async () => {
    vi.useFakeTimers();
    try {
      stubFetchOk({ enabled: true });
      const controller = new AbortController();
      const added = vi.spyOn(controller.signal, "addEventListener");
      const removed = vi.spyOn(controller.signal, "removeEventListener");
      await expect(api.proxySettings(controller.signal)).resolves.toEqual({ enabled: true });
      expect(added).toHaveBeenCalledWith("abort", expect.any(Function), { once: true });
      expect(removed).toHaveBeenCalledWith("abort", added.mock.calls[0]?.[1]);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it("preserves an already-aborted caller's reason", async () => {
    pendingFetch();
    const controller = new AbortController();
    const reason = new DOMException("Caller stopped", "AbortError");
    controller.abort(reason);
    await expect(api.proxySettings(controller.signal)).rejects.toBe(reason);
  });

  it("removes the caller listener after a failed response", async () => {
    const failure = new Error("Network failed");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(failure));
    const controller = new AbortController();
    const added = vi.spyOn(controller.signal, "addEventListener");
    const removed = vi.spyOn(controller.signal, "removeEventListener");
    await expect(api.proxySettings(controller.signal)).rejects.toBe(failure);
    expect(removed).toHaveBeenCalledWith("abort", added.mock.calls[0]?.[1]);
  });
  function pendingFetch() {
    vi.stubGlobal("fetch", vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) throw new Error("A cancellable request needs a signal.");
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    })));
  }

  it("preserves caller cancellation instead of reporting a timeout", async () => {
    vi.useFakeTimers();
    try {
      pendingFetch();
      const controller = new AbortController();
      const added = vi.spyOn(controller.signal, "addEventListener");
      const removed = vi.spyOn(controller.signal, "removeEventListener");
      const result = api.usageBreakdown({ kind: "lookback", window: "7d" }, "me", undefined, controller.signal);
      const rejected = expect(result).rejects.toMatchObject({ name: "AbortError" });
      controller.abort();
      await rejected;
      expect(removed).toHaveBeenCalledWith("abort", added.mock.calls[0]?.[1]);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it("still times out when the caller signal remains active", async () => {
    vi.useFakeTimers();
    try {
      pendingFetch();
      const controller = new AbortController();
      const added = vi.spyOn(controller.signal, "addEventListener");
      const removed = vi.spyOn(controller.signal, "removeEventListener");
      const result = api.proxySettings(controller.signal);
      const rejected = expect(result).rejects.toThrow("got no response in 30s");
      await vi.advanceTimersByTimeAsync(30_000);
      await rejected;
      expect(controller.signal.aborted).toBe(false);
      expect(removed).toHaveBeenCalledWith("abort", added.mock.calls[0]?.[1]);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
});

describe("api client: unavailable api during a deploy", () => {
  const gateway = (status = 503) =>
    new Response("<html><body>503 Service Temporarily Unavailable</body></html>", {
      status,
      headers: { "Content-Type": "text/html" },
    });
  const ok = (body: unknown = {}) =>
    new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

  beforeEach(() => {
    vi.useFakeTimers();
    useApiAvailability.setState({ unavailableSince: null });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("retries a GET through ingress gateway errors and network failures", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(gateway(503))
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(gateway(502))
      .mockResolvedValueOnce(ok({ id: "s1" }));
    vi.stubGlobal("fetch", fetchMock);
    const result = api.getSession("s1");
    await vi.advanceTimersByTimeAsync(500);
    expect(useApiAvailability.getState().unavailableSince).not.toBeNull();
    await vi.advanceTimersByTimeAsync(1_000 + 2_000);
    await expect(result).resolves.toEqual({ id: "s1" });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(useApiAvailability.getState().unavailableSince).toBeNull();
  });

  it("gives up after the retry budget with a message that names the action", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => gateway()));
    const result = api.getSession("s1");
    const rejected = expect(result).rejects.toThrow("Wait a few seconds, then try again.");
    await vi.advanceTimersByTimeAsync(60_000);
    await rejected;
    await expect(result).rejects.toBeInstanceOf(ApiUnavailableError);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not retry a mutation, because the api may have applied it", async () => {
    const fetchMock = vi.fn(async () => gateway());
    vi.stubGlobal("fetch", fetchMock);
    await expect(api.deleteSession("s1")).rejects.toBeInstanceOf(ApiUnavailableError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(useApiAvailability.getState().unavailableSince).not.toBeNull();
  });

  it("does not retry a JSON 503 from the api itself", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ error: "not configured" }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    useApiAvailability.setState({ unavailableSince: 1 });
    const err = await api.getSession("s1").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).not.toBeInstanceOf(ApiUnavailableError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(useApiAvailability.getState().unavailableSince).toBeNull();
  });

  it("stops retrying when the caller aborts", async () => {
    const fetchMock = vi.fn(async () => gateway());
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    const result = api.proxySettings(controller.signal);
    const rejected = expect(result).rejects.toBeDefined();
    await vi.advanceTimersByTimeAsync(100);
    controller.abort(new Error("left the page"));
    await rejected;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
