import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SlackApi } from "./api.js";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("SlackApi.joinChannel", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts conversations.join with the channel id and bearer token", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { ok: true }));

    const api = new SlackApi("xoxb-test");
    const result = await api.joinChannel("C123");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://slack.com/api/conversations.join");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer xoxb-test");
    expect(JSON.parse(init.body as string)).toEqual({ channel: "C123" });
    expect(result).toEqual({ ok: true, alreadyIn: false });
  });

  it("reports alreadyIn=true when Slack sets already_in_channel", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { ok: true, already_in_channel: true, channel: { id: "C123" } }),
    );

    const api = new SlackApi("xoxb-test");
    const result = await api.joinChannel("C123");

    expect(result).toEqual({ ok: true, alreadyIn: true });
  });

  it("returns { ok: false, error } on Slack error without throwing", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { ok: false, error: "channel_not_found" }),
    );

    const api = new SlackApi("xoxb-test");
    const result = await api.joinChannel("C_missing");

    expect(result).toEqual({ ok: false, error: "channel_not_found" });
  });

  it("surfaces missing_scope as a returned error (not a throw)", async () => {
    // Realistic Grafana IRM webhook failure mode when the app hasn't been
    // reinstalled with channels:join yet.
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { ok: false, error: "missing_scope" }),
    );

    const api = new SlackApi("xoxb-test");
    const result = await api.joinChannel("C123");

    expect(result).toEqual({ ok: false, error: "missing_scope" });
  });

  it("respects a custom baseUrl (transport-level fake API redirection)", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { ok: true }));

    const api = new SlackApi("xoxb-test", "http://127.0.0.1:9999");
    await api.joinChannel("C123");

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:9999/conversations.join");
  });
});


describe("attention reconciliation", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("finds the delivery metadata on a later history page", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, { ok: true, messages: [{ ts: "1", metadata: { event_type: "other" } }], response_metadata: { next_cursor: "next" } }))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true, messages: [{ ts: "2", metadata: { event_type: "valet_attention", event_payload: { delivery_id: "job" } } }] }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await new SlackApi("test").findAttentionMessage("D123", "job", 120_000)).toEqual({ ts: "2" });
    const url = new URL(String(fetchMock.mock.calls[1]?.[0]));
    expect(url.searchParams.get("channel")).toBe("D123");
    expect(url.searchParams.get("cursor")).toBe("next");
    expect(url.searchParams.get("include_all_metadata")).toBe("true");
    expect(url.searchParams.get("oldest")).toBe("60");
  });

  it("identifies an actual gate prompt from its metadata", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(jsonResponse(200, { ok: true, messages: [
      { ts: "3", metadata: { event_type: "valet_attention", event_payload: { delivery_id: "job", gate_id: "gate" } } },
    ] })));
    expect(await new SlackApi("test").findAttentionMessage("D123", "job", 0)).toEqual({ ts: "3", gateId: "gate" });
  });

  it("does not sleep through a history rate limit", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ ok: false, error: "ratelimited" }), {
      status: 429, headers: { "Content-Type": "application/json", "Retry-After": "120" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(new SlackApi("test").findAttentionMessage("D123", "job", 0)).rejects.toThrow("ratelimited");
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[1].signal).toBeInstanceOf(AbortSignal);
  });

  it("returns a miss and throws lookup errors so the outbox can resend", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(200, { ok: true, messages: [] }))
      .mockResolvedValueOnce(jsonResponse(200, { ok: false, error: "missing_scope" }));
    vi.stubGlobal("fetch", fetchMock);
    const api = new SlackApi("test");
    expect(await api.findAttentionMessage("D123", "job", 0)).toBeNull();
    await expect(api.findAttentionMessage("D123", "job", 0)).rejects.toThrow("missing_scope");
  });
});
