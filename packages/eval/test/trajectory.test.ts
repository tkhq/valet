import { describe, expect, it } from "vitest";
import type { MessageEntry, SessionEntry } from "@valet/engine";
import { extractTrajectory, toolResultText } from "../src/index.js";

let entryId = 0;
function assistantEntry(overrides: Partial<MessageEntry>): MessageEntry {
  return {
    id: `e-${entryId++}`,
    sessionId: "s1",
    threadId: "t1",
    parentId: null,
    createdAt: 1000 + entryId,
    type: "message",
    role: "assistant",
    content: "",
    ...overrides,
  };
}

function userEntry(content: string): MessageEntry {
  return {
    id: `e-${entryId++}`,
    sessionId: "s1",
    threadId: "t1",
    parentId: null,
    createdAt: 1000 + entryId,
    type: "message",
    role: "user",
    content,
  };
}

describe("toolResultText", () => {
  it("reads the engine's { text } shape", () => {
    expect(toolResultText({ text: "hello" })).toBe("hello");
  });

  it("reads pi-agent-core's { content: [{type: 'text', text}] } shape", () => {
    expect(toolResultText({ content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] })).toBe(
      "a\nb",
    );
  });

  it("reads a bare string", () => {
    expect(toolResultText("raw")).toBe("raw");
  });

  it("returns empty string for unreadable shapes", () => {
    expect(toolResultText(undefined)).toBe("");
    expect(toolResultText(42)).toBe("");
    expect(toolResultText({ foo: 1 })).toBe("");
  });
});

describe("extractTrajectory", () => {
  it("extracts tool calls, turns, final output, and aggregates usage", () => {
    const usage1 = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15 };
    const usage2 = { input: 20, output: 8, cacheRead: 2, cacheWrite: 1, total: 31 };
    const cost2 = { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 };
    const entries: SessionEntry[] = [
      userEntry("do the thing"),
      assistantEntry({
        content: "",
        usage: usage1,
        parts: [
          {
            type: "tool_call",
            callId: "c1",
            toolName: "mem_write",
            status: "completed",
            args: { path: "a.md", content: "x" },
            result: { text: "Created: a.md" },
          },
        ],
      }),
      assistantEntry({
        content: "done",
        stopReason: "end_turn",
        usage: usage2,
        cost: cost2,
        parts: [{ type: "text", text: "done" }],
      }),
    ];

    const t = extractTrajectory({
      caseId: "case-1",
      prompt: "do the thing",
      model: "anthropic/claude-haiku-4-5",
      durationMs: 1234,
      entries,
    });

    expect(t.caseId).toBe("case-1");
    expect(t.finalOutput).toBe("done");
    expect(t.stopReason).toBe("end_turn");
    expect(t.durationMs).toBe(1234);
    expect(t.turns).toHaveLength(2);
    expect(t.turns[0].usage).toEqual(usage1);
    expect(t.turns[1].cost).toEqual(cost2);
    expect(t.usage).toEqual({ input: 30, output: 13, cacheRead: 2, cacheWrite: 1, total: 46 });
    expect(t.cost).toEqual(cost2);
    expect(t.toolCalls).toHaveLength(1);
    expect(t.toolCalls[0]).toMatchObject({
      toolName: "mem_write",
      callId: "c1",
      status: "completed",
      index: 0,
    });
  });

  it("omits cost when no turn is priced and keeps zero usage totals", () => {
    const entries: SessionEntry[] = [userEntry("hi"), assistantEntry({ content: "hello" })];
    const t = extractTrajectory({
      caseId: "c",
      prompt: "hi",
      model: "m",
      durationMs: 1,
      entries,
    });
    expect(t.cost).toBeUndefined();
    expect(t.usage.total).toBe(0);
    expect(t.finalOutput).toBe("hello");
  });

  it("indexes tool calls across entries in order", () => {
    const entries: SessionEntry[] = [
      assistantEntry({
        parts: [
          { type: "tool_call", callId: "c1", toolName: "a", status: "completed" },
          { type: "tool_call", callId: "c2", toolName: "b", status: "error", error: "boom" },
        ],
      }),
      assistantEntry({
        parts: [{ type: "tool_call", callId: "c3", toolName: "c", status: "completed" }],
      }),
    ];
    const t = extractTrajectory({ caseId: "c", prompt: "p", model: "m", durationMs: 1, entries });
    expect(t.toolCalls.map((c) => [c.toolName, c.index])).toEqual([
      ["a", 0],
      ["b", 1],
      ["c", 2],
    ]);
    expect(t.toolCalls[1].error).toBe("boom");
  });

  it("attaches children when provided", () => {
    const child = extractTrajectory({ caseId: "c#child-0", prompt: "p", model: "m", durationMs: 1, entries: [] });
    const t = extractTrajectory({
      caseId: "c",
      prompt: "p",
      model: "m",
      durationMs: 1,
      entries: [],
      children: [child],
    });
    expect(t.children).toHaveLength(1);
    expect(t.children?.[0].caseId).toBe("c#child-0");
  });
});
