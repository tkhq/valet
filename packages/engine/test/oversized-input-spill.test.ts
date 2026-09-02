import { describe, it, expect } from "vitest";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import {
  Engine,
  InMemoryEventStream,
  InMemorySessionStore,
  VirtualSandboxProvider,
  buildSpilledInputMarker,
  inputSpillThreshold,
  truncateInputWithMarker,
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

  it("truncateInputWithMarker keeps a head slice and appends a note", () => {
    const text = "x".repeat(10_000);
    const out = truncateInputWithMarker(text, 100); // 100 tokens -> ~400 chars kept
    expect(out.length).toBeLessThan(text.length);
    expect(out.startsWith("x".repeat(400))).toBe(true);
    expect(out).toContain("Input truncated");
  });

  it("truncateInputWithMarker leaves short text untouched", () => {
    expect(truncateInputWithMarker("short", 100)).toBe("short");
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

    // The persisted user entry holds the pointer, not the paste.
    expect(userEntry.content).not.toBe(bigPaste);
    expect(userEntry.content).toContain("/workspace/.valet/large-inputs/");
    expect(userEntry.content).toContain("Large input saved to a file");
    expect(userEntry.content.length).toBeLessThan(bigPaste.length);

    // The full paste is in the sandbox at the pointed path.
    const path = userEntry.content.match(/(\/workspace\/\.valet\/large-inputs\/[^\s]+\.txt)/)![1];
    expect(await session.sandbox.readFile(path)).toBe(bigPaste);

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
});
