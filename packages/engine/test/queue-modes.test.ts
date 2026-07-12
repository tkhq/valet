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
  type SessionEntry,
  type SubmissionOutcome,
  type WriteFence,
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

describe("queue mode: collect (buffered window)", () => {
  it("merges buffered prompts into one combined prompt", async () => {
    const faux = registerFauxProvider({ provider: "collect-merge" });
    faux.setResponses([fauxAssistantMessage("merged-done")]);

    const { engine, store } = makeEngine();
    const session = await engine.createSession({
      userId: "u1",
      orgId: "o1",
      workspace: "/",
      sandbox: {},
      model: faux.getModel(),
      queueMode: "collect",
      collectWindowMs: 60,
    });

    const r1 = await session.prompt("one");
    const r2 = await session.prompt("two");
    const r3 = await session.prompt("three");

    await waitFor(async () => {
      const items = await Promise.all([
        store.getQueueItem(session.id, r1.queueItemId),
        store.getQueueItem(session.id, r2.queueItemId),
        store.getQueueItem(session.id, r3.queueItemId),
      ]);
      return items.every((i) => i?.status === "settled");
    });

    const [a, b, c] = await Promise.all([
      store.getQueueItem(session.id, r1.queueItemId),
      store.getQueueItem(session.id, r2.queueItemId),
      store.getQueueItem(session.id, r3.queueItemId),
    ]);
    expect(a?.outcome).toEqual({ outcome: "merged" });
    expect(b?.outcome).toEqual({ outcome: "merged" });
    expect(c?.outcome).toEqual({ outcome: "merged" });
    const mergedId = a?.mergedIntoItemId;
    expect(mergedId).toBeDefined();
    expect(b?.mergedIntoItemId).toBe(mergedId);
    expect(c?.mergedIntoItemId).toBe(mergedId);

    await waitFor(async () => (await store.getQueueItem(session.id, mergedId!))?.status === "settled");
    const merged = await store.getQueueItem(session.id, mergedId!);
    expect(merged?.outcome).toEqual({ outcome: "completed" });
    const constituentIds = (merged?.metadata?.collect as { constituentIds: string[] } | undefined)
      ?.constituentIds;
    expect(constituentIds).toEqual([r1.queueItemId, r2.queueItemId, r3.queueItemId]);

    const entries = await session.readEntries("web:default");
    const mergedUser = entries.find(
      (e): e is MessageEntry => e.type === "message" && e.role === "user" && e.queueItemId === mergedId,
    );
    expect(mergedUser?.content).toBe("[1] one\n\n[2] two\n\n[3] three");
    const mergedAssistant = entries.find(
      (e): e is MessageEntry =>
        e.type === "message" && e.role === "assistant" && e.queueItemId === mergedId,
    );
    expect(mergedAssistant?.content).toBe("merged-done");

    faux.unregister();
  });

  it("dispatchId dedup: re-submitting mid-window returns the existing constituent, flush still has 3", async () => {
    const faux = registerFauxProvider({ provider: "collect-dedup" });
    faux.setResponses([fauxAssistantMessage("merged-done")]);

    const { engine, store } = makeEngine();
    const session = await engine.createSession({
      userId: "u1",
      orgId: "o1",
      workspace: "/",
      sandbox: {},
      model: faux.getModel(),
      queueMode: "collect",
      collectWindowMs: 80,
    });

    const r1 = await session.thread().submitPrompt("one", { dispatchId: "d-1" });
    const r2 = await session.thread().submitPrompt("two", {});
    const dup = await session.thread().submitPrompt("one", { dispatchId: "d-1" });
    expect(dup.queueItemId).toBe(r1.queueItemId);
    const r3 = await session.thread().submitPrompt("three", {});

    await waitFor(async () => (await store.getQueueItem(session.id, r1.queueItemId))?.status === "settled");

    const a = await store.getQueueItem(session.id, r1.queueItemId);
    const mergedId = a?.mergedIntoItemId;
    await waitFor(async () => (await store.getQueueItem(session.id, mergedId!))?.status === "settled");
    const merged = await store.getQueueItem(session.id, mergedId!);
    const constituentIds = (merged?.metadata?.collect as { constituentIds: string[] } | undefined)
      ?.constituentIds;
    expect(constituentIds).toEqual([r1.queueItemId, r2.queueItemId, r3.queueItemId]);
    expect(constituentIds).toHaveLength(3);

    faux.unregister();
  });
});

