import { describe, it, expect } from "vitest";
import type { Message } from "@earendil-works/pi-ai/compat";
import {
  applyPrune,
  entriesToAgentMessages,
  entriesToSummaryMessages,
  estimateContextTokens,
  estimateLiveContextTokens,
  estimateTokens,
  estimateEntryTokens,
  extractFileContext,
  planPrune,
  selectCutPoint,
  storedToolResultText,
  stripAnalysisScratchpad,
  tailBudget,
  turns,
  usableTokens,
  type MessageEntry,
  type SessionEntry,
} from "../src/index.js";

const MODEL = {
  id: "fake",
  name: "fake",
  api: "anthropic-messages" as const,
  provider: "anthropic" as const,
  baseUrl: "",
  reasoning: false,
  input: ["text"] as ("text" | "image")[],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100_000,
  maxTokens: 8_000,
};

function user(id: string, content: string): MessageEntry {
  return {
    id,
    sessionId: "s",
    threadId: "t",
    parentId: null,
    type: "message",
    role: "user",
    content,
    createdAt: 1,
  };
}

function assistant(id: string, content: string, parts?: MessageEntry["parts"]): MessageEntry {
  return {
    id,
    sessionId: "s",
    threadId: "t",
    parentId: null,
    type: "message",
    role: "assistant",
    content,
    parts,
    createdAt: 1,
  };
}

describe("compaction: estimateTokens / estimateEntryTokens", () => {
  it("estimateTokens approximates 4 chars per token", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("a".repeat(40))).toBe(10);
  });

  it("counts text content, parts text, and tool args/results", () => {
    const e = assistant("a", "ignored", [
      { type: "text", text: "a".repeat(40) },
      {
        type: "tool_call",
        callId: "c",
        toolName: "x",
        status: "completed",
        args: { p: "y".repeat(20) },
        result: "z".repeat(80),
      },
    ]);
    // 40 (text) + ~30 (args json: {"p":"yyyy..."} ~= 30 chars) + 80 (result) ~= ~37 tokens
    const tokens = estimateEntryTokens(e);
    expect(tokens).toBeGreaterThan(30);
    expect(tokens).toBeLessThan(50);
  });

  it("ignores elided tool results", () => {
    const e = assistant("a", "", [
      {
        type: "tool_call",
        callId: "c",
        toolName: "x",
        status: "completed",
        result: "z".repeat(80),
        elided: true,
      },
    ]);
    expect(estimateEntryTokens(e)).toBe(0);
  });
});

describe("compaction: usableTokens / tailBudget", () => {
  it("usableTokens defaults reserve to min(20k, maxTokens)", () => {
    expect(usableTokens(MODEL)).toBe(100_000 - 8_000);
  });

  it("reserveTokens overrides", () => {
    expect(usableTokens(MODEL, { reserveTokens: 50_000 })).toBe(50_000);
  });

  it("tailBudget = 25% of usable, floored at 2k", () => {
    expect(tailBudget(100_000)).toBe(25_000);
    expect(tailBudget(20_000)).toBe(5_000);
    expect(tailBudget(4_000)).toBe(2_000);
  });

  it("scales with production-size context windows instead of capping at 8k (TKAI-305)", () => {
    // 200k-context model, 8k maxTokens: usable = 192k → tail = 48k. The old
    // fixed 8k ceiling kept 4% of the window verbatim on every prod model.
    const prodModel = { ...MODEL, contextWindow: 200_000 };
    const usable = usableTokens(prodModel);
    expect(usable).toBe(192_000);
    expect(tailBudget(usable)).toBe(48_000);
  });

  it("maxPreserveRecentTokens caps the budget only when configured", () => {
    expect(tailBudget(100_000, { maxPreserveRecentTokens: 8_000 })).toBe(8_000);
    // The floor still wins over a configured ceiling below it.
    expect(tailBudget(100_000, { maxPreserveRecentTokens: 1_000 })).toBe(2_000);
  });
});

describe("compaction: turns", () => {
  it("segments by user-message boundaries", () => {
    const entries = [
      user("u1", "first"),
      assistant("a1", "ans"),
      user("u2", "second"),
      assistant("a2", "ans"),
    ];
    const t = turns(entries);
    expect(t).toHaveLength(2);
    expect(t[0]).toMatchObject({ start: 0, end: 2, id: "u1" });
    expect(t[1]).toMatchObject({ start: 2, end: 4, id: "u2" });
  });

  it("returns no turns when there are no user messages", () => {
    expect(turns([assistant("a", "x")])).toEqual([]);
  });
});

