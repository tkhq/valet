import { describe, it, expect } from "vitest";
import {
  fauxAssistantMessage,
  registerFauxProvider,
} from "@earendil-works/pi-ai/compat";
import {
  Engine,
  InMemoryEventStream,
  InMemorySessionStore,
  VirtualSandboxProvider,
  type BusEvent,
  type CompactionEntry,
  type ResolvedModel,
} from "../src/index.js";
import { summarize } from "../src/compaction.js";

function makeEngine() {
  const store = new InMemorySessionStore();
  const bus = new InMemoryEventStream();
  const sandboxProvider = new VirtualSandboxProvider();
  const events: BusEvent[] = [];
  bus.subscribe({}, (e) => events.push(e));
  const engine = new Engine({ providers: { store, stream: bus, sandboxProvider } });
  return { engine, store, bus, events };
}

async function waitFor(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 5));
  }
}

// Long enough that the live transcript's char-based estimate exceeds the
// tiny fixtures' usable budget (contextWindow 50 → usable 45 tokens ≈ 180
// chars). The proactive trigger measures the transcript estimate, not
// provider-reported usage (TKAI-305).
const OVER_BUDGET_PROMPT = "third prompt " + "x".repeat(400);

describe("compaction: proactive (token threshold)", () => {
  it("after a turn that pushes the context estimate past usable, runs compaction and inserts a CompactionEntry", async () => {
    // Tiny model dimensions: usable = contextWindow - min(reserveCap, maxTokens) = 50 - 5 = 45.
    // OVER_BUDGET_PROMPT alone pushes the live transcript estimate past 45 tokens.
    const faux2 = registerFauxProvider({
      provider: "compact-proactive",
      models: [
        {
          id: "tiny",
          name: "tiny",
          contextWindow: 50,
          maxTokens: 5,
        },
      ],
    });
    // Two responses: the third user turn's assistant response, then the
    // summarizer completion (one-shot completeSimple from compactThread).
    faux2.setResponses([
      fauxAssistantMessage("third response"),
      fauxAssistantMessage(
        "## Goal\n- test\n\n## Constraints & Preferences\n- (none)\n\n## Progress\n### Done\n- prior turns\n\n### In Progress\n- (none)\n\n### Blocked\n- (none)\n\n## Key Decisions\n- (none)\n\n## Next Steps\n- (none)\n\n## Critical Context\n- (none)\n\n## Relevant Files\n- (none)",
      ),
    ]);
    const { engine: engine2, store: store2, events: events2 } = makeEngine();
    const session2 = await engine2.createSession({
      userId: "u",
      orgId: "o",
      workspace: "/",
      sandbox: {},
      model: faux2.getModel("tiny")!,
      compaction: { tailTurns: 1 },
    });

    // Pre-populate two prior turns directly in the store so we have a
    // head to compact when the third turn triggers proactive compaction.
    const thread = session2.thread();
    await store2.appendEntries(session2.id, thread.id, [
      {
        id: "e-1",
        sessionId: session2.id,
        threadId: thread.id,
        parentId: null,
        type: "message",
        role: "user",
        content: "first prompt",
        createdAt: 1,
      },
      {
        id: "e-2",
        sessionId: session2.id,
        threadId: thread.id,
        parentId: "e-1",
        type: "message",
        role: "assistant",
        content: "first response",
        createdAt: 2,
      },
      {
        id: "e-3",
        sessionId: session2.id,
        threadId: thread.id,
        parentId: "e-2",
        type: "message",
        role: "user",
        content: "second prompt",
        createdAt: 3,
      },
      {
        id: "e-4",
        sessionId: session2.id,
        threadId: thread.id,
        parentId: "e-3",
        type: "message",
        role: "assistant",
        content: "second response",
        createdAt: 4,
      },
    ]);

    // Trigger the third turn — its response reports high usage, kicking
    // off compaction.
    const receipt = await session2.prompt(OVER_BUDGET_PROMPT);
    await waitFor(
      () =>
        events2.some(
          (e) =>
            e.event.type === "compaction_end" && e.event.threadId === receipt.threadId,
        ),
    );

    // Verify a CompactionEntry was inserted.
    const entries = await store2.getEntries(session2.id, thread.id);
    const compactionEntries = entries.filter(
      (e): e is CompactionEntry => e.type === "compaction",
    );
    expect(compactionEntries).toHaveLength(1);
    const c = compactionEntries[0];
    expect(c.summary).toContain("## Goal");
    expect(c.summary).toContain("## Relevant Files");
    expect(c.coveredEntryIds).toContain("e-1");
    expect(c.coveredEntryIds).toContain("e-2");

    // compaction_start + compaction_end events fired for this thread.
    const compStart = events2.find((e) => e.event.type === "compaction_start");
    const compEnd = events2.find((e) => e.event.type === "compaction_end");
    expect(compStart).toBeDefined();
    expect(compEnd).toBeDefined();

    faux2.unregister();
  });

  it("summarizer honors the per-turn resolver apiKey (BYO-key compaction)", async () => {
    // Same proactive setup, but with a host `resolveModel` seam supplying a
    // per-turn key. The summarizer's one-shot completion must run with that
    // key — otherwise a BYO-key session dies on first context overflow.
    const seenKeys: Array<string | undefined> = [];
    const faux = registerFauxProvider({
      provider: "compact-byo-key",
      models: [{ id: "tiny", name: "tiny", contextWindow: 50, maxTokens: 5 }],
    });
    const record = (_ctx: unknown, opts: { apiKey?: string } | undefined) => {
      seenKeys.push(opts?.apiKey);
      return fauxAssistantMessage("third response");
    };
    const recordSummary = (_ctx: unknown, opts: { apiKey?: string } | undefined) => {
      seenKeys.push(opts?.apiKey);
      return fauxAssistantMessage(
        "## Goal\n- test\n\n## Constraints & Preferences\n- (none)\n\n## Progress\n### Done\n- prior turns\n\n### In Progress\n- (none)\n\n### Blocked\n- (none)\n\n## Key Decisions\n- (none)\n\n## Next Steps\n- (none)\n\n## Critical Context\n- (none)\n\n## Relevant Files\n- (none)",
      );
    };
    faux.setResponses([record, recordSummary]);

    const model = faux.getModel("tiny")!;
    const { engine, store, events } = makeEngine();
    const session = await engine.createSession({
      userId: "u",
      orgId: "o",
      workspace: "/",
      sandbox: {},
      model,
      resolveModel: async (_spec: string): Promise<ResolvedModel | null> => ({
        model,
        apiKey: "org-key-xyz",
      }),
      compaction: { tailTurns: 1 },
    });

    const thread = session.thread();
    await store.appendEntries(session.id, thread.id, [
      { id: "e-1", sessionId: session.id, threadId: thread.id, parentId: null, type: "message", role: "user", content: "first prompt", createdAt: 1 },
      { id: "e-2", sessionId: session.id, threadId: thread.id, parentId: "e-1", type: "message", role: "assistant", content: "first response", createdAt: 2 },
      { id: "e-3", sessionId: session.id, threadId: thread.id, parentId: "e-2", type: "message", role: "user", content: "second prompt", createdAt: 3 },
      { id: "e-4", sessionId: session.id, threadId: thread.id, parentId: "e-3", type: "message", role: "assistant", content: "second response", createdAt: 4 },
    ]);

    const receipt = await session.prompt(OVER_BUDGET_PROMPT);
    await waitFor(() =>
      events.some(
        (e) => e.event.type === "compaction_end" && e.event.threadId === receipt.threadId,
      ),
    );

    // Two completions ran (turn + summarizer); both saw the resolver key.
    expect(seenKeys).toEqual(["org-key-xyz", "org-key-xyz"]);

    faux.unregister();
  });
});

