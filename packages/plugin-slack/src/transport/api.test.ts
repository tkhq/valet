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