describe("compaction: selectCutPoint", () => {
  // Use a tokenize override to make the math easy: each entry "weighs" 100 tokens.
  const fixed = () => 100;

  it("keeps the last tailTurns turns when they fit the budget", () => {
    const entries = [
      user("u1", ""),
      assistant("a1", ""),
      user("u2", ""),
      assistant("a2", ""),
      user("u3", ""),
      assistant("a3", ""),
    ];
    // usable = 100k - 8k = 92k → budget = 23k; tailTurns=2 binds first.
    const cut = selectCutPoint({ entries, model: MODEL, cfg: { tailTurns: 2 }, tokenize: fixed });
    expect(cut.cutIndex).toBe(2);
    expect(cut.tailStartId).toBe("u2");
    expect(cut.fallbackToFloor).toBe(false);
  });

  it("default tailTurns lets the token budget bind instead of the turn count", () => {
    const entries = [
      user("u1", ""),
      assistant("a1", ""),
      user("u2", ""),
      assistant("a2", ""),
      user("u3", ""),
      assistant("a3", ""),
    ];
    // All 3 turns (600 est. tokens) fit the 23k budget within the default
    // tailTurns (8) → nothing to compact.
    const cut = selectCutPoint({ entries, model: MODEL, tokenize: fixed });
    expect(cut.cutIndex).toBe(0);
    expect(cut.tailStartId).toBe("u1");
  });

  it("respects tailTurns=1", () => {
    const entries = [
      user("u1", ""),
      assistant("a1", ""),
      user("u2", ""),
      assistant("a2", ""),
    ];
    const cut = selectCutPoint({
      entries,
      model: MODEL,
      cfg: { tailTurns: 1 },
      tokenize: fixed,
    });
    expect(cut.cutIndex).toBe(2);
    expect(cut.tailStartId).toBe("u2");
  });

  it("splits a turn that's too big to fit the budget", () => {
    const entries = [
      user("u1", ""),
      assistant("a1", ""),
      user("u2", ""),
      assistant("a2", ""),
      assistant("a3", ""),
      assistant("a4", ""),
      assistant("a5", ""),
    ];
    // u2 turn is 5 entries × 100 = 500. budget < 500 forces a split.
    const cut = selectCutPoint({
      entries,
      model: MODEL,
      cfg: { tailTurns: 1, minPreserveRecentTokens: 200, maxPreserveRecentTokens: 200 },
      tokenize: fixed,
    });
    // Split point should be inside u2's turn.
    expect(cut.cutIndex).toBeGreaterThan(2);
    expect(cut.cutIndex).toBeLessThan(7);
    expect(cut.fallbackToFloor).toBe(false);
  });

  it("falls back to keeping just the last turn when nothing fits", () => {
    const entries = [
      user("u1", ""),
      // a single huge turn that can't be split below the floor
      assistant("a1", ""),
    ];
    const cut = selectCutPoint({
      entries,
      model: MODEL,
      cfg: { tailTurns: 1, minPreserveRecentTokens: 50, maxPreserveRecentTokens: 50 },
      tokenize: () => 500, // each entry 500, way over the 50-token budget
    });
    expect(cut.cutIndex).toBe(0);
    expect(cut.fallbackToFloor).toBe(true);
  });
});