describe("compaction: rehydrate replaces covered entries with the summary", () => {
  it("entriesToAgentMessages drops covered entries and injects <previous-context>", async () => {
    const { entriesToAgentMessages } = await import("../src/thread.js");
    const summary = "## Goal\n- resumed task";
    const messages = entriesToAgentMessages(
      [
        {
          id: "u-1",
          sessionId: "s",
          threadId: "t",
          parentId: null,
          type: "message",
          role: "user",
          content: "old prompt",
          createdAt: 1,
        },
        {
          id: "a-1",
          sessionId: "s",
          threadId: "t",
          parentId: "u-1",
          type: "message",
          role: "assistant",
          content: "old answer",
          createdAt: 2,
        },
        {
          id: "c-1",
          sessionId: "s",
          threadId: "t",
          parentId: "a-1",
          type: "compaction",
          summary,
          coveredEntryIds: ["u-1", "a-1"],
          tokenCountBefore: 100,
          tokenCountAfter: 20,
          createdAt: 3,
        },
        {
          id: "u-2",
          sessionId: "s",
          threadId: "t",
          parentId: "c-1",
          type: "message",
          role: "user",
          content: "new prompt",
          createdAt: 4,
        },
      ],
      { api: "anthropic-messages", provider: "anthropic", id: "model" },
    );
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe("user");
    if (messages[0].role === "user") {
      const text = messages[0].content[0];
      if (text.type === "text") expect(text.text).toContain("<previous-context>");
      if (text.type === "text") expect(text.text).toContain(summary);
    }
    expect(messages[1]).toMatchObject({ role: "user" });
    if (messages[1].role === "user") {
      const text = messages[1].content[0];
      if (text.type === "text") expect(text.text).toBe("new prompt");
    }
  });
});

