/**
 * Two parts of one change. A reload restores the usage anchor from the
 * newest response's stored usage, so the estimate counts tool definitions
 * and real tokens again. A thread whose runs use fresh context is bounded
 * by a checkpoint with a fixed note, not by LLM summaries of history no run
 * reads, and a pass inside such a turn summarizes only the turn's own work.
 */
import { describe, it, expect } from "vitest";
import { fauxAssistantMessage, registerFauxProvider, Type, type Context } from "@earendil-works/pi-ai/compat";
import { fauxToolCall } from "../src/test-helpers/tool-intent.js";
import {
  Engine,
  InMemoryEventStream,
  InMemorySessionStore,
  VirtualSandboxProvider,
  type BusEvent,
  type SessionEntry,
  type ToolDef,
} from "../src/index.js";
import { usageAnchorEntryId } from "../src/thread.js";
import { FRESH_CONTEXT_KEY, PRUNED_AT_KEY } from "../src/types.js";
import { COMPLETE_SUMMARY } from "./fixtures/compaction-summary.js";

const MILLION = 1_000_000;
const OLD_RUN = "OLD_RUN_MARKER";
const SLACK = { channelType: "slack", channelId: "C1" } as const;

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

const errorCodes = (events: BusEvent[]) => events.flatMap((e) => (e.event.type === "error" ? [e.event.code] : []));

function message(id: string, role: "user" | "assistant", extra: Partial<Extract<SessionEntry, { type: "message" }>> = {}): SessionEntry {
  return { id, sessionId: "s", threadId: "t", parentId: null, type: "message", role, content: id, createdAt: 10, ...extra };
}
const usage = (total: number) => ({ input: total - 10, output: 10, cacheRead: 0, cacheWrite: 0, total });

describe("usageAnchorEntryId", () => {
  it("picks the newest response with stored usage", () => {
    expect(usageAnchorEntryId([message("u", "user"), message("a1", "assistant", { usage: usage(500) }), message("a2", "assistant", { usage: usage(900) })])).toBe("a2");
  });

  it("refuses a response older than the newest checkpoint", () => {
    const checkpoint: SessionEntry = { id: "c", sessionId: "s", threadId: "t", parentId: null, type: "compaction", summary: "s", coveredEntryIds: ["u"], tokenCountBefore: 1, tokenCountAfter: 1, createdAt: 20 };
    expect(usageAnchorEntryId([message("u", "user"), message("a", "assistant", { usage: usage(900) }), checkpoint], new Set(["u"]))).toBeUndefined();
  });

  it("refuses a response a later prune made stale, and a fresh-context slice", () => {
    expect(usageAnchorEntryId([
      message("a0", "assistant", { metadata: { [PRUNED_AT_KEY]: 30 } }),
      message("a1", "assistant", { usage: usage(900), createdAt: 20 }),
    ])).toBeUndefined();
    expect(usageAnchorEntryId([
      message("a0", "assistant", { metadata: { [PRUNED_AT_KEY]: 5 } }),
      message("a1", "assistant", { usage: usage(900), createdAt: 20 }),
    ])).toBe("a1");
    expect(usageAnchorEntryId([message("a", "assistant", { usage: usage(900), metadata: { [FRESH_CONTEXT_KEY]: true } })])).toBeUndefined();
  });

  it("never falls back to an older response", () => {
    expect(usageAnchorEntryId([message("a1", "assistant", { usage: usage(900) }), message("a2", "assistant")])).toBeUndefined();
  });
});

describe("usage anchor after a reload", () => {
  it("measures a reloaded thread from the newest response's stored usage", async () => {
    // The stored response read 150k tokens: the tool definitions and system
    // prompt the character ruler cannot see. A reload used to measure a few
    // hundred.
    const faux = registerFauxProvider({ provider: "anchor-reload", models: [{ id: "big", name: "big", contextWindow: MILLION, maxTokens: 64_000 }] });
    const { engine, store } = makeEngine();
    const session = await engine.createSession({ userId: "u", orgId: "o", workspace: "/", sandbox: {}, model: faux.getModel("big")! });
    const thread = session.thread();
    await store.appendEntries(session.id, thread.id, [
      { id: "e-1", sessionId: session.id, threadId: thread.id, parentId: null, type: "message", role: "user", content: "hello", createdAt: 1 },
      { id: "e-2", sessionId: session.id, threadId: thread.id, parentId: "e-1", type: "message", role: "assistant", content: "hi", createdAt: 2, usage: usage(150_000) },
    ]);
    thread.rehydrateTranscript(await store.getEntries(session.id, thread.id));
    const measured = (await thread.contextUsage())!.tokens;
    expect(measured).toBeGreaterThanOrEqual(150_000);
    expect(measured).toBeLessThan(151_000);
    faux.unregister();
  });
});

