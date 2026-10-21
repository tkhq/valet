/**
 * Mid-turn delivery: a prompt admitted with `queueMode: "inject"` while a
 * turn runs joins that turn at its next step, after the current tool calls,
 * instead of waiting for the turn to end. An item that may not join the
 * running turn runs after it, in order.
 */
import { describe, it, expect } from "vitest";
import {
  fauxAssistantMessage,
  fauxToolCall,
  registerFauxProvider,
  Type,
  type FauxResponseStep,
} from "@earendil-works/pi-ai/compat";
import {
  canDeliverMidTurn,
  Engine,
  InMemoryEventStream,
  InMemorySessionStore,
  MID_TURN_DELIVERY_KEY,
  VirtualSandboxProvider,
  type MessageEntry,
  type QueueItem,
  type ToolDef,
} from "../src/index.js";

const PERSON = { id: "u1", interactive: true };

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 5));
  }
}

function latch(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((r) => { open = r; });
  return { promise, open };
}

/** A tool that parks until the test releases it: the window a long command runs in. */
function blockingTool(): { tool: ToolDef; entered: Promise<void>; release: () => void } {
  const entered = latch();
  const gate = latch();
  const tool: ToolDef = {
    name: "block",
    description: "blocks until released",
    parameters: Type.Object({}),
    execute: async () => {
      entered.open();
      await gate.promise;
      return { text: "released" };
    },
  };
  return { tool, entered: entered.promise, release: gate.open };
}

/** The user-message texts the model received, in order. */
function userTexts(context: { messages: Array<{ role: string; content: unknown }> }): string[] {
  return context.messages.filter((m) => m.role === "user").map((m) =>
    typeof m.content === "string"
      ? m.content
      : (m.content as Array<{ type: string; text?: string }>).filter((b) => b.type === "text").map((b) => b.text).join(""));
}

async function setup(provider: string, responses: FauxResponseStep[], tools: ToolDef[] = []) {
  const faux = registerFauxProvider({ provider });
  faux.setResponses(responses);
  const store = new InMemorySessionStore();
  const engine = new Engine({ providers: { store, stream: new InMemoryEventStream(), sandboxProvider: new VirtualSandboxProvider() } });
  const session = await engine.createSession({ userId: "u1", orgId: "o1", workspace: "/", sandbox: {}, model: faux.getModel(), tools });
  const thread = await session.ensureDefaultThread();
  const settled = async (id: string) => (await store.getQueueItem(session.id, id))?.status === "settled";
  const outcome = async (id: string) => (await store.getQueueItem(session.id, id))?.outcome?.outcome;
  const userEntries = async () => (await session.readEntries(thread.key)).filter(
    (e): e is MessageEntry => e.type === "message" && e.role === "user",
  );
  return { faux, store, session, thread, settled, outcome, userEntries };
}

