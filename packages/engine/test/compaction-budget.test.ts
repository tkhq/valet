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
import { compactionBudget, selectCutPoint, usableTokens } from "../src/compaction.js";
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

/** A 1M-window session with two finished turns of history (about 12.5k tokens, under a 15k budget). */
async function bigWindowSession(
  provider: string,
  compaction: CompactionConfig,
  extra: Partial<CreateSessionOptions> = {},
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
    { id: "e-1", sessionId: session.id, threadId: thread.id, parentId: null, type: "message", role: "user", content: "The codename is Halyard.", createdAt: 1 },
    { id: "e-2", sessionId: session.id, threadId: thread.id, parentId: "e-1", type: "message", role: "assistant", content: "Noted. " + "x".repeat(50_000), createdAt: 2 },
    { id: "e-3", sessionId: session.id, threadId: thread.id, parentId: "e-2", type: "message", role: "user", content: "second prompt", createdAt: 3 },
    { id: "e-4", sessionId: session.id, threadId: thread.id, parentId: "e-3", type: "message", role: "assistant", content: "second response", createdAt: 4 },
  ]);
  thread.rehydrateTranscript(await store.getEntries(session.id, thread.id));
  return { faux, store, events, session, thread };
}

const errorCodes = (events: BusEvent[]) =>
  events.flatMap((e) => (e.event.type === "error" ? [e.event.code] : []));

describe("compaction budget: a finished turn above the budget", () => {
  it("compacts a 1M-window thread at the budget without a continuation call", async () => {
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

    const receipt = await session.prompt("third prompt");
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
    const { faux, events, session, thread } = await bigWindowSession("budget-next-request", { contextBudgetTokens: 15_000, tailTurns: 1 });
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
      compaction: { contextBudgetTokens: 2_000 },
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
