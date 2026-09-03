import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  compareToBaseline,
  formatScorecard,
  loadLatestBaseline,
  saveBaseline,
} from "../src/index.js";
import type { BaselineRecord, ScorecardEntry, Trajectory } from "../src/index.js";

function makeTrajectory(overrides: Partial<Trajectory> = {}): Trajectory {
  return {
    caseId: "case-a",
    prompt: "p",
    model: "anthropic/claude-haiku-4-5",
    turns: [{ index: 0 }],
    toolCalls: [
      { toolName: "mem_write", callId: "c1", status: "completed", index: 0 },
      { toolName: "mem_read", callId: "c2", status: "completed", index: 1 },
    ],
    finalOutput: "done",
    usage: { input: 700, output: 300, cacheRead: 0, cacheWrite: 0, total: 1000 },
    cost: { input: 0.01, output: 0.01, cacheRead: 0, cacheWrite: 0, total: 0.02 },
    durationMs: 3200,
    ...overrides,
  };
}

function makeEntry(overrides: Partial<ScorecardEntry> = {}): ScorecardEntry {
  return {
    caseId: "case-a",
    status: "pass",
    durationMs: 3200,
    costUsd: 0.02,
    totalTokens: 1000,
    checkResults: [
      { check: { type: "no_errors" }, pass: true },
      { check: { type: "output_contains", value: "done" }, pass: true },
    ],
    trajectory: makeTrajectory(),
    ...overrides,
  };
}

describe("formatScorecard", () => {
  it("renders per-case rows, failed-check details, and totals", () => {
    const entries: ScorecardEntry[] = [
      makeEntry(),
      makeEntry({
        caseId: "case-b",
        status: "fail",
        checkResults: [
          { check: { type: "no_errors" }, pass: true },
          { check: { type: "max_turns", value: 1 }, pass: false, detail: "expected at most 1 turn(s), got 3." },
        ],
      }),
      makeEntry({ caseId: "case-c", status: "skip", skipReason: "missing credential: github" }),
    ];

    const out = formatScorecard(entries, { wallMs: 10_000 });

    expect(out).toContain("EVAL SCORECARD");
    expect(out).toMatch(/PASS case-a\s+3\.2s\s+\$0\.0200\s+checks 2\/2/);
    expect(out).toMatch(/FAIL case-b/);
    expect(out).toContain("x max_turns: expected at most 1 turn(s), got 3.");
    expect(out).toContain("SKIP case-c");
    expect(out).toContain("missing credential: github");
    expect(out).toContain("totals: 1 passed, 1 failed, 1 skipped");
    expect(out).toContain("tokens 2,000");
    expect(out).toContain("wall 10.0s");
  });

  it("marks the whole run unpriced when no case has cost", () => {
    const out = formatScorecard([makeEntry({ costUsd: undefined })]);
    expect(out).toContain("cost unpriced");
  });

  it("renders the baseline comparison section", () => {
    const baseline: BaselineRecord = {
      caseId: "case-a",
      model: "anthropic/claude-haiku-4-5",
      savedAt: "2026-09-01T00:00:00.000Z",
      status: "pass",
      trajectory: makeTrajectory(),
    };
    const failing = makeEntry({
      status: "fail",
      totalTokens: 1500,
      trajectory: makeTrajectory({
        usage: { input: 1000, output: 500, cacheRead: 0, cacheWrite: 0, total: 1500 },
        toolCalls: [{ toolName: "bash", callId: "c9", status: "completed", index: 0 }],
      }),
    });
    const out = formatScorecard([failing], {
      comparisons: [compareToBaseline(failing, baseline)],
    });

    expect(out).toContain("BASELINE COMPARISON");
    expect(out).toContain("REGRESSION pass -> fail");
    expect(out).toContain("tokens +50.0%");
    expect(out).toContain("tools changed");
    expect(out).toContain("1 regression(s), 0 improvement(s)");
  });
});

describe("baseline save/load", () => {
  it("round-trips a trajectory through JSON and loads the latest for the model", async () => {
    const dir = mkdtempSync(join(tmpdir(), "valet-eval-baselines-"));
    const older: BaselineRecord = {
      caseId: "case-a",
      model: "anthropic/claude-haiku-4-5",
      savedAt: "2026-08-01T00:00:00.000Z",
      status: "fail",
      trajectory: makeTrajectory(),
    };
    const newer: BaselineRecord = { ...older, savedAt: "2026-09-01T00:00:00.000Z", status: "pass" };

    const p1 = await saveBaseline(dir, older);
    const p2 = await saveBaseline(dir, newer);
    expect(p1).toContain(join("case-a", "anthropic-claude-haiku-4-5_2026-08-01.json"));
    expect(p2).toContain("2026-09-01.json");

    const loaded = await loadLatestBaseline(dir, "case-a", "anthropic/claude-haiku-4-5");
    expect(loaded).not.toBeNull();
    expect(loaded?.savedAt).toBe(newer.savedAt);
    expect(loaded?.status).toBe("pass");
    expect(loaded?.trajectory).toEqual(makeTrajectory());
  });

  it("falls back to another model's baseline and the comparison notes it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "valet-eval-baselines-"));
    await saveBaseline(dir, {
      caseId: "case-a",
      model: "anthropic/claude-old",
      savedAt: "2026-09-01T00:00:00.000Z",
      status: "pass",
      trajectory: makeTrajectory({ model: "anthropic/claude-old" }),
    });

    const loaded = await loadLatestBaseline(dir, "case-a", "anthropic/claude-new");
    expect(loaded?.model).toBe("anthropic/claude-old");
    if (!loaded) throw new Error("unreachable");

    const entry = makeEntry({ trajectory: makeTrajectory({ model: "anthropic/claude-new" }) });
    const c = compareToBaseline(entry, loaded);
    expect(c.baselineModel).toBe("anthropic/claude-old");
  });

  it("returns null when the case has no baselines", async () => {
    const dir = mkdtempSync(join(tmpdir(), "valet-eval-baselines-"));
    expect(await loadLatestBaseline(dir, "case-a", "m")).toBeNull();
  });
});

describe("compareToBaseline", () => {
  const baseline: BaselineRecord = {
    caseId: "case-a",
    model: "anthropic/claude-haiku-4-5",
    savedAt: "2026-09-01T00:00:00.000Z",
    status: "fail",
    trajectory: makeTrajectory(),
  };

  it("flags an improvement fail -> pass", () => {
    const c = compareToBaseline(makeEntry(), baseline);
    expect(c.verdict).toBe("improvement");
    expect(c.toolSequenceChanged).toBe(false);
  });

  it("reports unchanged and cost delta", () => {
    const c = compareToBaseline(
      makeEntry({
        status: "fail",
        trajectory: makeTrajectory({
          cost: { input: 0.02, output: 0.01, cacheRead: 0, cacheWrite: 0, total: 0.03 },
        }),
      }),
      baseline,
    );
    expect(c.verdict).toBe("unchanged");
    expect(c.costDeltaUsd).toBeCloseTo(0.01, 6);
  });

  it("omits token delta when a side has no usage", () => {
    const c = compareToBaseline(
      makeEntry({
        totalTokens: undefined,
        trajectory: makeTrajectory({ usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }),
      }),
      baseline,
    );
    expect(c.tokenDeltaPct).toBeUndefined();
  });
});
