/**
 * Compaction budget: a 1M-token model compacts between turns at the
 * compaction budget, not near its window. The checks also pin what must not
 * get worse: a budget pass never adds a model call to the finished turn, a
 * pass with nothing to reclaim is not a failure, the next request still
 * carries the summary and the newest turn word for word, and `0` restores
 * the window-sized trigger.
 */
import { describe, it, expect } from "vitest";
import { fauxAssistantMessage, registerFauxProvider, Type } from "@earendil-works/pi-ai/compat";
import { MODEL_CALL_LIMIT_KEY } from "@valet/shared";
import { fauxToolCall } from "../src/test-helpers/tool-intent.js";
import {
  Engine,
  InMemoryEventStream,
  InMemorySessionStore,
  VirtualSandboxProvider,
  type BusEvent,
  type CompactionConfig,
  type CreateSessionOptions,
  type SessionEntry,
  type ToolDef,
} from "../src/index.js";
import { compactionBudget, idleCompactionDelayMs, selectCutPoint, usableTokens } from "../src/compaction.js";
import { COMPLETE_SUMMARY } from "./fixtures/compaction-summary.js";

const MILLION = 1_000_000;

function modelWith(contextWindow: number) {
  return {
    id: `m-${contextWindow}`,
    name: "m",
    api: "faux",
    provider: "faux",
    baseUrl: "",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens: 64_000,
  } as const;
}

describe("compactionBudget", () => {
  it("caps a 1M window at 200k and leaves a small window at its usable size", () => {
    expect(compactionBudget(modelWith(MILLION))).toBe(200_000);
    expect(compactionBudget(modelWith(272_000))).toBe(200_000);
    expect(compactionBudget(modelWith(128_000))).toBe(usableTokens(modelWith(128_000)));
  });

  it("takes a configured cap, and 0 removes the cap", () => {
    expect(compactionBudget(modelWith(MILLION), { contextBudgetTokens: 50_000 })).toBe(50_000);
    expect(compactionBudget(modelWith(MILLION), { contextBudgetTokens: 0 })).toBe(usableTokens(modelWith(MILLION)));
  });

  it("waits until shortly before the prompt cache expires before an idle pass", () => {
    expect(idleCompactionDelayMs({ purpose: "orchestrator" })).toBe(55 * 60_000);
    expect(idleCompactionDelayMs({ purpose: "interactive" })).toBe(4 * 60_000);
    expect(idleCompactionDelayMs({ purpose: "interactive", cacheRetention: "long" })).toBe(55 * 60_000);
    expect(idleCompactionDelayMs({ cacheRetention: "none" })).toBe(0);
    expect(idleCompactionDelayMs({ purpose: "orchestrator", compaction: { idleCompactionMs: 0 } })).toBe(0);
  });

  it("sizes the verbatim tail from the budget, not the window", () => {
    // Eight 20k-token turns. 25% of usable on a 1M window would keep all of
    // them (245k), so nothing would leave the context. 25% of the 200k budget
    // keeps the newest two.
    const entries: SessionEntry[] = [];
    for (let i = 0; i < 8; i++) {
      entries.push(
        { id: `u${i}`, sessionId: "s", threadId: "t", parentId: null, type: "message", role: "user", content: `q${i}`, createdAt: i * 2 },
        { id: `a${i}`, sessionId: "s", threadId: "t", parentId: null, type: "message", role: "assistant", content: "x".repeat(80_000), createdAt: i * 2 + 1 },
      );
    }
    const cut = selectCutPoint({ entries, model: modelWith(MILLION) });
    expect(cut.tailStartId).toBe("u6");
    expect(cut.fallbackToFloor).toBe(false);
  });
});

function makeEngine() {
  const store = new InMemorySessionStore();
  const bus = new InMemoryEventStream();
  const events: BusEvent[] = [];
  bus.subscribe({}, (e) => events.push(e));
  const engine = new Engine({ providers: { store, stream: bus, sandboxProvider: new VirtualSandboxProvider() } });
  return { engine, store, events };
}

async function waitFor(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 5));
  }
}

/**
 * A 1M-window session with two finished turns of history (about 12.5k
 * tokens, under a 15k budget). `historyAt` stamps the history; the default
 * is long ago, so the thread reads as idle.
 */
