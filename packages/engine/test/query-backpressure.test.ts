import { describe, expect, it, vi } from "vitest";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import {
  Engine, InMemoryEventStream, InMemorySessionStore, VirtualSandboxProvider,
  type QueueItem,
} from "../src/index.js";

async function fixture() {
  const faux = registerFauxProvider({ provider: "query-backpressure" });
  const store = new InMemorySessionStore();
  const session = await new Engine({ providers: {
    store, stream: new InMemoryEventStream(), sandboxProvider: new VirtualSandboxProvider(),
  } }).createSession({ userId: "u", orgId: "o", workspace: "/", sandbox: {}, model: faux.getModel() });
  const thread = await session.ensureDefaultThread();
  const item: QueueItem = {
    id: "waiting", threadId: thread.id, content: "pending", status: "queued",
    attemptCount: 0, maxAttempts: 10, createdAt: Date.now(), updatedAt: Date.now(),
    timeoutAt: Date.now() + 60_000,
  };
  return { store, session, thread, item, cleanup: () => { session.suspendTimers(); faux.unregister(); } };
}

describe("database backpressure", () => {
  it("bounds slow result reads and still observes settlement without an event", async () => {
    const f = await fixture();
    await f.store.admitSubmission(f.session.id, f.thread.id, f.item);
    const read = f.store.getQueueItem.bind(f.store);
    let active = 0;
    let peak = 0;
    const reads = vi.spyOn(f.store, "getQueueItem").mockImplementation(async (...args) => {
      active++;
      peak = Math.max(peak, active);
      const snapshot = await read(...args);
      await new Promise((resolve) => setTimeout(resolve, 300));
      active--;
      return snapshot;
    });
    vi.useFakeTimers();
    try {
      const pending = f.thread.awaitResult(f.item.id);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(peak).toBe(1);
      expect(reads.mock.calls.length).toBeLessThanOrEqual(6);
      await f.store.settleUnclaimed(f.session.id, f.thread.id, f.item.id, { outcome: "superseded" });
      await vi.advanceTimersByTimeAsync(2_000);
      expect((await pending).outcome).toBe("superseded");
      const completedReads = reads.mock.calls.length;
      await vi.advanceTimersByTimeAsync(10_000);
      expect(reads).toHaveBeenCalledTimes(completedReads);
    } finally {
      vi.useRealTimers();
      reads.mockRestore();
      f.cleanup();
    }
  });

  it("recovers from a failed fallback read and stops polling after cancellation", async () => {
    const f = await fixture();
    await f.store.admitSubmission(f.session.id, f.thread.id, f.item);
    const read = f.store.getQueueItem.bind(f.store);
    const reads = vi.spyOn(f.store, "getQueueItem")
      .mockImplementationOnce(read)
      .mockRejectedValueOnce(new Error("temporary database failure"));
    const controller = new AbortController();
    vi.useFakeTimers();
    try {
      const pending = f.thread.awaitResult(f.item.id, { signal: controller.signal });
      const rejected = expect(pending).rejects.toThrow("aborted");
      await vi.advanceTimersByTimeAsync(2_000);
      expect(reads.mock.calls.length).toBeGreaterThanOrEqual(3);
      controller.abort();
      await rejected;
      const count = reads.mock.calls.length;
      await vi.advanceTimersByTimeAsync(10_000);
      expect(reads).toHaveBeenCalledTimes(count);
      expect((await read(f.session.id, f.item.id))?.status).toBe("queued");
    } finally {
      vi.useRealTimers();
      reads.mockRestore();
      f.cleanup();
    }
  });

  it("reads idle session state once regardless of historical thread count", async () => {
    const f = await fixture();
    for (let i = 0; i < 250; i++) f.session.thread(`history:${i}`);
    const submissions = vi.spyOn(f.store, "listUnsettledSubmissions");
    const gates = vi.spyOn(f.store, "listDecisionGates");
    try {
      await f.session.sweepOnce();
      expect(submissions).toHaveBeenCalledTimes(1);
      expect(gates).toHaveBeenCalledExactlyOnceWith(f.session.id, undefined, "pending");
    } finally {
      submissions.mockRestore();
      gates.mockRestore();
      f.cleanup();
    }
  });

  it("joins a slow sweep instead of stacking passes, then permits another pass", async () => {
    const f = await fixture();
    let release = () => {};
    const blocked = new Promise<QueueItem[]>((resolve) => { release = () => resolve([]); });
    const submissions = vi.spyOn(f.store, "listUnsettledSubmissions").mockReturnValueOnce(blocked);
    vi.useFakeTimers();
    try {
      f.session.ensureTimers();
      await vi.advanceTimersByTimeAsync(20_000);
      expect(submissions).toHaveBeenCalledTimes(1);
      const first = f.session.sweepOnce();
      expect(f.session.sweepOnce()).toBe(first);
      release();
      await first;
      await vi.advanceTimersByTimeAsync(5_000);
      expect(submissions).toHaveBeenCalledTimes(2);
    } finally {
      release();
      f.cleanup();
      vi.useRealTimers();
      submissions.mockRestore();
    }
  });

  it("does not wait for a model drive before sweeping other threads again", async () => {
    const f = await fixture();
    await f.store.admitSubmission(f.session.id, f.thread.id, f.item);
    let release = () => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    const kick = vi.spyOn(f.thread, "kick").mockReturnValue(held);
    const submissions = vi.spyOn(f.store, "listUnsettledSubmissions");
    try {
      await f.session.sweepOnce();
      await f.session.sweepOnce();
      expect(kick).toHaveBeenCalledTimes(2);
      expect(submissions).toHaveBeenCalledTimes(2);
    } finally {
      release();
      kick.mockRestore();
      submissions.mockRestore();
      f.cleanup();
    }
  });

  it("reconciles idle history with a constant number of submission reads", async () => {
    const f = await fixture();
    for (let i = 0; i < 250; i++) f.session.thread(`history:${i}`);
    const reads = vi.spyOn(f.store, "listUnsettledSubmissions");
    try {
      await f.session.reconcile();
      expect(reads).toHaveBeenCalledTimes(3);
    } finally {
      reads.mockRestore();
      f.cleanup();
    }
  });

  it("does not stack lease renewals while the store is slow", async () => {
    const f = await fixture();
    const running = vi.spyOn(f.thread, "runningItemId").mockReturnValue(f.item.id);
    let release = () => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    const renew = vi.spyOn(f.store, "renewLeases").mockImplementationOnce(async () => { await held; });
    try {
      const first = f.session.heartbeatOnce();
      expect(f.session.heartbeatOnce()).toBe(first);
      expect(renew).toHaveBeenCalledTimes(1);
      release();
      await first;
      await f.session.heartbeatOnce();
      expect(renew).toHaveBeenCalledTimes(2);
    } finally {
      release();
      renew.mockRestore();
      running.mockRestore();
      f.cleanup();
    }
  });
});
