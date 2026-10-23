import { afterEach, describe, expect, it, vi } from "vitest";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { Engine, InMemoryEventStream, InMemorySessionStore, VirtualSandboxProvider, executeBuiltin } from "../src/index.js";

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()));

async function setup() {
  const faux = registerFauxProvider({ provider: "fork-command" });
  cleanups.push(() => faux.unregister());
  const store = new InMemorySessionStore();
  const engine = new Engine({ providers: { store, stream: new InMemoryEventStream(), sandboxProvider: new VirtualSandboxProvider() } });
  const session = await engine.createSession({ userId: "u", orgId: "o", workspace: "/workspace", sandbox: {}, model: faux.getModel() });
  return { session, thread: session.thread() };
}

describe("/fork host command", () => {
  it("registers the command and preserves the raw prompt for the authorized host", async () => {
    const { session, thread } = await setup();
    expect(session.commandRegistry().list()).toContainEqual(expect.objectContaining({ name: "fork", source: "builtin", argHint: "[prompt]" }));
    const forkThread = vi.fn().mockResolvedValue("[Open the new thread](/threads/new)");
    const receipt = await session.prompt('/FORK Explain "two words"\nthen continue', { threadId: thread.id, forkThread });
    expect(forkThread).toHaveBeenCalledExactlyOnceWith(thread.id, 'Explain "two words"\nthen continue');
    expect(receipt.queueItemId).toBeFalsy();
    expect(await thread.readEntries()).toContainEqual(expect.objectContaining({ type: "command_result", command: "/fork", ok: true, output: "[Open the new thread](/threads/new)" }));
  });

  it("persists host failures and never queues them as model prompts", async () => {
    const { session, thread } = await setup();
    await session.prompt("/fork", { forkThread: async () => { throw new Error("Access denied. Ask the thread owner."); } });
    expect(await thread.readEntries()).toContainEqual(expect.objectContaining({ type: "command_result", ok: false, output: "Access denied. Ask the thread owner." }));
  });

  it("gives hosts without the capability an actionable result", async () => {
    const { session, thread } = await setup();
    await session.prompt("/fork");
    expect(await thread.readEntries()).toContainEqual(expect.objectContaining({ type: "command_result", ok: false, output: expect.stringContaining("Open this thread in the Valet app") }));
  });
});

it("uses the host's app link when a channel cannot fork", async () => {
  const { session, thread } = await setup();
  const result = await executeBuiltin("fork", [], session, {
    listModels: async () => [], listChildSessions: async () => [],
    threadUrl: (threadId) => `https://valet.example.com/threads/${threadId}`,
  }, thread);
  expect(result.ok).toBe(false);
  expect(result.output).toContain(`https://valet.example.com/threads/${thread.id}`);
});
