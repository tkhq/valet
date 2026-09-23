import { describe, it, expect } from "vitest";
import {
  fauxAssistantMessage,
  registerFauxProvider,
} from "@earendil-works/pi-ai/compat";
import {
  Engine,
  InMemoryEventStream,
  InMemorySessionStore,
  StaleAttemptError,
  VirtualSandboxProvider,
  type BusEvent,
  type CompactionEntry,
  type ResolvedModel,
  type SessionEntry,
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
      compaction: { tailTurns: 1, autoContinue: false },
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

    const receipt = await session.prompt(OVER_BUDGET_PROMPT, {
      channel: { channelType: "slack", channelId: "slack:T1:D1" },
    });
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
      // The continuation answers the same reader as the turn it continues:
      // it inherits the interrupted item's channel mark, so the outbound
      // channel path does not classify it as a web prompt (TKAI-323).
      expect(autoContinue.channel).toEqual({ channelType: "slack", channelId: "slack:T1:D1" });
    }
    // The continuation stays inside the original submission. The child
    // watcher therefore cannot observe settlement at the compaction boundary.
    expect(autoContinue?.queueItemId).toBe(receipt.queueItemId);
    const compaction = entries.find((entry) => entry.type === "compaction");
    expect(autoContinue?.parentId).toBe(compaction?.id);
    const lastAssistant = entries
      .filter((e) => e.type === "message" && e.role === "assistant")
      .at(-1);
    expect(lastAssistant?.type === "message" && lastAssistant.content).toBe(
      "continued from where I left off",
    );
    expect(lastAssistant?.queueItemId).toBe(receipt.queueItemId);
    expect(lastAssistant?.parentId).toBe(autoContinue?.id);
    const result = await thread.awaitResult(receipt.queueItemId);
    expect(result).toMatchObject({
      outcome: "completed",
      text: "continued from where I left off",
    });
    const settled = events.filter(
      (event) =>
        event.queueItemId === receipt.queueItemId &&
        event.event.type === "submission_settled",
    );
    expect(settled).toHaveLength(1);
    expect(
      (await store.listUnsettledSubmissions(session.id)).filter(
        (item) => item.metadata?.compaction_continue === true,
      ),
    ).toHaveLength(0);

    faux.unregister();
  });

  it("fails a child visibly when its same-submission continuation cannot start", async () => {
    const faux = registerFauxProvider({
      provider: "compact-child-continuation-failure",
      models: [{ id: "tiny", name: "tiny", contextWindow: 50, maxTokens: 5 }],
    });
    faux.setResponses([
      fauxAssistantMessage("implementation reached the boundary"),
      fauxAssistantMessage(
        "## Goal\n- finish child work\n\n## Continuation Checkpoint\n- Branch: fix/child\n- Next Action: continue implementation",
      ),
    ]);
    const { engine, store, events } = makeEngine();
    const session = await engine.createSession({
      userId: "u",
      orgId: "o",
      workspace: "/",
      sandbox: {},
      purpose: "child",
      model: faux.getModel("tiny")!,
      compaction: { tailTurns: 1 },
    });
    const thread = session.thread();
    await store.appendEntries(session.id, thread.id, [
      {
        id: "u-before",
        sessionId: session.id,
        threadId: thread.id,
        parentId: null,
        type: "message",
        role: "user",
        content: "start implementation",
        createdAt: 1,
      },
      {
        id: "a-before",
        sessionId: session.id,
        threadId: thread.id,
        parentId: "u-before",
        type: "message",
        role: "assistant",
        content: "working",
        createdAt: 2,
      },
    ]);
    const append = store.appendEntries.bind(store);
    store.appendEntries = async (sessionId, threadId, entries, fence) => {
      if (
        entries.some(
          (entry) => entry.type === "message" && entry.metadata?.compaction_continue === true,
        )
      ) {
        throw new Error("could not persist continuation checkpoint edge");
      }
      await append(sessionId, threadId, entries, fence);
    };

    const receipt = await session.prompt(OVER_BUDGET_PROMPT);
    const result = await thread.awaitResult(receipt.queueItemId);
    expect(result.outcome).toBe("failed");
    expect(result.error).toContain("could not persist continuation checkpoint edge");
    expect(
      events.some(
        (event) =>
          event.event.type === "error" &&
          event.event.code === "compaction_continuation_failed",
      ),
    ).toBe(true);
    expect(
      (await store.getEntries(session.id, thread.id)).some(
        (entry) => entry.type === "compaction",
      ),
    ).toBe(true);

    faux.unregister();
  });

  it("does not run continuation after its fenced prompt append goes stale", async () => {
    const faux = registerFauxProvider({
      provider: "compact-stale-continuation",
      models: [{ id: "tiny", name: "tiny", contextWindow: 50, maxTokens: 5 }],
    });
    faux.setResponses([
      fauxAssistantMessage("implementation reached the boundary"),
      fauxAssistantMessage(SUMMARY_RESPONSE),
      fauxAssistantMessage("must not run"),
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
      { id: "u-before-stale", sessionId: session.id, threadId: thread.id, parentId: null, type: "message", role: "user", content: "start", createdAt: 1 },
      { id: "a-before-stale", sessionId: session.id, threadId: thread.id, parentId: "u-before-stale", type: "message", role: "assistant", content: "working", createdAt: 2 },
    ]);
    const append = store.appendEntries.bind(store);
    store.appendEntries = async (sessionId, threadId, entries, fence) => {
      if (entries.some((entry) => entry.metadata?.compaction_continue === true)) {
        throw new StaleAttemptError(fence?.itemId ?? "missing", fence?.attemptId ?? "missing");
      }
      await append(sessionId, threadId, entries, fence);
    };

    const receipt = await session.prompt(OVER_BUDGET_PROMPT);
    await waitFor(() =>
      events.some(
        (event) =>
          event.event.type === "error" &&
          event.event.code === "stale_fence",
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(faux.getPendingResponseCount()).toBe(1);
    expect(
      (await store.getEntries(session.id, thread.id)).some(
        (entry) => entry.type === "message" && entry.content === "must not run",
      ),
    ).toBe(false);
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
        autoContinue: false,
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

  it("restores a legacy compaction with its null-parent suffix", async () => {
    const faux = registerFauxProvider({
      provider: "compact-legacy-restore",
      models: [{ id: "large", name: "large", contextWindow: 100_000, maxTokens: 1_000 }],
    });
    const store = new InMemorySessionStore();
    const bus = new InMemoryEventStream();
    const sandboxProvider = new VirtualSandboxProvider();
    const engine1 = new Engine({ providers: { store, stream: bus, sandboxProvider } });
    const options = {
      userId: "u",
      orgId: "o",
      workspace: "/",
      sandbox: {},
      model: faux.getModel("large")!,
    };
    const session1 = await engine1.createSession(options);
    const thread = session1.thread();
    await store.appendEntries(session1.id, thread.id, [
      { id: "e1", sessionId: session1.id, threadId: thread.id, parentId: null, type: "message", role: "user", content: "covered request", createdAt: 1 },
      { id: "e2", sessionId: session1.id, threadId: thread.id, parentId: null, type: "message", role: "assistant", content: "covered answer", createdAt: 2 },
      { id: "c1", sessionId: session1.id, threadId: thread.id, parentId: "e2", type: "compaction", summary: "LEGACY-SUMMARY", coveredEntryIds: ["e1", "e2"], tokenCountBefore: 20, tokenCountAfter: 5, createdAt: 3 },
      { id: "e3", sessionId: session1.id, threadId: thread.id, parentId: null, type: "message", role: "user", content: "POST-COMPACTION-INSTRUCTION", createdAt: 4 },
      { id: "e4", sessionId: session1.id, threadId: thread.id, parentId: null, type: "message", role: "assistant", content: "post-compaction detail", createdAt: 5 },
    ]);
    faux.setResponses([
      (context) => {
        const rendered = JSON.stringify(context.messages);
        expect(rendered).toContain("LEGACY-SUMMARY");
        expect(rendered).toContain("POST-COMPACTION-INSTRUCTION");
        return fauxAssistantMessage("continued after restore");
      },
    ]);

    const engine2 = new Engine({ providers: { store, stream: bus, sandboxProvider } });
    const restored = await engine2.restoreSession({ sessionId: session1.id, options });
    const receipt = await restored.prompt("continue");
    expect(await restored.thread().awaitResult(receipt.queueItemId)).toMatchObject({
      outcome: "completed",
      text: "continued after restore",
    });
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

describe("compaction: summarizer input covers the head", () => {
  // usable = contextWindow - min(reserveCap, maxTokens) = 50 - 5 = 45, so the
  // summarizer input budget is min(max(45, 8_000), 64_000) = 8_000 tokens.
  // The summarizer caps one prose block at 20_000 chars, so this step costs
  // about 5_000 tokens of that budget, not the 10_000 its raw text implies.
  const OVERSIZED_STEP = "x".repeat(40_000);

  /** Assert that every named entry reached the summarizer input. */
  function expectSummarized(input: string, ids: readonly string[]): void {
    for (const id of ids) expect(input).toContain(`marker-${id}`);
  }

  it("summarizes the enclosing turn when the head ends inside an assistant run", async () => {
    const summarizerInputs: string[] = [];
    const faux = registerFauxProvider({
      provider: "compact-coverage-head",
      models: [{ id: "tiny", name: "tiny", contextWindow: 50, maxTokens: 5 }],
    });
    faux.setResponses([
      (ctx: { messages: unknown[] }) => {
        summarizerInputs.push(JSON.stringify(ctx.messages));
        return fauxAssistantMessage(SUMMARY_RESPONSE);
      },
    ]);
    const { engine, store } = makeEngine();
    const session = await engine.createSession({
      userId: "u",
      orgId: "o",
      workspace: "/",
      sandbox: {},
      model: faux.getModel("tiny")!,
      compaction: { autoContinue: false },
    });
    const thread = session.thread();
    // One long agentic turn: a single user message, then an assistant run
    // that outgrows the summarizer input budget. The cut splits the turn, so
    // the head ends on an assistant entry and the tail carries no user entry.
    await store.appendEntries(session.id, thread.id, [
      { id: "e-1", sessionId: session.id, threadId: thread.id, parentId: null, type: "message", role: "user", content: "marker-e-1 start the long turn", createdAt: 1 },
      { id: "e-2", sessionId: session.id, threadId: thread.id, parentId: "e-1", type: "message", role: "assistant", content: `marker-e-2 ${OVERSIZED_STEP}`, createdAt: 2 },
      { id: "e-3", sessionId: session.id, threadId: thread.id, parentId: "e-2", type: "message", role: "assistant", content: "marker-e-3 latest step", createdAt: 3 },
    ]);

    const outcome = await thread.compactThread({ mode: "manual" });
    expect(outcome).toBe("compacted");

    const entries = await store.getEntries(session.id, thread.id);
    const compaction = entries.find((e): e is CompactionEntry => e.type === "compaction");
    expect(compaction).toBeDefined();
    expect(compaction!.coveredEntryIds).toEqual(["e-1", "e-2"]);
    expect(summarizerInputs).toHaveLength(1);
    // Every covered entry must reach the summarizer. Without this the
    // checkpoint claims coverage of entries the summary never saw.
    expectSummarized(summarizerInputs[0], compaction!.coveredEntryIds);
    faux.unregister();
  });

  it("summarizes the head when a normal turn follows a long agentic turn", async () => {
    const summarizerInputs: string[] = [];
    const faux = registerFauxProvider({
      provider: "compact-coverage-normal-tail",
      models: [{ id: "tiny", name: "tiny", contextWindow: 50, maxTokens: 5 }],
    });
    faux.setResponses([
      (ctx: { messages: unknown[] }) => {
        summarizerInputs.push(JSON.stringify(ctx.messages));
        return fauxAssistantMessage(SUMMARY_RESPONSE);
      },
    ]);
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
    // The product's ordinary shape: one long agentic turn, then a short
    // newest turn. The newest turn's own user entry must not pull the
    // summarizer window off the head (TKAI-461).
    await store.appendEntries(session.id, thread.id, [
      { id: "e-1", sessionId: session.id, threadId: thread.id, parentId: null, type: "message", role: "user", content: "marker-e-1 start the long turn", createdAt: 1 },
      { id: "e-2", sessionId: session.id, threadId: thread.id, parentId: "e-1", type: "message", role: "assistant", content: `marker-e-2 ${OVERSIZED_STEP}`, createdAt: 2 },
      { id: "e-3", sessionId: session.id, threadId: thread.id, parentId: "e-2", type: "message", role: "user", content: "marker-e-3 second prompt", createdAt: 3 },
      { id: "e-4", sessionId: session.id, threadId: thread.id, parentId: "e-3", type: "message", role: "assistant", content: "marker-e-4 second response", createdAt: 4 },
    ]);

    const outcome = await thread.compactThread({ mode: "manual" });
    expect(outcome).toBe("compacted");

    const entries = await store.getEntries(session.id, thread.id);
    const compaction = entries.find((e): e is CompactionEntry => e.type === "compaction");
    expect(compaction).toBeDefined();
    expect(compaction!.coveredEntryIds).toEqual(["e-1", "e-2"]);
    expect(summarizerInputs).toHaveLength(1);
    expectSummarized(summarizerInputs[0], compaction!.coveredEntryIds);
    faux.unregister();
  });

  it("keeps the head in the summarizer input when a command result ends the head", async () => {
    const summarizerInputs: string[] = [];
    const faux = registerFauxProvider({
      provider: "compact-coverage-command-result",
      models: [{ id: "tiny", name: "tiny", contextWindow: 50, maxTokens: 5 }],
    });
    faux.setResponses([
      (ctx: { messages: unknown[] }) => {
        summarizerInputs.push(JSON.stringify(ctx.messages));
        return fauxAssistantMessage(SUMMARY_RESPONSE);
      },
    ]);
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
    // A slash command at the end of a turn appends a command_result: an entry
    // that costs no tokens and renders into no summarizer message. The head
    // must still reach the summarizer through the entries behind it.
    await store.appendEntries(session.id, thread.id, [
      { id: "e-1", sessionId: session.id, threadId: thread.id, parentId: null, type: "message", role: "user", content: "marker-e-1 start the long turn", createdAt: 1 },
      { id: "e-2", sessionId: session.id, threadId: thread.id, parentId: "e-1", type: "message", role: "assistant", content: `marker-e-2 ${OVERSIZED_STEP}`, createdAt: 2 },
      { id: "c-3", sessionId: session.id, threadId: thread.id, parentId: "e-2", type: "command_result", command: "/status", source: "builtin", ok: true, output: "ready", createdAt: 3 },
      { id: "e-4", sessionId: session.id, threadId: thread.id, parentId: "c-3", type: "message", role: "user", content: "marker-e-4 second prompt", createdAt: 4 },
      { id: "e-5", sessionId: session.id, threadId: thread.id, parentId: "e-4", type: "message", role: "assistant", content: "marker-e-5 second response", createdAt: 5 },
    ]);

    const outcome = await thread.compactThread({ mode: "manual" });
    expect(outcome).toBe("compacted");

    const entries = await store.getEntries(session.id, thread.id);
    const compaction = entries.find((e): e is CompactionEntry => e.type === "compaction");
    expect(compaction).toBeDefined();
    expect(compaction!.coveredEntryIds).toEqual(["e-1", "e-2", "c-3"]);
    expect(summarizerInputs).toHaveLength(1);
    // c-3 renders into nothing by design; the message entries it hides
    // behind must still be there.
    expectSummarized(summarizerInputs[0], ["e-1", "e-2"]);
    faux.unregister();
  });

  it("reaches past a command result when the head outgrows the input budget", async () => {
    const summarizerInputs: string[] = [];
    const faux = registerFauxProvider({
      provider: "compact-coverage-command-result-oversized",
      models: [{ id: "tiny", name: "tiny", contextWindow: 50, maxTokens: 5 }],
    });
    faux.setResponses([
      (ctx: { messages: unknown[] }) => {
        summarizerInputs.push(JSON.stringify(ctx.messages));
        return fauxAssistantMessage(SUMMARY_RESPONSE);
      },
    ]);
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
    // e-2 costs about 60_000 tokens of summarizer input, past the
    // 8_000-token budget, and the zero-token c-3 sits behind it. The window
    // stops on c-3, which renders into nothing, so it must step back to the
    // newest entry the summarizer can actually read (TKAI-461).
    await store.appendEntries(session.id, thread.id, [
      { id: "e-1", sessionId: session.id, threadId: thread.id, parentId: null, type: "message", role: "user", content: "marker-e-1 start the long turn", createdAt: 1 },
      {
        id: "e-2", sessionId: session.id, threadId: thread.id, parentId: "e-1", type: "message", role: "assistant", content: "",
        parts: Array.from({ length: 12 }, (_, i) => ({
          type: "text" as const,
          text: `marker-e-2 step ${i} ${OVERSIZED_STEP}`,
        })),
        createdAt: 2,
      },
      { id: "c-3", sessionId: session.id, threadId: thread.id, parentId: "e-2", type: "command_result", command: "/status", source: "builtin", ok: true, output: "ready", createdAt: 3 },
      { id: "e-4", sessionId: session.id, threadId: thread.id, parentId: "c-3", type: "message", role: "user", content: "marker-e-4 second prompt", createdAt: 4 },
      { id: "e-5", sessionId: session.id, threadId: thread.id, parentId: "e-4", type: "message", role: "assistant", content: "marker-e-5 second response", createdAt: 5 },
    ]);

    const outcome = await thread.compactThread({ mode: "manual" });
    expect(outcome).toBe("compacted");

    const entries = await store.getEntries(session.id, thread.id);
    const compaction = entries.find((e): e is CompactionEntry => e.type === "compaction");
    // The step-back window is [e-2, c-3], and the checkpoint claims exactly
    // it. e-1 never reached the summarizer, so it keeps its place in live
    // context for the next pass.
    expect(compaction!.coveredEntryIds).toEqual(["e-2", "c-3"]);
    expect(summarizerInputs).toHaveLength(1);
    // A head larger than the budget is summarized from the part that fit.
    // The summary must still be written from head content, never from the
    // prompt template alone.
    expectSummarized(summarizerInputs[0], ["e-2"]);
    faux.unregister();
  });

  it("refuses to compact when no entry it must replace carries summarizer text", async () => {
    const faux = registerFauxProvider({
      provider: "compact-coverage-gap",
      models: [{ id: "tiny", name: "tiny", contextWindow: 50, maxTokens: 5 }],
    });
    // Queued but never consumed: the coverage check runs before the
    // summarizer call, so a pass that cannot cover the head costs nothing.
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
    // head = [e-1, e-2]: an empty user entry and an assistant entry that
    // holds only thinking. The summarizer reads neither, so the checkpoint
    // would claim coverage of text it never saw.
    await store.appendEntries(session.id, thread.id, [
      { id: "e-1", sessionId: session.id, threadId: thread.id, parentId: null, type: "message", role: "user", content: "", createdAt: 1 },
      { id: "e-2", sessionId: session.id, threadId: thread.id, parentId: "e-1", type: "message", role: "assistant", content: "", parts: [{ type: "thinking", text: OVERSIZED_STEP }], createdAt: 2 },
      { id: "e-3", sessionId: session.id, threadId: thread.id, parentId: "e-2", type: "message", role: "user", content: "marker-e-3 second prompt", createdAt: 3 },
      { id: "e-4", sessionId: session.id, threadId: thread.id, parentId: "e-3", type: "message", role: "assistant", content: "marker-e-4 second response", createdAt: 4 },
    ]);

    const outcome = await thread.compactThread({ mode: "manual" });
    expect(outcome).toBe("coverage_gap");

    const entries = await store.getEntries(session.id, thread.id);
    expect(entries.filter((e) => e.type === "compaction")).toHaveLength(0);
    expect(
      events.filter(
        (e) => e.event.type === "error" && e.event.code === "compaction_coverage_gap",
      ),
    ).toHaveLength(1);
    expect(faux.getPendingResponseCount()).toBe(1);
    faux.unregister();
  });

  it("stops the overflow retry before it shrinks the head out of the input", async () => {
    const inputSizes: number[] = [];
    const overflow = (ctx: { messages: unknown[] }) => {
      inputSizes.push(ctx.messages.length);
      return fauxAssistantMessage("", {
        stopReason: "error",
        errorMessage: "prompt is too long: 100 tokens > 50 maximum",
      });
    };
    const faux = registerFauxProvider({
      provider: "compact-coverage-retry",
      models: [{ id: "tiny", name: "tiny", contextWindow: 50, maxTokens: 5 }],
    });
    faux.setResponses([overflow, overflow, fauxAssistantMessage(SUMMARY_RESPONSE)]);
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
    // head = [e-1, c-2]. The first retry drops the optional tail evidence.
    // The second would halve the head down to the command result, which
    // renders into nothing, so the pass must stop instead of buying a
    // summary the checkpoint cannot use.
    await store.appendEntries(session.id, thread.id, [
      { id: "e-1", sessionId: session.id, threadId: thread.id, parentId: null, type: "message", role: "user", content: "marker-e-1 first prompt", createdAt: 1 },
      { id: "c-2", sessionId: session.id, threadId: thread.id, parentId: "e-1", type: "command_result", command: "/status", source: "builtin", ok: true, output: "ready", createdAt: 2 },
      { id: "e-3", sessionId: session.id, threadId: thread.id, parentId: "c-2", type: "message", role: "user", content: "marker-e-3 second prompt", createdAt: 3 },
      { id: "e-4", sessionId: session.id, threadId: thread.id, parentId: "e-3", type: "message", role: "assistant", content: "marker-e-4 second response", createdAt: 4 },
    ]);

    await expect(thread.compactThread({ mode: "manual" })).rejects.toThrow(
      /prompt is too long/,
    );

    const entries = await store.getEntries(session.id, thread.id);
    expect(entries.filter((e) => e.type === "compaction")).toHaveLength(0);
    // Two attempts: the full input, then the same head without tail evidence.
    expect(inputSizes).toHaveLength(2);
    expect(inputSizes[1]).toBeLessThan(inputSizes[0]);
    expect(faux.getPendingResponseCount()).toBe(1);
    faux.unregister();
  });

  it("spends the summarizer budget on the head before the newest turn", async () => {
    const summarizerInputs: string[] = [];
    // usable = 200_000 - min(20_000, 4_000) = 196_000, so the summarizer
    // input budget is the 64_000-token ceiling.
    const faux = registerFauxProvider({
      provider: "compact-coverage-allocation",
      models: [{ id: "big", name: "big", contextWindow: 200_000, maxTokens: 4_000 }],
    });
    faux.setResponses([
      (ctx: { messages: unknown[] }) => {
        summarizerInputs.push(JSON.stringify(ctx.messages));
        return fauxAssistantMessage(SUMMARY_RESPONSE);
      },
    ]);
    const { engine, store } = makeEngine();
    const session = await engine.createSession({
      userId: "u",
      orgId: "o",
      workspace: "/",
      sandbox: {},
      model: faux.getModel("big")!,
      compaction: { tailTurns: 1, autoContinue: false },
    });
    const thread = session.thread();
    // The head costs about 60_000 tokens of summarizer input and the newest
    // turn about 7_000. One window over both would stop on the head and
    // summarize the newest turn alone, so the head takes its window first
    // and the evidence takes what is left (TKAI-461).
    await store.appendEntries(session.id, thread.id, [
      { id: "e-1", sessionId: session.id, threadId: thread.id, parentId: null, type: "message", role: "user", content: "marker-e-1 start the long turn", createdAt: 1 },
      {
        id: "e-2", sessionId: session.id, threadId: thread.id, parentId: "e-1", type: "message", role: "assistant", content: "",
        parts: Array.from({ length: 12 }, (_, i) => ({
          type: "text" as const,
          text: `marker-e-2 step ${i} ${OVERSIZED_STEP}`,
        })),
        createdAt: 2,
      },
      { id: "e-3", sessionId: session.id, threadId: thread.id, parentId: "e-2", type: "message", role: "user", content: "marker-e-3 second prompt", createdAt: 3 },
      {
        id: "e-4", sessionId: session.id, threadId: thread.id, parentId: "e-3", type: "message", role: "assistant", content: "",
        parts: [
          { type: "text", text: `marker-e-4 a ${"y".repeat(14_000)}` },
          { type: "text", text: `marker-e-4 b ${"y".repeat(14_000)}` },
        ],
        createdAt: 4,
      },
    ]);

    const outcome = await thread.compactThread({ mode: "manual" });
    expect(outcome).toBe("compacted");

    expect(summarizerInputs).toHaveLength(1);
    expectSummarized(summarizerInputs[0], ["e-1", "e-2"]);
    // The head left no room for the optional evidence.
    expect(summarizerInputs[0]).not.toContain("marker-e-4");
    faux.unregister();
  });

  it("drops tail evidence that cannot fit its budget and keeps the head", async () => {
    const summarizerInputs: string[] = [];
    // A roomy model: usable = 200_000 - min(20_000, 4_000) = 196_000, so the
    // tail budget holds this newest turn verbatim and the summarizer input
    // budget is the 64_000-token ceiling. Only the 8_000-token evidence
    // budget is binding here.
    const faux = registerFauxProvider({
      provider: "compact-coverage-tail-cap",
      models: [{ id: "big", name: "big", contextWindow: 200_000, maxTokens: 4_000 }],
    });
    faux.setResponses([
      (ctx: { messages: unknown[] }) => {
        summarizerInputs.push(JSON.stringify(ctx.messages));
        return fauxAssistantMessage(SUMMARY_RESPONSE);
      },
    ]);
    const { engine, store } = makeEngine();
    const session = await engine.createSession({
      userId: "u",
      orgId: "o",
      workspace: "/",
      sandbox: {},
      model: faux.getModel("big")!,
      compaction: { tailTurns: 1, autoContinue: false },
    });
    const thread = session.thread();
    // The newest entry alone is about 15_000 tokens of summarizer input,
    // past the 8_000-token evidence budget. Evidence is optional; the head
    // is not, so the pass keeps the head and sends no evidence.
    await store.appendEntries(session.id, thread.id, [
      { id: "e-1", sessionId: session.id, threadId: thread.id, parentId: null, type: "message", role: "user", content: "marker-e-1 first prompt", createdAt: 1 },
      { id: "e-2", sessionId: session.id, threadId: thread.id, parentId: "e-1", type: "message", role: "assistant", content: "marker-e-2 first response", createdAt: 2 },
      { id: "e-3", sessionId: session.id, threadId: thread.id, parentId: "e-2", type: "message", role: "user", content: "marker-e-3 second prompt", createdAt: 3 },
      {
        id: "e-4", sessionId: session.id, threadId: thread.id, parentId: "e-3", type: "message", role: "assistant", content: "",
        parts: [
          { type: "text", text: `marker-e-4 a ${OVERSIZED_STEP}` },
          { type: "text", text: `marker-e-4 b ${OVERSIZED_STEP}` },
          { type: "text", text: `marker-e-4 c ${OVERSIZED_STEP}` },
        ],
        createdAt: 4,
      },
    ]);

    const outcome = await thread.compactThread({ mode: "manual" });
    expect(outcome).toBe("compacted");

    expect(summarizerInputs).toHaveLength(1);
    expectSummarized(summarizerInputs[0], ["e-1", "e-2"]);
    expect(summarizerInputs[0]).not.toContain("marker-e-3");
    expect(summarizerInputs[0]).not.toContain("marker-e-4");
    faux.unregister();
  });

  it("summarize accepts an assistant-first input", async () => {
    const roles: string[] = [];
    const faux = registerFauxProvider({
      provider: "compact-assistant-first",
      models: [{ id: "tiny", name: "tiny", contextWindow: 100_000, maxTokens: 1_000 }],
    });
    faux.setResponses([
      (ctx: { messages: Array<{ role: string }> }) => {
        roles.push(...ctx.messages.map((m) => m.role));
        return fauxAssistantMessage(SUMMARY_RESPONSE);
      },
    ]);

    const result = await summarize({
      headEntries: [
        { id: "a-1", sessionId: "s", threadId: "t", parentId: null, type: "message", role: "assistant", content: "mid-turn step", createdAt: 1 },
      ],
      model: faux.getModel("tiny")!,
    });

    expect(result.summary).toBe(SUMMARY_RESPONSE);
    // Pi adds the summarizer system message first. The conversation must
    // still start with a user message, not the assistant head entry.
    expect(roles.slice(1, 3)).toEqual(["user", "assistant"]);
    faux.unregister();
  });

  it("summarize refuses an input that holds no conversation history", async () => {
    const faux = registerFauxProvider({
      provider: "compact-empty-input",
      models: [{ id: "tiny", name: "tiny", contextWindow: 100_000, maxTokens: 1_000 }],
    });
    faux.setResponses([fauxAssistantMessage(SUMMARY_RESPONSE)]);

    // A command_result renders into no summarizer message. Without this
    // guard the summarizer wrote a summary from the prompt template alone.
    await expect(
      summarize({
        headEntries: [
          { id: "c-1", sessionId: "s", threadId: "t", parentId: null, type: "command_result", command: "/status", source: "builtin", ok: true, output: "ready", createdAt: 1 },
        ],
        model: faux.getModel("tiny")!,
      }),
    ).rejects.toThrow(/no conversation history/);
    expect(faux.getPendingResponseCount()).toBe(1);
    faux.unregister();
  });

  // The two automatic callers must treat "coverage_gap" exactly as they
  // treat "insufficient": compaction cannot help, and it will not help on a
  // retry. The outcomes are separate values so `/compact` can name the right
  // corrective action, not so the callers can act differently.
  const unreadableHead = (sessionId: string, threadId: string) => [
    { id: "e-1", sessionId, threadId, parentId: null, type: "message" as const, role: "user" as const, content: "", createdAt: 1 },
    { id: "e-2", sessionId, threadId, parentId: "e-1", type: "message" as const, role: "assistant" as const, content: "", parts: [{ type: "thinking" as const, text: "x".repeat(200) }], createdAt: 2 },
  ];

  it("feeds the proactive circuit breaker when the head cannot be covered", async () => {
    const faux = registerFauxProvider({
      provider: "compact-coverage-breaker",
      models: [{ id: "tiny", name: "tiny", contextWindow: 50, maxTokens: 5 }],
    });
    const summarizerError = () =>
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "summarizer down" });
    faux.setResponses([
      // Turn 1: the head holds no summarizer text, so compaction reports
      // coverage_gap and never calls the summarizer. Breaker count 1.
      fauxAssistantMessage("r1"),
      // Turns 2 and 3: turn 1 left readable entries in the head, so the
      // summarizer runs and fails. Breaker counts 2 and 3.
      fauxAssistantMessage("r2"), summarizerError,
      fauxAssistantMessage("r3"), summarizerError,
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
    await store.appendEntries(session.id, thread.id, unreadableHead(session.id, thread.id));

    for (let turn = 1; turn <= 3; turn++) {
      const receipt = await session.prompt(OVER_BUDGET_PROMPT);
      await waitFor(
        () =>
          events.filter(
            (e) => e.event.type === "turn_end" && e.event.threadId === receipt.threadId,
          ).length >= turn,
      );
    }

    const codes = events
      .filter((e) => e.event.type === "error")
      .map((e) => (e.event as { code: string }).code);
    // One gap, two summarizer failures, and the breaker opens on the third.
    expect(codes.filter((c) => c === "compaction_coverage_gap")).toHaveLength(1);
    expect(codes.filter((c) => c === "compaction_failed")).toHaveLength(2);
    expect(codes.filter((c) => c === "compaction_circuit_open")).toHaveLength(1);
    // The gap pass emits its own error. It must not also emit the generic
    // proactive-failure error for the same pass.
    expect(codes.filter((c) => c === "compaction_noop")).toHaveLength(0);
    expect(faux.getPendingResponseCount()).toBe(0);
    faux.unregister();
  });

  it("stops the reactive overflow retry when the head cannot be covered", async () => {
    const faux = registerFauxProvider({
      provider: "compact-coverage-reactive",
      models: [{ id: "tiny", name: "tiny", contextWindow: 50, maxTokens: 5 }],
    });
    faux.setResponses([
      // The turn overflows, which is what starts reactive compaction.
      fauxAssistantMessage("", {
        stopReason: "error",
        errorMessage: "prompt is too long: 100 tokens > 50 maximum",
      }),
      // Queued to prove the retry did NOT run. A retry would consume it.
      fauxAssistantMessage("retried response"),
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
    await store.appendEntries(session.id, thread.id, unreadableHead(session.id, thread.id));

    const receipt = await session.prompt("marker-reactive prompt");
    await waitFor(() =>
      events.some(
        (e) => e.event.type === "turn_end" && e.event.threadId === receipt.threadId,
      ),
    );

    const codes = events
      .filter((e) => e.event.type === "error")
      .map((e) => (e.event as { code: string }).code);
    // One failure, one report. The post-turn proactive check sees the same
    // oversized context and must not run a second pass over it, which would
    // print the identical error again for one turn.
    expect(codes.filter((c) => c === "compaction_coverage_gap")).toHaveLength(1);
    // The recorded overflow response stands. Retrying the turn would just
    // overflow again, so the retry response is still queued.
    expect(faux.getPendingResponseCount()).toBe(1);
    const entries = await store.getEntries(session.id, thread.id);
    expect(entries.filter((e) => e.type === "compaction")).toHaveLength(0);
    faux.unregister();
  });

  it("counts one blocked reactive pass once toward the breaker", async () => {
    const faux = registerFauxProvider({
      provider: "compact-coverage-reactive-breaker",
      models: [{ id: "tiny", name: "tiny", contextWindow: 50, maxTokens: 5 }],
    });
    const summarizerError = () =>
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "summarizer down" });
    faux.setResponses([
      // Turn 1: the turn overflows, reactive compaction finds an unreadable
      // head, and the pass reports the gap. Breaker count 1.
      fauxAssistantMessage("", {
        stopReason: "error",
        errorMessage: "prompt is too long: 100 tokens > 50 maximum",
      }),
      // Turns 2 and 3: turn 1 left a readable prompt in the head, so the
      // proactive pass reaches the summarizer and it fails. Counts 2 and 3.
      fauxAssistantMessage("r2"), summarizerError,
      fauxAssistantMessage("r3"), summarizerError,
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
    await store.appendEntries(session.id, thread.id, unreadableHead(session.id, thread.id));

    for (let turn = 1; turn <= 3; turn++) {
      const receipt = await session.prompt(OVER_BUDGET_PROMPT);
      await waitFor(
        () =>
          events.filter(
            (e) => e.event.type === "turn_end" && e.event.threadId === receipt.threadId,
          ).length >= turn,
      );
    }

    const codes = events
      .filter((e) => e.event.type === "error")
      .map((e) => (e.event as { code: string }).code);
    // The blocked reactive pass reports once and counts once. It counts,
    // because the thread must stop retrying a compaction that cannot help;
    // it counts ONCE, because one failure is one failure.
    expect(codes.filter((c) => c === "compaction_coverage_gap")).toHaveLength(1);
    expect(codes.filter((c) => c === "compaction_failed")).toHaveLength(2);
    expect(codes.filter((c) => c === "compaction_circuit_open")).toHaveLength(1);
    expect(faux.getPendingResponseCount()).toBe(0);
    faux.unregister();
  });
});

describe("compaction: coverage narrows to what the summarizer read", () => {
  // usable = contextWindow - min(reserveCap, maxTokens) = 50 - 5 = 45, so the
  // summarizer input budget is min(max(45, 8_000), 64_000) = 8_000 tokens.
  // The conversion caps one prose block at 20_000 chars, so each block of
  // this step costs about 5_000 tokens of that budget.
  const OVERSIZED_STEP = "x".repeat(40_000);

  /**
   * head = [e-1, e-2, e-3, e-4], tail = [e-5, e-6]. e-2 carries twelve
   * oversized blocks, about 60_000 summarizer tokens, so the 8_000-token
   * window stops in front of it and reaches e-3 and e-4 only.
   */
  function partialCoverageEntries(sessionId: string, threadId: string): SessionEntry[] {
    const ids = { sessionId, threadId, type: "message" as const };
    return [
      { ...ids, id: "e-1", parentId: null, role: "user", content: "marker-e-1 first prompt", createdAt: 1 },
      {
        ...ids,
        id: "e-2",
        parentId: "e-1",
        role: "assistant",
        content: "",
        parts: Array.from({ length: 12 }, (_, i) => ({
          type: "text" as const,
          text: `marker-e-2 step ${i} ${OVERSIZED_STEP}`,
        })),
        createdAt: 2,
      },
      { ...ids, id: "e-3", parentId: "e-2", role: "user", content: "marker-e-3 second prompt", createdAt: 3 },
      { ...ids, id: "e-4", parentId: "e-3", role: "assistant", content: "marker-e-4 second response", createdAt: 4 },
      { ...ids, id: "e-5", parentId: "e-4", role: "user", content: "marker-e-5 third prompt", createdAt: 5 },
      { ...ids, id: "e-6", parentId: "e-5", role: "assistant", content: "marker-e-6 third response", createdAt: 6 },
    ];
  }

  it("leaves a head entry the summarizer never read in the model context", async () => {
    const summarizerInputs: string[] = [];
    const faux = registerFauxProvider({
      provider: "compact-coverage-narrow",
      models: [{ id: "tiny", name: "tiny", contextWindow: 50, maxTokens: 5 }],
    });
    faux.setResponses([
      (ctx: { messages: unknown[] }) => {
        summarizerInputs.push(JSON.stringify(ctx.messages));
        return fauxAssistantMessage(SUMMARY_RESPONSE);
      },
    ]);
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
    await store.appendEntries(session.id, thread.id, partialCoverageEntries(session.id, thread.id));

    expect(await thread.compactThread({ mode: "manual" })).toBe("compacted");

    const entries = await store.getEntries(session.id, thread.id);
    const compaction = entries.find((e): e is CompactionEntry => e.type === "compaction");
    // The summarizer read e-3 and e-4. e-1 and e-2 never reached it, so the
    // checkpoint does not claim them.
    expect(compaction!.coveredEntryIds).toEqual(["e-3", "e-4"]);
    expect(summarizerInputs[0]).toContain("marker-e-3");
    expect(summarizerInputs[0]).not.toContain("marker-e-2");
    // The size the checkpoint reports is the history it replaced, not the
    // history it left behind: e-2 alone estimates over 10_000 tokens.
    expect(compaction!.tokenCountBefore).toBeLessThan(1_000);

    const { entriesToAgentMessages } = await import("../src/thread.js");
    const rebuilt = JSON.stringify(
      entriesToAgentMessages(entries, { api: "anthropic-messages", provider: "anthropic", id: "tiny" }),
    );
    // The unread head stays in live context; the summarized head does not.
    expect(rebuilt).toContain("marker-e-2");
    expect(rebuilt).not.toContain("marker-e-4");
    faux.unregister();
  });

  it("converges: each pass covers more, and a pass with nothing left reports noop", async () => {
    const faux = registerFauxProvider({
      provider: "compact-coverage-converge",
      models: [{ id: "tiny", name: "tiny", contextWindow: 50, maxTokens: 5 }],
    });
    faux.setResponses(Array.from({ length: 8 }, () => fauxAssistantMessage(SUMMARY_RESPONSE)));
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
    await store.appendEntries(session.id, thread.id, partialCoverageEntries(session.id, thread.id));

    const covered: string[][] = [];
    const outcomes: string[] = [];
    for (let pass = 0; pass < 8; pass++) {
      const outcome = await thread.compactThread({ mode: "manual" });
      outcomes.push(outcome);
      const entries = await store.getEntries(session.id, thread.id);
      const checkpoints = entries.filter((e): e is CompactionEntry => e.type === "compaction");
      if (checkpoints.length > 0) covered.push(checkpoints.at(-1)!.coveredEntryIds);
      if (outcome !== "compacted") break;
    }

    // Three passes reach the whole head, each one strictly further back than
    // the last. A repeated pass cannot spin: the fourth finds every readable
    // head entry already covered and reclaims nothing.
    expect(outcomes).toEqual(["compacted", "compacted", "compacted", "noop"]);
    expect(covered).toEqual([
      ["e-3", "e-4"],
      ["e-2", "e-3", "e-4"],
      ["e-1", "e-2", "e-3", "e-4"],
      ["e-1", "e-2", "e-3", "e-4"],
    ]);

    // Each checkpoint carries the previous one's coverage. The rebuild reads
    // the newest checkpoint alone, so a pass that dropped the carried half
    // would put the head back into the context an earlier pass shrank.
    const { entriesToAgentMessages } = await import("../src/thread.js");
    const rebuilt = JSON.stringify(
      entriesToAgentMessages(
        await store.getEntries(session.id, thread.id),
        { api: "anthropic-messages", provider: "anthropic", id: "tiny" },
      ),
    );
    for (const id of ["e-1", "e-2", "e-3", "e-4"]) {
      expect(rebuilt).not.toContain(`marker-${id}`);
    }
    expect(rebuilt).toContain("marker-e-5");
    faux.unregister();
  });
});

describe("compaction: a head whose older half a checkpoint already covers", () => {
  /** Entries 1 and 2, summarized by checkpoint c-1. */
  function alreadyCompacted(sessionId: string, threadId: string): SessionEntry[] {
    const ids = { sessionId, threadId };
    return [
      { ...ids, id: "e-1", parentId: null, type: "message", role: "user", content: "marker-e-1 first prompt", createdAt: 1 },
      { ...ids, id: "e-2", parentId: "e-1", type: "message", role: "assistant", content: "marker-e-2 first response", createdAt: 2 },
      {
        ...ids,
        id: "c-1",
        parentId: "e-2",
        type: "compaction",
        summary: SUMMARY_RESPONSE,
        coveredEntryIds: ["e-1", "e-2"],
        tokenCountBefore: 20,
        tokenCountAfter: 10,
        createdAt: 3,
      },
    ];
  }

  it("counts only the entries it must replace when it cannot read them", async () => {
    const faux = registerFauxProvider({
      provider: "compact-coverage-pending-count",
      models: [{ id: "tiny", name: "tiny", contextWindow: 50, maxTokens: 5 }],
    });
    // Queued but never consumed: the guard runs before the summarizer call.
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
    const ids = { sessionId: session.id, threadId: thread.id };
    await store.appendEntries(session.id, thread.id, [
      ...alreadyCompacted(session.id, thread.id),
      // head continues with two entries the summarizer reads as nothing.
      { ...ids, id: "e-4", parentId: "c-1", type: "message", role: "user", content: "", createdAt: 4 },
      { ...ids, id: "e-5", parentId: "e-4", type: "message", role: "assistant", content: "", parts: [{ type: "thinking", text: "x".repeat(200) }], createdAt: 5 },
      { ...ids, id: "e-6", parentId: "e-5", type: "message", role: "user", content: "marker-e-6 second prompt", createdAt: 6 },
      { ...ids, id: "e-7", parentId: "e-6", type: "message", role: "assistant", content: "marker-e-7 second response", createdAt: 7 },
    ]);

    expect(await thread.compactThread({ mode: "manual" })).toBe("coverage_gap");

    const gaps = events.filter(
      (e) => e.event.type === "error" && e.event.code === "compaction_coverage_gap",
    );
    expect(gaps).toHaveLength(1);
    // head = [e-1, e-2, c-1, e-4, e-5], and c-1 already covers e-1 and e-2.
    // The three entries left are what this pass must replace, and the count
    // the user sees names them, not the whole head.
    expect(gaps[0].event).toMatchObject({
      error:
        "Compaction found no history to summarize. The 3 entries it must replace hold " +
        "no text the summarizer can read. Start a new thread if the context still overflows.",
    });
    faux.unregister();
  });

  it("reports noop when the entries left over are never in the model context", async () => {
    const faux = registerFauxProvider({
      provider: "compact-coverage-pending-nonmessage",
      models: [{ id: "tiny", name: "tiny", contextWindow: 50, maxTokens: 5 }],
    });
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
    const ids = { sessionId: session.id, threadId: thread.id };
    await store.appendEntries(session.id, thread.id, [
      ...alreadyCompacted(session.id, thread.id),
      // head = [e-1, e-2, c-1, cr-4]. Past the covered pair, only a
      // checkpoint and a command result are left, and the rebuild renders
      // neither into the model context.
      { ...ids, id: "cr-4", parentId: "c-1", type: "command_result", command: "/status", source: "builtin", ok: true, output: "ready", createdAt: 4 },
      { ...ids, id: "e-5", parentId: "cr-4", type: "message", role: "user", content: "marker-e-5 second prompt", createdAt: 5 },
      { ...ids, id: "e-6", parentId: "e-5", type: "message", role: "assistant", content: "marker-e-6 second response", createdAt: 6 },
    ]);

    // Nothing to reclaim is not a coverage gap: no summary could shrink this
    // context, and the counter must not report an invariant violation.
    expect(await thread.compactThread({ mode: "manual" })).toBe("noop");
    expect(
      events.filter(
        (e) => e.event.type === "error" && e.event.code === "compaction_coverage_gap",
      ),
    ).toHaveLength(0);
    expect(faux.getPendingResponseCount()).toBe(1);
    faux.unregister();
  });
});
