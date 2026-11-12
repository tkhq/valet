/**
 * A compaction inside a running turn can summarize the start of that turn,
 * including its own prompt. The next model request must still carry the
 * prompt word for word and a list of the calls the turn already made, so
 * the resumed turn does not answer with a summary or repeat a side effect.
 * A pass after the turn ends must not bring the finished prompt back.
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
import { mergeTurnCalls, turnCallLines, turnCallsNote } from "../src/thread.js";
import { COMPLETE_SUMMARY } from "./fixtures/compaction-summary.js";

const PROMPT = "Triage alert 4711 in #alerts and reply in its thread.";

function makeEngine() {
  const store = new InMemorySessionStore();
  const bus = new InMemoryEventStream();
  const events: BusEvent[] = [];
  bus.subscribe({}, (e) => events.push(e));
  const engine = new Engine({ providers: { store, stream: bus, sandboxProvider: new VirtualSandboxProvider() } });
  return { engine, store, events };
}

function text(context: Context): string {
  return JSON.stringify(context.messages);
}

/** The summarizer's request: the cached-prefix prompt or the bounded summarizer's template. */
function isSummaryRequest(context: Context): boolean {
  const last = JSON.stringify(context.messages.at(-1));
  return last.includes("compact this conversation") || last.includes("<template>");
}

describe("compaction inside a running turn keeps the turn's task", () => {
  it("sends the prompt verbatim and the calls already made in the next request", async () => {
    const faux = registerFauxProvider({
      provider: "running-task",
      models: [{ id: "small", name: "small", contextWindow: 20_000, maxTokens: 1_000 }],
    });
    const { engine, store, events } = makeEngine();
    const calls: string[] = [];
    const tools: ToolDef[] = [
      {
        name: "add_reaction", description: "Adds a reaction to a post",
        parameters: Type.Object({ name: Type.String(), ts: Type.String() }),
        execute: async (args) => { calls.push(`add_reaction ${JSON.stringify(args)}`); return { text: "reaction added" }; },
      },
      {
        name: "query_logs", description: "Reads log lines",
        parameters: Type.Object({ query: Type.String() }),
        execute: async (args) => { calls.push(`query_logs ${JSON.stringify(args)}`); return { text: "log line ".repeat(700) }; },
      },
    ];
    const session = await engine.createSession({
      userId: "u", orgId: "o", workspace: "/", sandbox: {}, model: faux.getModel("small")!,
      compaction: { reserveTokens: 1_000, tailTurns: 1, contextBudgetTokens: 0 },
      builtinTools: [], tools,
    });
    const thread = session.thread();
    await store.appendEntries(session.id, thread.id, [
      { id: "e-1", sessionId: session.id, threadId: thread.id, parentId: null, type: "message", role: "user", content: "Earlier alert.", createdAt: 1 },
      { id: "e-2", sessionId: session.id, threadId: thread.id, parentId: "e-1", type: "message", role: "assistant", content: "Handled. " + "x".repeat(30_000), createdAt: 2 },
    ]);
    thread.rehydrateTranscript(await store.getEntries(session.id, thread.id));

    // The model reacts once, then reads logs until a summary appears in its
    // context. The first request after the summary is the one under test.
    let afterSummary: Context | undefined;
    let nextTurn: Context | undefined;
    let toolCalls = 0;
    const respond = (context: Context) => {
      if (isSummaryRequest(context)) return fauxAssistantMessage(COMPLETE_SUMMARY);
      if (JSON.stringify(context.messages.at(-1)).includes("What is 2+2?")) {
        nextTurn = structuredClone(context);
        return fauxAssistantMessage("4");
      }
      if (text(context).includes("<previous-context>")) {
        afterSummary ??= structuredClone(context);
        return fauxAssistantMessage("Posted the triage reply.");
      }
      toolCalls++;
      return toolCalls === 1
        ? fauxAssistantMessage([fauxToolCall("add_reaction", { name: "investigating", ts: "1700000000.000100" })], { stopReason: "toolUse" })
        : fauxAssistantMessage([fauxToolCall("query_logs", { query: `errors ${toolCalls}` })], { stopReason: "toolUse" });
    };
    faux.setResponses(Array.from({ length: 30 }, () => respond));

    const receipt = await session.prompt(PROMPT);
    const outcome = await thread.awaitResult(receipt.queueItemId, { timeoutMs: 8000 });

    expect(JSON.stringify(outcome)).toContain("Posted the triage reply.");
    expect(calls.filter((call) => call.startsWith("add_reaction"))).toHaveLength(1);
    const compactions = (await store.getEntries(session.id, thread.id)).filter((e): e is Extract<SessionEntry, { type: "compaction" }> => e.type === "compaction");
    expect(compactions.length).toBeGreaterThan(0);
    // The pass covered the turn's own prompt: this is the case under test.
    const promptEntry = (await store.getEntries(session.id, thread.id)).find((e) => e.type === "message" && e.role === "user" && e.queueItemId === receipt.queueItemId);
    expect(compactions[0]!.coveredEntryIds).toContain(promptEntry!.id);

    const request = afterSummary!;
    const userTexts = request.messages.filter((m) => m.role === "user").map((m) => JSON.stringify(m.content));
    const summaryAt = userTexts.findIndex((t) => t.includes("<previous-context>"));
    const promptAt = userTexts.findIndex((t) => t.includes(PROMPT));
    expect(summaryAt).toBeGreaterThanOrEqual(0);
    expect(promptAt).toBeGreaterThan(summaryAt);
    const note = userTexts.find((t) => t.includes("[Compaction note]"));
    expect(note).toBeDefined();
    expect(note).toContain("add_reaction");
    expect(note).toContain("investigating");
    expect(note).toContain("1700000000.000100");

    // The next, unrelated turn reads the summary, not the old request and
    // its "still in progress" note.
    const next = await session.prompt("What is 2+2?");
    await thread.awaitResult(next.queueItemId, { timeoutMs: 4000 });
    const nextText = JSON.stringify(nextTurn!.messages);
    expect(nextText).not.toContain(PROMPT);
    expect(nextText).not.toContain("[Compaction note]");
    expect(nextText).toContain("<previous-context>");
    expect(events.filter((e) => e.event.type === "error")).toEqual([]);
    faux.unregister();
  });
});

