import { describe, it, expect } from "vitest";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import {
  Engine,
  InMemoryEventStream,
  InMemorySessionStore,
  VirtualSandboxProvider,
  buildSpilledInputMarker,
  entriesToAgentMessages,
  inputSpillThreshold,
  type BusEvent,
  type MessageEntry,
} from "../src/index.js";

function makeEngine() {
  const store = new InMemorySessionStore();
  const bus = new InMemoryEventStream();
  const sandboxProvider = new VirtualSandboxProvider();
  const events: BusEvent[] = [];
  bus.subscribe({}, (e) => events.push(e));
  const engine = new Engine({ providers: { store, stream: bus, sandboxProvider } });
  return { engine, store, bus, events };
}

async function waitForStatus(
  events: BusEvent[],
  threadId: string,
  status: string,
  timeoutMs = 2000,
): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const found = events.some(
        (e) =>
          e.event.type === "status" &&
          e.event.threadId === threadId &&
          e.event.status === status,
      );
      if (found) return resolve();
      if (Date.now() - start > timeoutMs) {
        return reject(new Error(`timed out waiting for status=${status}`));
      }
      setTimeout(tick, 5);
    };
    tick();
  });
}

describe("inputSpillThreshold", () => {
  // Real Models via the faux provider (no double-cast of a partial object).
  const faux = registerFauxProvider({
    provider: "threshold-dims",
    models: [
      { id: "big", name: "big", contextWindow: 200_000, maxTokens: 8_000 },
      { id: "empty", name: "empty", contextWindow: 0, maxTokens: 0 },
    ],
  });
  const big = faux.getModel("big")!;
  const empty = faux.getModel("empty")!;

  it("returns the configured maxInputTokens when set", () => {
    expect(inputSpillThreshold(big, { maxInputTokens: 1_234 })).toBe(1_234);
  });

  it("disables spilling when maxInputTokens is 0 (or negative)", () => {
    expect(inputSpillThreshold(big, { maxInputTokens: 0 })).toBe(Number.POSITIVE_INFINITY);
    expect(inputSpillThreshold(big, { maxInputTokens: -5 })).toBe(Number.POSITIVE_INFINITY);
  });

  it("defaults to 60% of usable context", () => {
    // usable = 200_000 - min(20_000, 8_000) = 192_000; 60% = 115_200.
    expect(inputSpillThreshold(big)).toBe(115_200);
  });

  it("disables spilling when the model has no usable budget", () => {
    expect(inputSpillThreshold(empty)).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("marker helpers", () => {
  it("buildSpilledInputMarker names the file and the paging instruction", () => {
    const marker = buildSpilledInputMarker({ path: "/workspace/.valet/large-inputs/e-1.txt", tokens: 900, chars: 3600 });
    expect(marker).toContain("/workspace/.valet/large-inputs/e-1.txt");
    expect(marker).toContain("900 tokens");
    expect(marker).toContain("sed -n '1,400p'");
    expect(marker.length).toBeLessThan(600); // the pointer is small, not the paste
  });
});

describe("oversized input spill (integration)", () => {
  it("spills a large paste to a sandbox file and replaces it with a pointer", async () => {
    const faux = registerFauxProvider({ provider: "spill1" });
    faux.setResponses([fauxAssistantMessage("looked at the file")]);

    const { engine, events } = makeEngine();
    const session = await engine.createSession({
      userId: "u",
      orgId: "o",
      workspace: "/workspace",
      sandbox: {},
      model: faux.getModel(),
      compaction: { maxInputTokens: 20 }, // spill anything over ~20 tokens
    });

    const bigPaste = "PASTED TRANSCRIPT LINE. ".repeat(200); // ~4800 chars, ~1200 tokens
    const receipt = await session.prompt(bigPaste);
    await waitForStatus(events, receipt.threadId, "idle");

    const entries = await session.readEntries("web:default");
    const messages = entries.filter((e): e is MessageEntry => e.type === "message");
    const userEntry = messages.find((m) => m.role === "user")!;

    // The persisted entry keeps the FULL paste (durable, REST-visible), with
    // the file path recorded in metadata.
    expect(userEntry.content).toBe(bigPaste);
    const path = String(userEntry.metadata?.valetSpilledInputPath ?? "");
    expect(path).toMatch(/\/workspace\/\.valet\/large-inputs\/.+\.txt$/);

    // The full paste is also in the sandbox at that path for the agent to page.
    expect(await session.sandbox.readFile(path)).toBe(bigPaste);

    // But the LLM view (hot and cold) is the small pointer, not the paste.
    const llm = entriesToAgentMessages(
      entries,
      { api: "a", provider: "spill1", id: "m" },
      {},
    );
    const llmUser = llm.find((m) => m.role === "user")!;
    const llmText = (llmUser.content as Array<{ type: string; text?: string }>)
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("");
    expect(llmText).toContain("Large input saved to a file");
    expect(llmText).toContain(path);
    expect(llmText).not.toContain(bigPaste);
    expect(llmText.length).toBeLessThan(bigPaste.length);

    // The turn completed normally (no overflow loop).
    const assistant = messages.find((m) => m.role === "assistant");
    expect(assistant?.content).toBe("looked at the file");

    faux.unregister();
  });

  it("does not spill an ordinary-sized message", async () => {
    const faux = registerFauxProvider({ provider: "spill2" });
    faux.setResponses([fauxAssistantMessage("ok")]);

    const { engine, events } = makeEngine();
    const session = await engine.createSession({
      userId: "u",
      orgId: "o",
      workspace: "/workspace",
      sandbox: {},
      model: faux.getModel(),
      compaction: { maxInputTokens: 20 },
    });

    const receipt = await session.prompt("hi there");
    await waitForStatus(events, receipt.threadId, "idle");

    const entries = await session.readEntries("web:default");
    const userEntry = entries
      .filter((e): e is MessageEntry => e.type === "message")
      .find((m) => m.role === "user")!;
    expect(userEntry.content).toBe("hi there");

    faux.unregister();
  });
});

describe("compaction fail-safe: newest turn larger than the window", () => {
  it("returns 'insufficient' instead of a false success that loops", async () => {
    const faux = registerFauxProvider({
      provider: "insufficient1",
      models: [{ id: "small", name: "small", contextWindow: 200, maxTokens: 5 }],
    });
    faux.setResponses([]); // no LLM call expected; compaction bails before summarizing

    const { engine, store } = makeEngine();
    const session = await engine.createSession({
      userId: "u",
      orgId: "o",
      workspace: "/",
      sandbox: {},
      model: faux.getModel("small")!,
      // Disable input spill so the oversized entry stays in the transcript,
      // reproducing an un-compactable tail (e.g. an oversized tool result).
      // minPreserveRecentTokens keeps the tail budget below the giant turn so
      // selectCutPoint is forced to floor (keep the un-splittable last turn).
      compaction: { tailTurns: 1, minPreserveRecentTokens: 5, maxInputTokens: 0 },
    });

    const thread = session.thread();
    // usable = 200 - min(20_000, 5) = 195. Tail budget = max(5, floor(195*0.25)
    // = 48) = 48. A ~900-char tail estimates ~225 tokens: over the 48-token
    // budget (can't fit), a single entry (can't split), and over usable 195 —
    // the exact un-compactable shape the fail-safe must catch.
    await store.appendEntries(session.id, thread.id, [
      {
        id: "e-1",
        sessionId: session.id,
        threadId: thread.id,
        parentId: null,
        type: "message",
        role: "user",
        content: "first small prompt",
        createdAt: 1,
      },
      {
        id: "e-2",
        sessionId: session.id,
        threadId: thread.id,
        parentId: "e-1",
        type: "message",
        role: "assistant",
        content: "small reply",
        createdAt: 2,
      },
      {
        id: "e-3",
        sessionId: session.id,
        threadId: thread.id,
        parentId: "e-2",
        type: "message",
        role: "user",
        content: "X".repeat(900),
        createdAt: 3,
      },
    ]);

    const outcome = await thread.compactThread({ mode: "manual" });
    expect(outcome).toBe("insufficient");

    faux.unregister();
  });

  it("does not report 'insufficient' when the prune pass elides the oversized tail", async () => {
    const faux = registerFauxProvider({
      provider: "insufficient2",
      models: [{ id: "mid", name: "mid", contextWindow: 100_000, maxTokens: 5 }],
    });
    // One summarizer response for the head; the tail is elided, not summarized.
    faux.setResponses([
      fauxAssistantMessage(
        "## Goal\n- t\n\n## Constraints & Preferences\n- (none)\n\n## Progress\n### Done\n- x\n\n### In Progress\n- (none)\n\n### Blocked\n- (none)\n\n## Key Decisions\n- (none)\n\n## Next Steps\n- (none)\n\n## Critical Context\n- (none)\n\n## Relevant Files\n- (none)",
      ),
    ]);

    const { engine, store } = makeEngine();
    const session = await engine.createSession({
      userId: "u",
      orgId: "o",
      workspace: "/",
      sandbox: {},
      model: faux.getModel("mid")!,
      compaction: { tailTurns: 1 },
    });

    const thread = session.thread();
    // usable ~= 99_995. The newest turn holds a ~120k-token tool result: over
    // usable pre-prune (would wrongly trip the fail-safe on the un-pruned view)
    // but the prune pass elides it (over pruneProtectTokens 40k), so the real
    // tail is tiny and compaction should proceed.
    await store.appendEntries(session.id, thread.id, [
      {
        id: "e-1",
        sessionId: session.id,
        threadId: thread.id,
        parentId: null,
        type: "message",
        role: "user",
        content: "first question",
        createdAt: 1,
      },
      {
        id: "e-2",
        sessionId: session.id,
        threadId: thread.id,
        parentId: "e-1",
        type: "message",
        role: "assistant",
        content: "first answer",
        createdAt: 2,
      },
      {
        id: "e-3",
        sessionId: session.id,
        threadId: thread.id,
        parentId: "e-2",
        type: "message",
        role: "user",
        content: "second question",
        createdAt: 3,
      },
      {
        id: "e-4",
        sessionId: session.id,
        threadId: thread.id,
        parentId: "e-3",
        type: "message",
        role: "assistant",
        content: "",
        parts: [
          {
            type: "tool_call",
            callId: "c1",
            toolName: "read",
            status: "completed",
            args: { path: "/big.log" },
            result: "Z".repeat(480_000), // ~120k tokens, elidable by prune
          },
        ],
        createdAt: 4,
      },
    ]);

    const outcome = await thread.compactThread({ mode: "manual" });
    expect(outcome).not.toBe("insufficient");
    expect(outcome).toBe("compacted");

    faux.unregister();
  });
});
