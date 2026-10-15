import { describe, expect, it } from "vitest";
import {
  createAssistantMessageEventStream,
  fauxAssistantMessage,
  fauxThinking,
  fauxToolCall,
  registerApiProvider,
  registerFauxProvider,
  Type,
  type AssistantMessage,
} from "@earendil-works/pi-ai/compat";
import {
  completedSubmissionOutcome,
  Engine,
  InMemoryEventStream,
  InMemorySessionStore,
  MODEL_RESPONSE_METADATA_KEY,
  modelResponseMetadata,
  readModelResponseMetadata,
  VirtualSandboxProvider,
  type MessageEntry,
  type SessionEntry,
} from "../src/index.js";

function makeEngine() {
  const store = new InMemorySessionStore();
  const stream = new InMemoryEventStream();
  const engine = new Engine({ providers: { store, stream, sandboxProvider: new VirtualSandboxProvider() } });
  return { engine, store, stream };
}

const cases: Array<{
  name: string; content: AssistantMessage["content"] | string; stopReason: AssistantMessage["stopReason"];
  outcome: string; delta?: string;
}> = [
  { name: "normal text", content: "answer", stopReason: "stop", outcome: "completed" },
  { name: "empty", content: [], stopReason: "stop", outcome: "failed" },
  { name: "whitespace", content: " \n", stopReason: "stop", outcome: "failed" },
  { name: "thinking only", content: [fauxThinking("PRIVATE REASONING")], stopReason: "stop", outcome: "failed" },
  { name: "length with valid JSON", content: '{"answer":"partial"}', stopReason: "length", outcome: "failed" },
  { name: "error", content: "partial", stopReason: "error", outcome: "failed" },
  { name: "abort", content: "partial", stopReason: "aborted", outcome: "aborted" },
  { name: "stream/final mismatch", content: [], stopReason: "stop", outcome: "failed", delta: "streamed answer" },
];

describe("terminal result integrity", () => {
  it.each(cases)("validates $name without retrying the provider", async test => {
    const faux = registerFauxProvider({ provider: "terminal-integrity" });
    const model = faux.getModel();
    const message: AssistantMessage = {
      ...fauxAssistantMessage(test.content, { stopReason: test.stopReason, errorMessage: test.stopReason === "error" ? "invalid request" : undefined, responseId: "response-1" }),
      api: model.api, provider: model.provider, model: model.id, rawStopReason: "native-stop", endTurn: true,
      usage: { input: 2, output: 1810, cacheRead: 0, cacheWrite: 0, totalTokens: 1812,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    };
    let calls = 0;
    const stream = () => {
      calls++;
      const events = createAssistantMessageEventStream();
      const partial = { ...message, content: [] };
      events.push({ type: "start", partial });
      if (test.delta) {
        events.push({ type: "text_delta", contentIndex: 0, delta: test.delta,
          partial: { ...message, content: [{ type: "text", text: test.delta }] } });
      }
      if (message.stopReason === "error" || message.stopReason === "aborted") {
        events.push({ type: "error", reason: message.stopReason, error: message });
      } else {
        events.push({ type: "done", reason: message.stopReason === "length" ? "length" : "stop", message });
      }
      events.end(message);
      return events;
    };
    registerApiProvider({ api: faux.api, stream, streamSimple: stream });
    const { engine, store } = makeEngine();
    const session = await engine.createSession({ userId: "u", orgId: "o", workspace: "/", sandbox: {}, purpose: "workflow", model });
    try {
      const thread = session.thread("research");
      const receipt = await thread.submitPrompt("report", {});
      const result = await thread.awaitResult(receipt.queueItemId, { resultSchema: Type.Object({ answer: Type.String() }), timeoutMs: 2000 });
      expect(result.outcome).toBe(test.outcome);
      if (test.outcome !== "completed") expect(result.output).toBeUndefined();
      const item = await store.getQueueItem(session.id, receipt.queueItemId);
      expect(item).toMatchObject({ status: "settled", attemptCount: 1, outcome: { outcome: test.outcome } });
      const entries = await store.getEntries(session.id, receipt.threadId);
      const last = entries.filter((e): e is MessageEntry => e.type === "message" && e.role === "assistant").at(-1);
      expect(last?.usage?.output).toBe(1810);
      expect(last && readModelResponseMetadata(last)).toMatchObject({
        stopReason: test.stopReason, rawStopReason: "native-stop", provider: model.provider, api: model.api,
        responseId: "response-1", thinkingPresent: test.name === "thinking only",
        streamedTextLength: test.delta?.length ?? 0, effectiveMaxOutputTokens: null, requestId: null,
        providerTerminalStatus: null, incompleteReason: null,
      });
      expect(JSON.stringify(entries)).not.toContain("PRIVATE REASONING");
      expect(last?.content).not.toContain("streamed answer");
      await thread.awaitResult(receipt.queueItemId);
      await session.reconcile();
      expect(calls).toBe(1);
    } finally {
      session.suspendTimers();
      faux.unregister();
    }
  });

  it("rejects a historical empty completed row without changing its durable outcome", async () => {
    const faux = registerFauxProvider({ provider: "historical-empty" });
    faux.setResponses([fauxAssistantMessage("original answer")]);
    const { engine, store } = makeEngine();
    const session = await engine.createSession({ userId: "u", orgId: "o", workspace: "/", sandbox: {}, model: faux.getModel() });
    try {
      const thread = session.thread("research");
      const receipt = await thread.submitPrompt("report", {});
      expect(await thread.awaitResult(receipt.queueItemId)).toMatchObject({ outcome: "completed" });
      const entries = await store.getEntries(session.id, receipt.threadId);
      const last = entries.filter((e): e is MessageEntry => e.type === "message" && e.role === "assistant").at(-1);
      if (!last) throw new Error("missing terminal entry");
      await store.updateEntry(session.id, receipt.threadId, { ...last, content: "", parts: [], metadata: undefined });
      expect(await thread.awaitResult(receipt.queueItemId, { resultSchema: Type.Object({ answer: Type.String() }) }))
        .toMatchObject({ outcome: "failed", error: expect.stringContaining("no terminal text") });
      expect((await store.getQueueItem(session.id, receipt.queueItemId))?.outcome).toEqual({ outcome: "completed" });
      expect(faux.state.callCount).toBe(1);
    } finally { session.suspendTimers(); faux.unregister(); }
  });

  it("does not repeat a side effect after an empty terminal response", async () => {
    const faux = registerFauxProvider({ provider: "terminal-side-effect" });
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("effect", {}, { id: "effect-1" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxThinking("PRIVATE REASONING")]),
    ]);
    let effects = 0;
    const { engine, store } = makeEngine();
    const session = await engine.createSession({ userId: "u", orgId: "o", workspace: "/", sandbox: {}, purpose: "workflow", model: faux.getModel(),
      tools: [{ name: "effect", description: "record effect", parameters: Type.Object({}), execute: async () => { effects++; return { text: "effect recorded" }; } }] });
    try {
      const thread = session.thread("research");
      const receipt = await thread.submitPrompt("run effect", {});
      expect(await thread.awaitResult(receipt.queueItemId)).toMatchObject({ outcome: "failed", error: expect.stringContaining("no terminal text") });
      await session.reconcile();
      expect(effects).toBe(1);
      expect(faux.state.callCount).toBe(2);
      const entries = await store.getEntries(session.id, receipt.threadId);
      const call = entries.filter((e): e is MessageEntry => e.type === "message").flatMap(e => e.parts ?? []).find(p => p.type === "tool_call");
      expect(call).toMatchObject({ status: "completed", result: { text: "effect recorded" } });
    } finally {
      session.suspendTimers();
      faux.unregister();
    }
  });
});