describe("turn call notes", () => {
  const assistant = (id: string, queueItemId: string, parts: NonNullable<Extract<SessionEntry, { type: "message" }>["parts"]>): SessionEntry => ({
    id, sessionId: "s", threadId: "t", parentId: null, type: "message", role: "assistant", content: "", parts, queueItemId, createdAt: 1,
  });

  it("lists the turn's finished calls with short arguments and leaves out silent tools and other turns", () => {
    const lines = turnCallLines([
      assistant("a1", "q1", [
        { type: "tool_call", callId: "c1", toolName: "post_message", args: { text: "y".repeat(500) }, status: "completed", result: "ok" },
        { type: "tool_call", callId: "c2", toolName: "read", args: { path: "/a" }, status: "completed", result: "ok" },
        { type: "tool_call", callId: "c3", toolName: "write", args: { path: "/b" }, status: "error", result: "denied" },
        { type: "tool_call", callId: "c4", toolName: "bash", args: { command: "sleep 9" }, status: "running" },
      ]),
      assistant("a0", "q0", [{ type: "tool_call", callId: "c0", toolName: "post_message", args: { text: "older turn" }, status: "completed", result: "ok" }]),
    ], "q1", new Set(["read"]));
    expect(lines).toEqual([
      "- post_message {\"text\":\"" + "y".repeat(80) + "…\"}",
      "- write {\"path\":\"/b\"} (failed)",
    ]);
  });

  it("keeps the first and newest calls across passes and counts the rest", () => {
    const line = (n: number) => `- post {"n":${n}}`;
    let calls = mergeTurnCalls(undefined, "q1", Array.from({ length: 25 }, (_, n) => line(n)));
    expect(calls.omitted).toBe(0);
    calls = mergeTurnCalls(calls, "q1", Array.from({ length: 20 }, (_, n) => line(25 + n)));
    const note = turnCallsNote(calls)!;
    expect(note).toContain(line(0));
    expect(note).toContain(line(9));
    expect(note).not.toContain(line(10) + "\n");
    expect(note).toContain("15 more calls");
    expect(note).toContain(line(44));
    // Another turn's record starts over.
    expect(mergeTurnCalls(calls, "q2", [line(99)])).toEqual({ queueItemId: "q2", first: [line(99)], last: [], omitted: 0 });
  });

  it("returns no note when the turn made no listed call", () => {
    expect(turnCallsNote({ queueItemId: "q1", first: [], last: [], omitted: 0 })).toBeUndefined();
  });
});