describe("compaction: auto-continue", () => {
  it("after proactive compaction, runs an auto-continue turn tagged with compaction_continue", async () => {
    const faux = registerFauxProvider({
      provider: "compact-autocontinue",
      models: [{ id: "tiny", name: "tiny", contextWindow: 50, maxTokens: 5 }],
    });
    faux.setResponses([
      // Third user prompt → assistant response (triggers proactive compaction).
      fauxAssistantMessage("third response"),
      // Summarizer one-shot.
      fauxAssistantMessage(
        "## Goal\n- t\n\n## Constraints & Preferences\n- (none)\n\n## Progress\n### Done\n- (none)\n\n### In Progress\n- (none)\n\n### Blocked\n- (none)\n\n## Key Decisions\n- (none)\n\n## Next Steps\n- (none)\n\n## Critical Context\n- (none)\n\n## Relevant Files\n- (none)",
      ),
      // Auto-continue turn → assistant response.
      fauxAssistantMessage("continued from where I left off"),
    ]);
    const { engine, store, events } = makeEngine();
    const session = await engine.createSession({
      userId: "u",
      orgId: "o",
      workspace: "/",
      sandbox: {},
      model: faux.getModel("tiny")!,
      compaction: { tailTurns: 1 },
    });
    const thread = session.thread();
    await store.appendEntries(session.id, thread.id, [
      {
        id: "u-1",
        sessionId: session.id,
        threadId: thread.id,
        parentId: null,
        type: "message",
        role: "user",
        content: "first prompt",
        createdAt: 1,
      },
      {
        id: "a-1",
        sessionId: session.id,
        threadId: thread.id,
        parentId: "u-1",
        type: "message",
        role: "assistant",
        content: "first response",
        createdAt: 2,
      },
    ]);

    const receipt = await session.prompt(OVER_BUDGET_PROMPT);
    // Wait for two turn_ends after the prompt: the original third turn,
    // then the auto-continue turn.
    await waitFor(
      () =>
        events.filter(
          (e) => e.event.type === "turn_end" && e.event.threadId === receipt.threadId,
        ).length >= 2,
    );

    const entries = await store.getEntries(session.id, thread.id);
    const userEntries = entries.filter(
      (e) => e.type === "message" && e.role === "user",
    );
    // The auto-continue user message should be present and tagged.
    const autoContinue = userEntries.find(
      (e) => e.type === "message" && e.metadata?.compaction_continue === true,
    );
    expect(autoContinue).toBeDefined();
    if (autoContinue?.type === "message") {
      expect(autoContinue.content).toContain("Continue if you have next steps");
    }
    // And the assistant's continuation response should follow it.
    const lastAssistant = entries
      .filter((e) => e.type === "message" && e.role === "assistant")
      .at(-1);
    expect(lastAssistant?.type === "message" && lastAssistant.content).toBe(
      "continued from where I left off",
    );

    faux.unregister();
  });

  it("autoContinue: false suppresses the synthetic follow-up", async () => {
    const faux = registerFauxProvider({
      provider: "compact-autocontinue-off",
      models: [{ id: "tiny", name: "tiny", contextWindow: 50, maxTokens: 5 }],
    });
    faux.setResponses([
      fauxAssistantMessage("third response"),
      fauxAssistantMessage(
        "## Goal\n- t\n\n## Constraints & Preferences\n- (none)\n\n## Progress\n### Done\n- (none)\n\n### In Progress\n- (none)\n\n### Blocked\n- (none)\n\n## Key Decisions\n- (none)\n\n## Next Steps\n- (none)\n\n## Critical Context\n- (none)\n\n## Relevant Files\n- (none)",
      ),
    ]);
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
    await store.appendEntries(session.id, thread.id, [
      {
        id: "u-1",
        sessionId: session.id,
        threadId: thread.id,
        parentId: null,
        type: "message",
        role: "user",
        content: "first prompt",
        createdAt: 1,
      },
      {
        id: "a-1",
        sessionId: session.id,
        threadId: thread.id,
        parentId: "u-1",
        type: "message",
        role: "assistant",
        content: "first response",
        createdAt: 2,
      },
    ]);

    const receipt = await session.prompt(OVER_BUDGET_PROMPT);
    await waitFor(
      () =>
        events.some(
          (e) =>
            e.event.type === "compaction_end" && e.event.threadId === receipt.threadId,
        ),
    );
    // Wait a bit longer to make sure no follow-up turn fires.
    await new Promise((r) => setTimeout(r, 100));

    const entries = await store.getEntries(session.id, thread.id);
    const synthetic = entries.find(
      (e) => e.type === "message" && e.metadata?.compaction_continue === true,
    );
    expect(synthetic).toBeUndefined();

    faux.unregister();
  });
});