async function bigWindowSession(
  provider: string,
  compaction: CompactionConfig,
  extra: Partial<CreateSessionOptions> = {},
  historyAt = 1,
) {
  const faux = registerFauxProvider({
    provider,
    models: [{ id: "big", name: "big", contextWindow: MILLION, maxTokens: 64_000 }],
  });
  const { engine, store, events } = makeEngine();
  const session = await engine.createSession({
    userId: "u",
    orgId: "o",
    workspace: "/",
    sandbox: {},
    model: faux.getModel("big")!,
    compaction,
    ...extra,
  });
  const thread = session.thread();
  await store.appendEntries(session.id, thread.id, [
    { id: "e-1", sessionId: session.id, threadId: thread.id, parentId: null, type: "message", role: "user", content: "The codename is Halyard.", createdAt: historyAt + 0 },
    { id: "e-2", sessionId: session.id, threadId: thread.id, parentId: "e-1", type: "message", role: "assistant", content: "Noted. " + "x".repeat(50_000), createdAt: historyAt + 1 },
    { id: "e-3", sessionId: session.id, threadId: thread.id, parentId: "e-2", type: "message", role: "user", content: "second prompt", createdAt: historyAt + 2 },
    { id: "e-4", sessionId: session.id, threadId: thread.id, parentId: "e-3", type: "message", role: "assistant", content: "second response", createdAt: historyAt + 3 },
  ]);
  thread.rehydrateTranscript(await store.getEntries(session.id, thread.id));
  return { faux, store, events, session, thread };
}

const SLACK = { channelType: "slack", channelId: "C1" } as const;

const errorCodes = (events: BusEvent[]) =>
  events.flatMap((e) => (e.event.type === "error" ? [e.event.code] : []));

