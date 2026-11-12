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
  type ResolvedModel,
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

  it("summarizes by repeating the turn's last request, so the prompt cache serves it", async () => {
    const { faux, store, events, session, thread } = await bigWindowSession("budget-cached-prefix", { contextBudgetTokens: 15_000, tailTurns: 1 });
    const seen: Array<{ systemPrompt: unknown; tools: string; messages: unknown[] }> = [];
    const record = (reply: ReturnType<typeof fauxAssistantMessage>) => (context: { systemPrompt?: unknown; tools?: unknown; messages: unknown[] }) => {
      seen.push({ systemPrompt: context.systemPrompt, tools: JSON.stringify(context.tools ?? []), messages: [...context.messages] });
      return reply;
    };
    faux.setResponses([
      record(fauxAssistantMessage("third response " + "y".repeat(16_000))),
      record(fauxAssistantMessage(COMPLETE_SUMMARY)),
    ]);

    const receipt = await session.prompt("third prompt", { channel: SLACK });
    await waitFor(() => events.some((e) => e.event.type === "compaction_end" && e.event.threadId === receipt.threadId));
    await thread.awaitResult(receipt.queueItemId, { timeoutMs: 4000 });

    expect(seen).toHaveLength(2);
    const [turn, summary] = seen;
    // Same system prompt and tools, and the turn's messages as a prefix.
    expect(summary.systemPrompt).toEqual(turn.systemPrompt);
    expect(summary.tools).toBe(turn.tools);
    expect(JSON.stringify(summary.messages.slice(0, turn.messages.length))).toBe(JSON.stringify(turn.messages));
    // Then the turn's response and the summary prompt.
    expect(JSON.stringify(summary.messages.at(-2))).toContain("third response");
    expect(JSON.stringify(summary.messages.at(-1))).toContain("Do not call any tools");
    const checkpoint = (await store.getEntries(session.id, thread.id)).find((e) => e.type === "compaction");
    expect(checkpoint?.type === "compaction" && checkpoint.coveredEntryIds).toEqual(expect.arrayContaining(["e-1", "e-2"]));
    expect(errorCodes(events)).toEqual([]);
    faux.unregister();
  });

  it("falls back to the bounded summarizer when the cached-prefix summary calls a tool", async () => {
    const { faux, store, events, session, thread } = await bigWindowSession("budget-prefix-fallback", { contextBudgetTokens: 15_000, tailTurns: 1 });
    let calls = 0;
    faux.setResponses([
      () => { calls++; return fauxAssistantMessage("third response " + "y".repeat(16_000)); },
      () => { calls++; return fauxAssistantMessage([fauxToolCall("lookup", {}, { id: "tc-1" })]); },
      () => { calls++; return fauxAssistantMessage(COMPLETE_SUMMARY); },
    ]);

    const receipt = await session.prompt("third prompt", { channel: SLACK });
    await waitFor(() => events.some((e) => e.event.type === "compaction_end" && e.event.threadId === receipt.threadId));
    await thread.awaitResult(receipt.queueItemId, { timeoutMs: 4000 });

    expect(calls).toBe(3);
    const checkpoints = (await store.getEntries(session.id, thread.id)).filter((e) => e.type === "compaction");
    expect(checkpoints).toHaveLength(1);
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

  it("reports a failed budget pass without opening the circuit breaker", async () => {
    const { faux, events, session, thread } = await bigWindowSession("budget-fails", { contextBudgetTokens: 15_000, tailTurns: 1, idleCompactionMs: 0 });
    const reply = () => fauxAssistantMessage("reply " + "y".repeat(16_000));
    const summarizerError = () => fauxAssistantMessage("", { stopReason: "error", errorMessage: "summarizer down" });
    // Three turns above the budget, and each turn-end pass fails. Three
    // failed overflow passes would open the breaker.
    faux.setResponses([reply, summarizerError, reply, summarizerError, reply, summarizerError]);

    for (const text of ["third prompt", "fourth prompt", "fifth prompt"]) {
      const receipt = await session.prompt(text, { channel: SLACK });
      await thread.awaitResult(receipt.queueItemId, { timeoutMs: 4000 });
    }
    await waitFor(() => errorCodes(events).filter((c) => c === "compaction_failed").length === 3);

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

describe("compaction budget: prune before a summary", () => {
  /** A Slack thread over its 15k budget: two old 10k-token tool outputs, plus `prose` characters of plain reply. */
  async function prunableThread(provider: string, prose: number) {
    const faux = registerFauxProvider({
      provider,
      models: [{ id: "big", name: "big", contextWindow: MILLION, maxTokens: 64_000 }],
    });
    const { engine, store, events } = makeEngine();
    const session = await engine.createSession({
      userId: "u", orgId: "o", workspace: "/", sandbox: {}, model: faux.getModel("big")!,
      compaction: { contextBudgetTokens: 15_000, tailTurns: 1, pruneProtectTokens: 1_000, pruneMinimumTokens: 1_000 },
    });
    const thread = session.thread();
    const toolTurn = (n: number, parent: string | null): SessionEntry[] => [
      { id: `u-${n}`, sessionId: session.id, threadId: thread.id, parentId: parent, type: "message", role: "user", content: `read log ${n}`, createdAt: n * 10 },
      { id: `a-${n}`, sessionId: session.id, threadId: thread.id, parentId: `u-${n}`, type: "message", role: "assistant", content: "", createdAt: n * 10 + 1,
        parts: [{ type: "tool_call", callId: `c-${n}`, toolName: "read", args: { path: `/log-${n}` }, status: "completed", result: { text: "line ".repeat(8_000) } }] },
    ];
    await store.appendEntries(session.id, thread.id, [
      { id: "u-0", sessionId: session.id, threadId: thread.id, parentId: null, type: "message", role: "user", content: "notes?", createdAt: 1 },
      { id: "a-0", sessionId: session.id, threadId: thread.id, parentId: "u-0", type: "message", role: "assistant", content: "n".repeat(prose), createdAt: 2 },
      ...toolTurn(1, "a-0"), ...toolTurn(2, "a-1"),
    ]);
    thread.rehydrateTranscript(await store.getEntries(session.id, thread.id));
    return { faux, store, events, session, thread };
  }

  it("ends the pass without a summary when clearing old tool output leaves headroom", async () => {
    const { faux, store, events, session, thread } = await prunableThread("prune-fits", 100);
    let calls = 0;
    faux.setResponses([
      () => { calls++; return fauxAssistantMessage("checked"); },
      () => { calls++; return fauxAssistantMessage(COMPLETE_SUMMARY); },
    ]);

    const receipt = await session.prompt("anything new?", { channel: SLACK });
    await thread.awaitResult(receipt.queueItemId, { timeoutMs: 4000 });
    await waitFor(() => !thread.hasActiveRun);

    const entries = await store.getEntries(session.id, thread.id);
    expect(calls).toBe(1);
    expect(entries.filter((e) => e.type === "compaction")).toHaveLength(0);
    const parts = entries.flatMap((e) => (e.type === "message" ? e.parts ?? [] : []));
    expect(parts.some((p) => p.type === "tool_call" && p.elided === true)).toBe(true);
    expect((await thread.contextUsage())!.tokens).toBeLessThan(15_000);
    expect(errorCodes(events)).toEqual([]);
    faux.unregister();
  });

  it("still summarizes when the prune leaves the context near the budget", async () => {
    // About 12.5k tokens of prose survive the prune: under the 15k budget,
    // over the 11.25k target that leaves a summary's headroom.
    const { faux, store, events, session, thread } = await prunableThread("prune-near-budget", 50_000);
    let summaries = 0;
    const respond = (context: { messages: readonly unknown[] }) => {
      const last = JSON.stringify(context.messages.at(-1));
      if (last.includes("compact this conversation") || last.includes("<template>")) {
        summaries++;
        return fauxAssistantMessage(COMPLETE_SUMMARY);
      }
      return fauxAssistantMessage("checked");
    };
    faux.setResponses([respond, respond, respond]);

    const receipt = await session.prompt("anything new?", { channel: SLACK });
    await thread.awaitResult(receipt.queueItemId, { timeoutMs: 4000 });
    await waitFor(() => !thread.hasActiveRun);

    expect(summaries).toBe(1);
    expect((await store.getEntries(session.id, thread.id)).filter((e) => e.type === "compaction")).toHaveLength(1);
    expect(errorCodes(events)).toEqual([]);
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

  it("keeps the transcript for an armed idle pass, so the pass reuses the cached prefix", async () => {
    // The host releases idle transcripts after 30 minutes and the idle pass
    // runs at 55. A released transcript has no last response to repeat, so
    // the pass fell back to the bounded summarizer at full input price.
    // Each resolution returns a new key, as after a rotation.
    let resolutions = 0;
    const { faux, store, events, session, thread } = await bigWindowSession(
      "budget-idle-keeps-transcript",
      { contextBudgetTokens: 15_000, tailTurns: 1, idleCompactionMs: 300 },
      { resolveModel: async (): Promise<ResolvedModel | null> => ({ model: faux.getModel("big")!, apiKey: `key-${resolutions++}` }) },
    );
    let summaryRequest = "";
    let summaryKey: string | undefined;
    faux.setResponses([
      () => fauxAssistantMessage("third response " + "y".repeat(16_000)),
      (context, opts) => { summaryRequest = JSON.stringify(context.messages.at(-1)); summaryKey = opts?.apiKey; return fauxAssistantMessage(COMPLETE_SUMMARY); },
    ]);

    const receipt = await session.prompt("third prompt");
    await thread.awaitResult(receipt.queueItemId, { timeoutMs: 4000 });
    await waitFor(() => !thread.hasActiveRun);
    await new Promise((r) => setTimeout(r, 50));
    // The host's idle sweep runs before the idle pass.
    expect(session.releaseIdleTranscripts(Date.now() + 1)).toBe(0);
    await waitFor(() => events.some((e) => e.event.type === "compaction_end" && e.event.threadId === receipt.threadId));
    await thread.kick();

    expect((await store.getEntries(session.id, thread.id)).filter((e) => e.type === "compaction")).toHaveLength(1);
    expect(summaryRequest).toContain("compact this conversation");
    expect(summaryKey).toBe(`key-${resolutions - 1}`);
    expect(summaryKey).not.toBe("key-0");
    expect(errorCodes(events)).toEqual([]);
    // With the pass done, a later sweep may release the transcript.
    expect(session.releaseIdleTranscripts(Date.now() + 1)).toBe(1);
    faux.unregister();
  });

  it("runs the idle pass with the key the model resolver supplies", async () => {
    // The turn clears its resolver key when it ends. The idle pass must
    // resolve the key again, or a session whose only key comes from the
    // resolver summarizes on ambient credentials.
    const seenKeys: Array<string | undefined> = [];
    const { faux, store, events, session, thread } = await bigWindowSession(
      "budget-idle-resolver-key",
      { contextBudgetTokens: 15_000, tailTurns: 1, idleCompactionMs: 50 },
      {
        resolveModel: async (): Promise<ResolvedModel | null> => ({ model: faux.getModel("big")!, apiKey: "org-key-idle" }),
      },
    );
    faux.setResponses([
      (_context, opts) => { seenKeys.push(opts?.apiKey); return fauxAssistantMessage("third response " + "y".repeat(16_000)); },
      (_context, opts) => { seenKeys.push(opts?.apiKey); return fauxAssistantMessage(COMPLETE_SUMMARY); },
    ]);

    const receipt = await session.prompt("third prompt");
    await thread.awaitResult(receipt.queueItemId, { timeoutMs: 4000 });
    await waitFor(() => events.some((e) => e.event.type === "compaction_end" && e.event.threadId === receipt.threadId));
    await thread.kick();

    expect((await store.getEntries(session.id, thread.id)).filter((e) => e.type === "compaction")).toHaveLength(1);
    expect(seenKeys).toEqual(["org-key-idle", "org-key-idle"]);
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

/** Text of the summarizer request: the last user message the summarizer received. */
function summaryRequestText(messages: readonly unknown[]): string {
  return JSON.stringify(messages.at(-1));
}

describe("compaction inside a running turn", () => {
  it("tells the summarizer the turn continues and that its own request is not a user message", async () => {
    // A 20k window: the tool result pushes the second request past the usable
    // context, so the context-preparation pass compacts inside the turn.
    const faux = registerFauxProvider({
      provider: "midturn-summary",
      models: [{ id: "small", name: "small", contextWindow: 20_000, maxTokens: 1_000 }],
    });
    const { engine, store, events } = makeEngine();
    const reactions: string[] = [];
    const tools: ToolDef[] = [{
      name: "add_reaction", description: "Adds a reaction to a post", parameters: Type.Object({}),
      execute: async () => { reactions.push("investigating"); return { text: "reaction added " + "r".repeat(30_000) }; },
    }];
    const session = await engine.createSession({
      userId: "u", orgId: "o", workspace: "/", sandbox: {}, model: faux.getModel("small")!,
      compaction: { reserveTokens: 1_000, tailTurns: 1, contextBudgetTokens: 0 },
      builtinTools: [], tools,
    });
    const thread = session.thread();
    await store.appendEntries(session.id, thread.id, [
      { id: "e-1", sessionId: session.id, threadId: thread.id, parentId: null, type: "message", role: "user", content: "The codename is Halyard.", createdAt: 1 },
      { id: "e-2", sessionId: session.id, threadId: thread.id, parentId: "e-1", type: "message", role: "assistant", content: "Noted. " + "x".repeat(50_000), createdAt: 2 },
    ]);
    thread.rehydrateTranscript(await store.getEntries(session.id, thread.id));
    let summaryRequest = "";
    faux.setResponses([
      () => fauxAssistantMessage([fauxToolCall("add_reaction", {})], { stopReason: "toolUse" }),
      (context) => { summaryRequest = summaryRequestText(context.messages); return fauxAssistantMessage(COMPLETE_SUMMARY); },
      () => fauxAssistantMessage("triage posted"),
    ]);

    const receipt = await session.prompt("triage the new post");
    const outcome = await thread.awaitResult(receipt.queueItemId, { timeoutMs: 4000 });

    expect(reactions).toEqual(["investigating"]);
    expect(JSON.stringify(outcome)).toContain("triage posted");
    expect((await store.getEntries(session.id, thread.id)).filter((e) => e.type === "compaction")).toHaveLength(1);
    expect(summaryRequest).toContain("comes from the system, not from the user");
    expect(summaryRequest).toContain("The newest turn is still running");
    expect(summaryRequest).toContain("this turn did it");
    expect(errorCodes(events)).toEqual([]);
    faux.unregister();
  });

  it("does not say the turn continues when the pass runs after the turn finished", async () => {
    const { faux, events, session, thread } = await bigWindowSession("turn-end-summary", { contextBudgetTokens: 15_000, tailTurns: 1 });
    let summaryRequest = "";
    faux.setResponses([
      () => fauxAssistantMessage("third response " + "y".repeat(16_000)),
      (context) => { summaryRequest = summaryRequestText(context.messages); return fauxAssistantMessage(COMPLETE_SUMMARY); },
    ]);

    const receipt = await session.prompt("third prompt", { channel: SLACK });
    await waitFor(() => events.some((e) => e.event.type === "compaction_end" && e.event.threadId === receipt.threadId));
    await thread.awaitResult(receipt.queueItemId, { timeoutMs: 4000 });

    expect(summaryRequest).toContain("comes from the system, not from the user");
    expect(summaryRequest).not.toContain("still running");
    faux.unregister();
  });
});
