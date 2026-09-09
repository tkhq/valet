import { describe, expect, it, vi } from "vitest";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import {
  Engine, InMemoryEventStream, InMemorySessionStore, VirtualSandboxProvider,
  type Session,
  type SessionEntry,
} from "../src/index.js";

describe("lazy session history", () => {
  it("restores metadata without reading entries, then loads only the prompted thread", async () => {
    const faux = registerFauxProvider({ provider: "lazy-history" });
    const store = new InMemorySessionStore();
    const providers = { store, stream: new InMemoryEventStream(), sandboxProvider: new VirtualSandboxProvider() };
    const options = { userId: "u", orgId: "o", workspace: "/", sandbox: {}, model: faux.getModel() };
    const original = await new Engine({ providers }).createSession(options);
    const first = await original.ensureDefaultThread();
    const other = original.thread("web:other");
    await store.saveThread(original.id, other.toThreadData());
    const entry: SessionEntry = {
      id: "prior", sessionId: original.id, threadId: first.id, parentId: null,
      type: "message", role: "user", content: "remember the blue house",
      parts: [{ type: "text", text: "remember the blue house" }], createdAt: 1,
    };
    await store.appendEntries(original.id, first.id, [entry]);
    await store.appendEntries(original.id, other.id, [{ ...entry, id: "other-prior", threadId: other.id }]);
    const reads = vi.spyOn(store, "getEntries");
    let restored: Session | undefined;
    try {
      restored = await new Engine({ providers }).restoreSession({ sessionId: original.id, options });
      expect(restored.listThreads()).toHaveLength(2);
      await restored.refreshCommandRegistry();
      expect(restored.commandRegistry().list().length).toBeGreaterThan(0);
      expect(reads).not.toHaveBeenCalled();
      const contexts: string[] = [];
      faux.setResponses([
        (context) => {
          contexts.push(JSON.stringify(context.messages));
          return fauxAssistantMessage("remembered");
        },
        (context) => {
          contexts.push(JSON.stringify(context.messages));
          return fauxAssistantMessage("again");
        },
      ]);
      const thread = restored.threadById(first.id)!;
      const receipt = await thread.submitPrompt("what color?", {});
      await thread.awaitResult(receipt.queueItemId);
      expect(contexts[0]).toContain("remember the blue house");
      expect(contexts[0]?.match(/what color\?/g)).toHaveLength(1);
      expect(reads.mock.calls.every((args) => args[1] === first.id)).toBe(true);
      const second = await thread.submitPrompt("one more time", {});
      await thread.awaitResult(second.queueItemId);
      expect(contexts[1]).toContain("remembered");
      expect(contexts[1]?.match(/remember the blue house/g)).toHaveLength(1);
    } finally {
      original.suspendTimers();
      restored?.suspendTimers();
      reads.mockRestore();
      faux.unregister();
    }
  });
});