describe("compaction budget: a finished turn above the budget", () => {
  it("compacts a Slack turn above the budget at turn end without a continuation call", async () => {
    // The third reply adds about 4k tokens and crosses the 15k budget. Under
    // the old trigger this thread would wait until about 980k.
    const { faux, store, events, session, thread } = await bigWindowSession("budget-compacts", { contextBudgetTokens: 15_000, tailTurns: 1 });
    let calls = 0;
    faux.setResponses([
      () => { calls++; return fauxAssistantMessage("third response " + "y".repeat(16_000)); },
      () => { calls++; return fauxAssistantMessage(COMPLETE_SUMMARY); },
      // A continuation would consume this response. The test fails if it does.
      () => { calls++; return fauxAssistantMessage("unexpected continuation"); },
    ]);

    const receipt = await session.prompt("third prompt", { channel: SLACK });
    await waitFor(() => events.some((e) => e.event.type === "compaction_end" && e.event.threadId === receipt.threadId));
    await thread.awaitResult(receipt.queueItemId, { timeoutMs: 4000 });

    const entries = await store.getEntries(session.id, thread.id);
    const checkpoints = entries.filter((e) => e.type === "compaction");
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0].type === "compaction" && checkpoints[0].coveredEntryIds).toContain("e-1");
    expect(calls).toBe(2);
    expect(entries.some((e) => e.type === "message" && e.metadata?.compaction_continue === true)).toBe(false);
    expect(errorCodes(events)).toEqual([]);
    faux.unregister();
  });

  it("sends the summary and the newest turn verbatim on the next request", async () => {
    const { faux, events, session, thread } = await bigWindowSession("budget-next-request", { contextBudgetTokens: 15_000, tailTurns: 1, idleCompactionMs: 0 });
    let nextRequest = "";
    faux.setResponses([
      () => fauxAssistantMessage("third response " + "y".repeat(16_000)),
      () => fauxAssistantMessage(COMPLETE_SUMMARY),
      (context) => { nextRequest = JSON.stringify(context.messages); return fauxAssistantMessage("fourth response"); },
    ]);

    const third = await session.prompt("third prompt");
    await waitFor(() => events.some((e) => e.event.type === "compaction_end" && e.event.threadId === third.threadId));
    await thread.awaitResult(third.queueItemId, { timeoutMs: 4000 });
    const fourth = await session.prompt("fourth prompt");
    await thread.awaitResult(fourth.queueItemId, { timeoutMs: 4000 });

    expect(nextRequest).toContain("previous-context");
    expect(nextRequest).toContain("## Goal");
    expect(nextRequest).toContain("third prompt");
    expect(nextRequest).toContain("fourth prompt");
    // The covered history left the request.
    expect(nextRequest).not.toContain("x".repeat(1_000));
    faux.unregister();
  });

  it("does not report or count a budget pass that finds nothing to reclaim", async () => {
    // One turn and no head: the whole context is the newest turn, which
    // compaction always keeps. Under the overflow trigger this is a
    // compaction_noop failure; under the budget it is expected.
    const faux = registerFauxProvider({
      provider: "budget-noop",
      models: [{ id: "big", name: "big", contextWindow: MILLION, maxTokens: 64_000 }],
    });
    const { engine, events } = makeEngine();
    const session = await engine.createSession({
      userId: "u", orgId: "o", workspace: "/", sandbox: {},
      model: faux.getModel("big")!,
      compaction: { contextBudgetTokens: 2_000, idleCompactionMs: 0 },
    });
    faux.setResponses([() => fauxAssistantMessage("answer " + "z".repeat(20_000))]);

    const receipt = await session.prompt("one prompt");
    await session.thread().awaitResult(receipt.queueItemId, { timeoutMs: 4000 });

    expect(errorCodes(events)).not.toContain("compaction_noop");
    expect(errorCodes(events)).not.toContain("compaction_circuit_open");
    faux.unregister();
  });

  it("compacts a workflow submission that stopped at its model call limit above the budget", async () => {
    // The limit ends the submission after a tool call. An overflow pass would
    // continue the turn, so it stays off; the budget pass never continues.
    const tools: ToolDef[] = [{
      name: "read_item", description: "Reads one item", parameters: Type.Object({}),
      execute: async () => ({ text: "item " + "w".repeat(16_000) }),
    }];
    const { faux, store, events, session, thread } = await bigWindowSession(
      "budget-call-limit",
      { contextBudgetTokens: 15_000, tailTurns: 1 },
      { purpose: "workflow", builtinTools: [], tools },
    );
    let summaries = 0;
    faux.setResponses([
      () => fauxAssistantMessage([fauxToolCall("read_item", {})], { stopReason: "toolUse" }),
      () => fauxAssistantMessage([fauxToolCall("read_item", {})], { stopReason: "toolUse" }),
      () => { summaries++; return fauxAssistantMessage(COMPLETE_SUMMARY); },
    ]);

    const receipt = await session.prompt("read every item", { metadata: { [MODEL_CALL_LIMIT_KEY]: 2 } });
    const outcome = await thread.awaitResult(receipt.queueItemId, { timeoutMs: 4000 });
    await waitFor(() => events.some((e) => e.event.type === "compaction_end" && e.event.threadId === receipt.threadId));

    expect(JSON.stringify(outcome)).toContain("This step stopped after 2 model calls");
    expect(summaries).toBe(1);
    const entries = await store.getEntries(session.id, thread.id);
    expect(entries.filter((e) => e.type === "compaction")).toHaveLength(1);
    expect(entries.some((e) => e.type === "message" && e.metadata?.compaction_continue === true)).toBe(false);
    faux.unregister();
  });

  it("keeps the window-sized trigger when the budget is 0", async () => {
    const { faux, store, session, thread } = await bigWindowSession("budget-off", { contextBudgetTokens: 0, tailTurns: 1 });
    faux.setResponses([() => fauxAssistantMessage("third response " + "y".repeat(16_000))]);

    const receipt = await session.prompt("third prompt");
    await thread.awaitResult(receipt.queueItemId, { timeoutMs: 4000 });

    const entries = await store.getEntries(session.id, thread.id);
    expect(entries.filter((e) => e.type === "compaction")).toHaveLength(0);
    faux.unregister();
  });

  it("reports the budget as the context meter limit", async () => {
    const { faux, thread } = await bigWindowSession("budget-meter", { contextBudgetTokens: 15_000 });
    const usage = await thread.contextUsage();
    expect(usage?.limit).toBe(15_000);
    expect(usage?.contextWindow).toBe(MILLION);
    faux.unregister();
  });
});