describe("compaction: planPrune", () => {
  function tcResult(id: string, callId: string, toolName: string, resultLen: number, opts: { protected?: boolean; elided?: boolean } = {}): MessageEntry {
    return assistant(id, "", [
      {
        type: "tool_call",
        callId,
        toolName,
        status: "completed",
        args: { x: 1 },
        result: "z".repeat(resultLen),
        elided: opts.elided,
      },
    ]);
  }

  it("preserves recent tool outputs within the protect window", () => {
    // 30k tokens of recent tool output; protect window is 40k → nothing to elide.
    const entries = [
      user("u1", ""),
      tcResult("a1", "c1", "bash", 60_000), // ~15k tokens
      tcResult("a2", "c2", "bash", 60_000), // ~15k tokens, total ~30k
    ];
    const plan = planPrune({ entries });
    expect(plan.willCommit).toBe(false);
    expect(plan.savedTokens).toBe(0);
  });

  it("marks older tool outputs once cumulative exceeds protect window", () => {
    // 3 entries × ~24k tokens each = 72k cumulative → first two fit in protect window
    // (40k), the oldest one is older than the window → marked.
    const entries = [
      user("u1", ""),
      tcResult("a1", "c1", "bash", 100_000), // ~25k tokens, oldest
      tcResult("a2", "c2", "bash", 100_000), // ~25k
      tcResult("a3", "c3", "bash", 100_000), // ~25k, newest
    ];
    const plan = planPrune({ entries });
    expect(plan.willCommit).toBe(true);
    expect(plan.toElide.has("a1")).toBe(true);
    expect(plan.savedTokens).toBeGreaterThanOrEqual(20_000);
  });

  it("skips protected tools", () => {
    const entries = [
      user("u1", ""),
      tcResult("a1", "c1", "skill", 100_000), // protected by default
      tcResult("a2", "c2", "bash", 100_000),
      tcResult("a3", "c3", "bash", 100_000),
    ];
    const plan = planPrune({ entries });
    // a1 was protected, only a2 / a3 count toward the protect window. a2 sits at ~50k
    // cumulative, a3 at ~25k. So only a2 might be elided. Either way, "a1" is never in
    // the elision plan.
    expect(plan.toElide.has("a1")).toBe(false);
  });

  it("skips already-elided parts", () => {
    const entries = [
      user("u1", ""),
      tcResult("a1", "c1", "bash", 100_000, { elided: true }),
      tcResult("a2", "c2", "bash", 100_000),
      tcResult("a3", "c3", "bash", 100_000),
    ];
    const plan = planPrune({ entries });
    expect(plan.toElide.has("a1")).toBe(false);
  });

  it("doesn't commit if savings are below pruneMinimumTokens", () => {
    const entries = [
      user("u1", ""),
      tcResult("a1", "c1", "bash", 200_000), // ~50k tokens
      tcResult("a2", "c2", "bash", 200_000), // ~50k tokens, plenty in protect
    ];
    // Set pruneMinimumTokens very high → won't commit.
    const plan = planPrune({ entries, cfg: { pruneMinimumTokens: 1_000_000 } });
    expect(plan.willCommit).toBe(false);
  });
});

describe("compaction: applyPrune", () => {
  it("marks tool_call parts elided but keeps the stored result (TKAI-305)", () => {
    const entries: SessionEntry[] = [
      user("u1", ""),
      assistant("a1", "", [
        {
          type: "tool_call",
          callId: "c1",
          toolName: "bash",
          status: "completed",
          args: { cmd: "ls" },
          result: "very long output",
        },
      ]),
    ];
    const plan = {
      toElide: new Map([["a1", ["c1"]]]),
      savedTokens: 100_000,
      willCommit: true,
    };
    applyPrune(entries, plan);
    const a1 = entries[1];
    if (a1.type !== "message") throw new Error("expected message");
    const tc = a1.parts?.[0];
    expect(tc?.type).toBe("tool_call");
    if (tc?.type === "tool_call") {
      expect(tc.elided).toBe(true);
      // The stored text survives — elision applies at render time only, so
      // the summarizer can still read the output at the next compaction.
      expect(tc.result).toBe("very long output");
    }
  });

  it("is a no-op when willCommit=false", () => {
    const entries: SessionEntry[] = [
      user("u1", ""),
      assistant("a1", "", [
        {
          type: "tool_call",
          callId: "c1",
          toolName: "bash",
          status: "completed",
          result: "keep me",
        },
      ]),
    ];
    applyPrune(entries, { toElide: new Map([["a1", ["c1"]]]), savedTokens: 0, willCommit: false });
    const a1 = entries[1];
    if (a1.type !== "message") throw new Error("expected message");
    const tc = a1.parts?.[0];
    if (tc?.type === "tool_call") {
      expect(tc.elided).toBeUndefined();
      expect(tc.result).toBe("keep me");
    }
  });
});

describe("compaction: extractFileContext", () => {
  it("classifies read vs modified by tool name", () => {
    const entries: SessionEntry[] = [
      assistant("a1", "", [
        { type: "tool_call", callId: "c1", toolName: "read", status: "completed", args: { path: "/a.txt" } },
        { type: "tool_call", callId: "c2", toolName: "write", status: "completed", args: { path: "/b.txt" } },
        { type: "tool_call", callId: "c3", toolName: "edit", status: "completed", args: { path: "/c.txt" } },
        { type: "tool_call", callId: "c4", toolName: "grep", status: "completed", args: { path: "/d.txt" } },
      ]),
    ];
    const fc = extractFileContext(entries);
    expect(fc.read.sort()).toEqual(["/a.txt", "/d.txt"]);
    expect(fc.modified.sort()).toEqual(["/b.txt", "/c.txt"]);
  });

  it("dedupes paths", () => {
    const entries: SessionEntry[] = [
      assistant("a1", "", [
        { type: "tool_call", callId: "c1", toolName: "read", status: "completed", args: { path: "/a.txt" } },
        { type: "tool_call", callId: "c2", toolName: "read", status: "completed", args: { path: "/a.txt" } },
      ]),
    ];
    const fc = extractFileContext(entries);
    expect(fc.read).toEqual(["/a.txt"]);
  });
});

