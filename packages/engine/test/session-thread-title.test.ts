import { describe, expect, it, vi } from "vitest";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { Engine, InMemoryEventStream, InMemorySessionStore, VirtualSandboxProvider } from "../src/index.js";

describe("session thread title", () => {
  it("stamps an initial title in the new thread's metadata and keeps it on reuse", async () => {
    const faux = registerFauxProvider({ provider: "thread-title" });
    const store = new InMemorySessionStore();
    const session = await new Engine({ providers: { store, stream: new InMemoryEventStream(), sandboxProvider: new VirtualSandboxProvider() } })
      .createSession({ userId: "u", orgId: "o", workspace: "/", sandbox: {}, model: faux.getModel() });
    try {
      const thread = await session.createThread("sub:rule-1", { title: "ENG triage" });
      expect(thread.toThreadData().metadata?.title).toBe("ENG triage");
      const persisted = (await store.listThreads(session.id)).find((t) => t.key === "sub:rule-1");
      expect(persisted?.metadata?.title).toBe("ENG triage");
      // A second create of the same key returns the first thread unchanged.
      const again = await session.createThread("sub:rule-1", { title: "Other" });
      expect(again.toThreadData().metadata?.title).toBe("ENG triage");
      // Initial host metadata lands in the write that creates the thread.
      const gated = await session.createThread("sub:rule-3", { title: "Private", metadata: { slackChannels: ["CPRIV"] } });
      expect(gated.toThreadData().metadata).toMatchObject({ title: "Private", slackChannels: ["CPRIV"] });
      const gatedStored = (await store.listThreads(session.id)).find((t) => t.key === "sub:rule-3");
      expect(gatedStored?.metadata).toMatchObject({ title: "Private", slackChannels: ["CPRIV"] });
      // A thread created without a title carries no title key.
      const plain = await session.createThread("sub:rule-2");
      expect(plain.toThreadData().metadata).not.toHaveProperty("title");
    } finally { session.suspendTimers(); faux.unregister(); }
  });
});

describe("thread metadata list", () => {
  it("adds a value once and persists it", async () => {
    const faux = registerFauxProvider({ provider: "thread-metadata-list" });
    const store = new InMemorySessionStore();
    const session = await new Engine({ providers: { store, stream: new InMemoryEventStream(), sandboxProvider: new VirtualSandboxProvider() } })
      .createSession({ userId: "u", orgId: "o", workspace: "/", sandbox: {}, model: faux.getModel() });
    try {
      const thread = await session.createThread("sub:rule-1", { title: "Rule" });
      await thread.addToMetadataList("slackChannels", "C1");
      await thread.addToMetadataList("slackChannels", "C1");
      await thread.addToMetadataList("slackChannels", "C2");
      expect(thread.toThreadData().metadata?.slackChannels).toEqual(["C1", "C2"]);
      const persisted = (await store.listThreads(session.id)).find((t) => t.id === thread.id);
      expect(persisted?.metadata?.slackChannels).toEqual(["C1", "C2"]);
      expect(persisted?.metadata?.title).toBe("Rule");
    } finally { session.suspendTimers(); faux.unregister(); }
  });

  it("shows a new value to a save that runs while its own write waits", async () => {
    const faux = registerFauxProvider({ provider: "thread-metadata-race" });
    const store = new InMemorySessionStore();
    const session = await new Engine({ providers: { store, stream: new InMemoryEventStream(), sandboxProvider: new VirtualSandboxProvider() } })
      .createSession({ userId: "u", orgId: "o", workspace: "/", sandbox: {}, model: faux.getModel() });
    try {
      const thread = await session.createThread("sub:rule-1");
      const save = store.saveThread.bind(store);
      let release = () => {};
      const held = new Promise<void>((resolve) => { release = resolve; });
      const spy = vi.spyOn(store, "saveThread").mockImplementationOnce(async (sessionId, data) => { await held; await save(sessionId, data); });
      const adding = thread.addToMetadataList("slackChannels", "C1");
      // A concurrent save reads the thread while the first write waits, and
      // its write lands last.
      const concurrent = thread.toThreadData();
      release();
      await adding;
      spy.mockRestore();
      await store.saveThread(session.id, concurrent);
      const persisted = (await store.listThreads(session.id)).find((t) => t.id === thread.id);
      expect(persisted?.metadata?.slackChannels).toEqual(["C1"]);
      expect(thread.toThreadData().metadata?.slackChannels).toEqual(["C1"]);
    } finally { session.suspendTimers(); faux.unregister(); }
  });
});