describe("compaction: pruning persists via updateEntry", () => {
  it("pruned tool_call results are marked elided in the DAG, not just the live transcript", async () => {
    const faux = registerFauxProvider({
      provider: "compact-prune-persist",
      models: [{ id: "tiny", name: "tiny", contextWindow: 50, maxTokens: 5 }],
    });
    faux.setResponses([
      fauxAssistantMessage("trigger response"),
      fauxAssistantMessage(
        "## Goal\n- t\n\n## Constraints & Preferences\n- (none)\n\n## Progress\n### Done\n- (none)\n\n### In Progress\n- (none)\n\n### Blocked\n- (none)\n\n## Key Decisions\n- (none)\n\n## Next Steps\n- (none)\n\n## Critical Context\n- (none)\n\n## Relevant Files\n- (none)",
      ),
    ]);
    const { engine, store, events } = makeEngine();
    const session = await engine.createSession({
      userId: "u",
      orgId: "o",
      workspace: "/",
      sandbox: {},
      model: faux.getModel("tiny")!,
      compaction: {
        tailTurns: 1,
        // Tiny token thresholds so a moderately-sized fixture triggers pruning
        // even though we're working with chars, not real tokens.
        pruneProtectTokens: 200,
        pruneMinimumTokens: 200,
      },
    });
    const thread = session.thread();

    // Pre-populate the DAG with two prior turns whose assistant messages
    // contain large bash tool outputs (~3000 chars each ≈ 750 token estimate).
    const bigOutput = "x".repeat(3_000);
    await store.appendEntries(session.id, thread.id, [
      {
        id: "u-1",
        sessionId: session.id,
        threadId: thread.id,
        parentId: null,
        type: "message",
        role: "user",
        content: "first prompt",
        createdAt: 1,
      },
      {
        id: "a-1",
        sessionId: session.id,
        threadId: thread.id,
        parentId: "u-1",
        type: "message",
        role: "assistant",
        content: "",
        parts: [
          {
            type: "tool_call",
            callId: "tc-1",
            toolName: "bash",
            status: "completed",
            args: { command: "ls /large-dir" },
            result: bigOutput,
          },
        ],
        createdAt: 2,
      },
      {
        id: "u-2",
        sessionId: session.id,
        threadId: thread.id,
        parentId: "a-1",
        type: "message",
        role: "user",
        content: "second prompt",
        createdAt: 3,
      },
      {
        id: "a-2",
        sessionId: session.id,
        threadId: thread.id,
        parentId: "u-2",
        type: "message",
        role: "assistant",
        content: "",
        parts: [
          {
            type: "tool_call",
            callId: "tc-2",
            toolName: "bash",
            status: "completed",
            args: { command: "cat /large-file" },
            result: bigOutput,
          },
        ],
        createdAt: 4,
      },
    ]);

    const receipt = await session.prompt(OVER_BUDGET_PROMPT);
    await waitFor(
      () =>
        events.some(
          (e) =>
            e.event.type === "compaction_end" && e.event.threadId === receipt.threadId,
        ),
    );

    // Re-load entries from the store and verify a-1's tool_call is elided —
    // and that the stored result text survived (TKAI-305: elision applies at
    // render time; the summarizer still needs the text).
    const entries = await store.getEntries(session.id, thread.id);
    const a1 = entries.find((e) => e.id === "a-1");
    expect(a1?.type).toBe("message");
    if (a1?.type === "message") {
      const tc = a1.parts?.[0];
      expect(tc?.type).toBe("tool_call");
      if (tc?.type === "tool_call") {
        expect(tc.elided).toBe(true);
        expect(tc.result).toBe(bigOutput);
      }
    }

    faux.unregister();
  });
});

const SUMMARY_RESPONSE =
  "## Goal\n- test\n\n## Constraints & Preferences\n- (none)\n\n## Progress\n### Done\n- prior turns\n\n### In Progress\n- (none)\n\n### Blocked\n- (none)\n\n## Key Decisions\n- (none)\n\n## Next Steps\n- (none)\n\n## Critical Context\n- (none)\n\n## Relevant Files\n- (none)";

describe("compaction: /compact instructions", () => {
  it("passes user instructions through to the summarizer prompt", async () => {
    const captured: string[] = [];
    const faux = registerFauxProvider({
      provider: "compact-instr",
      models: [{ id: "tiny", name: "tiny", contextWindow: 100_000, maxTokens: 1000 }],
    });
    faux.setResponses([
      (ctx: { messages: Array<{ content: unknown }> }) => {
        captured.push(JSON.stringify(ctx.messages));
        return fauxAssistantMessage(SUMMARY_RESPONSE);
      },
    ]);
    const result = await summarize({
      headEntries: [
        {
          id: "e-1",
          sessionId: "s",
          threadId: "t",
          parentId: null,
          type: "message",
          role: "user",
          content: "please refactor the parser",
          createdAt: 1,
        },
      ],
      model: faux.getModel("tiny")!,
      instructions: "keep the exact file names",
    });
    expect(result.summary).toContain("## Goal");
    expect(captured).toHaveLength(1);
    expect(captured[0]).toContain("keep the exact file names");
    faux.unregister();
  });
});

