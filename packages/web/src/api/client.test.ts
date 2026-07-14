/**
 * `client.ts` URL-building unit test — orchestrator and other session ids
 * contain colons (`orchestrator:user:{userId}`), so every path segment that
 * interpolates an id must be `encodeURIComponent`-ed or the colon collides
 * with Hono's own path-param parsing on some routes. Spies on global
 * `fetch` to assert the exact request URL without a real server.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { api } from "./client";

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

  it("patchThread encodes both the session id and the thread id", async () => {
    const fetchMock = stubFetchOk();
    await api.patchThread(COLON_ID, "thread:1", { model: "claude-haiku-4-5" });
    const url = fetchMock.mock.calls[0]?.[0] as string;
    expect(url).toBe(
      `/api/sessions/${encodeURIComponent(COLON_ID)}/threads/${encodeURIComponent("thread:1")}`,
    );
  });

  it("sendPrompt encodes the session id", async () => {
    const fetchMock = stubFetchOk();
    await api.sendPrompt(COLON_ID, { text: "hi" });
    const url = fetchMock.mock.calls[0]?.[0] as string;
    expect(url).toBe(`/api/sessions/${encodeURIComponent(COLON_ID)}/messages`);
  });

  it("resolveDecision encodes session id and gate id", async () => {
    const fetchMock = stubFetchOk();
    await api.resolveDecision(COLON_ID, "gate:1", { actionId: "approve" });
    const url = fetchMock.mock.calls[0]?.[0] as string;
    expect(url).toBe(
      `/api/sessions/${encodeURIComponent(COLON_ID)}/decisions/${encodeURIComponent("gate:1")}/resolve`,
    );
  });

  it("ensureOrchestrator posts to /orchestrator with no id to encode", async () => {
    const fetchMock = stubFetchOk({ sessionId: COLON_ID });
    const res = await api.ensureOrchestrator();
    const url = fetchMock.mock.calls[0]?.[0] as string;
    expect(url).toBe("/api/orchestrator");
    expect(res.sessionId).toBe(COLON_ID);
  });

  it("abortThread encodes both the session id and the thread id", async () => {
    const fetchMock = stubFetchOk();
    await api.abortThread(COLON_ID, "thread:1");
    const url = fetchMock.mock.calls[0]?.[0] as string;
    expect(url).toBe(
      `/api/sessions/${encodeURIComponent(COLON_ID)}/threads/${encodeURIComponent("thread:1")}/abort`,
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