function entry(id: string, queueItemId: string, content: string, extra: Partial<MessageEntry> = {}): MessageEntry {
  return { id, sessionId: "s", threadId: "t", parentId: null, createdAt: 1,
    type: "message", role: "assistant", queueItemId, content, stopReason: "end_turn", ...extra };
}

it("rejects the last empty response without substituting earlier output across compaction or repair queues", () => {
  const entries: SessionEntry[] = [
    entry("original-answer", "original", '{"answer":"earlier"}'),
    entry("repair-blank-early", "repair", ""),
    { id: "compact", sessionId: "s", threadId: "t", parentId: null, createdAt: 2, type: "compaction",
      summary: "summary", coveredEntryIds: ["original-answer", "repair-blank-early"], tokenCountBefore: 100, tokenCountAfter: 10 },
    entry("repair-blank-selected", "repair", ""),
  ];
  expect(completedSubmissionOutcome(entries, "original")).toEqual({ outcome: "completed" });
  expect(completedSubmissionOutcome(entries, "repair")).toMatchObject({ outcome: "failed" });
  entries.push(entry("original-blank", "original", ""));
  expect(completedSubmissionOutcome(entries, "original")).toMatchObject({ outcome: "failed" });
  expect(completedSubmissionOutcome(entries, "missing")).toMatchObject({ outcome: "failed" });
});

it("bounds and allowlists response metadata without private response fields", () => {
  const message = { ...fauxAssistantMessage([fauxThinking("SECRET")]), responseId: "r".repeat(1000) };
  const metadata = modelResponseMetadata(message, 4, 123);
  const stored = entry("e", "q", "", { metadata: { [MODEL_RESPONSE_METADATA_KEY]: { ...metadata, thinking: "SECRET", blockTypes: ["thinking", "SECRET"] } } });
  const result = readModelResponseMetadata(stored);
  expect(result).toMatchObject({ thinkingPresent: true, blockTypes: ["thinking"], textLength: 0, requestedMaxOutputTokens: 123 });
  expect(result?.responseId?.length).toBe(200);
  expect(JSON.stringify(result)).not.toContain("SECRET");
  expect(readModelResponseMetadata(entry("old", "q", ""))).toBeNull();
});
