/**
 * Mid-turn delivery: a prompt admitted with `queueMode: "inject"` while a
 * turn runs joins that turn at its next step, after the current tool calls,
 * instead of waiting for the turn to end. An item that may not join the
 * running turn runs after it, in order.
 */
import { describe, it, expect } from "vitest";
import {
  fauxAssistantMessage,

  registerFauxProvider,
  Type,
  type FauxResponseStep,
} from "@earendil-works/pi-ai/compat";
import { fauxToolCall } from "../src/test-helpers/tool-intent.js";
import { TOOL_SCOPE_KEY } from "@valet/shared";
import {
  canDeliverMidTurn,
  Engine,
  InMemoryEventStream,
  InMemorySessionStore,
  MID_TURN_DELIVERY_KEY,
  VirtualSandboxProvider,
  type BusEvent,
  type MessageEntry,
  type QueueItem,
  type ToolDef,
  type WriteFence,
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

async function setup(provider: string, responses: FauxResponseStep[], tools: ToolDef[] = [], stream = new InMemoryEventStream()) {
  const faux = registerFauxProvider({ provider });
  faux.setResponses(responses);
  const store = new InMemorySessionStore();
  const events: BusEvent[] = [];
  stream.subscribe({}, (e) => events.push(e));
  const engine = new Engine({ providers: { store, stream, sandboxProvider: new VirtualSandboxProvider() } });
  const session = await engine.createSession({ userId: "u1", orgId: "o1", workspace: "/", sandbox: {}, model: faux.getModel(), tools });
  const thread = await session.ensureDefaultThread();
  const settled = async (id: string) => (await store.getQueueItem(session.id, id))?.status === "settled";
  const outcome = async (id: string) => (await store.getQueueItem(session.id, id))?.outcome?.outcome;
  const userEntries = async () => (await session.readEntries(thread.key)).filter(
    (e): e is MessageEntry => e.type === "message" && e.role === "user",
  );
  return { faux, store, session, thread, settled, outcome, userEntries, events };
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
    // The merged item's result is the turn that answered it.
    expect(await h.thread.awaitResult(second.queueItemId)).toMatchObject({ outcome: "completed" });
    // Its settle event names that turn, so a live follower can wait on it.
    expect(h.events.map((e) => e.event).find((e) => e.type === "submission_settled" && e.queueItemId === second.queueItemId))
      .toMatchObject({ outcome: { outcome: "merged" }, mergedIntoItemId: first.queueItemId });
    h.faux.unregister();
  });

  it("joins a child's result to a running turn on another child's result", async () => {
    const { tool, entered, release } = blockingTool();
    const h = await setup("mid-turn-child-results", [
      fauxAssistantMessage([fauxToolCall("block", {}, { id: "tc-1" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("read both results"),
    ], [tool]);
    const owner = { type: "user" as const, id: "u1" };
    const first = await h.thread.submitPrompt({ kind: "signal", signalType: "child.settled", body: "first result" },
      { dispatchId: "d1", internalSender: { sessionId: "child-a", owner }, queueMode: "inject" });
    await entered;
    const second = await h.thread.submitPrompt({ kind: "signal", signalType: "child.settled", body: "second result" },
      { dispatchId: "d2", internalSender: { sessionId: "child-b", owner }, queueMode: "inject" });
    release();
    await waitFor(() => h.settled(first.queueItemId));

    expect(await h.outcome(second.queueItemId)).toBe("merged");
    expect(h.faux.state.callCount).toBe(2);
    h.faux.unregister();
  });

  it("keeps a child's result out of a person's running turn", async () => {
    const { tool, entered, release } = blockingTool();
    const h = await setup("mid-turn-child-person", [
      fauxAssistantMessage([fauxToolCall("block", {}, { id: "tc-1" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("done with your request"),
      fauxAssistantMessage("read the result"),
    ], [tool]);
    const first = await h.thread.submitPrompt("run the long command", { author: PERSON });
    await entered;
    const result = await h.thread.submitPrompt({ kind: "signal", signalType: "child.settled", body: "a result" },
      { dispatchId: "d1", internalSender: { sessionId: "child-a", owner: { type: "user", id: "u1" } }, queueMode: "inject" });
    release();
    await waitFor(() => h.settled(result.queueItemId));

    expect(await h.outcome(first.queueItemId)).toBe("completed");
    // The result ran as its own turn after the person's turn.
    expect(await h.outcome(result.queueItemId)).toBe("completed");
    expect(h.faux.state.callCount).toBe(3);
    h.faux.unregister();
  });

  it("runs a message sent during the final answer as the next turn", async () => {
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

    await waitFor(() => h.settled(second.queueItemId));
    // A boundary after a final answer delivers nothing: recovery would read
    // that answer as the end of the turn. The message runs next instead.
    expect(seen).toEqual(["question one", "one more thing"]);
    expect(await h.outcome(second.queueItemId)).toBe("completed");
    expect(h.faux.state.callCount).toBe(2);
    h.faux.unregister();
  });

  it("delivers an earlier item even when taking a later one fails", async () => {
    const { tool, entered, release } = blockingTool();
    let seen: string[] = [];
    const h = await setup("mid-turn-partial", [
      fauxAssistantMessage([fauxToolCall("block", {}, { id: "tc-1" })], { stopReason: "toolUse" }),
      (context) => { seen = userTexts(context); return fauxAssistantMessage("saw the first"); },
      fauxAssistantMessage("answered the second"),
    ], [tool]);

    const first = await h.thread.submitPrompt("run it", { author: PERSON });
    await entered;
    const b = await h.thread.submitPrompt("message b", { author: PERSON, queueMode: "inject" });
    const c = await h.thread.submitPrompt("message c", { author: PERSON, queueMode: "inject" });
    const settle = h.store.settleUnclaimed.bind(h.store);
    let failed = false;
    h.store.settleUnclaimed = async (...args: Parameters<typeof settle>) => {
      if (args[2] === c.queueItemId && !failed) { failed = true; throw new Error("store unavailable"); }
      return settle(...args);
    };
    release();
    await waitFor(() => h.settled(c.queueItemId));

    expect(seen).toEqual(["run it", "message b"]);
    expect(await h.outcome(first.queueItemId)).toBe("completed");
    expect(await h.outcome(b.queueItemId)).toBe("merged");
    expect(await h.outcome(c.queueItemId)).toBe("completed");
    expect(h.faux.state.callCount).toBe(3);
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

describe("mid-turn delivery when the turn stops or recovers", () => {
  it("leaves an item queued when Stop lands while it is written, and runs it next", async () => {
    const { tool, entered, release } = blockingTool();
    const answer = (context: { messages: Array<{ role: string; content: unknown }> }) =>
      fauxAssistantMessage(userTexts(context).at(-1) === "message b" ? "b answered" : "a continued");
    const h = await setup("mid-turn-stop", [
      fauxAssistantMessage([fauxToolCall("block", {}, { id: "tc-1" })], { stopReason: "toolUse" }),
      answer, answer, answer,
    ], [tool]);

    const first = await h.thread.submitPrompt("run it", { author: PERSON });
    await entered;
    const b = await h.thread.submitPrompt("message b", { author: PERSON, queueMode: "inject" });
    const append = h.store.appendEntries.bind(h.store);
    let stopped = false;
    h.store.appendEntries = async (...args: Parameters<typeof append>) => {
      if (!stopped && args[2].some((e) => e.type === "message" && e.queueItemId === b.queueItemId)) {
        stopped = true;
        void h.thread.interrupt(first.queueItemId);
        await new Promise((r) => setTimeout(r, 20));
      }
      return append(...args);
    };
    release();
    await waitFor(() => h.settled(b.queueItemId));

    expect(await h.outcome(first.queueItemId)).toBe("aborted");
    expect(await h.outcome(b.queueItemId)).toBe("completed");
    const entries = await h.store.getEntries(h.session.id, h.thread.id);
    expect(entries.filter((e) => e.type === "message" && e.role === "user" && e.queueItemId === b.queueItemId)).toHaveLength(1);
    h.faux.unregister();
  });

  it("does not steer an item whose entry an earlier process wrote before a crash", async () => {
    const { tool, entered, release } = blockingTool();
    let seen: string[] = [];
    const h = await setup("mid-turn-recovered", [
      fauxAssistantMessage([fauxToolCall("block", {}, { id: "tc-1" })], { stopReason: "toolUse" }),
      (context) => { seen = userTexts(context); return fauxAssistantMessage("done"); },
    ], [tool]);

    const first = await h.thread.submitPrompt("run it", { author: PERSON });
    await entered;
    const b = await h.thread.submitPrompt("do b once", { author: PERSON, queueMode: "inject" });
    // An earlier process wrote b's entry and died before settling it. A
    // recovered turn rebuilds its context from that entry.
    await h.store.appendEntries(h.session.id, h.thread.id, [{
      id: "e-from-before", sessionId: h.session.id, threadId: h.thread.id, parentId: null, type: "message",
      role: "user", content: "do b once", queueItemId: b.queueItemId, createdAt: Date.now(),
    }]);
    release();
    await waitFor(() => h.settled(first.queueItemId));

    expect(await h.outcome(b.queueItemId)).toBe("merged");
    expect(seen).toEqual(["run it"]);
    const entries = await h.store.getEntries(h.session.id, h.thread.id);
    expect(entries.filter((e) => e.type === "message" && e.role === "user" && e.queueItemId === b.queueItemId)).toHaveLength(1);
    h.faux.unregister();
  });

  it("delivers nothing after a response the output limit cut off", async () => {
    const modelEntered = latch();
    const modelGate = latch();
    const h = await setup("mid-turn-length", [
      async () => {
        modelEntered.open();
        await modelGate.promise;
        return fauxAssistantMessage([fauxToolCall("block", {}, { id: "tc-1" })], { stopReason: "length" });
      },
      fauxAssistantMessage("after the cut"),
      fauxAssistantMessage("b answered"),
      fauxAssistantMessage("spare"),
    ], [blockingTool().tool]);

    await h.thread.submitPrompt("long answer", { author: PERSON });
    await modelEntered.promise;
    const b = await h.thread.submitPrompt("message b", { author: PERSON, queueMode: "inject" });
    modelGate.open();
    await waitFor(() => h.settled(b.queueItemId));

    expect(await h.outcome(b.queueItemId)).toBe("completed");
    h.faux.unregister();
  });
});

describe("mid-turn delivery and Send now", () => {
  it("refuses a Send now that arrives while delivery takes the item, and leaves one entry", async () => {
    const { tool, entered, release } = blockingTool();
    let seen: string[] = [];
    const h = await setup("mid-turn-promote", [
      fauxAssistantMessage([fauxToolCall("block", {}, { id: "tc-1" })], { stopReason: "toolUse" }),
      (context) => { seen = userTexts(context); return fauxAssistantMessage("done"); },
    ], [tool]);

    const first = await h.thread.submitPrompt("run it", { author: PERSON });
    await entered;
    const second = await h.thread.submitPrompt("check the logs too", { author: PERSON, queueMode: "inject" });

    // Fire Send now after delivery wrote the user entry and before it
    // settles the item, the window a promotion off the chain could win.
    let promotion: Promise<unknown> | undefined;
    const settle = h.store.settleUnclaimed.bind(h.store);
    h.store.settleUnclaimed = async (...args: Parameters<typeof settle>) => {
      if (args[3].outcome === "merged" && promotion === undefined) {
        promotion = h.thread.promoteQueuedItem(second.queueItemId).then(() => "promoted", (err: Error) => err.message);
        await new Promise((r) => setTimeout(r, 20));
      }
      return settle(...args);
    };
    release();
    await waitFor(() => h.settled(first.queueItemId));

    expect(await promotion).toMatch(/no longer queued/);
    expect(await h.outcome(second.queueItemId)).toBe("merged");
    expect(seen).toEqual(["run it", "check the logs too"]);
    expect((await h.userEntries()).map((e) => e.content)).toEqual(["run it", "check the logs too"]);
    expect(h.faux.state.callCount).toBe(2);
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
    // A narrower tool scope never runs under a wider turn.
    expect(canDeliverMidTurn(item({ metadata: { [MID_TURN_DELIVERY_KEY]: true, [TOOL_SCOPE_KEY]: { tools: [], actions: [] } } }), base, "u1")).toBe(false);
    // Channel, model pin and role must match the running turn.
    expect(canDeliverMidTurn(item({ channel: { channelType: "slack", channelId: "C1" } }), base, "u1")).toBe(false);
    expect(canDeliverMidTurn(item({ model: "big" }), base, "u1")).toBe(false);
    expect(canDeliverMidTurn(item({ role: "reviewer" }), base, "u1")).toBe(false);
  });

  it("joins another agent's signal only to a signal turn from the same owner", () => {
    const stamp = (id: string) => ({ senderSessionId: `child-${id}`, senderOwner: { type: "user", id }, hopCount: 1 });
    const result = (owner: string) => item({
      author: undefined,
      content: { kind: "signal", signalType: "child.settled", body: "result" },
      metadata: { [MID_TURN_DELIVERY_KEY]: true, signalStamp: stamp(owner) },
    });
    const resultTurn = { ...base, author: undefined, content: { kind: "signal" as const, signalType: "child.settled", body: "first" }, metadata: { signalStamp: stamp("u1") } };
    expect(canDeliverMidTurn(result("u1"), resultTurn, "u1")).toBe(true);
    // Never a person's own turn: the result would act with their authority.
    expect(canDeliverMidTurn(result("u1"), base, "u1")).toBe(false);
    // Never a wake-up's turn, which has no sender stamp.
    expect(canDeliverMidTurn(result("u1"), { ...resultTurn, metadata: {} }, "u1")).toBe(false);
    // Never a result turn from another owner.
    expect(canDeliverMidTurn(result("u2"), resultTurn, "u1")).toBe(false);
  });
});

/** The tool-result texts the model received, in order. */
function toolResultTexts(context: { messages: Array<{ role: string; content: unknown }> }): string[] {
  return context.messages.filter((m) => m.role === "toolResult").map((m) =>
    typeof m.content === "string"
      ? m.content
      : (m.content as Array<{ type: string; text?: string }>).filter((b) => b.type === "text").map((b) => b.text).join(""));
}

describe("a message while a question is open", () => {
  const askRepo = fauxAssistantMessage(
    [fauxToolCall("ask_question", { question: "Which repo?", options: ["web", "api"] }, { id: "tc-q" })],
    { stopReason: "toolUse" },
  );

  it("withdraws the question so the turn replies to the message", async () => {
    let seenUsers: string[] = [];
    let seenResults: string[] = [];
    const h = await setup("question-message", [
      askRepo,
      (context) => {
        seenUsers = userTexts(context);
        seenResults = toolResultTexts(context);
        return fauxAssistantMessage("web is the frontend");
      },
    ]);

    const first = await h.thread.submitPrompt("pick a repo for me", { author: PERSON });
    await waitFor(() => h.thread.pendingDecisionGates().length === 1);
    const gateId = h.thread.pendingDecisionGates()[0]!.id;
    const second = await h.thread.submitPrompt("what is in web?", { author: PERSON, queueMode: "inject" });
    await waitFor(() => h.settled(first.queueItemId));

    // One turn: the question closed, and the message joined the turn.
    expect(seenUsers).toEqual(["pick a repo for me", "what is in web?"]);
    expect(seenResults.at(-1)).toContain('The person wrote a message instead of answering "Which repo?"');
    expect(await h.outcome(first.queueItemId)).toBe("completed");
    expect(await h.outcome(second.queueItemId)).toBe("merged");
    expect(h.faux.state.callCount).toBe(2);
    expect(await h.store.getDecisionGate(h.session.id, gateId)).toMatchObject({ status: "withdrawn" });
    expect(h.events.map((e) => e.event).find((e) => e.type === "decision_gate_withdrawn"))
      .toMatchObject({ gateId, reason: "message" });
    h.faux.unregister();
  });

  it("withdraws the question for a message admitted before the question's waiter exists", async () => {
    // Hold the question's announcement: the gate is saved and shown, but the
    // waiter is not registered yet. A message sent now must still close it.
    let reached!: () => void;
    const announced = new Promise<void>((resolve) => { reached = resolve; });
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    class HoldingStream extends InMemoryEventStream {
      override async append(event: BusEvent, eventKey: string, fence?: WriteFence): Promise<{ offset: string }> {
        if (event.event.type === "decision_gate") { reached(); await held; }
        return super.append(event, eventKey, fence);
      }
    }
    const h = await setup("question-window", [askRepo, fauxAssistantMessage("web is the frontend")], [], new HoldingStream());

    const first = await h.thread.submitPrompt("pick a repo for me", { author: PERSON });
    await announced;
    expect(h.thread.pendingDecisionGates()).toHaveLength(0);
    const second = await h.thread.submitPrompt("what is in web?", { author: PERSON, queueMode: "inject" });
    release();
    await waitFor(() => h.settled(first.queueItemId));

    expect(await h.outcome(first.queueItemId)).toBe("completed");
    expect(await h.outcome(second.queueItemId)).toBe("merged");
    expect(h.events.map((e) => e.event).find((e) => e.type === "decision_gate_withdrawn")).toMatchObject({ reason: "message" });
    h.faux.unregister();
  });

  it("keeps the question open for a message no person typed", async () => {
    const h = await setup("question-event", [askRepo, fauxAssistantMessage("picked web")]);

    const first = await h.thread.submitPrompt("pick a repo for me", { author: PERSON });
    await waitFor(() => h.thread.pendingDecisionGates().length === 1);
    const gateId = h.thread.pendingDecisionGates()[0]!.id;
    // An event delivery runs as the person but is not their typing.
    const event = await h.thread.submitPrompt("a webhook arrived", { author: { id: "u1" }, queueMode: "inject" });
    await new Promise((r) => setTimeout(r, 50));

    expect(h.thread.isPendingGate(gateId)).toBe(true);
    expect((await h.store.getQueueItem(h.session.id, event.queueItemId))?.status).toBe("queued");
    h.thread.resolveDecision(gateId, { actionId: "option-0", resolvedBy: "u1", resolvedAt: Date.now() });
    await waitFor(() => h.settled(first.queueItemId));
    h.faux.unregister();
  });

  it("keeps the question open for a followup that waits for the turn to end", async () => {
    const h = await setup("question-followup", [askRepo, fauxAssistantMessage("picked web"), fauxAssistantMessage("ok")]);

    const first = await h.thread.submitPrompt("pick a repo for me", { author: PERSON });
    await waitFor(() => h.thread.pendingDecisionGates().length === 1);
    const gateId = h.thread.pendingDecisionGates()[0]!.id;
    const later = await h.thread.submitPrompt("after that, open a PR", { author: PERSON, queueMode: "followup" });
    await new Promise((r) => setTimeout(r, 50));

    expect(h.thread.isPendingGate(gateId)).toBe(true);
    h.thread.resolveDecision(gateId, { actionId: "option-0", resolvedBy: "u1", resolvedAt: Date.now() });
    await waitFor(() => h.settled(later.queueItemId));
    expect(await h.outcome(first.queueItemId)).toBe("completed");
    h.faux.unregister();
  });
});