describe("queue mode: steer (abort + new)", () => {
  it("aborts the current turn and starts a new one immediately", async () => {
    const faux = registerFauxProvider({ provider: "steer-mode", tokensPerSecond: 30 });
    const longText = Array.from({ length: 30 }, (_, i) => `word${i}`).join(" ");
    faux.setResponses([fauxAssistantMessage(longText), fauxAssistantMessage("steer-done")]);

    const { engine, store, events } = makeEngine();
    const session = await engine.createSession({
      userId: "u1",
      orgId: "o1",
      workspace: "/",
      sandbox: {},
      model: faux.getModel(),
    });

    const r1 = await session.prompt("original");
    // Wait until the turn is actively streaming before steering, so the
    // interrupt lands mid-turn rather than after a natural completion.
    await waitFor(() => events.some((e) => e.event.type === "text_delta"));

    const r2 = await session.thread().submitPrompt("steer-in", { queueMode: "steer" });

    await waitFor(async () => {
      const items = await Promise.all([
        store.getQueueItem(session.id, r1.queueItemId),
        store.getQueueItem(session.id, r2.queueItemId),
      ]);
      return items.every((i) => i?.status === "settled");
    });

    // Store truth: A superseded pointing at S; S completed.
    const a = await store.getQueueItem(session.id, r1.queueItemId);
    expect(a?.outcome).toEqual({ outcome: "superseded" });
    expect(a?.supersededByItemId).toBe(r2.queueItemId);

    const s = await store.getQueueItem(session.id, r2.queueItemId);
    expect(s?.outcome).toEqual({ outcome: "completed" });

    // A's partial entries remain, persisted under A's own queueItemId — not
    // discarded by the steer.
    const entries = await session.readEntries("web:default");
    const aAssistant = entries.find(
      (e): e is MessageEntry =>
        e.type === "message" && e.role === "assistant" && e.queueItemId === r1.queueItemId,
    );
    expect(aAssistant).toBeDefined();
    expect(aAssistant?.stopReason).toBe("abort");
    expect((aAssistant?.content.length ?? 0) > 0).toBe(true);

    const sAssistant = entries.find(
      (e): e is MessageEntry =>
        e.type === "message" && e.role === "assistant" && e.queueItemId === r2.queueItemId,
    );
    expect(sAssistant?.content).toBe("steer-done");

    faux.unregister();
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

describe("queue: settlement resilience", () => {
  it("a transient finalizeSettlement failure does not wedge the thread or leak a rejection", async () => {
    // Store whose finalizeSettlement throws once (transient I/O, SQLITE_BUSY).
    class FlakyFinalizeStore extends InMemorySessionStore {
      failuresRemaining = 1;
      override async finalizeSettlement(
        sessionId: string,
        threadId: string,
        itemId: string,
        fence: WriteFence,
      ): Promise<void> {
        if (this.failuresRemaining > 0) {
          this.failuresRemaining -= 1;
          throw new Error("SQLITE_BUSY");
        }
        return super.finalizeSettlement(sessionId, threadId, itemId, fence);
      }
    }
    const faux = registerFauxProvider({ provider: "flaky-finalize" });
    faux.setResponses([fauxAssistantMessage("a-done"), fauxAssistantMessage("b-done")]);

    const store = new FlakyFinalizeStore();
    const bus = new InMemoryEventBus();
    const engine = new Engine({
      providers: { store, bus, sandboxProvider: new VirtualSandboxProvider() },
    });
    const session = await engine.createSession({
      userId: "u1",
      orgId: "o1",
      workspace: "/",
      sandbox: {},
      model: faux.getModel(),
    });

    const r1 = await session.prompt("a");
    // The item must eventually settle despite the one-shot finalize failure
    // (retried by the claim loop / sweep once the store recovers), and no
    // unhandled rejection may escape (vitest fails the run on those).
    await waitFor(async () => {
      await session.sweepOnce();
      return (await store.getQueueItem(session.id, r1.queueItemId))?.status === "settled";
    });
    const a = await store.getQueueItem(session.id, r1.queueItemId);
    expect(a?.outcome).toEqual({ outcome: "completed" });

    // Thread stays usable: a subsequent prompt claims and settles normally.
    const r2 = await session.prompt("b");
    await waitFor(async () => {
      await session.sweepOnce();
      return (await store.getQueueItem(session.id, r2.queueItemId))?.status === "settled";
    });
    const b = await store.getQueueItem(session.id, r2.queueItemId);
    expect(b?.outcome).toEqual({ outcome: "completed" });

    faux.unregister();
  });

  it("a turn that throws outside the agent stream settles failed with the error text", async () => {
    // Store whose appendEntries throws once (the turn's first fenced write —
    // the user entry) with a non-stale error: the turn must settle `failed`,
    // not `completed` derived from a stale prior stop reason.
    class DiskFullOnceStore extends InMemorySessionStore {
      failuresRemaining = 1;
      override async appendEntries(
        sessionId: string,
        threadId: string,
        entries: SessionEntry[],
        fence?: WriteFence,
      ): Promise<void> {
        if (this.failuresRemaining > 0 && entries.some((e) => e.type === "message")) {
          this.failuresRemaining -= 1;
          throw new Error("disk full");
        }
        return super.appendEntries(sessionId, threadId, entries, fence);
      }
    }
    const faux = registerFauxProvider({ provider: "turn-throws" });
    faux.setResponses([fauxAssistantMessage("never-used"), fauxAssistantMessage("second-ok")]);

    const store = new DiskFullOnceStore();
    const bus = new InMemoryEventBus();
    const engine = new Engine({
      providers: { store, bus, sandboxProvider: new VirtualSandboxProvider() },
    });
    const session = await engine.createSession({
      userId: "u1",
      orgId: "o1",
      workspace: "/",
      sandbox: {},
      model: faux.getModel(),
    });

    const r1 = await session.prompt("a");
    await waitFor(async () => {
      const item = await store.getQueueItem(session.id, r1.queueItemId);
      return item?.status === "settled";
    });
    const item = await store.getQueueItem(session.id, r1.queueItemId);
    const outcome: SubmissionOutcome | undefined = item?.outcome;
    expect(outcome?.outcome).toBe("failed");
    expect(outcome?.error).toContain("disk full");

    // Thread stays usable afterwards.
    const r2 = await session.prompt("b");
    await waitFor(async () => {
      const it = await store.getQueueItem(session.id, r2.queueItemId);
      return it?.status === "settled";
    });
    expect((await store.getQueueItem(session.id, r2.queueItemId))?.outcome).toEqual({
      outcome: "completed",
    });

    faux.unregister();
  });
});

describe("queue: length-terminated turns", () => {
  it("stopReason 'length' persists as end_turn and settles completed", async () => {
    const faux = registerFauxProvider({ provider: "max-tokens" });
    faux.setResponses([fauxAssistantMessage("truncated but usable", { stopReason: "length" })]);

    const { engine, store } = makeEngine();
    const session = await engine.createSession({
      userId: "u1",
      orgId: "o1",
      workspace: "/",
      sandbox: {},
      model: faux.getModel(),
    });

    const r1 = await session.prompt("go long");
    await waitFor(async () => {
      const item = await store.getQueueItem(session.id, r1.queueItemId);
      return item?.status === "settled";
    });

    const item = await store.getQueueItem(session.id, r1.queueItemId);
    expect(item?.outcome).toEqual({ outcome: "completed" });

    // Task 6 resolves result text from "last assistant entry with stopReason
    // end_turn" — a max-tokens turn must still carry one.
    const entries = await session.readEntries("web:default");
    const lastAssistant = entries
      .filter((e): e is MessageEntry => e.type === "message" && e.role === "assistant")
      .at(-1);
    expect(lastAssistant?.stopReason).toBe("end_turn");
    expect(lastAssistant?.queueItemId).toBe(r1.queueItemId);

    faux.unregister();
  });
});