describe("compaction: summarizer input (TKAI-305)", () => {
  const SUMMARY_WITH_NEW_SECTIONS =
    "## Goal\n- t\n\n## Constraints & Preferences\n- (none)\n\n## Progress\n### Done\n- (none)\n\n### In Progress\n- (none)\n\n### Blocked\n- (none)\n\n## Key Decisions\n- (none)\n\n## Agreed Approach\n- (none)\n\n## Active Tools & Skills\n- (none)\n\n## Next Steps\n- (none)\n\n## Critical Context\n- (none)\n\n## Relevant Files\n- (none)";

  it("a pruned tool result still reaches the summarizer; the template carries the new sections", async () => {
    const captured: string[] = [];
    const faux = registerFauxProvider({
      provider: "compact-elided-summary",
      models: [{ id: "tiny", name: "tiny", contextWindow: 100_000, maxTokens: 1_000 }],
    });
    faux.setResponses([
      (ctx: { messages: Array<{ content: unknown }> }) => {
        captured.push(JSON.stringify(ctx.messages));
        return fauxAssistantMessage(SUMMARY_WITH_NEW_SECTIONS);
      },
    ]);
    const result = await summarize({
      headEntries: [
        {
          id: "u-1",
          sessionId: "s",
          threadId: "t",
          parentId: null,
          type: "message",
          role: "user",
          content: "load the deploy skill and plan the rollout",
          createdAt: 1,
        },
        {
          id: "a-1",
          sessionId: "s",
          threadId: "t",
          parentId: "u-1",
          type: "message",
          role: "assistant",
          content: "",
          parts: [
            {
              type: "tool_call",
              callId: "tc-1",
              toolName: "bash",
              status: "completed",
              args: { command: "cat plan.md" },
              // Elided by an earlier prune pass — the stored text survives.
              result: "the settled plan is blue-green deploys",
              elided: true,
            },
          ],
          createdAt: 2,
        },
      ],
      model: faux.getModel("tiny")!,
    });
    expect(result.summary).toContain("## Agreed Approach");
    expect(captured).toHaveLength(1);
    // The pruned output's text was fed to the summarizer, not the marker.
    expect(captured[0]).toContain("the settled plan is blue-green deploys");
    expect(captured[0]).not.toContain("[output elided to save context]");
    // The prompt instructs the summarizer to keep approach + tool awareness.
    expect(captured[0]).toContain("## Agreed Approach");
    expect(captured[0]).toContain("## Active Tools & Skills");
    faux.unregister();
  });
});

