import { describe, it, expect } from "vitest";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import {
  Engine,
  InMemoryEventStream,
  InMemorySessionStore,
  VirtualSandboxProvider,
  type MessageEntry,
  type QueueItem,
  type SignalContent,
} from "../src/index.js";
import {
  buildOverheardDigest,
  OVERHEARD_DIGEST_HEADER,
  overheardCoalesceKey,
} from "../src/submission.js";

const THREAD_KEY = "slack:C1:100.1";

function overheardSignal(fields: { body: string; sender?: string; messageTs?: string }): SignalContent {
  const attributes: Record<string, string> = { channel: "C1" };
  if (fields.sender) attributes.sender = fields.sender;
  return {
    kind: "signal",
    signalType: "slack.message",
    body: fields.body,
    attributes,
    origin: {
      channelType: "slack",
      threadKey: THREAD_KEY,
      reply: "manual",
      messageTs: fields.messageTs ?? "100.2",
    },
  };
}

function queueItemOf(content: SignalContent, id: string, createdAt: number): QueueItem {
  return {
    id,
    threadId: "t1",
    content,
    status: "queued",
    attemptCount: 0,
    maxAttempts: 10,
    timeoutAt: createdAt + 3_600_000,
    createdAt,
    updatedAt: createdAt,
  };
}

describe("overheard digest: pure helpers", () => {
  it("overheardCoalesceKey keys only manual-reply signals by origin threadKey", () => {
    expect(overheardCoalesceKey(overheardSignal({ body: "hi" }))).toBe(THREAD_KEY);
    expect(overheardCoalesceKey("plain prompt")).toBeUndefined();
    expect(overheardCoalesceKey({ text: "prompt object" })).toBeUndefined();
    const addressed: SignalContent = {
      ...overheardSignal({ body: "hi" }),
      origin: { channelType: "slack", threadKey: THREAD_KEY, reply: "auto" },
    };
    expect(overheardCoalesceKey(addressed)).toBeUndefined();
    const originless: SignalContent = { kind: "signal", signalType: "timer.fired", body: "tick" };
    expect(overheardCoalesceKey(originless)).toBeUndefined();
  });

  it("buildOverheardDigest renders one 'Name: message' line per item under the header", () => {
    const a = queueItemOf(overheardSignal({ body: "first", sender: "Alice" }), "q1", 1);
    const b = queueItemOf(overheardSignal({ body: "second", sender: "Bob", messageTs: "100.3" }), "q2", 2);
    const { content, digest } = buildOverheardDigest([a, b]);
    expect(content.body).toBe(`${OVERHEARD_DIGEST_HEADER}\nAlice: first\nBob: second`);
    expect(content.attributes).toEqual({ channel: "C1", digest: "2" });
    expect(content.origin?.messageTs).toBe("100.3");
    expect(content.origin?.reply).toBe("manual");
    expect(digest).toEqual({ constituentIds: ["q1", "q2"], lines: ["Alice: first", "Bob: second"] });
  });

  it("a senderless message contributes its bare body line", () => {
    const a = queueItemOf(overheardSignal({ body: "no name here" }), "q1", 1);
    const b = queueItemOf(overheardSignal({ body: "named", sender: "Cara" }), "q2", 2);
    const { content } = buildOverheardDigest([a, b]);
    expect(content.body).toBe(`${OVERHEARD_DIGEST_HEADER}\nno name here\nCara: named`);
  });

  it("re-merging a digest item reuses its stored lines instead of nesting headers", () => {
    const a = queueItemOf(overheardSignal({ body: "first", sender: "Alice" }), "q1", 1);
    const b = queueItemOf(overheardSignal({ body: "second", sender: "Bob" }), "q2", 2);
    const first = buildOverheardDigest([a, b]);
    const digestItem: QueueItem = {
      ...queueItemOf(first.content, "q3", 3),
      metadata: { overheardDigest: first.digest },
    };
    const c = queueItemOf(overheardSignal({ body: "third", sender: "Cara" }), "q4", 4);
    const second = buildOverheardDigest([digestItem, c]);
    expect(second.content.body).toBe(
      `${OVERHEARD_DIGEST_HEADER}\nAlice: first\nBob: second\nCara: third`,
    );
    expect(second.content.attributes?.digest).toBe("3");
    expect(second.digest.constituentIds).toEqual(["q3", "q4"]);
  });
});

