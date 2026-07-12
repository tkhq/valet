import { describe, it, expect } from "vitest";
import { fauxAssistantMessage, registerFauxProvider, type FauxResponseStep } from "@mariozechner/pi-ai";
import {
  Engine,
  InMemoryEventBus,
  InMemorySessionStore,
  VirtualSandboxProvider,
  type BusEvent,
  type EngineEvent,
  type MessageEntry,
} from "../src/index.js";

function makeEngine() {
  const store = new InMemorySessionStore();
  const bus = new InMemoryEventBus();
  const sandboxProvider = new VirtualSandboxProvider();
  const events: BusEvent[] = [];
  bus.subscribe({}, (e) => events.push(e));
  const engine = new Engine({ providers: { store, bus, sandboxProvider } });
  return { engine, store, events };
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("queue mode: followup (FIFO)", () => {
  it("processes prompts in order and settles each submission completed", async () => {
    const faux = registerFauxProvider({ provider: "fifo", tokensPerSecond: 50 });
    const responses: FauxResponseStep[] = [
      fauxAssistantMessage("a-done"),
      fauxAssistantMessage("b-done"),
      fauxAssistantMessage("c-done"),
    ];
    faux.setResponses(responses);

    const { engine, store, events } = makeEngine();
    const session = await engine.createSession({
      userId: "u1",
      orgId: "o1",
      workspace: "/",
      sandbox: {},
      model: faux.getModel(),
    });

    const r1 = await session.prompt("a");
    const r2 = await session.prompt("b");
    const r3 = await session.prompt("c");

    // Drain: three turn_ends AND all three submissions settled in the store.
    await waitFor(async () => {
      const items = await Promise.all([
        store.getQueueItem(session.id, r1.queueItemId),
        store.getQueueItem(session.id, r2.queueItemId),
        store.getQueueItem(session.id, r3.queueItemId),
      ]);
      return items.every((i) => i?.status === "settled");
    });

    // Store truth: every submission settled `completed`.
    for (const r of [r1, r2, r3]) {
      const item = await store.getQueueItem(session.id, r.queueItemId);
      expect(item?.status).toBe("settled");
      expect(item?.outcome).toEqual({ outcome: "completed" });
    }

    const entries = await session.readEntries("web:default");
    const userMessages = entries.filter(
      (e): e is MessageEntry => e.type === "message" && e.role === "user",
    );
    expect(userMessages.map((m) => m.content)).toEqual(["a", "b", "c"]);
    // Each user entry is linked to its submission, in order.
    expect(userMessages.map((m) => m.queueItemId)).toEqual([
      r1.queueItemId,
      r2.queueItemId,
      r3.queueItemId,
    ]);

    const assistantMessages = entries.filter(
      (e): e is MessageEntry => e.type === "message" && e.role === "assistant",
    );
    expect(assistantMessages.map((m) => m.content)).toEqual(["a-done", "b-done", "c-done"]);
    // Final assistant entry per turn carries queueItemId + stopReason end_turn.
    expect(assistantMessages.map((m) => m.queueItemId)).toEqual([
      r1.queueItemId,
      r2.queueItemId,
      r3.queueItemId,
    ]);
    expect(assistantMessages.map((m) => m.stopReason)).toEqual([
      "end_turn",
      "end_turn",
      "end_turn",
    ]);

    // The submission_settled EngineEvent fired for each.
    const settled = events.filter((e) => e.event.type === "submission_settled");
    expect(settled).toHaveLength(3);

    faux.unregister();
  });

  it("same dispatchId twice returns the same queueItemId (idempotent admission)", async () => {
    const faux = registerFauxProvider({ provider: "dispatch-dedup", tokensPerSecond: 50 });
    faux.setResponses([fauxAssistantMessage("only-once")]);

    const { engine, store } = makeEngine();
    const session = await engine.createSession({
      userId: "u1",
      orgId: "o1",
      workspace: "/",
      sandbox: {},
      model: faux.getModel(),
    });

    const first = await session.thread().submitPrompt("dedup me", { dispatchId: "d-1" });
    const second = await session.thread().submitPrompt("dedup me", { dispatchId: "d-1" });
    expect(second.queueItemId).toBe(first.queueItemId);

    await waitFor(async () => {
      const item = await store.getQueueItem(session.id, first.queueItemId);
      return item?.status === "settled";
    });

    const entries = await session.readEntries("web:default");
    const userMessages = entries.filter(
      (e): e is MessageEntry => e.type === "message" && e.role === "user",
    );
    // Only one turn ran despite two submits.
    expect(userMessages).toHaveLength(1);

    faux.unregister();
  });
});

// Task 4: collect mode operates on real durable collect windows (merge +
// settleUnclaimed). Until then collect submissions route to plain admission,
// so this behavioral test is deferred.
describe.skip("queue mode: collect (buffered window)", () => {
  it("merges buffered prompts into one combined prompt", async () => {
    // Task 4
  });
});

// Task 4: steer supersession is transactional (admitSubmission steer option +
// settleUnclaimed). Deferred to Task 4.
describe.skip("queue mode: steer (abort + new)", () => {
  it("aborts the current turn and starts a new one immediately", async () => {
    // Task 4
  });
});

describe("queue: pause + resume", () => {
  it("paused thread keeps the submission queued until resumed, then settles it", async () => {
    const faux = registerFauxProvider({ provider: "pause-resume" });
    faux.setResponses([
      fauxAssistantMessage("first-done"),
      fauxAssistantMessage("second-done"),
    ]);

    const { engine, store, events } = makeEngine();
    const session = await engine.createSession({
      userId: "u1",
      orgId: "o1",
      workspace: "/",
      sandbox: {},
      model: faux.getModel(),
    });

    const r1 = await session.prompt("first");
    await waitFor(async () => {
      const item = await store.getQueueItem(session.id, r1.queueItemId);
      return item?.status === "settled";
    });
    const turnEndsBefore = events.filter((e) => e.event.type === "turn_end").length;

    await session.pause();
    const r2 = await session.thread().submitPrompt("second", {});

    // Give it a beat — the paused thread must NOT claim/run the second item.
    await new Promise((r) => setTimeout(r, 50));
    expect(events.filter((e) => e.event.type === "turn_end").length).toBe(turnEndsBefore);
    const whilePaused = await store.getQueueItem(session.id, r2.queueItemId);
    expect(whilePaused?.status).toBe("queued");

    await session.resume();
    await waitFor(async () => {
      const item = await store.getQueueItem(session.id, r2.queueItemId);
      return item?.status === "settled";
    });

    const entries = await session.readEntries("web:default");
    const assistants = entries.filter(
      (e): e is MessageEntry => e.type === "message" && e.role === "assistant",
    );
    expect(assistants.map((m) => m.content)).toEqual(["first-done", "second-done"]);
    const secondItem = await store.getQueueItem(session.id, r2.queueItemId);
    expect(secondItem?.outcome).toEqual({ outcome: "completed" });

    faux.unregister();
  });
});

describe("queue: abort", () => {
  it("aborts a queued (not-yet-claimed) submission via settleUnclaimed", async () => {
    const faux = registerFauxProvider({ provider: "abort-queued" });
    faux.setResponses([fauxAssistantMessage("first-done"), fauxAssistantMessage("second-done")]);

    const { engine, store } = makeEngine();
    const session = await engine.createSession({
      userId: "u1",
      orgId: "o1",
      workspace: "/",
      sandbox: {},
      model: faux.getModel(),
    });

    // Pause so the second submission stays queued, then abort it.
    const r1 = await session.prompt("first");
    await waitFor(async () => (await store.getQueueItem(session.id, r1.queueItemId))?.status === "settled");
    await session.pause();
    const r2 = await session.thread().submitPrompt("second", {});
    expect((await store.getQueueItem(session.id, r2.queueItemId))?.status).toBe("queued");

    await session.abort();
    const aborted = await store.getQueueItem(session.id, r2.queueItemId);
    expect(aborted?.status).toBe("settled");
    expect(aborted?.outcome).toEqual({ outcome: "aborted" });

    faux.unregister();
  });
});
