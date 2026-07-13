import { InMemoryEventStream, InMemorySessionStore } from "../src/index.js";
import { runEventStreamContract } from "../src/test-helpers/index.js";
import type { QueueItem } from "../src/index.js";

// The contract suite calls ctx.factory() once at the top of every `it`, so a
// fresh store/stream pair is created per test; `seed` (invoked immediately
// after within the same test) closes over the store created by the most
// recent factory() call.
let currentStore: InMemorySessionStore | undefined;

const SESSION = "fence-sess";
const THREAD = "fence-thread";

runEventStreamContract("InMemoryEventStream", {
  factory: () => {
    const store = new InMemorySessionStore();
    currentStore = store;
    return new InMemoryEventStream({
      fenceCheck: (fence) => store.isCurrentAttempt(fence.itemId, fence.attemptId),
    });
  },
  fenceFixture: {
    seed: async (itemId: string) => {
      const store = currentStore;
      if (!store) throw new Error("fenceFixture.seed called before factory()");
      const now = Date.now();
      await store.saveSession({
        id: SESSION,
        owner: { type: "user", id: "u1" },
        userId: "u1",
        orgId: "o1",
        workspace: "/",
        purpose: "interactive",
        status: "running",
        createdAt: now,
        updatedAt: now,
      });
      await store.saveThread(SESSION, {
        id: THREAD,
        sessionId: SESSION,
        key: "web:default",
        status: "active",
        queueMode: "followup",
        createdAt: now,
        updatedAt: now,
      });
      const admitItem: QueueItem = {
        id: itemId,
        threadId: THREAD,
        content: "seed submission",
        status: "queued",
        attemptCount: 0,
        maxAttempts: 10,
        timeoutAt: now + 3_600_000,
        createdAt: now,
        updatedAt: now,
      };
      await store.admitSubmission(SESSION, THREAD, admitItem);
      const attemptId = `att-${itemId}`;
      const claimed = await store.claimSubmission({
        sessionId: SESSION,
        threadId: THREAD,
        itemId,
        attemptId,
        ownerId: "owner-1",
      });
      if (!claimed) throw new Error("fenceFixture.seed: claim failed");
      return { currentAttemptId: attemptId };
    },
  },
});
