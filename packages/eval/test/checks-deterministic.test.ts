import { describe, expect, it } from "vitest";
import { jsonSubsetMatches, runDeterministicCheck } from "../src/checks/deterministic.js";
import { runCheck, runChecks } from "../src/checks/index.js";
import type { DeterministicCheck, Trajectory, TrajectoryToolCall } from "../src/index.js";

function call(
  toolName: string,
  index: number,
  overrides: Partial<TrajectoryToolCall> = {},
): TrajectoryToolCall {
  return { toolName, callId: `c${index}`, status: "completed", index, ...overrides };
}

function makeTrajectory(overrides: Partial<Trajectory> = {}): Trajectory {
  return {
    caseId: "t",
    prompt: "p",
    model: "m",
    turns: [{ index: 0 }, { index: 1 }],
    toolCalls: [],
    finalOutput: "the deploy freeze ends Friday",
    usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, total: 150 },
    durationMs: 2_000,
    ...overrides,
  };
}

function run(check: DeterministicCheck, trajectory: Trajectory) {
  return runDeterministicCheck(check, trajectory);
}

describe("tool_called", () => {
  const t = makeTrajectory({
    toolCalls: [call("mem_write", 0), call("mem_read", 1), call("mem_write", 2)],
  });

  it("passes with the default at-least-once", () => {
    expect(run({ type: "tool_called", tool: "mem_read" }, t).pass).toBe(true);
  });

  it("fails when the tool was never called", () => {
    const r = run({ type: "tool_called", tool: "bash" }, t);
    expect(r.pass).toBe(false);
    expect(r.detail).toContain("bash");
    expect(r.detail).toContain("mem_write");
  });

  it("enforces exact count", () => {
    expect(run({ type: "tool_called", tool: "mem_write", count: 2 }, t).pass).toBe(true);
    expect(run({ type: "tool_called", tool: "mem_write", count: 1 }, t).pass).toBe(false);
  });

  it("enforces min and max", () => {
    expect(run({ type: "tool_called", tool: "mem_write", min: 2, max: 2 }, t).pass).toBe(true);
    expect(run({ type: "tool_called", tool: "mem_write", min: 3 }, t).pass).toBe(false);
    expect(run({ type: "tool_called", tool: "mem_write", max: 1 }, t).pass).toBe(false);
  });

  it("scopes to calls after another tool", () => {
    expect(run({ type: "tool_called", tool: "mem_write", after: "mem_read" }, t).pass).toBe(true);
    expect(run({ type: "tool_called", tool: "mem_read", after: "mem_write" }, t).pass).toBe(true);
    expect(
      run({ type: "tool_called", tool: "mem_write", after: "mem_read", count: 1 }, t).pass,
    ).toBe(true);
  });

  it("fails when the anchor tool was never called", () => {
    const r = run({ type: "tool_called", tool: "mem_write", after: "bash" }, t);
    expect(r.pass).toBe(false);
    expect(r.detail).toContain("`bash` was never called");
  });
});

describe("tool_not_called", () => {
  it("passes when absent and fails when present", () => {
    const t = makeTrajectory({ toolCalls: [call("bash", 0)] });
    expect(run({ type: "tool_not_called", tool: "mem_rm" }, t).pass).toBe(true);
    const r = run({ type: "tool_not_called", tool: "bash" }, t);
    expect(r.pass).toBe(false);
    expect(r.detail).toContain("bash");
  });
});

describe("tool_result_matches / tool_result_not_matches", () => {
  const t = makeTrajectory({
    toolCalls: [
      call("mem_rm", 0, { result: { text: "Deleted: a.md" } }),
      call("mem_rm", 1, { result: { content: [{ type: "text", text: "Not found: b.md" }] } }),
    ],
  });

  it("matches result text across result shapes", () => {
    expect(run({ type: "tool_result_matches", tool: "mem_rm", pattern: "^Deleted:" }, t).pass).toBe(true);
    expect(run({ type: "tool_result_matches", tool: "mem_rm", pattern: "^Not found:" }, t).pass).toBe(true);
  });

  it("fails when no result matches and when the tool was never called", () => {
    expect(run({ type: "tool_result_matches", tool: "mem_rm", pattern: "^Purged:" }, t).pass).toBe(false);
    const r = run({ type: "tool_result_matches", tool: "bash", pattern: "x" }, t);
    expect(r.pass).toBe(false);
    expect(r.detail).toContain("never called");
  });

  it("tool_result_not_matches flags offenders", () => {
    expect(run({ type: "tool_result_not_matches", tool: "mem_rm", pattern: "^Purged:" }, t).pass).toBe(true);
    const r = run({ type: "tool_result_not_matches", tool: "mem_rm", pattern: "^Not found:" }, t);
    expect(r.pass).toBe(false);
    expect(r.detail).toContain("Not found");
  });
});