describe("compaction: estimateContextTokens", () => {
  it("counts the system prompt plus text across all message roles", () => {
    const messages: Message[] = [
      { role: "user", content: "a".repeat(40), timestamp: 1 },
      {
        role: "assistant",
        content: [
          { type: "text", text: "b".repeat(40) },
          { type: "thinking", thinking: "c".repeat(40) },
          { type: "toolCall", id: "c1", name: "bash", arguments: { cmd: "d".repeat(20) } },
        ],
        api: "anthropic-messages",
        provider: "anthropic",
        model: "m",
        usage: {
          input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: 2,
      },
      {
        role: "toolResult",
        toolCallId: "c1",
        toolName: "bash",
        content: [{ type: "text", text: "e".repeat(40) }],
        isError: false,
        timestamp: 3,
      },
    ];
    const total = estimateContextTokens("s".repeat(40), messages);
    // 5 × 40-char blocks (system, user, text, thinking, result) = 50 tokens,
    // plus the toolCall args JSON (~8 tokens).
    expect(total).toBeGreaterThanOrEqual(50);
    expect(total).toBeLessThan(70);
  });

  it("counts image blocks with a flat estimate", () => {
    const messages: Message[] = [
      {
        role: "user",
        content: [{ type: "image", data: "x", mimeType: "image/png" }],
        timestamp: 1,
      },
    ];
    expect(estimateContextTokens(undefined, messages)).toBe(1_500);
  });
});

describe("compaction: estimateLiveContextTokens (TKAI-306)", () => {
  const assistantMsg = (usageTotal: number, text = ""): Message => ({
    role: "assistant",
    content: text ? [{ type: "text", text }] : [],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "m",
    usage: {
      input: usageTotal, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: usageTotal,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 1,
  });

  it("anchors on the newest assistant usage and estimates only later messages", () => {
    const messages: Message[] = [
      { role: "user", content: "ignored by the anchor", timestamp: 1 },
      assistantMsg(1_000),
      { role: "user", content: "x".repeat(40), timestamp: 2 }, // 10 estimated tokens
    ];
    // System prompt is inside the anchor's input — must not be re-added.
    expect(estimateLiveContextTokens("s".repeat(400), messages)).toBe(1_010);
  });

  it("falls back to the pure estimate when no message carries real usage", () => {
    const messages: Message[] = [
      { role: "user", content: "x".repeat(40), timestamp: 1 },
      assistantMsg(0, "y".repeat(40)), // rehydrated: fabricated zero usage
    ];
    // 10 (system) + 10 (user) + 10 (assistant text)
    expect(estimateLiveContextTokens("s".repeat(40), messages)).toBe(30);
  });

  it("skips zero-usage assistant messages when an older anchor exists", () => {
    const messages: Message[] = [
      assistantMsg(500),
      { role: "user", content: "x".repeat(40), timestamp: 2 }, // 10
      assistantMsg(0, "y".repeat(40)), // 10
    ];
    expect(estimateLiveContextTokens(undefined, messages)).toBe(520);
  });
});

describe("compaction: stripAnalysisScratchpad (TKAI-306)", () => {
  it("removes the analysis block and keeps the summary", () => {
    const raw = "<analysis>\ndraft notes\n</analysis>\n\n## Goal\n- ship it";
    expect(stripAnalysisScratchpad(raw)).toBe("## Goal\n- ship it");
  });

  it("removes every analysis block, not just the first", () => {
    const raw = "<analysis>one</analysis>\n## Goal\n- x\n<analysis>two</analysis>";
    expect(stripAnalysisScratchpad(raw)).toBe("## Goal\n- x");
  });

  it("removes an unclosed analysis block (truncated output)", () => {
    expect(stripAnalysisScratchpad("<analysis>\ntruncated mid-scratch")).toBe("");
  });

  it("passes through output without an analysis block", () => {
    expect(stripAnalysisScratchpad("## Goal\n- x")).toBe("## Goal\n- x");
  });
});

describe("compaction: summarizer input caps (TKAI-306)", () => {
  it("caps giant user prose and tool args so one entry cannot dominate", () => {
    const messages = entriesToSummaryMessages(
      [
        user("u1", "p".repeat(50_000)),
        assistant("a1", "", [
          {
            type: "tool_call",
            callId: "c1",
            toolName: "write",
            status: "completed",
            args: { content: "q".repeat(50_000) },
            result: "ok",
          },
        ]),
      ],
      { toolOutputMaxChars: 2_000 },
    );
    const total = JSON.stringify(messages).length;
    // 100k chars of input collapses to bounded output (20k prose cap +
    // 2k args cap + framing).
    expect(total).toBeLessThan(30_000);
    expect(JSON.stringify(messages)).toContain("truncated");
  });
});

describe("compaction: storedToolResultText", () => {
  it("returns the stored string or JSON", () => {
    expect(storedToolResultText({ result: "out" })).toBe("out");
    expect(storedToolResultText({ result: { text: "x" } })).toBe('{"text":"x"}');
  });

  it("returns undefined for missing results and legacy prune placeholders", () => {
    expect(storedToolResultText({})).toBeUndefined();
    expect(storedToolResultText({ result: { elided: true, reason: "pruned" } })).toBeUndefined();
  });
});

describe("compaction: thread_read escape hatch (TKAI-306)", () => {
  const fixture: SessionEntry[] = [
    user("u1", "old prompt"),
    {
      id: "c1",
      sessionId: "s",
      threadId: "t",
      parentId: "u1",
      type: "compaction",
      summary: "## Goal\n- resumed",
      coveredEntryIds: ["u1"],
      tokenCountBefore: 100,
      tokenCountAfter: 10,
      createdAt: 2,
    },
    user("u2", "new prompt"),
  ];
  const modelHint = { api: "anthropic-messages", provider: "anthropic", id: "m" };

  it("the summary wrapper names thread_read and the thread key when given", () => {
    const messages = entriesToAgentMessages(fixture, modelHint, { threadKey: "web:default" });
    const first = messages[0];
    if (first.role !== "user" || typeof first.content === "string") throw new Error("expected block user message");
    const text = first.content[0];
    if (text.type !== "text") throw new Error("expected text block");
    expect(text.text).toContain("thread_read");
    expect(text.text).toContain('"web:default"');
  });

  it("no hint without a thread key", () => {
    const messages = entriesToAgentMessages(fixture, modelHint);
    const first = messages[0];
    if (first.role !== "user" || typeof first.content === "string") throw new Error("expected block user message");
    const text = first.content[0];
    if (text.type !== "text") throw new Error("expected text block");
    expect(text.text).not.toContain("thread_read");
  });
});

describe("compaction: elided results and the summarizer (TKAI-305)", () => {
  const elidedEntry = assistant("a1", "", [
    {
      type: "tool_call",
      callId: "c1",
      toolName: "bash",
      status: "completed",
      args: { cmd: "cat notes" },
      result: "the agreed rollout plan is blue-green",
      elided: true,
    },
  ]);

  it("feeds an elided-but-preserved tool result to the summarizer", () => {
    const messages = entriesToSummaryMessages([elidedEntry], { toolOutputMaxChars: 2_000 });
    const text = JSON.stringify(messages);
    expect(text).toContain("the agreed rollout plan is blue-green");
    expect(text).not.toContain("[output elided to save context]");
  });

  it("falls back to the elision marker when the stored text was discarded (legacy prune)", () => {
    const legacy = assistant("a1", "", [
      {
        type: "tool_call",
        callId: "c1",
        toolName: "bash",
        status: "completed",
        result: { elided: true, reason: "pruned" },
        elided: true,
      },
    ]);
    const messages = entriesToSummaryMessages([legacy], { toolOutputMaxChars: 2_000 });
    expect(JSON.stringify(messages)).toContain("[output elided to save context]");
  });

  it("renders a placeholder in the LIVE context even though the stored text is preserved", () => {
    const messages = entriesToAgentMessages(
      [user("u1", "hi"), elidedEntry],
      { api: "anthropic-messages", provider: "anthropic", id: "m" },
    );
    const toolResult = messages.find((m) => m.role === "toolResult");
    expect(toolResult).toBeDefined();
    const text = JSON.stringify(toolResult);
    expect(text).toContain("[output elided to save context]");
    expect(text).not.toContain("blue-green");
  });
});
