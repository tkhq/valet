import { describe, it, expect } from "vitest";
import { fauxAssistantMessage, registerFauxProvider } from "@mariozechner/pi-ai";
import type { Context } from "@mariozechner/pi-ai";
import {
  Engine,
  InMemoryEventStream,
  InMemorySessionStore,
  VirtualSandboxProvider,
  ValidationError,
  PendingCapError,
  renderSignalEnvelope,
  type BusEvent,
  type MessageEntry,
  type SignalContent,
} from "../src/index.js";

function makeEngine() {
  const store = new InMemorySessionStore();
  const bus = new InMemoryEventStream();
  const sandboxProvider = new VirtualSandboxProvider();
  const events: BusEvent[] = [];
  bus.subscribe({}, (e) => events.push(e));
  const engine = new Engine({ providers: { store, stream: bus, sandboxProvider } });
  return { engine, store, events };
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 5));
  }
}

async function waitForStatus(
  events: BusEvent[],
  threadId: string,
  status: string,
  timeoutMs = 2000,
  fromIndex = 0,
): Promise<void> {
  await waitFor(
    () =>
      events
        .slice(fromIndex)
        .some(
          (e) => e.event.type === "status" && e.event.threadId === threadId && e.event.status === status,
        ),
    timeoutMs,
  );
}

function userMessageText(context: Context): string {
  const last = context.messages[context.messages.length - 1];
  if (!last || last.role !== "user") throw new Error("expected a user message");
  if (typeof last.content === "string") return last.content;
  const textBlock = last.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") throw new Error("expected a text block");
  return textBlock.text;
}