describe("mid-turn delivery", () => {
  it("delivers a message sent while a tool runs into the running turn", async () => {
    const { tool, entered, release } = blockingTool();
    let seen: string[] = [];
    const h = await setup("mid-turn-tool", [
      fauxAssistantMessage([fauxToolCall("block", {}, { id: "tc-1" })], { stopReason: "toolUse" }),
      (context) => { seen = userTexts(context); return fauxAssistantMessage("checked both"); },
    ], [tool]);

    const first = await h.thread.submitPrompt("run the long command", { author: PERSON });
    await entered;
    const second = await h.thread.submitPrompt("also check the logs", { author: PERSON, queueMode: "inject" });
    release();
    await waitFor(() => h.settled(first.queueItemId));

    // The model's next request after the tool call carries the message.
    expect(seen).toEqual(["run the long command", "also check the logs"]);
    expect(await h.outcome(first.queueItemId)).toBe("completed");
    expect(await h.outcome(second.queueItemId)).toBe("merged");
    // One turn: no second turn ran for the delivered message.
    expect(h.faux.state.callCount).toBe(2);
    // The transcript keeps the message where the model saw it.
    const entries = await h.session.readEntries(h.thread.key);
    const order = entries.flatMap((e) => e.type === "message" ? [`${e.role}:${e.role === "user" ? e.content : e.queueItemId}`] : []);
    expect(order).toEqual([
      "user:run the long command",
      `assistant:${first.queueItemId}`,
      "user:also check the logs",
      `assistant:${first.queueItemId}`,
    ]);
    expect((await h.userEntries())[1]?.queueItemId).toBe(second.queueItemId);
    h.faux.unregister();
  });

  it("delivers a message sent during the final answer, then continues the turn", async () => {
    const modelEntered = latch();
    const modelGate = latch();
    let seen: string[] = [];
    const h = await setup("mid-turn-final", [
      async () => { modelEntered.open(); await modelGate.promise; return fauxAssistantMessage("first answer"); },
      (context) => { seen = userTexts(context); return fauxAssistantMessage("answered the follow-up"); },
    ]);

    const first = await h.thread.submitPrompt("question one", { author: PERSON });
    await modelEntered.promise;
    const second = await h.thread.submitPrompt("one more thing", { author: PERSON, queueMode: "inject" });
    modelGate.open();
    await waitFor(() => h.settled(first.queueItemId));

    expect(seen).toEqual(["question one", "one more thing"]);
    expect(await h.outcome(second.queueItemId)).toBe("merged");
    expect(h.faux.state.callCount).toBe(2);
    h.faux.unregister();
  });

  it("delivers a wake-up with no author into the owner's turn", async () => {
    const { tool, entered, release } = blockingTool();
    let seen: string[] = [];
    const h = await setup("mid-turn-wakeup", [
      fauxAssistantMessage([fauxToolCall("block", {}, { id: "tc-1" })], { stopReason: "toolUse" }),
      (context) => { seen = userTexts(context); return fauxAssistantMessage("noted the timer"); },
    ], [tool]);

    const first = await h.thread.submitPrompt("start the build", { author: PERSON });
    await entered;
    const wake = await h.thread.submitPrompt(
      { kind: "signal", signalType: "wakeup.timer", tagName: "wakeup", body: "Check the deploy now." },
      { queueMode: "inject" },
    );
    release();
    await waitFor(() => h.settled(first.queueItemId));

    expect(await h.outcome(wake.queueItemId)).toBe("merged");
    expect(seen[1]).toContain("Check the deploy now.");
    expect(h.faux.state.callCount).toBe(2);
    h.faux.unregister();
  });

  it("runs another person's message as its own turn after the running turn", async () => {
    const { tool, entered, release } = blockingTool();
    const h = await setup("mid-turn-other", [
      fauxAssistantMessage([fauxToolCall("block", {}, { id: "tc-1" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("first done"),
      fauxAssistantMessage("second done"),
    ], [tool]);

    const first = await h.thread.submitPrompt("run it", { author: PERSON });
    await entered;
    const other = await h.thread.submitPrompt("from a teammate", { author: { id: "u2", interactive: true }, queueMode: "inject" });
    release();
    await waitFor(() => h.settled(other.queueItemId));

    expect(await h.outcome(first.queueItemId)).toBe("completed");
    expect(await h.outcome(other.queueItemId)).toBe("completed");
    expect(h.faux.state.callCount).toBe(3);
    h.faux.unregister();
  });

  it("does not deliver a message cancelled before the next step", async () => {
    const { tool, entered, release } = blockingTool();
    let seen: string[] = [];
    const h = await setup("mid-turn-cancel", [
      fauxAssistantMessage([fauxToolCall("block", {}, { id: "tc-1" })], { stopReason: "toolUse" }),
      (context) => { seen = userTexts(context); return fauxAssistantMessage("done"); },
    ], [tool]);

    const first = await h.thread.submitPrompt("run it", { author: PERSON });
    await entered;
    const second = await h.thread.submitPrompt("never mind this", { author: PERSON, queueMode: "inject" });
    expect(await h.thread.cancelQueuedItem(second.queueItemId)).toBe(true);
    release();
    await waitFor(() => h.settled(first.queueItemId));

    expect(seen).toEqual(["run it"]);
    expect(await h.outcome(second.queueItemId)).toBe("aborted");
    expect((await h.userEntries()).map((e) => e.content)).toEqual(["run it"]);
    h.faux.unregister();
  });
});

describe("canDeliverMidTurn", () => {
  const base: QueueItem = {
    id: "q-run",
    threadId: "t1",
    content: "running",
    author: { id: "u1", interactive: true },
    status: "running",
    attemptCount: 1,
    maxAttempts: 10,
    timeoutAt: 0,
    createdAt: 1,
    updatedAt: 1,
  };
  const item = (over: Partial<QueueItem>): QueueItem => ({
    ...base,
    id: "q-next",
    content: "next",
    status: "queued",
    metadata: { [MID_TURN_DELIVERY_KEY]: true },
    ...over,
  });

  it("takes only an inject item that adds no authority and needs no other routing", () => {
    expect(canDeliverMidTurn(item({}), base, "u1")).toBe(true);
    expect(canDeliverMidTurn(item({ metadata: {} }), base, "u1")).toBe(false);
    // A channel sender with no Valet account never joins, and is never joined.
    expect(canDeliverMidTurn(item({ author: { id: "u1", externalSender: true } }), base, "u1")).toBe(false);
    expect(canDeliverMidTurn(item({}), { ...base, author: { id: "u1", externalSender: true } }, "u1")).toBe(false);
    // Another person's message does not run as this person.
    expect(canDeliverMidTurn(item({ author: { id: "u2", interactive: true } }), base, "u1")).toBe(false);
    // A token-sent message does not borrow a signed-in turn.
    expect(canDeliverMidTurn(item({ author: { id: "u1" } }), base, "u1")).toBe(false);
    // A wake-up with no author joins the owner's turn, not a teammate's.
    const wake = item({ author: undefined, content: { kind: "signal", signalType: "wakeup.timer", body: "now" } });
    expect(canDeliverMidTurn(wake, base, "u1")).toBe(true);
    expect(canDeliverMidTurn(wake, base, "team:t1")).toBe(false);
    // A signal whose reply routes to a channel waits for its own turn.
    expect(canDeliverMidTurn(item({
      author: undefined,
      content: { kind: "signal", signalType: "wakeup.timer", body: "now", origin: { channelType: "slack", threadKey: "slack:C1:1.2" } },
    }), base, "u1")).toBe(false);
    // Channel, model pin and role must match the running turn.
    expect(canDeliverMidTurn(item({ channel: { channelType: "slack", channelId: "C1" } }), base, "u1")).toBe(false);
    expect(canDeliverMidTurn(item({ model: "big" }), base, "u1")).toBe(false);
    expect(canDeliverMidTurn(item({ role: "reviewer" }), base, "u1")).toBe(false);
  });
});
