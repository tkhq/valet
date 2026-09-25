import { afterEach, describe, expect, it, vi } from "vitest";
import type { Sandbox, SandboxCommandChannel, SandboxCommandChannelOptions } from "@valet/engine";
import { PolicySandbox, SandboxAttachment, VirtualSandboxProvider } from "@valet/engine";
import { browserRequest } from "./client.js";
import { browserChannelRequest } from "./channel.js";

const request = {
  protocolVersion: "1.0" as const, sessionId: "s", threadId: "t", actorId: "u", ownerId: "u", command: "status" as const,
};
const response = { protocolVersion: "1.0", runtimeId: "r", ok: true, events: [], cursor: 0, gap: false };
function fixture() {
  let options: SandboxCommandChannelOptions;
  const writes: { id: string; request: unknown }[] = [];
  const close = vi.fn(() => options.onClose());
  const open = vi.fn(async (_command: string, value: SandboxCommandChannelOptions): Promise<SandboxCommandChannel | null> => {
    options = value;
    return { close, write: async (data: string) => { writes.push(JSON.parse(data)); } };
  });
  const sandbox: Sandbox = {
    id: "s", openCommandChannel: open,
    exec: vi.fn(), readFile: vi.fn(), readBinary: vi.fn(), writeFile: vi.fn(), writeBinary: vi.fn(),
    readdir: vi.fn(), stat: vi.fn(), mkdir: vi.fn(), rm: vi.fn(),
  };
  return {
    sandbox, open, writes, close,
    reply(index: number, value = response) { options.onData(JSON.stringify({ id: writes[index].id, response: value }) + "\n"); },
    data(value: string) { options.onData(value); },
    disconnect() { options.onClose(new Error("Connection lost")); },
  };
}
afterEach(() => vi.useRealTimers());
describe("persistent browser channel", () => {
  it("reuses one process and correlates concurrent replies without blocking on a poll", async () => {
    const f = fixture();
    const poll = browserChannelRequest(f.sandbox, { ...request, command: "events", invocationId: "cell", waitMs: 1000 });
    const status = browserChannelRequest(f.sandbox, request);
    await vi.waitFor(() => expect(f.writes).toHaveLength(2));
    f.reply(1, { ...response, cursor: 2 });
    expect(await status).toMatchObject({ cursor: 2 });
    f.reply(0);
    expect(await poll).toEqual(response);
    expect(f.open).toHaveBeenCalledOnce();
    expect(f.open.mock.calls[0][0]).toBe("/usr/local/bin/valet-browser-client --stream");
    expect(f.open.mock.calls[0][1].privileged).toBe(true);
    expect(f.open.mock.calls[0][1]).toMatchObject({ target: "browser" });
    expect(f.open.mock.calls[0][1].waitForReady).toBe(true);
    f.disconnect();
  });
  it("runs concurrent first browser requests after one cold sandbox becomes ready", async () => {
    const f = fixture();
    const base = new VirtualSandboxProvider();
    const create = vi.fn(async () => f.sandbox);
    const attachment = new SandboxAttachment({
      backend: "browser-test", capabilities: () => base.capabilities(), create,
      restore: async () => f.sandbox, status: (id) => base.status(id), destroy: async () => {},
    }, {});
    const policy = new PolicySandbox(attachment);
    const first = browserRequest(policy, request);
    const second = browserRequest(policy, request);
    await vi.waitFor(() => expect(f.writes).toHaveLength(2));
    f.reply(0); f.reply(1);
    expect(await first).toEqual(response); expect(await second).toEqual(response);
    expect(create).toHaveBeenCalledOnce();
    expect(f.open.mock.calls[0][1]).toMatchObject({ target: "browser", privileged: true });
    await attachment.destroy();
  });
  it("prevents viewer connections from waking compute", async () => {
    const f = fixture();
    const pending = browserChannelRequest(f.sandbox, { ...request, audience: "viewer" });
    await vi.waitFor(() => expect(f.writes).toHaveLength(1));
    expect(f.open.mock.calls[0][1].waitForReady).toBe(false);
    f.reply(0); await pending; f.disconnect();
  });
  it("aborts one waiter but retains its slot until the remote reply", async () => {
    const f = fixture(); const abort = new AbortController();
    const canceled = browserChannelRequest(f.sandbox, request, abort.signal);
    const rejected = expect(canceled).rejects.toThrow();
    const other = browserChannelRequest(f.sandbox, request);
    await vi.waitFor(() => expect(f.writes).toHaveLength(2));
    abort.abort(); await rejected;
    f.reply(0); f.reply(1);
    expect(await other).toEqual(response); expect(f.close).not.toHaveBeenCalled();
    f.disconnect();
  });
  it("rejects pending mutations on disconnect without replay", async () => {
    const f = fixture();
    const pending = browserChannelRequest(f.sandbox, { ...request, command: "reset" });
    const rejected = expect(pending).rejects.toThrow(/outcome|status/i);
    await vi.waitFor(() => expect(f.writes).toHaveLength(1)); f.disconnect(); await rejected;
    expect(f.writes).toHaveLength(1);
    const next = browserChannelRequest(f.sandbox, request);
    await vi.waitFor(() => expect(f.writes).toHaveLength(2)); f.reply(1); await next;
    expect(f.open).toHaveBeenCalledTimes(2); f.disconnect();
  });
  it("bounds outstanding work and preserves capacity for dialog replies", async () => {
    const f = fixture();
    const calls = Array.from({length: 12}, () => browserChannelRequest(f.sandbox, request));
    await vi.waitFor(() => expect(f.writes).toHaveLength(12));
    await expect(browserChannelRequest(f.sandbox, request)).rejects.toThrow(/busy/i);
    const dialog = browserChannelRequest(f.sandbox, { ...request, command: "input", runtimeId: "r", tabId: "tab", documentId: "doc", leaseId: "lease", input: {type: "dialog", dialogId: "d", accept: false} });
    await vi.waitFor(() => expect(f.writes).toHaveLength(13));
    for (let i = 0; i < 13; i++) f.reply(i);
    await Promise.all([...calls, dialog]); f.disconnect();
  });
  it("rejects an oversized partial reply and never replays it", async () => {
    const f = fixture(); const pending = browserChannelRequest(f.sandbox, request);
    const rejected = expect(pending).rejects.toThrow(/transport|response/i);
    await vi.waitFor(() => expect(f.writes).toHaveLength(1));
    f.data("x".repeat(1_000_001)); await rejected; expect(f.close).toHaveBeenCalledOnce();
  });
  it("closes an idle channel and times out a hung request", async () => {
    vi.useFakeTimers(); const f = fixture();
    const pending = browserChannelRequest(f.sandbox, request);
    await vi.advanceTimersByTimeAsync(0); f.reply(0); await pending;
    await vi.advanceTimersByTimeAsync(30_000); expect(f.close).toHaveBeenCalledOnce();
    const hung = browserChannelRequest(f.sandbox, request);
    const rejected = expect(hung).rejects.toThrow(/outcome|status/i);
    await vi.advanceTimersByTimeAsync(35_000); await rejected;
    expect(f.close).toHaveBeenCalledTimes(2);
  });
  it("falls back only when the provider reports no channel before any write", async () => {
    const f = fixture(); f.open.mockResolvedValueOnce(null);
    expect(await browserChannelRequest(f.sandbox, request)).toBeNull();
    expect(f.writes).toHaveLength(0);
  });
});
