import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  fauxAssistantMessage,
  registerFauxProvider,
} from "@earendil-works/pi-ai/compat";

// The recorders are the units under test here, so they are replaced rather
// than driven through a meter provider. `metrics.test.ts` covers the
// instrument names, descriptions, and attributes these calls land on.
const recorded = vi.hoisted(() => ({
  coverageGap: [] as string[],
}));

vi.mock("../src/metrics.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/metrics.js")>();
  return {
    ...actual,
    recordCompactionCoverageGap: (mode: string) => {
      recorded.coverageGap.push(mode);
    },
  };
});

import {
  Engine,
  InMemoryEventStream,
  InMemorySessionStore,
  VirtualSandboxProvider,
  executeBuiltin,
  type BusEvent,
  type MessageEntry,
  type SessionEntry,
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

const SUMMARY_RESPONSE =
  "## Goal\n- test\n\n## Constraints & Preferences\n- (none)\n\n## Progress\n### Done\n- prior turns\n\n### In Progress\n- (none)\n\n### Blocked\n- (none)\n\n## Key Decisions\n- (none)\n\n## Next Steps\n- (none)\n\n## Critical Context\n- (none)\n\n## Relevant Files\n- (none)";

// usable = contextWindow - min(reserveCap, maxTokens) = 50 - 5 = 45, so the
// summarizer input budget is min(max(45, 8_000), 64_000) = 8_000 tokens. The
// summarizer caps one prose block at 20_000 chars, so this step costs about
// 5_000 tokens of that budget, not the 10_000 its raw text implies.
const OVERSIZED_STEP = "x".repeat(40_000);

/** One message entry, with the ids the store and the DAG walk both need. */
function message(
  ids: { sessionId: string; threadId: string },
  row: Omit<MessageEntry, "sessionId" | "threadId" | "type">,
): MessageEntry {
  return { ...ids, type: "message", ...row };
}

/** A head that holds no text the summarizer can read. */
function coverageGapEntries(sessionId: string, threadId: string): SessionEntry[] {
  const ids = { sessionId, threadId };
  return [
    message(ids, { id: "e-1", parentId: null, role: "user", content: "", createdAt: 1 }),
    message(ids, { id: "e-2", parentId: "e-1", role: "assistant", content: "", parts: [{ type: "thinking", text: OVERSIZED_STEP }], createdAt: 2 }),
    message(ids, { id: "e-3", parentId: "e-2", role: "user", content: "marker-e-3 second prompt", createdAt: 3 }),
    message(ids, { id: "e-4", parentId: "e-3", role: "assistant", content: "marker-e-4 second response", createdAt: 4 }),
  ];
}

beforeEach(() => {
  recorded.coverageGap.length = 0;
});

describe("compaction metrics: the head the summarizer could not read at all", () => {
  it("records the coverage-gap counter and names the corrective action", async () => {
    const faux = registerFauxProvider({
      provider: "compact-metrics-gap",
      models: [{ id: "tiny", name: "tiny", contextWindow: 50, maxTokens: 5 }],
    });
    // Queued but never consumed: the check runs before the summarizer call.
    faux.setResponses([fauxAssistantMessage(SUMMARY_RESPONSE)]);
    const { engine, store, events } = makeEngine();
    const session = await engine.createSession({
      userId: "u",
      orgId: "o",
      workspace: "/",
      sandbox: {},
      model: faux.getModel("tiny")!,
      compaction: { tailTurns: 1, autoContinue: false },
    });
    const thread = session.thread();
    await store.appendEntries(session.id, thread.id, coverageGapEntries(session.id, thread.id));

    const outcome = await thread.compactThread({ mode: "manual" });
    expect(outcome).toBe("coverage_gap");

    expect(recorded.coverageGap).toEqual(["manual"]);
    const errors = events.filter(
      (e) => e.event.type === "error" && e.event.code === "compaction_coverage_gap",
    );
    expect(errors).toHaveLength(1);
    expect(errors[0].event).toMatchObject({
      error:
        "Compaction found no history to summarize. The 2 entries it must replace hold " +
        "no text the summarizer can read. Start a new thread if the context still overflows.",
    });
    expect(faux.getPendingResponseCount()).toBe(1);
    faux.unregister();
  });

  it("reports the proactive mode on the counter", async () => {
    const faux = registerFauxProvider({
      provider: "compact-metrics-gap-mode",
      models: [{ id: "tiny", name: "tiny", contextWindow: 50, maxTokens: 5 }],
    });
    faux.setResponses([fauxAssistantMessage(SUMMARY_RESPONSE)]);
    const { engine, store } = makeEngine();
    const session = await engine.createSession({
      userId: "u",
      orgId: "o",
      workspace: "/",
      sandbox: {},
      model: faux.getModel("tiny")!,
      compaction: { tailTurns: 1, autoContinue: false },
    });
    const thread = session.thread();
    await store.appendEntries(session.id, thread.id, coverageGapEntries(session.id, thread.id));

    await thread.compactThread({ mode: "proactive", autoContinue: false });
    expect(recorded.coverageGap).toEqual(["proactive"]);
    faux.unregister();
  });

  it("/compact names the cause it found and an action that can work", async () => {
    const faux = registerFauxProvider({
      provider: "compact-metrics-gap-command",
      models: [{ id: "tiny", name: "tiny", contextWindow: 50, maxTokens: 5 }],
    });
    faux.setResponses([fauxAssistantMessage(SUMMARY_RESPONSE)]);
    const { engine, store } = makeEngine();
    const session = await engine.createSession({
      userId: "u",
      orgId: "o",
      workspace: "/",
      sandbox: {},
      model: faux.getModel("tiny")!,
      compaction: { tailTurns: 1, autoContinue: false },
    });
    const thread = session.thread();
    await store.appendEntries(session.id, thread.id, coverageGapEntries(session.id, thread.id));

    const result = await executeBuiltin("compact", [], session, undefined, thread);
    expect(result.ok).toBe(true);
    expect(result.output).toBe(
      "Could not compact: the older turns hold no text the summarizer can read, so a " +
        "summary would replace them with nothing. They stay in context. Run /new-thread " +
        "to continue with a fresh context.",
    );
    // The newest-turn diagnosis belongs to a different cause. It tells the
    // user to shorten the last message, which cannot help here.
    expect(result.output).not.toContain("Shorten the last message");
    faux.unregister();
  });
});
