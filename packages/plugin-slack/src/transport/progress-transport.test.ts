import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TurnProgress } from "@valet/engine";
import { ChannelProgressRejectedError } from "@valet/engine";
import { SlackApi } from "./api.js";
import { SlackTransport } from "./transport.js";

const progress: TurnProgress = { turnId: "turn", title: "Check the change", status: "in_progress", revision: "1", updatedAt: 1, tasks: [], omittedTasks: 0 };
const options = { threadTs: "100.1", idempotencyKey: "opaque-turn-key" };
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => { fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock); });
afterEach(() => vi.unstubAllGlobals());

describe("durable Slack task progress", () => {
  it("creates a native plan with opaque recovery metadata and updates it in place", async () => {
    fetchMock.mockResolvedValueOnce(json({ ok: true, ts: "100.2" })).mockResolvedValueOnce(json({ ok: true }));
    const transport = new SlackTransport(new SlackApi("test"), "T1", undefined, "UBOT");
    expect(await transport.publishProgress("slack:T1:D1:100.1", progress, options)).toEqual({ messageId: "100.2" });
    const first = JSON.parse(String(fetchMock.mock.calls[0]?.[1].body));
    expect(first).toMatchObject({ channel: "D1", thread_ts: "100.1", blocks: [{ type: "plan" }], metadata: { event_type: "valet_progress" } });
    expect(JSON.stringify(first.metadata)).not.toContain("opaque-turn-key");
    await transport.publishProgress("slack:T1:D1:100.1", { ...progress, status: "complete", revision: "2" }, { ...options, messageId: "100.2" });
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("chat.update");
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1].body))).toMatchObject({ ts: "100.2" });
    expect(fetchMock.mock.calls.filter(call => String(call[0]).includes("chat.postMessage"))).toHaveLength(1);
  });

  it("finds only the app's matching progress message before an explicit update", async () => {
    const api = new SlackApi("test");
    const find = vi.spyOn(api, "findProgressMessage").mockResolvedValue("100.2");
    fetchMock.mockResolvedValueOnce(json({ ok: true }));
    const transport = new SlackTransport(api, "T1", undefined, "UBOT");
    expect(await transport.publishProgress("slack:T1:C1:100.1", progress, { ...options, recoverOnly: true })).toEqual({ messageId: "100.2" });
    expect(find).toHaveBeenCalledWith("C1", "100.1", expect.any(String), { userId: "UBOT", botId: undefined });
    expect(fetchMock).not.toHaveBeenCalled();
    await transport.publishProgress("slack:T1:C1:100.1", progress, { ...options, messageId: "100.2" });
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("chat.update");
  });

  it("never posts when recovery cannot find a prior message", async () => {
    const api = new SlackApi("test");
    vi.spyOn(api, "findProgressMessage").mockResolvedValue(null);
    const transport = new SlackTransport(api, "T1", undefined, "UBOT");
    expect(await transport.publishProgress("slack:T1:D1:100.1", progress, { ...options, recoverOnly: true })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("checks the native author as well as recovery metadata across bounded pages", async () => {
    fetchMock.mockResolvedValueOnce(json({ ok: true, messages: [{ user: "UOTHER", ts: "bad", metadata: { event_type: "valet_progress", event_payload: { delivery_id: "key" } } }], response_metadata: { next_cursor: "next" } }))
      .mockResolvedValueOnce(json({ ok: true, messages: [{ user: "UBOT", ts: "100.3", metadata: { event_type: "valet_progress", event_payload: { delivery_id: "key" } } }] }));
    expect(await new SlackApi("test").findProgressMessage("C1", "100.1", "key", { userId: "UBOT" })).toBe("100.3");
    const request = new URL(String(fetchMock.mock.calls[1]?.[0]));
    expect(request.searchParams.get("cursor")).toBe("next");
    expect(request.searchParams.get("include_all_metadata")).toBe("true");
  });

  it("distinguishes definitive validation rejection from an uncertain provider failure", async () => {
    const transport = new SlackTransport(new SlackApi("test"), "T1", undefined, "UBOT");
    fetchMock.mockResolvedValueOnce(json({ ok: false, error: "invalid_blocks" }));
    await expect(transport.publishProgress("slack:T1:D1:100.1", progress, options)).rejects.toBeInstanceOf(ChannelProgressRejectedError);
    fetchMock.mockResolvedValueOnce(json({ ok: false, error: "internal_error" }));
    await expect(transport.publishProgress("slack:T1:D1:100.1", progress, options)).rejects.not.toBeInstanceOf(ChannelProgressRejectedError);
  });

  it("refuses recovery without an app identity", async () => {
    await expect(new SlackApi("test").findProgressMessage("C1", "100.1", "key", {})).rejects.toThrow("identity");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