describe("tool_args_match", () => {
  const t = makeTrajectory({
    toolCalls: [call("write", 0, { args: { path: "/tmp/a.txt", content: "hi", opts: { mode: 1 } } })],
  });

  it("passes on a JSON subset", () => {
    expect(run({ type: "tool_args_match", tool: "write", args: { path: "/tmp/a.txt" } }, t).pass).toBe(true);
    expect(
      run({ type: "tool_args_match", tool: "write", args: { opts: { mode: 1 } } }, t).pass,
    ).toBe(true);
  });

  it("fails on a mismatched subset or a missing tool", () => {
    expect(run({ type: "tool_args_match", tool: "write", args: { path: "/other" } }, t).pass).toBe(false);
    expect(run({ type: "tool_args_match", tool: "bash", args: {} }, t).pass).toBe(false);
  });
});

describe("jsonSubsetMatches", () => {
  it("compares primitives strictly", () => {
    expect(jsonSubsetMatches(1, 1)).toBe(true);
    expect(jsonSubsetMatches(1, "1")).toBe(false);
    expect(jsonSubsetMatches(null, null)).toBe(true);
  });

  it("requires exact arrays", () => {
    expect(jsonSubsetMatches([1, 2], [1, 2])).toBe(true);
    expect(jsonSubsetMatches([1], [1, 2])).toBe(false);
  });

  it("allows extra keys in the actual object", () => {
    expect(jsonSubsetMatches({ a: 1 }, { a: 1, b: 2 })).toBe(true);
    expect(jsonSubsetMatches({ a: { b: 2 } }, { a: { b: 2, c: 3 } })).toBe(true);
    expect(jsonSubsetMatches({ a: 1 }, { b: 2 })).toBe(false);
  });
});

describe("output checks", () => {
  const t = makeTrajectory({});

  it("output_contains by value and pattern", () => {
    expect(run({ type: "output_contains", value: "deploy freeze" }, t).pass).toBe(true);
    expect(run({ type: "output_contains", pattern: "ends \\w+day" }, t).pass).toBe(true);
    expect(run({ type: "output_contains", value: "missing" }, t).pass).toBe(false);
  });

  it("output_not_contains by value and pattern", () => {
    expect(run({ type: "output_not_contains", value: "missing" }, t).pass).toBe(true);
    const r = run({ type: "output_not_contains", pattern: "Friday" }, t);
    expect(r.pass).toBe(false);
  });
});

describe("terminal and error checks", () => {
  it("all_terminal fails on a running call", () => {
    const t = makeTrajectory({ toolCalls: [call("bash", 0, { status: "running" })] });
    expect(run({ type: "all_terminal" }, t).pass).toBe(false);
    expect(run({ type: "all_terminal" }, makeTrajectory({})).pass).toBe(true);
  });

  it("no_errors fails on an errored call and passes on completed", () => {
    const t = makeTrajectory({
      toolCalls: [call("bash", 0, { status: "error", error: "boom" }), call("read", 1)],
    });
    const r = run({ type: "no_errors" }, t);
    expect(r.pass).toBe(false);
    expect(r.detail).toContain("bash");
    expect(run({ type: "no_errors" }, makeTrajectory({})).pass).toBe(true);
  });
});

describe("budget checks", () => {
  it("max_turns", () => {
    expect(run({ type: "max_turns", value: 2 }, makeTrajectory({})).pass).toBe(true);
    expect(run({ type: "max_turns", value: 1 }, makeTrajectory({})).pass).toBe(false);
  });

  it("max_tokens", () => {
    expect(run({ type: "max_tokens", value: 150 }, makeTrajectory({})).pass).toBe(true);
    expect(run({ type: "max_tokens", value: 149 }, makeTrajectory({})).pass).toBe(false);
  });

  it("max_cost compares priced trajectories and passes unpriced with a note", () => {
    const priced = makeTrajectory({
      cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 },
    });
    expect(run({ type: "max_cost", value: 0.05 }, priced).pass).toBe(true);
    expect(run({ type: "max_cost", value: 0.01 }, priced).pass).toBe(false);
    const unpriced = run({ type: "max_cost", value: 0.01 }, makeTrajectory({}));
    expect(unpriced.pass).toBe(true);
    expect(unpriced.detail).toContain("unpriced");
  });

  it("max_duration", () => {
    expect(run({ type: "max_duration", value: 2_000 }, makeTrajectory({})).pass).toBe(true);
    expect(run({ type: "max_duration", value: 1_999 }, makeTrajectory({})).pass).toBe(false);
  });
});

describe("dispatch", () => {
  it("routes deterministic checks and preserves order in runChecks", async () => {
    const t = makeTrajectory({ toolCalls: [call("mem_write", 0)] });
    const results = await runChecks(
      [
        { type: "tool_called", tool: "mem_write" },
        { type: "max_turns", value: 1 },
      ],
      t,
    );
    expect(results.map((r) => r.pass)).toEqual([true, false]);
    expect(results[0].check.type).toBe("tool_called");
  });

  it("fails judge checks with a configuration detail when no judge is wired", async () => {
    const r = await runCheck({ type: "judge_output", rubric: "is it good?" }, makeTrajectory({}));
    expect(r.pass).toBe(false);
    expect(r.detail).toContain("judge model");
  });

  it("delegates judge checks to the context judge", async () => {
    const r = await runCheck(
      { type: "judge_output", rubric: "is it good?" },
      makeTrajectory({}),
      {
        judge: async (check) => ({ check, pass: true, score: 5, detail: "judged" }),
      },
    );
    expect(r.pass).toBe(true);
    expect(r.score).toBe(5);
  });
});
