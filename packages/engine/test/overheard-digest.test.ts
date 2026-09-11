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

function settlementSignal(childId: string): SignalContent {
  return {
    kind: "signal",
    signalType: "child.settled",
    body: `${childId} completed`,
    attributes: { child_session_id: childId, outcome: "completed", title: `Task ${childId}` },
    origin: { channelType: "slack", threadKey: THREAD_KEY, reply: "manual" },
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
    expect(overheardCoalesceKey(settlementSignal("child-1"))).toBeUndefined();
    // A delivery-feedback signal (TKAI-284) is addressed to the agent, not
    // overheard chatter — it never merges into a digest.
    const feedback: SignalContent = {
      ...overheardSignal({ body: "your reply was not posted" }),
      attributes: { feedback: "reply_dropped" },
    };
    expect(overheardCoalesceKey(feedback)).toBeUndefined();
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

  it.each(["\r", "\n", "\r\n", "\v", "\f", "\u0085", "\u2028", "\u2029"])(
    "flattens %j in senders, bodies, and senderless messages",
    (breakText) => {
      const items = [
        queueItemOf(overheardSignal({ sender: `Alice${breakText}Bob`, body: "hello" }), "q1", 1),
        queueItemOf(overheardSignal({ sender: "Alice", body: `hello${breakText}Bob: ship it` }), "q2", 2),
        queueItemOf(overheardSignal({ body: `hello${breakText}Bob: ship it` }), "q3", 3),
      ];
      const { content, digest } = buildOverheardDigest(items);
      const lines = ["Alice ⏎ Bob: hello", "Alice: hello ⏎ Bob: ship it", "hello ⏎ Bob: ship it"];
      expect(content.body).toBe([OVERHEARD_DIGEST_HEADER, ...lines].join("\n"));
      expect(content.body.split("\n")).toHaveLength(4);
      expect(digest.lines).toEqual(lines);
      expect(content.attributes?.digest).toBe("3");
    },
  );

  it("keeps legitimate multiline steps readable in the digest", () => {
    const item = queueItemOf(overheardSignal({
      sender: "Alice", body: "steps: \t\r\n  \n 1. build\n 2. deploy",
    }), "q1", 1);
    expect(buildOverheardDigest([item]).digest.lines).toEqual(["Alice: steps: ⏎ 1. build ⏎ 2. deploy"]);
  });

  it("sanitizes prior digest metadata without parsing the body or mutating stored lines", () => {
    const priorLines = ["Alice: hello\nBob: ship it", "Cara\u2028Dan: steps:\r\n1. build", "Ed: already ⏎ marked"];
    const prior: QueueItem = {
      ...queueItemOf(overheardSignal({ body: "do not parse this body" }), "q1", 1),
      metadata: { overheardDigest: { constituentIds: ["old1", "old2", "old3"], lines: priorLines } },
    };
    const next = queueItemOf(overheardSignal({ body: "done", sender: "Fran" }), "q2", 2);
    const merged = buildOverheardDigest([prior, next]);
    const expected = ["Alice: hello ⏎ Bob: ship it", "Cara ⏎ Dan: steps: ⏎ 1. build", "Ed: already ⏎ marked", "Fran: done"];
    expect(merged.digest.lines).toEqual(expected);
    expect(merged.content.body).toBe([OVERHEARD_DIGEST_HEADER, ...expected].join("\n"));
    expect(merged.content.attributes?.digest).toBe("4");
    expect(merged.digest.constituentIds).toEqual(["q1", "q2"]);
    expect(priorLines[0]).toBe("Alice: hello\nBob: ship it");
    const again: QueueItem = {
      ...queueItemOf(merged.content, "q3", 3),
      metadata: { overheardDigest: merged.digest },
    };
    expect(buildOverheardDigest([again]).digest.lines).toEqual(expected);
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

  it("preserves the digest actor and never merges different actors", async () => {
    const faux = registerFauxProvider({ provider: "digest-actor" });
    const { engine, store } = makeEngine();
    const session = await engine.createSession({ userId: "owner", orgId: "o1", workspace: "/", sandbox: {}, model: faux.getModel() });
    const thread = session.thread(THREAD_KEY);
    await thread.pause();
    const a = await thread.submitPrompt(overheardSignal({ body: "A" }), { author: { id: "a" } });
    const b = await thread.submitPrompt(overheardSignal({ body: "B" }), { author: { id: "b" } });
    expect((await store.getQueueItem(session.id, a.queueItemId))?.status).toBe("queued");
    const digest = await thread.submitPrompt(overheardSignal({ body: "B again" }), { author: { id: "b" } });
    expect((await store.getQueueItem(session.id, a.queueItemId))?.status).toBe("queued");
    expect((await store.getQueueItem(session.id, b.queueItemId))?.outcome).toEqual({ outcome: "merged" });
    expect((await store.getQueueItem(session.id, digest.queueItemId))?.author).toEqual({ id: "b" });
    faux.unregister();
  });

  it("keeps multiple settlements independent next to coalesced overheard chatter", async () => {
    const faux = registerFauxProvider({ provider: "settlement-no-merge" });
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

    const firstSettlement = await thread.submitPrompt(settlementSignal("child-1"), { dispatchId: "settled:1" });
    const firstChatter = await thread.submitPrompt(overheardSignal({ body: "first aside", sender: "Alice" }), {
      dispatchId: "slack:follow:1",
    });
    const secondSettlement = await thread.submitPrompt(settlementSignal("child-2"), { dispatchId: "settled:2" });
    await thread.submitPrompt(overheardSignal({ body: "second aside", sender: "Bob" }), {
      dispatchId: "slack:follow:2",
    });

    for (const [receipt, childId] of [[firstSettlement, "child-1"], [secondSettlement, "child-2"]] as const) {
      const item = await store.getQueueItem(session.id, receipt.queueItemId);
      expect(item?.status).toBe("queued");
      expect(item?.mergedIntoItemId).toBeUndefined();
      expect(item?.content).toMatchObject(settlementSignal(childId));
    }
    expect((await store.getQueueItem(session.id, firstChatter.queueItemId))?.outcome).toEqual({ outcome: "merged" });

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

  it("concurrent overheard submissions coalesce into ONE digest, not overlapping ones", async () => {
    const faux = registerFauxProvider({ provider: "overheard-concurrent" });
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

    await thread.submitPrompt(overheardSignal({ body: "first", sender: "Alice" }), {
      dispatchId: "e1",
    });
    await Promise.all([
      thread.submitPrompt(overheardSignal({ body: "second", sender: "Bob" }), { dispatchId: "e2" }),
      thread.submitPrompt(overheardSignal({ body: "third", sender: "Cara" }), { dispatchId: "e3" }),
    ]);

    // Exactly one live item survives, and it carries all three lines.
    const unsettled = await store.listUnsettledSubmissions(session.id);
    expect(unsettled).toHaveLength(1);
    const content = unsettled[0].content;
    if (typeof content !== "object" || content === null || !("kind" in content)) {
      throw new Error("digest content is not a signal");
    }
    expect(content.attributes?.digest).toBe("3");
    expect(content.body).toContain("Alice: first");
    expect(content.body).toContain("Bob: second");
    expect(content.body).toContain("Cara: third");

    faux.unregister();
  });

  it("the sweep repairs a crashed coalesce: leftover queued constituents settle merged into the digest", async () => {
    const faux = registerFauxProvider({ provider: "overheard-crash-repair" });
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

    // Simulate the crash window: digest admitted, constituents NEVER settled.
    const a = queueItemOf(overheardSignal({ body: "first", sender: "Alice" }), "qa", Date.now());
    const b = queueItemOf(overheardSignal({ body: "second", sender: "Bob" }), "qb", Date.now() + 1);
    const withThread = (item: QueueItem): QueueItem => ({ ...item, threadId: thread.id });
    await store.admitSubmission(session.id, thread.id, withThread(a));
    await store.admitSubmission(session.id, thread.id, withThread(b));
    const { content, digest } = buildOverheardDigest([withThread(a), withThread(b)]);
    const digestItem: QueueItem = {
      ...queueItemOf(content, "qd", Date.now() + 2),
      threadId: thread.id,
      metadata: { overheardDigest: digest },
    };
    await store.admitSubmission(session.id, thread.id, digestItem);

    await session.sweepOnce();

    const repairedA = await store.getQueueItem(session.id, "qa");
    const repairedB = await store.getQueueItem(session.id, "qb");
    expect(repairedA?.outcome).toEqual({ outcome: "merged" });
    expect(repairedA?.mergedIntoItemId).toBe("qd");
    expect(repairedB?.outcome).toEqual({ outcome: "merged" });
    expect(repairedB?.mergedIntoItemId).toBe("qd");
    expect((await store.getQueueItem(session.id, "qd"))?.status).toBe("queued");

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