function makeEngine() {
  const store = new InMemorySessionStore();
  const bus = new InMemoryEventStream();
  const engine = new Engine({
    providers: { store, stream: bus, sandboxProvider: new VirtualSandboxProvider() },
  });
  return { engine, store };
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("overheard digest: queue coalescing", () => {
  it("coalesces queued overheard messages from one origin thread into a single digest turn", async () => {
    const faux = registerFauxProvider({ provider: "overheard-merge" });
    faux.setResponses([fauxAssistantMessage("digest-done")]);

    const { engine, store } = makeEngine();
    const session = await engine.createSession({
      userId: "u1",
      orgId: "o1",
      workspace: "/",
      sandbox: {},
      model: faux.getModel(),
    });

    // A paused thread models "busy": overheard messages stay queued.
    // (Pause the thread AFTER creating it — session.pause() only reaches
    // threads that already exist.)
    const thread = session.thread(THREAD_KEY);
    await thread.pause();
    const r1 = await thread.submitPrompt(overheardSignal({ body: "could it be my workflow?", sender: "Alice" }), {
      dispatchId: "slack:follow:e1",
    });
    const r2 = await thread.submitPrompt(
      overheardSignal({ body: "nah just a bug", sender: "Conner", messageTs: "100.9" }),
      { dispatchId: "slack:follow:e2" },
    );

    // Both constituents settled `merged` into the digest the second receipt names.
    expect(r2.queueItemId).not.toBe(r1.queueItemId);
    const a = await store.getQueueItem(session.id, r1.queueItemId);
    expect(a?.outcome).toEqual({ outcome: "merged" });
    const digestId = a?.mergedIntoItemId;
    expect(digestId).toBeDefined();
    expect(r2.queueItemId).toBe(digestId);

    const digestItem = await store.getQueueItem(session.id, digestId!);
    expect(digestItem?.status).toBe("queued");
    const content = digestItem?.content;
    if (typeof content !== "object" || content === null || !("kind" in content)) {
      throw new Error("digest content is not a signal");
    }
    expect(content.body).toBe(
      `${OVERHEARD_DIGEST_HEADER}\nAlice: could it be my workflow?\nConner: nah just a bug`,
    );
    expect(content.attributes).toEqual({ channel: "C1", digest: "2" });
    expect(content.origin?.messageTs).toBe("100.9");

    // A third overheard message re-merges the queued digest.
    const r3 = await thread.submitPrompt(
      overheardSignal({ body: "confirmed, TKAI-296", sender: "Keisha", messageTs: "101.0" }),
      { dispatchId: "slack:follow:e3" },
    );
    const digest1 = await store.getQueueItem(session.id, digestId!);
    expect(digest1?.outcome).toEqual({ outcome: "merged" });
    expect(digest1?.mergedIntoItemId).toBe(r3.queueItemId);

    // One digest turn runs; the constituents never write user entries.
    await thread.resume();
    await waitFor(async () => (await store.getQueueItem(session.id, r3.queueItemId))?.status === "settled");
    expect((await store.getQueueItem(session.id, r3.queueItemId))?.outcome).toEqual({
      outcome: "completed",
    });
    const entries = await session.readEntries(THREAD_KEY);
    const userMessages = entries.filter(
      (e): e is MessageEntry => e.type === "message" && e.role === "user",
    );
    expect(userMessages).toHaveLength(1);
    expect(userMessages[0].content).toBe(
      `${OVERHEARD_DIGEST_HEADER}\nAlice: could it be my workflow?\nConner: nah just a bug\nKeisha: confirmed, TKAI-296`,
    );
    expect(userMessages[0].signal?.attributes?.digest).toBe("3");

    faux.unregister();
  });

  it("does not coalesce addressed signals or overheard signals from another origin thread", async () => {
    const faux = registerFauxProvider({ provider: "overheard-no-merge" });
    faux.setResponses([]);

    const { engine, store } = makeEngine();
    const session = await engine.createSession({
      userId: "u1",
      orgId: "o1",
      workspace: "/",
      sandbox: {},
      model: faux.getModel(),
    });
    const thread = session.thread(THREAD_KEY);
    await thread.pause();

    const overheard = await thread.submitPrompt(overheardSignal({ body: "ambient", sender: "Alice" }), {
      dispatchId: "e1",
    });
    const addressed: SignalContent = {
      kind: "signal",
      signalType: "slack.message",
      body: "hey bot, do the thing",
      attributes: { channel: "C1", sender: "Bob" },
      origin: { channelType: "slack", threadKey: THREAD_KEY, reply: "auto", messageTs: "100.5" },
    };
    const addressedReceipt = await thread.submitPrompt(addressed, { dispatchId: "e2" });
    const otherThread: SignalContent = {
      ...overheardSignal({ body: "different thread", sender: "Cara" }),
      origin: { channelType: "slack", threadKey: "slack:C1:999.9", reply: "manual", messageTs: "999.10" },
    };
    const otherReceipt = await thread.submitPrompt(otherThread, { dispatchId: "e3" });

    // All three still queued individually — nothing merged.
    for (const r of [overheard, addressedReceipt, otherReceipt]) {
      const item = await store.getQueueItem(session.id, r.queueItemId);
      expect(item?.status).toBe("queued");
      expect(item?.mergedIntoItemId).toBeUndefined();
    }

    faux.unregister();
  });

  it("a dispatchId redelivery after coalescing dedups against the merged constituent and does not re-digest", async () => {
    const faux = registerFauxProvider({ provider: "overheard-redelivery" });
    faux.setResponses([]);

    const { engine, store } = makeEngine();
    const session = await engine.createSession({
      userId: "u1",
      orgId: "o1",
      workspace: "/",
      sandbox: {},
      model: faux.getModel(),
    });
    const thread = session.thread(THREAD_KEY);
    await thread.pause();

    const first = overheardSignal({ body: "first", sender: "Alice" });
    const r1 = await thread.submitPrompt(first, { dispatchId: "e1" });
    const r2 = await thread.submitPrompt(overheardSignal({ body: "second", sender: "Bob" }), {
      dispatchId: "e2",
    });

    const redelivered = await thread.submitPrompt(first, { dispatchId: "e1" });
    expect(redelivered.queueItemId).toBe(r1.queueItemId);

    // Still exactly one live item: the digest.
    const unsettled = await store.listUnsettledSubmissions(session.id);
    expect(unsettled.map((i) => i.id)).toEqual([r2.queueItemId]);

    faux.unregister();
  });
});