describe("compaction: summarizer failure handling (TKAI-306)", () => {
  it("summarize rejects on an errored completion instead of storing an empty summary", async () => {
    const faux = registerFauxProvider({
      provider: "compact-summ-error",
      models: [{ id: "tiny", name: "tiny", contextWindow: 100_000, maxTokens: 1_000 }],
    });
    faux.setResponses([
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "provider exploded" }),
    ]);
    await expect(
      summarize({
        headEntries: [
          { id: "u-1", sessionId: "s", threadId: "t", parentId: null, type: "message", role: "user", content: "hi", createdAt: 1 },
        ],
        model: faux.getModel("tiny")!,
      }),
    ).rejects.toThrow("provider exploded");
    faux.unregister();
  });

  it("summarize rejects a length-truncated completion instead of storing garbage", async () => {
    const faux = registerFauxProvider({
      provider: "compact-summ-length",
      models: [{ id: "tiny", name: "tiny", contextWindow: 100_000, maxTokens: 1_000 }],
    });
    faux.setResponses([
      fauxAssistantMessage("<analysis>ran out of tok", { stopReason: "length" }),
    ]);
    await expect(
      summarize({
        headEntries: [
          { id: "u-1", sessionId: "s", threadId: "t", parentId: null, type: "message", role: "user", content: "hi", createdAt: 1 },
        ],
        model: faux.getModel("tiny")!,
      }),
    ).rejects.toThrow("length");
    faux.unregister();
  });

  it("summarize rejects when stripping leaves no summary text", async () => {
    const faux = registerFauxProvider({
      provider: "compact-summ-blank",
      models: [{ id: "tiny", name: "tiny", contextWindow: 100_000, maxTokens: 1_000 }],
    });
    faux.setResponses([
      fauxAssistantMessage("<analysis>only a scratchpad, no summary</analysis>"),
    ]);
    await expect(
      summarize({
        headEntries: [
          { id: "u-1", sessionId: "s", threadId: "t", parentId: null, type: "message", role: "user", content: "hi", createdAt: 1 },
        ],
        model: faux.getModel("tiny")!,
      }),
    ).rejects.toThrow("no summary text");
    faux.unregister();
  });

  it("a proactive pass with nothing to reclaim counts toward the breaker as compaction_noop", async () => {
    const faux = registerFauxProvider({
      provider: "compact-noop-breaker",
      models: [{ id: "tiny", name: "tiny", contextWindow: 50, maxTokens: 5 }],
    });
    // No summarizer responses queued: the pass must never reach summarize.
    faux.setResponses([
      fauxAssistantMessage("r1"),
      fauxAssistantMessage("r2"),
      fauxAssistantMessage("r3"),
      fauxAssistantMessage("r4"),
    ]);
    const { engine, events } = makeEngine();
    // A single over-budget turn with NO prior turns: the whole transcript
    // fits the tail budget (min floor 2k), so cutIndex is 0 → noop.
    const session = await engine.createSession({
      userId: "u",
      orgId: "o",
      workspace: "/",
      sandbox: {},
      model: faux.getModel("tiny")!,
      compaction: { autoContinue: false },
    });
    for (let turn = 1; turn <= 4; turn++) {
      const receipt = await session.prompt(OVER_BUDGET_PROMPT);
      await waitFor(
        () =>
          events.filter(
            (e) => e.event.type === "turn_end" && e.event.threadId === receipt.threadId,
          ).length >= turn,
      );
    }
    expect(events.filter((e) => e.event.type === "compaction_start")).toHaveLength(0);
    const noops = events.filter(
      (e) => e.event.type === "error" && e.event.code === "compaction_noop",
    );
    expect(noops).toHaveLength(3); // breaker opens after 3; turn 4 skips
    expect(
      events.filter(
        (e) => e.event.type === "error" && e.event.code === "compaction_circuit_open",
      ),
    ).toHaveLength(1);
    faux.unregister();
  });

  it("summarize strips the <analysis> scratchpad from the stored summary", async () => {
    const faux = registerFauxProvider({
      provider: "compact-summ-analysis",
      models: [{ id: "tiny", name: "tiny", contextWindow: 100_000, maxTokens: 1_000 }],
    });
    faux.setResponses([
      fauxAssistantMessage("<analysis>\nchronological notes\n</analysis>\n\n## Goal\n- ship"),
    ]);
    const result = await summarize({
      headEntries: [
        { id: "u-1", sessionId: "s", threadId: "t", parentId: null, type: "message", role: "user", content: "hi", createdAt: 1 },
      ],
      model: faux.getModel("tiny")!,
    });
    expect(result.summary).toBe("## Goal\n- ship");
    expect(result.summary).not.toContain("chronological notes");
    faux.unregister();
  });

  it("an overflowing summarize call retries with a truncated head and still compacts", async () => {
    const inputSizes: number[] = [];
    const faux = registerFauxProvider({
      provider: "compact-summ-overflow",
      models: [{ id: "tiny", name: "tiny", contextWindow: 50, maxTokens: 5 }],
    });
    faux.setResponses([
      // The triggering turn's assistant response.
      fauxAssistantMessage("trigger response"),
      // Summarizer attempt 1: context overflow (Anthropic's error shape).
      (ctx: { messages: unknown[] }) => {
        inputSizes.push(ctx.messages.length);
        return fauxAssistantMessage("", {
          stopReason: "error",
          errorMessage: "prompt is too long: 100 tokens > 50 maximum",
        });
      },
      // Summarizer attempt 2: succeeds on the truncated head.
      (ctx: { messages: unknown[] }) => {
        inputSizes.push(ctx.messages.length);
        return fauxAssistantMessage(SUMMARY_RESPONSE);
      },
    ]);
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
    await store.appendEntries(session.id, thread.id, [
      { id: "e-1", sessionId: session.id, threadId: thread.id, parentId: null, type: "message", role: "user", content: "first prompt", createdAt: 1 },
      { id: "e-2", sessionId: session.id, threadId: thread.id, parentId: "e-1", type: "message", role: "assistant", content: "first response", createdAt: 2 },
      { id: "e-3", sessionId: session.id, threadId: thread.id, parentId: "e-2", type: "message", role: "user", content: "second prompt", createdAt: 3 },
      { id: "e-4", sessionId: session.id, threadId: thread.id, parentId: "e-3", type: "message", role: "assistant", content: "second response", createdAt: 4 },
    ]);

    const receipt = await session.prompt(OVER_BUDGET_PROMPT);
    await waitFor(
      () =>
        events.some(
          (e) => e.event.type === "compaction_end" && e.event.threadId === receipt.threadId,
        ),
    );

    const entries = await store.getEntries(session.id, thread.id);
    const compactions = entries.filter((e): e is CompactionEntry => e.type === "compaction");
    expect(compactions).toHaveLength(1);
    // The CompactionEntry still covers the FULL head even though the retry
    // summarized a truncated slice.
    expect(compactions[0].coveredEntryIds).toContain("e-1");
    // The retry fed the summarizer strictly less input than the first attempt.
    expect(inputSizes).toHaveLength(2);
    expect(inputSizes[1]).toBeLessThan(inputSizes[0]);
    faux.unregister();
  });

  it("proactive compaction opens the circuit breaker after 3 consecutive failures; a manual success closes it", async () => {
    const faux = registerFauxProvider({
      provider: "compact-breaker",
      models: [{ id: "tiny", name: "tiny", contextWindow: 50, maxTokens: 5 }],
    });
    const summarizerError = () =>
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "summarizer down" });
    faux.setResponses([
      fauxAssistantMessage("r1"), summarizerError, // turn 1: compaction failure 1
      fauxAssistantMessage("r2"), summarizerError, // turn 2: failure 2
      fauxAssistantMessage("r3"), summarizerError, // turn 3: failure 3 → breaker opens
      fauxAssistantMessage("r4"),                  // turn 4: NO summarizer call queued
    ]);
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
    await store.appendEntries(session.id, thread.id, [
      { id: "e-1", sessionId: session.id, threadId: thread.id, parentId: null, type: "message", role: "user", content: "first prompt", createdAt: 1 },
      { id: "e-2", sessionId: session.id, threadId: thread.id, parentId: "e-1", type: "message", role: "assistant", content: "first response", createdAt: 2 },
    ]);

    for (let turn = 1; turn <= 4; turn++) {
      const receipt = await session.prompt(OVER_BUDGET_PROMPT);
      await waitFor(
        () =>
          events.filter(
            (e) => e.event.type === "turn_end" && e.event.threadId === receipt.threadId,
          ).length >= turn,
      );
    }

    // Three attempts ran; the fourth turn skipped compaction entirely.
    const starts = events.filter((e) => e.event.type === "compaction_start");
    expect(starts).toHaveLength(3);
    // The breaker announced itself with a distinct error code.
    const circuitEvents = events.filter(
      (e) => e.event.type === "error" && e.event.code === "compaction_circuit_open",
    );
    expect(circuitEvents).toHaveLength(1);
    // If the fourth turn had tried to compact, this response would be consumed.
    expect(faux.getPendingResponseCount()).toBe(0);

    // A successful manual /compact closes the breaker …
    faux.appendResponses([fauxAssistantMessage(SUMMARY_RESPONSE)]);
    await thread.compactThread({ mode: "manual" });
    // … and after the manual pass's one-turn cool-down
    // (skipNextProactiveCheck), over-budget turns compact proactively again.
    faux.appendResponses([
      fauxAssistantMessage("r5"), // cool-down turn: no compaction attempt
      fauxAssistantMessage("r6"),
      fauxAssistantMessage(SUMMARY_RESPONSE),
    ]);
    for (let turn = 5; turn <= 6; turn++) {
      const receipt = await session.prompt(OVER_BUDGET_PROMPT);
      await waitFor(
        () =>
          events.filter(
            (e) => e.event.type === "turn_end" && e.event.threadId === receipt.threadId,
          ).length >= turn,
      );
    }
    const startsAfter = events.filter((e) => e.event.type === "compaction_start");
    expect(startsAfter.length).toBeGreaterThanOrEqual(5); // 3 failures + manual + resumed proactive
    expect(faux.getPendingResponseCount()).toBe(0);
    faux.unregister();
  });
});

