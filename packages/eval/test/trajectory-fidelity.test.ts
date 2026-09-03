/**
 * Trajectory-fidelity coverage: recursive child aggregation, turn-to-
 * submission linkage, and elided-result handling (adversarial-review
 * findings 4, 10, 12).
 */
import { describe, expect, it } from "vitest";
import type { MessageEntry } from "@valet/engine";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@valet/engine/test-helpers";
import { aggregateUsage, extractTrajectory, runCase, runDeterministicCheck } from "../src/index.js";
import type { EvalCase, Trajectory } from "../src/index.js";

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

function usage(total: number) {
  return { input: total - 10, output: 10, cacheRead: 0, cacheWrite: 0, total };
}

function cost(total: number) {
  return { input: total / 2, output: total / 2, cacheRead: 0, cacheWrite: 0, total };
}

function makeTrajectory(overrides: Partial<Trajectory>): Trajectory {
  return {
    caseId: "t",
    prompt: "p",
    model: "m",
    turns: [{ index: 0 }],
    toolCalls: [],
    finalOutput: "",
    usage: usage(100),
    durationMs: 10,
    ...overrides,
  };
}

describe("aggregateUsage", () => {
  it("sums usage, cost, tool calls, and turns recursively across children", () => {
    const grandchild = makeTrajectory({ usage: usage(50), cost: cost(0.05) });
    const child = makeTrajectory({
      usage: usage(200),
      cost: cost(0.2),
      toolCalls: [{ toolName: "bash", callId: "c1", status: "completed", index: 0 }],
      children: [grandchild],
    });
    const parent = makeTrajectory({
      usage: usage(1000),
      cost: cost(1),
      turns: [{ index: 0 }, { index: 1 }],
      children: [child],
    });

    const totals = aggregateUsage(parent);
    expect(totals.usage.total).toBe(1250);
    expect(totals.cost?.total).toBeCloseTo(1.25, 6);
    expect(totals.toolCallCount).toBe(1);
    expect(totals.turnCount).toBe(4);
  });

  it("omits cost when no level is priced", () => {
    const parent = makeTrajectory({ children: [makeTrajectory({})] });
    expect(aggregateUsage(parent).cost).toBeUndefined();
  });
});

describe("budget checks include children", () => {
  const parent = makeTrajectory({
    usage: usage(1000),
    cost: cost(0.01),
    children: [makeTrajectory({ usage: usage(9500), cost: cost(0.99) })],
  });

  it("max_tokens fails on the recursive total even when the parent is lean", () => {
    const r = runDeterministicCheck({ type: "max_tokens", value: 2000 }, parent);
    expect(r.pass).toBe(false);
    expect(r.detail).toContain("children included");
    expect(r.detail).toContain("10500");
  });

  it("max_cost fails on the recursive total", () => {
    const r = runDeterministicCheck({ type: "max_cost", value: 0.5 }, parent);
    expect(r.pass).toBe(false);
  });
});

describe("turn-to-submission linkage", () => {
  it("stamps each turn with its entry's queueItemId", () => {
    const t = extractTrajectory({
      caseId: "c",
      prompt: "p",
      model: "m",
      durationMs: 1,
      entries: [
        assistantEntry({ queueItemId: "q1", content: "a" }),
        assistantEntry({ queueItemId: "q2", content: "b" }),
      ],
    });
    expect(t.turns.map((x) => x.queueItemId)).toEqual(["q1", "q2"]);
  });

  it("stamps each tool call with its entry's queueItemId", () => {
    const t = extractTrajectory({
      caseId: "c",
      prompt: "p",
      model: "m",
      durationMs: 1,
      entries: [
        assistantEntry({
          queueItemId: "q1",
          parts: [{ type: "tool_call", callId: "c1", toolName: "write", status: "completed" }],
        }),
        assistantEntry({
          queueItemId: "q2",
          parts: [{ type: "tool_call", callId: "c2", toolName: "edit", status: "completed" }],
        }),
      ],
    });
    expect(t.toolCalls.map((c) => c.queueItemId)).toEqual(["q1", "q2"]);
  });
});

describe("elided results", () => {
  it("marks elided tool calls and tool_result_matches reports the elision", () => {
    const t = extractTrajectory({
      caseId: "c",
      prompt: "p",
      model: "m",
      durationMs: 1,
      entries: [
        assistantEntry({
          parts: [
            {
              type: "tool_call",
              callId: "c1",
              toolName: "bash",
              status: "completed",
              result: { text: "original output" },
              elided: true,
            },
          ],
        }),
      ],
    });
    expect(t.toolCalls[0].elided).toBe(true);

    const r = runDeterministicCheck({ type: "tool_result_matches", tool: "bash", pattern: "original" }, t);
    expect(r.pass).toBe(false);
    expect(r.detail).toContain("elided by compaction");
  });

  it("a non-elided sibling result still satisfies the check", () => {
    const t = extractTrajectory({
      caseId: "c",
      prompt: "p",
      model: "m",
      durationMs: 1,
      entries: [
        assistantEntry({
          parts: [
            { type: "tool_call", callId: "c1", toolName: "bash", status: "completed", result: { text: "x" }, elided: true },
            { type: "tool_call", callId: "c2", toolName: "bash", status: "completed", result: { text: "the answer" } },
          ],
        }),
      ],
    });
    const r = runDeterministicCheck({ type: "tool_result_matches", tool: "bash", pattern: "answer" }, t);
    expect(r.pass).toBe(true);
  });
});

describe("child duration through the runner", () => {
  it("records a non-zero spawn-to-settle duration on child trajectories", async () => {
    const faux = registerFauxProvider({ provider: "fidelity-1" });
    const flatten = (content: unknown): string =>
      typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content
              .map((b) =>
                typeof b === "object" && b !== null && "text" in b ? String((b as { text: unknown }).text) : "",
              )
              .join("")
          : "";
    const route = (context: { messages: Array<{ role: string; content: unknown }> }) => {
      const lastUser = flatten(context.messages.filter((m) => m.role === "user").at(-1)?.content);
      const transcript = context.messages.map((m) => flatten(m.content)).join("\n");
      if (lastUser.includes("child work")) return fauxAssistantMessage("child done");
      if (lastUser.includes("child_settled")) return fauxAssistantMessage("noted");
      // The turn continuation after the task tool result must NOT spawn again.
      if (transcript.includes("spawned child session")) return fauxAssistantMessage("dispatched");
      return fauxAssistantMessage([fauxToolCall("task", { prompt: "child work" }, { id: "s1" })], {
        stopReason: "toolUse",
      });
    };
    faux.setResponses([route, route, route, route]);

    const evalCase: EvalCase = {
      id: "child-duration",
      session_type: "orchestrator",
      turns: [{ role: "user", content: "delegate" }],
      checks: [{ type: "no_errors" }],
    };
    const result = await runCase(evalCase, { model: faux.getModel() });

    expect(result.trajectory.children).toHaveLength(1);
    expect(result.trajectory.children?.[0].durationMs).toBeGreaterThan(0);
    faux.unregister();
  });
});