describe("SignalContent admission", () => {
  it("persists a user entry with raw body + signal metadata, and the model sees the escaped XML envelope", async () => {
    const faux = registerFauxProvider({ provider: "sig1" });
    const captured: Context[] = [];
    faux.setResponses([
      async (context: Context) => {
        captured.push(context);
        return fauxAssistantMessage("ack");
      },
    ]);

    const { engine, events } = makeEngine();
    const session = await engine.createSession({
      userId: "u1",
      orgId: "o1",
      workspace: "/",
      sandbox: {},
      model: faux.getModel(),
    });

    const content: SignalContent = {
      kind: "signal",
      signalType: "slack.message",
      body: `<b>hi</b> & "quote" 'apos'`,
      attributes: { sender: "alice & bob", channel: "C1" },
    };
    const receipt = await session.prompt(content);
    await waitForStatus(events, receipt.threadId, "idle");

    const entries = await session.readEntries("web:default");
    const userEntry = entries.find((e) => e.type === "message" && e.role === "user") as
      | MessageEntry
      | undefined;
    expect(userEntry).toBeDefined();
    expect(userEntry?.content).toBe(content.body); // raw, unescaped body
    expect(userEntry?.signal).toMatchObject({
      signalType: "slack.message",
      tagName: "signal", // default
      attributes: { sender: "alice & bob", channel: "C1" },
    });

    const expectedXml = renderSignalEnvelope(userEntry!.signal!, userEntry!.content);
    expect(expectedXml).toBe(
      `<signal signalType="slack.message" channel="C1" sender="alice &amp; bob">&lt;b&gt;hi&lt;/b&gt; &amp; &quot;quote&quot; &apos;apos&apos;</signal>`,
    );
    expect(userMessageText(captured[0])).toBe(expectedXml);

    faux.unregister();
  });

  it("renders with a custom tagName", async () => {
    const faux = registerFauxProvider({ provider: "sig2" });
    faux.setResponses([fauxAssistantMessage("ack")]);
    const { engine, events } = makeEngine();
    const session = await engine.createSession({
      userId: "u1",
      orgId: "o1",
      workspace: "/",
      sandbox: {},
      model: faux.getModel(),
    });

    const receipt = await session.prompt({
      kind: "signal",
      signalType: "github.issue_comment",
      body: "plain body",
      tagName: "gh_event",
    } satisfies SignalContent);
    await waitForStatus(events, receipt.threadId, "idle");

    const entries = await session.readEntries("web:default");
    const userEntry = entries.find((e) => e.type === "message" && e.role === "user") as MessageEntry;
    expect(userEntry.signal?.tagName).toBe("gh_event");
    expect(renderSignalEnvelope(userEntry.signal!, userEntry.content)).toBe(
      `<gh_event signalType="github.issue_comment">plain body</gh_event>`,
    );

    faux.unregister();
  });

  it("rejects an invalid tagName at admission", async () => {
    const faux = registerFauxProvider({ provider: "sig3" });
    faux.setResponses([fauxAssistantMessage("unused")]);
    const { engine } = makeEngine();
    const session = await engine.createSession({
      userId: "u1",
      orgId: "o1",
      workspace: "/",
      sandbox: {},
      model: faux.getModel(),
    });

    await expect(
      session.prompt({
        kind: "signal",
        signalType: "x",
        body: "y",
        tagName: "1-bad-start",
      } satisfies SignalContent),
    ).rejects.toThrow(ValidationError);

    faux.unregister();
  });

  it("internalSender stamps sender/owner, sets hopCount, and namespaces dispatchId per sender", async () => {
    const faux = registerFauxProvider({ provider: "sig4" });
    faux.setResponses([fauxAssistantMessage("a"), fauxAssistantMessage("b")]);
    const { engine, store, events } = makeEngine();
    const session = await engine.createSession({
      userId: "u1",
      orgId: "o1",
      workspace: "/",
      sandbox: {},
      model: faux.getModel(),
    });
    const thread = session.thread("web:default");

    const contentA: SignalContent = { kind: "signal", signalType: "child.settled", body: "from A" };
    const receiptA = await thread.submitPrompt(contentA, {
      dispatchId: "evt-1",
      internalSender: { sessionId: "sess-A", owner: { type: "user", id: "u-a" }, hopCount: 0 },
    });
    await waitForStatus(events, receiptA.threadId, "idle");
    const afterA = events.length;

    const contentB: SignalContent = { kind: "signal", signalType: "child.settled", body: "from B" };
    const receiptB = await thread.submitPrompt(contentB, {
      dispatchId: "evt-1", // same external dispatchId, different sender
      internalSender: { sessionId: "sess-B", owner: { type: "org", id: "o-b" }, hopCount: 1 },
    });
    await waitForStatus(events, receiptB.threadId, "idle", 2000, afterA);

    // Two distinct admissions, not deduped against each other.
    expect(receiptA.queueItemId).not.toBe(receiptB.queueItemId);
    const itemA = await store.getQueueItem(session.id, receiptA.queueItemId);
    const itemB = await store.getQueueItem(session.id, receiptB.queueItemId);
    expect(itemA?.dispatchId).toBe("sess-A:evt-1");
    expect(itemB?.dispatchId).toBe("sess-B:evt-1");

    const entries = await session.readEntries("web:default");
    const userEntries = entries.filter((e) => e.type === "message" && e.role === "user") as MessageEntry[];
    const entryA = userEntries.find((e) => e.content === "from A");
    const entryB = userEntries.find((e) => e.content === "from B");
    expect(entryA?.signal).toMatchObject({
      senderSessionId: "sess-A",
      senderOwner: { type: "user", id: "u-a" },
      hopCount: 1,
    });
    expect(entryB?.signal).toMatchObject({
      senderSessionId: "sess-B",
      senderOwner: { type: "org", id: "o-b" },
      hopCount: 2,
    });

    faux.unregister();
  });

  it("hop budget: hopCount 3 admits (default budget 3), hopCount 4 rejects", async () => {
    const faux = registerFauxProvider({ provider: "sig5" });
    faux.setResponses([fauxAssistantMessage("ok")]);
    const { engine, events } = makeEngine();
    const session = await engine.createSession({
      userId: "u1",
      orgId: "o1",
      workspace: "/",
      sandbox: {},
      model: faux.getModel(),
    });
    const thread = session.thread("web:default");

    // internalSender.hopCount 2 -> stamped hopCount 3 == budget -> admits.
    const okReceipt = await thread.submitPrompt(
      { kind: "signal", signalType: "s", body: "ok" } satisfies SignalContent,
      {
        dispatchId: "d-ok",
        internalSender: { sessionId: "sess-X", owner: { type: "user", id: "u-x" }, hopCount: 2 },
      },
    );
    await waitForStatus(events, okReceipt.threadId, "idle");

    // internalSender.hopCount 3 -> stamped hopCount 4 > budget -> rejects.
    await expect(
      thread.submitPrompt({ kind: "signal", signalType: "s", body: "bad" } satisfies SignalContent, {
        dispatchId: "d-bad",
        internalSender: { sessionId: "sess-X", owner: { type: "user", id: "u-x" }, hopCount: 3 },
      }),
    ).rejects.toThrow(ValidationError);

    faux.unregister();
  });

  it("rejects an internal signal admission with no dispatchId", async () => {
    const faux = registerFauxProvider({ provider: "sig6" });
    faux.setResponses([fauxAssistantMessage("unused")]);
    const { engine } = makeEngine();
    const session = await engine.createSession({
      userId: "u1",
      orgId: "o1",
      workspace: "/",
      sandbox: {},
      model: faux.getModel(),
    });

    await expect(
      session.thread("web:default").submitPrompt(
        { kind: "signal", signalType: "s", body: "b" } satisfies SignalContent,
        { internalSender: { sessionId: "sess-Y", owner: { type: "user", id: "u-y" } } },
      ),
    ).rejects.toThrow(ValidationError);

    faux.unregister();
  });

  it("stamped sender_session attribute wins over a colliding user-supplied attribute", async () => {
    const faux = registerFauxProvider({ provider: "sig7" });
    faux.setResponses([fauxAssistantMessage("ok")]);
    const { engine, events } = makeEngine();
    const session = await engine.createSession({
      userId: "u1",
      orgId: "o1",
      workspace: "/",
      sandbox: {},
      model: faux.getModel(),
    });
    const thread = session.thread("web:default");

    const receipt = await thread.submitPrompt(
      {
        kind: "signal",
        signalType: "s",
        body: "b",
        attributes: { sender_session: "spoofed", hop: "999" },
      } satisfies SignalContent,
      {
        dispatchId: "d-spoof",
        internalSender: { sessionId: "sess-real", owner: { type: "user", id: "u-z" }, hopCount: 0 },
      },
    );
    await waitForStatus(events, receipt.threadId, "idle");

    const entries = await session.readEntries("web:default");
    const userEntry = entries.find((e) => e.type === "message" && e.role === "user") as MessageEntry;
    const xml = renderSignalEnvelope(userEntry.signal!, userEntry.content);
    expect(xml).toContain('sender_session="sess-real"');
    expect(xml).toContain('hop="1"');
    expect(xml).not.toContain("spoofed");
    expect(xml).not.toContain('"999"');

    faux.unregister();
  });
});

