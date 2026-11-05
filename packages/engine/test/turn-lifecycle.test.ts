import { describe, expect, it, vi } from "vitest";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { Engine, InMemoryEventStream, InMemorySessionStore, VirtualSandboxProvider, type QueueItem } from "../src/index.js";

async function seed(terminalizing: boolean) {
  const store = new InMemorySessionStore();
  const now = Date.now();
  await store.saveSession({ id: "session", owner: { type: "user", id: "owner" }, userId: "owner", orgId: "org", workspace: "/", purpose: "interactive", status: "running", createdAt: now, updatedAt: now });
  await store.saveThread("session", { id: "thread", sessionId: "session", key: "web:default", status: "active", queueMode: "followup", createdAt: now, updatedAt: now });
  const item: QueueItem = { id: "submission", threadId: "thread", content: "Inspect", author: { id: "actor" }, status: "queued", attemptCount: 0, maxAttempts: 10, timeoutAt: now + 60_000, createdAt: now, updatedAt: now };
  await store.admitSubmission("session", "thread", item);
  await store.claimSubmission({ sessionId: "session", threadId: "thread", itemId: item.id, attemptId: "attempt", ownerId: "previous-process" });
  if (terminalizing) await store.reserveSettlement("session", "thread", item.id, { outcome: "completed" }, { itemId: item.id, attemptId: "attempt" });
  else await store.appendEntries("session", "thread", [{ id: "complete", sessionId: "session", threadId: "thread", parentId: null, type: "message", role: "assistant", content: "Done", queueItemId: item.id, stopReason: "end_turn", createdAt: now }]);
  return store;
}

describe("durable turn completion hooks", () => {
  it("keeps settlement pending until cleanup persistence succeeds", async () => {
    const store = await seed(true);
    const provider = new VirtualSandboxProvider();
    const create = vi.spyOn(provider, "create");
    const hook = vi.fn().mockRejectedValueOnce(new Error("cleanup persistence unavailable")).mockResolvedValue(undefined);
    const faux = registerFauxProvider({ provider: "turn-lifecycle-retry" });
    const engine = new Engine({ providers: { store, stream: new InMemoryEventStream(), sandboxProvider: provider } });
    try {
      const session = await engine.restoreSession({ sessionId: "session", options: { userId: "owner", orgId: "org", workspace: "/", sandbox: {}, model: faux.getModel(), onTurnComplete: hook } });
      session.suspendTimers();
      const item = await store.getQueueItem("session", "submission");
      expect(item?.status).toBe("terminalizing");
      if (!item) throw new Error("Expected the pending submission.");
      await expect(session.threadById("thread")?.retryFinalize(item)).resolves.toBe(true);
      expect((await store.getQueueItem("session", "submission"))?.status).toBe("settled");
      expect(create).not.toHaveBeenCalled();
    } finally { faux.unregister(); }
  });

  it.each([true, false])("records recovered completion before finalization without waking compute (terminalizing=%s)", async (terminalizing) => {
    const store = await seed(terminalizing);
    const provider = new VirtualSandboxProvider();
    const create = vi.spyOn(provider, "create");
    const hook = vi.fn(async () => {
      expect((await store.getQueueItem("session", "submission"))?.status).toBe("terminalizing");
    });
    const faux = registerFauxProvider({ provider: `turn-lifecycle-${terminalizing}` });
    const engine = new Engine({ providers: { store, stream: new InMemoryEventStream(), sandboxProvider: provider } });
    try {
      const session = await engine.restoreSession({ sessionId: "session", options: { userId: "owner", orgId: "org", workspace: "/", sandbox: {}, model: faux.getModel(), onTurnComplete: hook } });
      expect(hook).toHaveBeenCalledWith(expect.objectContaining({ submissionId: "submission", threadId: "thread", actorId: "actor", sandbox: undefined }));
      expect(create).not.toHaveBeenCalled();
      expect((await store.getQueueItem("session", "submission"))?.status).toBe("settled");
      session.suspendTimers();
    } finally { faux.unregister(); }
  });
});