describe("compaction budget: when an interactive thread compacts", () => {
  it("keeps the full context through a turn, then compacts once the thread is idle", async () => {
    const { faux, store, events, session, thread } = await bigWindowSession(
      "budget-idle",
      { contextBudgetTokens: 15_000, tailTurns: 1, idleCompactionMs: 50 },
    );
    let calls = 0;
    faux.setResponses([
      () => { calls++; return fauxAssistantMessage("third response " + "y".repeat(16_000)); },
      () => { calls++; return fauxAssistantMessage(COMPLETE_SUMMARY); },
      () => { calls++; return fauxAssistantMessage("unexpected continuation"); },
    ]);

    const receipt = await session.prompt("third prompt");
    await thread.awaitResult(receipt.queueItemId, { timeoutMs: 4000 });
    expect((await store.getEntries(session.id, thread.id)).filter((e) => e.type === "compaction")).toHaveLength(0);

    await waitFor(() => events.some((e) => e.event.type === "compaction_end" && e.event.threadId === receipt.threadId));
    await thread.kick();
    const entries = await store.getEntries(session.id, thread.id);
    expect(entries.filter((e) => e.type === "compaction")).toHaveLength(1);
    expect(calls).toBe(2);
    expect(entries.some((e) => e.type === "message" && e.metadata?.compaction_continue === true)).toBe(false);
    expect(errorCodes(events)).toEqual([]);
    faux.unregister();
  });

  it("does not compact while a person keeps working", async () => {
    const { faux, store, events, session, thread } = await bigWindowSession(
      "budget-active",
      { contextBudgetTokens: 15_000, tailTurns: 1, idleCompactionMs: 60_000 },
    );
    let fourthRequest = "";
    faux.setResponses([
      () => fauxAssistantMessage("third response " + "y".repeat(16_000)),
      (context) => { fourthRequest = JSON.stringify(context.messages); return fauxAssistantMessage("fourth response"); },
    ]);

    const third = await session.prompt("third prompt");
    await thread.awaitResult(third.queueItemId, { timeoutMs: 4000 });
    const fourth = await session.prompt("fourth prompt");
    await thread.awaitResult(fourth.queueItemId, { timeoutMs: 4000 });

    // No pass started, and the fourth turn read the whole history.
    expect(events.some((e) => e.event.type === "compaction_start")).toBe(false);
    const entries = await store.getEntries(session.id, thread.id);
    expect(entries.filter((e) => e.type === "compaction")).toHaveLength(0);
    expect(entries.some((e) => e.type === "message" && e.role === "assistant" && e.content === "fourth response")).toBe(true);
    expect(fourthRequest).toContain("x".repeat(1_000));
    await thread.abort();
    faux.unregister();
  });

  it("postpones a Slack turn-end pass while another message waits", async () => {
    const { faux, store, events, session, thread } = await bigWindowSession(
      "budget-queued",
      { contextBudgetTokens: 15_000, tailTurns: 1 },
    );
    let queued: Promise<{ queueItemId: string }> | undefined;
    let secondRequest = "";
    faux.setResponses([
      () => {
        queued = session.prompt("follow-up", { channel: SLACK });
        return fauxAssistantMessage("third response " + "y".repeat(16_000));
      },
      (context) => { secondRequest = JSON.stringify(context.messages); return fauxAssistantMessage("follow-up response"); },
      () => fauxAssistantMessage(COMPLETE_SUMMARY),
    ]);

    const receipt = await session.prompt("third prompt", { channel: SLACK });
    await thread.awaitResult(receipt.queueItemId, { timeoutMs: 4000 });
    const followUp = await queued!;
    await thread.awaitResult(followUp.queueItemId, { timeoutMs: 4000 });
    await waitFor(() => events.some((e) => e.event.type === "compaction_end"));

    // The follow-up ran on the uncompacted context; the pass ran after it.
    expect(secondRequest).toContain("x".repeat(1_000));
    const entries = await store.getEntries(session.id, thread.id);
    const checkpoint = entries.findIndex((e) => e.type === "compaction");
    const followUpReply = entries.findIndex((e) => e.type === "message" && e.role === "assistant" && e.content === "follow-up response");
    expect(checkpoint).toBeGreaterThan(followUpReply);
    faux.unregister();
  });

  it("compacts a reloaded thread before its turn only when it sat idle past the delay", async () => {
    // A restart loses the idle timer. The first turn after a reload stands in
    // for it: an idle thread compacts first, a recently active one does not.
    for (const [name, historyAt, expectCompacted] of [
      ["budget-reload-idle", 1, true],
      ["budget-reload-active", Date.now(), false],
    ] as const) {
      const { faux, store, events, session, thread } = await bigWindowSession(
        name,
        { contextBudgetTokens: 10_000, tailTurns: 1, idleCompactionMs: 60_000 },
        {},
        historyAt,
      );
      let turnRequest = "";
      faux.setResponses([
        ...(expectCompacted ? [() => fauxAssistantMessage(COMPLETE_SUMMARY)] : []),
        (context) => { turnRequest = JSON.stringify(context.messages); return fauxAssistantMessage("reply"); },
      ]);

      const receipt = await session.prompt("next prompt");
      await thread.awaitResult(receipt.queueItemId, { timeoutMs: 4000 });

      const entries = await store.getEntries(session.id, thread.id);
      expect(entries.some((e) => e.type === "compaction"), name).toBe(expectCompacted);
      expect(events.some((e) => e.event.type === "compaction_start"), name).toBe(expectCompacted);
      expect(entries.some((e) => e.type === "message" && e.role === "assistant" && e.content === "reply"), name).toBe(true);
      expect(turnRequest.includes("x".repeat(1_000)), name).toBe(!expectCompacted);
      await thread.abort();
      faux.unregister();
    }
  });
});