describe("per-thread pending cap", () => {
  it("the 21st unsettled followup admission on a thread throws PendingCapError; other threads unaffected", async () => {
    const { engine } = makeEngine();
    const faux = registerFauxProvider({ provider: "cap1" });
    // Never resolves the model call for the first item, so items 1..20 stay
    // queued/unsettled (only the head ever gets claimed and runs).
    faux.setResponses([
      (_context, options) =>
        new Promise<never>((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    ]);

    const session = await engine.createSession({
      userId: "u1",
      orgId: "o1",
      workspace: "/",
      sandbox: {},
      model: faux.getModel(),
    });
    const thread = session.thread("web:default");
    const other = session.thread("web:other");

    for (let i = 0; i < 20; i++) {
      await thread.submitPrompt(`msg-${i}`, {});
    }
    await expect(thread.submitPrompt("msg-21", {})).rejects.toThrow(PendingCapError);

    // A different thread on the same session is unaffected.
    await expect(other.submitPrompt("still fine", {})).resolves.toBeDefined();

    faux.unregister();
  });

  it("steer still admits past the cap by superseding pending items", async () => {
    const { engine } = makeEngine();
    const faux = registerFauxProvider({ provider: "cap2" });
    faux.setResponses([
      (_context, options) =>
        new Promise<never>((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    ]);

    const session = await engine.createSession({
      userId: "u1",
      orgId: "o1",
      workspace: "/",
      sandbox: {},
      model: faux.getModel(),
      queueMode: "followup",
    });
    const thread = session.thread("web:default");

    for (let i = 0; i < 20; i++) {
      await thread.submitPrompt(`msg-${i}`, {});
    }
    await expect(thread.submitPrompt("msg-21", {})).rejects.toThrow(PendingCapError);

    // Steer supersedes the pending backlog in the same atomic admission, so
    // it always succeeds regardless of how many items were pending.
    await expect(
      thread.submitPrompt("steer-in", { queueMode: "steer" }),
    ).resolves.toBeDefined();

    faux.unregister();
  });
});
