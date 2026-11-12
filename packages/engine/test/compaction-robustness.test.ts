/**
 * Compaction robustness: the breaker gates the reactive retry, a manual
 * /compact waits for the running turn and holds the drive lock, and the
 * bounded summarizer reads a head oldest first.
 */
import { describe, it, expect } from "vitest";
import { fauxAssistantMessage, registerFauxProvider, type AssistantMessage } from "@earendil-works/pi-ai/compat";
import {
  Engine,
  InMemoryEventStream,
  InMemorySessionStore,
  VirtualSandboxProvider,
  type BusEvent,
  type SessionEntry,
} from "../src/index.js";
import { reactiveRetryAllowed } from "../src/thread.js";
import { selectSummaryCheckpointHead } from "../src/compaction.js";
import { COMPLETE_SUMMARY } from "./fixtures/compaction-summary.js";

async function waitFor(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("reactiveRetryAllowed", () => {
  const overflow: AssistantMessage = {
    role: "assistant", content: [], api: "faux", provider: "faux", model: "m", stopReason: "error",
    errorMessage: "prompt is too long: 100 tokens > 50 maximum",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    timestamp: 1,
  };

  it("retries an overflow while the breaker is closed, and not once it is open", () => {
    expect(reactiveRetryAllowed({ retryInProgress: false, compactionFailures: 2, contextWindow: 50 }, overflow)).toBe(true);
    expect(reactiveRetryAllowed({ retryInProgress: false, compactionFailures: 3, contextWindow: 50 }, overflow)).toBe(false);
    expect(reactiveRetryAllowed({ retryInProgress: true, compactionFailures: 0, contextWindow: 50 }, overflow)).toBe(false);
    expect(reactiveRetryAllowed({ retryInProgress: false, compactionFailures: 0, contextWindow: 50 }, { ...overflow, stopReason: "stop" })).toBe(false);
  });
});

describe("selectSummaryCheckpointHead", () => {
  const entry = (id: string, size: number): SessionEntry => ({
    id, sessionId: "s", threadId: "t", parentId: null, type: "message", role: "user", content: "x".repeat(size), createdAt: 1,
  });
  const sizeOf = (e: SessionEntry) => (e.type === "message" ? e.content.length : 0);

  it("takes the oldest entries that fit", () => {
    expect(selectSummaryCheckpointHead([entry("a", 40), entry("b", 40), entry("c", 40)], 100, { sizeOf }).map((e) => e.id)).toEqual(["a", "b"]);
  });

  it("takes an oversized first entry alone, then the zero-cost entries after it", () => {
    expect(selectSummaryCheckpointHead([entry("big", 500), entry("free", 0), entry("c", 10)], 100, { sizeOf }).map((e) => e.id)).toEqual(["big", "free"]);
  });
});

describe("manual /compact during a turn", () => {
  it("waits for the running turn to end before it compacts", async () => {
    const faux = registerFauxProvider({ provider: "compact-waits", models: [{ id: "big", name: "big", contextWindow: 1_000_000, maxTokens: 64_000 }] });
    const store = new InMemorySessionStore();
    const bus = new InMemoryEventStream();
    const order: string[] = [];
    bus.subscribe({}, (e: BusEvent) => {
      if (e.event.type === "compaction_start" || e.event.type === "turn_end") order.push(e.event.type);
    });
    const engine = new Engine({ providers: { store, stream: bus, sandboxProvider: new VirtualSandboxProvider() } });
    const session = await engine.createSession({
      userId: "u", orgId: "o", workspace: "/", sandbox: {}, model: faux.getModel("big")!,
      compaction: { tailTurns: 1, autoContinue: false, contextBudgetTokens: 0 },
    });
    const thread = session.thread();
    await store.appendEntries(session.id, thread.id, [
      { id: "e-1", sessionId: session.id, threadId: thread.id, parentId: null, type: "message", role: "user", content: "earlier prompt", createdAt: 1 },
      { id: "e-2", sessionId: session.id, threadId: thread.id, parentId: "e-1", type: "message", role: "assistant", content: "earlier reply", createdAt: 2 },
    ]);
    thread.rehydrateTranscript(await store.getEntries(session.id, thread.id));
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let started!: () => void;
    const running = new Promise<void>((resolve) => { started = resolve; });
    faux.setResponses([
      async () => { started(); await held; return fauxAssistantMessage("turn reply"); },
      fauxAssistantMessage(COMPLETE_SUMMARY),
    ]);

    const turn = await session.prompt("long task");
    await running;
    const command = await session.prompt("/compact");
    // The command answers at once and leaves the pass for after the turn.
    expect(command.command?.name).toBe("compact");
    await new Promise((r) => setTimeout(r, 600));
    expect(order).toEqual([]);

    release();
    await thread.awaitResult(turn.queueItemId, { timeoutMs: 4000 });
    await waitFor(() => order.includes("compaction_start"));
    let entries: SessionEntry[] = [];
    await waitFor(() => { void store.getEntries(session.id, thread.id).then((e) => { entries = e; }); return entries.some((e) => e.type === "command_result"); });

    expect(order).toEqual(["turn_end", "compaction_start"]);
    // The turn reply was persisted before the pass.
    const reply = entries.find((e) => e.type === "message" && e.role === "assistant" && e.content.includes("turn reply"));
    expect(reply).toBeDefined();
    const result = entries.find((e) => e.type === "command_result");
    expect(result?.type === "command_result" && result.ok).toBe(true);
    faux.unregister();
  });
});
