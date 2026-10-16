import { describe, expect, it } from "vitest";
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
      // A thread created without a title carries no title key.
      const plain = await session.createThread("sub:rule-2");
      expect(plain.toThreadData().metadata).not.toHaveProperty("title");
    } finally { session.suspendTimers(); faux.unregister(); }
  });
});