describe("compaction: proactive trigger rehydration (restart)", () => {
  it("compacts BEFORE the first post-restart turn when the rehydrated transcript exceeds usable", async () => {
    // usable = contextWindow - min(reserveCap, maxTokens) = 100000 - 5. The
    // persisted transcript estimates to ~112k tokens (450k chars / 4), so
    // the restored thread must compact before its first turn hits the
    // model. Any compaction observed here is the pre-turn check's doing.
    const faux = registerFauxProvider({
      provider: "compact-restart",
      models: [{ id: "tiny", name: "tiny", contextWindow: 100_000, maxTokens: 5 }],
    });
    const store = new InMemorySessionStore();
    const bus = new InMemoryEventStream();
    const sandboxProvider = new VirtualSandboxProvider();
    const events: BusEvent[] = [];
    bus.subscribe({}, (e) => events.push(e));
    const model = faux.getModel("tiny")!;
    const options = {
      userId: "u",
      orgId: "o",
      workspace: "/",
      sandbox: {},
      model,
      compaction: { tailTurns: 1 },
    };

    const engine1 = new Engine({ providers: { store, stream: bus, sandboxProvider } });
    const session1 = await engine1.createSession(options);
    const thread1 = session1.thread();
    await store.appendEntries(session1.id, thread1.id, [
      {
        id: "e-1",
        sessionId: session1.id,
        threadId: thread1.id,
        parentId: null,
        type: "message",
        role: "user",
        content: "first prompt",
        createdAt: 1,
      },
      {
        id: "e-2",
        sessionId: session1.id,
        threadId: thread1.id,
        parentId: "e-1",
        type: "message",
        role: "assistant",
        content: "x".repeat(300_000), // ~75k estimated tokens
        createdAt: 2,
      },
      {
        id: "e-3",
        sessionId: session1.id,
        threadId: thread1.id,
        parentId: "e-2",
        type: "message",
        role: "user",
        content: "second prompt",
        createdAt: 3,
      },
      {
        id: "e-4",
        sessionId: session1.id,
        threadId: thread1.id,
        parentId: "e-3",
        type: "message",
        role: "assistant",
        content: "y".repeat(150_000), // ~37.5k estimated tokens
        createdAt: 4,
      },
    ]);

    // "Restart": a fresh Engine over the same providers rehydrates the
    // session from the store. Response order proves the sequencing — the
    // summarizer consumes the FIRST faux response, the turn the SECOND.
    faux.setResponses([
      fauxAssistantMessage(SUMMARY_RESPONSE),
      fauxAssistantMessage("post-restart response"),
    ]);
    const engine2 = new Engine({ providers: { store, stream: bus, sandboxProvider } });
    const restored = await engine2.restoreSession({ sessionId: session1.id, options });
    const receipt = await restored.prompt("third prompt");
    await waitFor(
      () =>
        events.some(
          (e) => e.event.type === "compaction_end" && e.event.threadId === receipt.threadId,
        ),
    );
    await waitFor(() =>
      events.some(
        (e) => e.event.type === "turn_end" && e.event.threadId === receipt.threadId,
      ),
    );

    const entries = await store.getEntries(session1.id, receipt.threadId);
    const compactions = entries.filter((e): e is CompactionEntry => e.type === "compaction");
    expect(compactions).toHaveLength(1);
    // The turn's reply is the SECOND faux response — the summarizer ran
    // first, i.e. compaction protected the turn instead of following it.
    const lastAssistant = [...entries]
      .reverse()
      .find((e) => e.type === "message" && e.role === "assistant");
    expect(lastAssistant?.type === "message" && lastAssistant.content).toBe(
      "post-restart response",
    );
    // The pre-turn pass runs BEFORE the user entry is appended: exactly one
    // "third prompt" user entry exists, positioned after the compaction
    // entry — a rebuild that captured the prompt would duplicate it in the
    // LLM context.
    const thirdPrompts = entries.filter(
      (e) => e.type === "message" && e.role === "user" && e.content === "third prompt",
    );
    expect(thirdPrompts).toHaveLength(1);
    expect(entries.indexOf(compactions[0])).toBeLessThan(entries.indexOf(thirdPrompts[0]));
    // No synthetic auto-continue was queued for the pre-turn pass, and the
    // post-turn check was not suppressed by it (no second compaction means
    // it simply had nothing to do — the flag is only armed with a follow-up).
    const unsettled = await store.listUnsettledSubmissions(session1.id);
    expect(unsettled.filter((i) => i.metadata?.compaction_continue)).toHaveLength(0);
    faux.unregister();
  });

  it("does not compact after restart when a prior compaction already covers the transcript", async () => {
    const faux = registerFauxProvider({
      provider: "compact-restart-skip",
      models: [{ id: "tiny", name: "tiny", contextWindow: 100_000, maxTokens: 5 }],
    });
    const store = new InMemorySessionStore();
    const bus = new InMemoryEventStream();
    const sandboxProvider = new VirtualSandboxProvider();
    const events: BusEvent[] = [];
    bus.subscribe({}, (e) => events.push(e));
    const model = faux.getModel("tiny")!;
    const options = {
      userId: "u",
      orgId: "o",
      workspace: "/",
      sandbox: {},
      model,
      compaction: { tailTurns: 1 },
    };

    const engine1 = new Engine({ providers: { store, stream: bus, sandboxProvider } });
    const session1 = await engine1.createSession(options);
    const thread1 = session1.thread();
    await store.appendEntries(session1.id, thread1.id, [
      {
        id: "e-1",
        sessionId: session1.id,
        threadId: thread1.id,
        parentId: null,
        type: "message",
        role: "user",
        content: "first prompt",
        createdAt: 1,
      },
      {
        id: "e-2",
        sessionId: session1.id,
        threadId: thread1.id,
        parentId: "e-1",
        type: "message",
        role: "assistant",
        content: "x".repeat(500_000), // huge, but covered by c-1 below
        createdAt: 2,
      },
      {
        // The rehydrated transcript replaces the covered entries with the
        // short summary, so the pre-turn estimate stays far under usable —
        // the restored thread must NOT run a spurious pre-turn pass.
        id: "c-1",
        sessionId: session1.id,
        threadId: thread1.id,
        parentId: "e-2",
        type: "compaction",
        summary: "prior summary",
        coveredEntryIds: ["e-1", "e-2"],
        tokenCountBefore: 100,
        tokenCountAfter: 10,
        createdAt: 3,
      },
    ]);

    faux.setResponses([fauxAssistantMessage("post-restart response")]);
    const engine2 = new Engine({ providers: { store, stream: bus, sandboxProvider } });
    const restored = await engine2.restoreSession({ sessionId: session1.id, options });
    const receipt = await restored.prompt("second prompt");
    await waitFor(() =>
      events.some(
        (e) => e.event.type === "turn_end" && e.event.threadId === receipt.threadId,
      ),
    );

    const compactionEvents = events.filter((e) => e.event.type === "compaction_start");
    expect(compactionEvents).toHaveLength(0);
    const entries = await store.getEntries(session1.id, receipt.threadId);
    expect(entries.filter((e) => e.type === "compaction")).toHaveLength(1); // only c-1
    faux.unregister();
  });
});