describe("fresh-context threads", () => {
  async function freshThread(provider: string, contextWindow: number, compaction: Record<string, number>, opts: { personWrote?: boolean; maxTokens?: number } = {}) {
    const faux = registerFauxProvider({ provider, models: [{ id: "m", name: "m", contextWindow, maxTokens: opts.maxTokens ?? 1_000 }] });
    const { engine, store, events } = makeEngine();
    const posts: string[] = [];
    const tools: ToolDef[] = [
      { name: "post", description: "Posts a message", parameters: Type.Object({ text: Type.String() }), execute: async (args) => { posts.push(JSON.stringify(args)); return { text: "posted" }; } },
      { name: "query_logs", description: "Reads log lines", parameters: Type.Object({ query: Type.String() }), execute: async () => ({ text: "log line ".repeat(700) }) },
    ];
    const session = await engine.createSession({ userId: "u", orgId: "o", workspace: "/", sandbox: {}, model: faux.getModel("m")!, compaction, builtinTools: [], tools });
    const thread = session.thread();
    await store.appendEntries(session.id, thread.id, [
      { id: "e-1", sessionId: session.id, threadId: thread.id, parentId: null, type: "message", role: "user", content: `${OLD_RUN} delivery`, createdAt: 1,
        ...(opts.personWrote ? {} : { signal: { signalType: "slack.bot_message", tagName: "signal" } }) },
      { id: "e-2", sessionId: session.id, threadId: thread.id, parentId: "e-1", type: "message", role: "assistant", content: `${OLD_RUN} handled. ` + "x".repeat(50_000), createdAt: 2 },
    ]);
    thread.rehydrateTranscript(await store.getEntries(session.id, thread.id));
    return { faux, store, events, session, thread, posts };
  }

  it("covers history no run reads with a fixed note after the turn, with no summary call", async () => {
    const { faux, store, events, session, thread } = await freshThread("fresh-after-turn", MILLION, { contextBudgetTokens: 15_000, tailTurns: 1 });
    let calls = 0;
    faux.setResponses([
      () => { calls++; return fauxAssistantMessage("run done " + "y".repeat(16_000)); },
      () => { calls++; return fauxAssistantMessage(COMPLETE_SUMMARY); },
    ]);

    const receipt = await session.prompt("new delivery", { channel: SLACK, metadata: { [FRESH_CONTEXT_KEY]: true } });
    await thread.awaitResult(receipt.queueItemId, { timeoutMs: 4000 });
    await waitFor(() => !thread.hasActiveRun);

    const entries = await store.getEntries(session.id, thread.id);
    const checkpoints = entries.filter((e): e is Extract<SessionEntry, { type: "compaction" }> => e.type === "compaction");
    expect(calls).toBe(1);
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0]!.summary).toContain("Earlier automated runs");
    expect(checkpoints[0]!.coveredEntryIds).toEqual(expect.arrayContaining(["e-1", "e-2"]));
    expect((await thread.contextUsage())!.tokens).toBeLessThan(15_000);
    expect(errorCodes(events)).toEqual([]);
    faux.unregister();
  });

  it("summarizes history a person wrote instead of covering it with the note", async () => {
    const { faux, store, session, thread } = await freshThread("fresh-person", MILLION, { contextBudgetTokens: 15_000, tailTurns: 1 }, { personWrote: true });
    let summaries = 0;
    faux.setResponses(Array.from({ length: 2 }, () => (context: Context) => {
      const last = JSON.stringify(context.messages.at(-1));
      if (last.includes("compact this conversation") || last.includes("<template>")) { summaries++; return fauxAssistantMessage(COMPLETE_SUMMARY); }
      return fauxAssistantMessage("run done " + "y".repeat(16_000));
    }));

    const receipt = await session.prompt({ kind: "signal", signalType: "slack.bot_message", body: "new delivery" }, { channel: SLACK, metadata: { [FRESH_CONTEXT_KEY]: true } });
    await thread.awaitResult(receipt.queueItemId, { timeoutMs: 4000 });
    await waitFor(() => !thread.hasActiveRun);

    const checkpoints = (await store.getEntries(session.id, thread.id)).filter((e): e is Extract<SessionEntry, { type: "compaction" }> => e.type === "compaction");
    expect(summaries).toBe(1);
    expect(checkpoints.at(-1)!.summary).not.toContain("Earlier automated runs");

    // A later delivery covers the automated run with the note and keeps the
    // person's summary ahead of it.
    faux.appendResponses(Array.from({ length: 3 }, () => (context: Context) => {
      const last = JSON.stringify(context.messages.at(-1));
      if (last.includes("compact this conversation") || last.includes("<template>")) { summaries++; return fauxAssistantMessage(COMPLETE_SUMMARY); }
      return fauxAssistantMessage("run done " + "y".repeat(60_000));
    }));
    const second = await session.prompt({ kind: "signal", signalType: "slack.bot_message", body: "second delivery" }, { channel: SLACK, metadata: { [FRESH_CONTEXT_KEY]: true } });
    await thread.awaitResult(second.queueItemId, { timeoutMs: 4000 });
    await waitFor(() => !thread.hasActiveRun);
    const all = await store.getEntries(session.id, thread.id);
    const latest = all.filter((e): e is Extract<SessionEntry, { type: "compaction" }> => e.type === "compaction").at(-1)!;
    expect(latest.summary).toContain("Earlier automated runs");
    expect(latest.summary).toContain("## Goal");
    expect(latest.summary.match(/Earlier automated runs/g)).toHaveLength(1);
    faux.unregister();
  });

  it("does not continue a finished fresh-context turn after the note pass on a 200k model", async () => {
    // usable = 200k - 20k = 180k, under the 200k budget cap, so the post-turn
    // trigger reads "overflow", which continues a turn by default.
    const { faux, store, session, thread } = await freshThread("fresh-no-continue", 200_000, { tailTurns: 1 }, { maxTokens: 20_000 });
    await store.appendEntries(session.id, thread.id, [
      { id: "e-3", sessionId: session.id, threadId: thread.id, parentId: "e-2", type: "message", role: "user", content: "older delivery", createdAt: 3, signal: { signalType: "slack.bot_message", tagName: "signal" } },
      { id: "e-4", sessionId: session.id, threadId: thread.id, parentId: "e-3", type: "message", role: "assistant", content: "z".repeat(620_000), createdAt: 4 },
    ]);
    thread.rehydrateTranscript(await store.getEntries(session.id, thread.id));
    let calls = 0;
    faux.setResponses(Array.from({ length: 3 }, () => () => { calls++; return fauxAssistantMessage("run done " + "y".repeat(60_000)); }));

    const receipt = await session.prompt("new delivery", { channel: SLACK, metadata: { [FRESH_CONTEXT_KEY]: true } });
    await thread.awaitResult(receipt.queueItemId, { timeoutMs: 4000 });
    await waitFor(() => !thread.hasActiveRun);
    await new Promise((r) => setTimeout(r, 50));

    const entries = await store.getEntries(session.id, thread.id);
    expect(entries.filter((e) => e.type === "compaction").length).toBeGreaterThan(0);
    expect(calls).toBe(1);
    expect(entries.filter((e) => e.type === "message" && e.role === "user")).toHaveLength(3);
    faux.unregister();
  });

  it("summarizes only the turn's own work inside a fresh-context turn and sends no earlier run", async () => {
    // A 20k window: the turn's own log reads cross it, so context
    // preparation compacts inside the turn.
    const { faux, store, events, session, thread, posts } = await freshThread("fresh-in-turn", 20_000, { reserveTokens: 1_000, tailTurns: 1, contextBudgetTokens: 0 });
    let summaryInput = "";
    let afterSummary: Context | undefined;
    let reads = 0;
    const respond = (context: Context) => {
      const text = JSON.stringify(context.messages);
      const last = JSON.stringify(context.messages.at(-1));
      if (last.includes("compact this conversation") || last.includes("<template>")) {
        summaryInput = text;
        return fauxAssistantMessage(COMPLETE_SUMMARY);
      }
      if (last.includes("posted")) return fauxAssistantMessage("done");
      if (text.includes("<previous-context>")) {
        afterSummary ??= structuredClone(context);
        return fauxAssistantMessage([fauxToolCall("post", { text: "triage" })], { stopReason: "toolUse" });
      }
      reads++;
      return fauxAssistantMessage([fauxToolCall("query_logs", { query: `q${reads}` })], { stopReason: "toolUse" });
    };
    faux.setResponses(Array.from({ length: 30 }, () => respond));

    const receipt = await session.prompt("Triage the alert: read logs until a summary appears, then post.", { channel: SLACK, metadata: { [FRESH_CONTEXT_KEY]: true } });
    const outcome = await thread.awaitResult(receipt.queueItemId, { timeoutMs: 8000 });

    expect(outcome.outcome).toBe("completed");
    const checkpoints = (await store.getEntries(session.id, thread.id)).filter((e) => e.type === "compaction");
    expect(checkpoints.length).toBeGreaterThan(0);
    // The summarizer read the turn's own work, not the earlier run.
    expect(summaryInput).not.toBe("");
    expect(summaryInput).not.toContain(OLD_RUN);
    // No request after the summary carries the earlier run.
    expect(JSON.stringify(afterSummary?.messages ?? [])).not.toContain(OLD_RUN);
    expect(posts).toHaveLength(1);
    expect(errorCodes(events)).toEqual([]);
    faux.unregister();
  });
});
