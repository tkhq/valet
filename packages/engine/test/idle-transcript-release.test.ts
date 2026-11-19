import { describe, expect, it, vi } from "vitest";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { Engine, InMemoryEventStream, InMemorySessionStore, VirtualSandboxProvider } from "../src/index.js";

function setup(provider: string) {
  const faux = registerFauxProvider({ provider });
  const store = new InMemorySessionStore();
  const providers = { store, stream: new InMemoryEventStream(), sandboxProvider: new VirtualSandboxProvider() };
  const options = { userId: "u", orgId: "o", workspace: "/", sandbox: {}, model: faux.getModel() };
  return { faux, store, providers, options };
}

describe("idle transcript release", () => {
  it("drops an idle thread's transcript and reloads it from the store on the next turn", async () => {
    const { faux, store, providers, options } = setup("idle-release");
    const session = await new Engine({ providers }).createSession(options);
    const contexts: string[] = [];
    faux.setResponses([
      () => fauxAssistantMessage("noted"),
      (context) => {
        contexts.push(JSON.stringify(context.messages));
        return fauxAssistantMessage("blue");
      },
    ]);
    try {
      const thread = await session.ensureDefaultThread();
      const first = await thread.submitPrompt("remember the blue house", {});
      await thread.awaitResult(first.queueItemId);

      // Used just now, so a window that ended a minute ago keeps it.
      expect(thread.releaseIdleTranscript(Date.now() - 60_000)).toBe(false);
      // awaitResult resolves just before the claim loop exits; release waits for it.
      await vi.waitFor(() => expect(session.releaseIdleTranscripts(Date.now() + 1)).toBe(1));
      // Already released: nothing left to drop.
      expect(session.releaseIdleTranscripts(Date.now() + 1)).toBe(0);

      const snapshots = vi.spyOn(store, "getThreadSnapshot");
      const second = await thread.submitPrompt("what color?", {});
      await thread.awaitResult(second.queueItemId);
      expect(snapshots).toHaveBeenCalledWith(session.id, thread.id);
      // The reloaded transcript carries the earlier turn exactly once.
      expect(contexts[0]?.match(/remember the blue house/g)).toHaveLength(1);
      expect(contexts[0]).toContain("noted");
      expect(contexts[0]?.match(/what color\?/g)).toHaveLength(1);
      snapshots.mockRestore();
    } finally {
      session.suspendTimers();
      faux.unregister();
    }
  });

  it("builds a restored thread's agent on first use and drops it with the transcript", async () => {
    const { faux, store, providers, options } = setup("idle-release-lazy-agent");
    const built: string[] = [];
    const withContext = { ...options, threadSystemContext: (t: { key: string }) => { built.push(t.key); return undefined; } };
    const first = await new Engine({ providers }).createSession(withContext);
    for (const key of ["a", "b", "c"]) await first.createThread(key);
    first.suspendTimers();
    built.length = 0;
    faux.setResponses([() => fauxAssistantMessage("one"), () => fauxAssistantMessage("two")]);
    const session = await new Engine({ providers: { ...providers, stream: new InMemoryEventStream() } })
      .restoreSession({ sessionId: first.id, options: withContext });
    try {
      // A restored session's idle threads hold no agent or system prompt.
      expect(built).toEqual([]);
      const thread = session.listThreads().find((t) => t.key === "b")!;
      const receipt = await thread.submitPrompt("hello", {});
      await thread.awaitResult(receipt.queueItemId);
      expect(built).toEqual(["b"]);
      // Released with its transcript; the next turn builds a fresh one.
      await vi.waitFor(() => expect(session.releaseIdleTranscripts(Date.now() + 1)).toBe(1));
      const again = await thread.submitPrompt("again", {});
      await thread.awaitResult(again.queueItemId);
      expect(built).toEqual(["b", "b"]);
      expect((await store.getQueueItem(session.id, again.queueItemId))?.status).toBe("settled");
    } finally {
      session.suspendTimers();
      faux.unregister();
    }
  });

  it("keeps the transcript of a thread with a running turn", async () => {
    const { faux, providers, options } = setup("idle-release-running");
    const session = await new Engine({ providers }).createSession(options);
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let started!: () => void;
    const running = new Promise<void>((resolve) => { started = resolve; });
    faux.setResponses([
      async () => {
        started();
        await held;
        return fauxAssistantMessage("done");
      },
    ]);
    try {
      const thread = await session.ensureDefaultThread();
      const receipt = await thread.submitPrompt("long task", {});
      await running;
      expect(thread.releaseIdleTranscript(Date.now() + 60_000)).toBe(false);
      release();
      await thread.awaitResult(receipt.queueItemId);
      await vi.waitFor(() => expect(thread.releaseIdleTranscript(Date.now() + 60_000)).toBe(true));
    } finally {
      session.suspendTimers();
      faux.unregister();
    }
  });
});
