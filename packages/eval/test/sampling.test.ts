/**
 * Sampling-rigor coverage (adversarial-review findings 1, 2, 3): pass@k
 * multi-run cases, variance stats, the comparator noise band, and the
 * temperature seam.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fauxAssistantMessage, registerFauxProvider } from "@valet/engine/test-helpers";
import { compareToBaseline, formatScorecard, parseCliArgs, parseEvalCase, runSuite } from "../src/index.js";
import type { BaselineRecord, EvalCase, ScorecardEntry, Trajectory } from "../src/index.js";

function makeCase(overrides: Partial<EvalCase>): EvalCase {
  return {
    id: "case-x",
    turns: [{ role: "user", content: "answer" }],
    checks: [{ type: "output_contains", value: "good" }],
    ...overrides,
  };
}

function makeTrajectory(overrides: Partial<Trajectory> = {}): Trajectory {
  return {
    caseId: "case-x",
    prompt: "p",
    model: "m",
    turns: [{ index: 0 }],
    toolCalls: [],
    finalOutput: "good",
    usage: { input: 900, output: 100, cacheRead: 0, cacheWrite: 0, total: 1000 },
    durationMs: 10,
    ...overrides,
  };
}

describe("case loader sampling fields", () => {
  it("accepts runs, pass_threshold, temperature", () => {
    const c = parseEvalCase(
      { ...makeCase({}), runs: 5, pass_threshold: 0.6, temperature: 0 },
      "t.yaml",
    );
    expect(c.runs).toBe(5);
    expect(c.pass_threshold).toBe(0.6);
    expect(c.temperature).toBe(0);
  });

  it("rejects invalid runs and thresholds", () => {
    expect(() => parseEvalCase({ ...makeCase({}), runs: 0 }, "t.yaml")).toThrow(/runs/);
    expect(() => parseEvalCase({ ...makeCase({}), runs: 2.5 }, "t.yaml")).toThrow(/runs/);
    expect(() => parseEvalCase({ ...makeCase({}), pass_threshold: 0 }, "t.yaml")).toThrow(/pass_threshold/);
    expect(() => parseEvalCase({ ...makeCase({}), pass_threshold: 1.5 }, "t.yaml")).toThrow(/pass_threshold/);
  });

  it("parses --runs and rejects garbage", () => {
    expect(parseCliArgs(["--runs", "5"]).runsOverride).toBe(5);
    expect(() => parseCliArgs(["--runs", "many"])).toThrow(/--runs/);
  });
});

describe("runSuite pass@k", () => {
  it("runs a case N times, defaults to strict all-runs-pass, and records stats", async () => {
    const faux = registerFauxProvider({ provider: "sampling-1" });
    // 2 good runs, 1 bad run.
    faux.setResponses([
      fauxAssistantMessage("good output"),
      fauxAssistantMessage("bad output"),
      fauxAssistantMessage("good output"),
    ]);
    const dir = mkdtempSync(join(tmpdir(), "valet-eval-sampling-"));

    const result = await runSuite([makeCase({ runs: 3 })], {
      model: faux.getModel(),
      baselinesDir: dir,
    });

    const entry = result.entries[0];
    expect(entry.status).toBe("fail");
    expect(entry.sampling).toMatchObject({ runs: 3, passes: 2, threshold: 1 });
    expect(entry.sampling?.tokensPerRun).toHaveLength(3);
    // The reported run is the first FAILING one, so its checks explain the fail.
    expect(entry.checkResults[0].pass).toBe(false);
    faux.unregister();
  });

  it("pass_threshold below 1 tolerates a failing minority", async () => {
    const faux = registerFauxProvider({ provider: "sampling-2" });
    faux.setResponses([
      fauxAssistantMessage("good output"),
      fauxAssistantMessage("bad output"),
      fauxAssistantMessage("good output"),
    ]);
    const dir = mkdtempSync(join(tmpdir(), "valet-eval-sampling-"));

    const result = await runSuite([makeCase({ runs: 3, pass_threshold: 0.6 })], {
      model: faux.getModel(),
      baselinesDir: dir,
    });
    expect(result.entries[0].status).toBe("pass");
    expect(result.entries[0].sampling?.passes).toBe(2);
    faux.unregister();
  });

  it("runsOverride wins over the case's runs", async () => {
    const faux = registerFauxProvider({ provider: "sampling-3" });
    faux.setResponses([fauxAssistantMessage("good output"), fauxAssistantMessage("good output")]);
    const dir = mkdtempSync(join(tmpdir(), "valet-eval-sampling-"));

    const result = await runSuite([makeCase({ runs: 5 })], {
      model: faux.getModel(),
      baselinesDir: dir,
      runsOverride: 2,
    });
    expect(result.entries[0].sampling?.runs).toBe(2);
    expect(result.entries[0].status).toBe("pass");
    faux.unregister();
  });

  it("saved baselines carry the sampling stats", async () => {
    const faux = registerFauxProvider({ provider: "sampling-4" });
    faux.setResponses([fauxAssistantMessage("good output"), fauxAssistantMessage("good output")]);
    const dir = mkdtempSync(join(tmpdir(), "valet-eval-sampling-"));

    await runSuite([makeCase({ runs: 2 })], {
      model: faux.getModel(),
      baselinesDir: dir,
      saveBaselines: true,
      now: () => new Date("2026-09-02T00:00:00.000Z"),
    });
    const { loadLatestBaseline } = await import("../src/index.js");
    const loaded = await loadLatestBaseline(dir, "case-x", `${faux.getModel().provider}/${faux.getModel().id}`);
    expect(loaded?.sampling?.runs).toBe(2);
    faux.unregister();
  });
});

describe("comparator noise band", () => {
  const baseline: BaselineRecord = {
    caseId: "case-x",
    model: "m",
    savedAt: "2026-09-01T00:00:00.000Z",
    status: "pass",
    trajectory: makeTrajectory(),
    sampling: {
      runs: 5,
      passes: 5,
      threshold: 1,
      tokensPerRun: [900, 1000, 1100, 950, 1050],
      tokensMean: 1000,
      tokensStd: 70,
    },
  };

  function entryWithTokens(mean: number, std: number): ScorecardEntry {
    return {
      caseId: "case-x",
      status: "pass",
      durationMs: 10,
      totalTokens: mean,
      checkResults: [],
      trajectory: makeTrajectory({
        usage: { input: mean - 100, output: 100, cacheRead: 0, cacheWrite: 0, total: mean },
      }),
      sampling: {
        runs: 5,
        passes: 5,
        threshold: 1,
        tokensPerRun: [mean],
        tokensMean: mean,
        tokensStd: std,
      },
    };
  }

  it("labels a small delta within noise and a large delta significant", () => {
    const small = compareToBaseline(entryWithTokens(1100, 60), baseline);
    expect(small.tokenDeltaSignificance).toBe("within_noise");
    const large = compareToBaseline(entryWithTokens(1500, 60), baseline);
    expect(large.tokenDeltaSignificance).toBe("significant");
  });

  it("leaves single-run vs single-run comparisons unlabeled", () => {
    const noStats: BaselineRecord = { ...baseline, sampling: undefined };
    const entry: ScorecardEntry = {
      caseId: "case-x",
      status: "pass",
      durationMs: 10,
      totalTokens: 1500,
      checkResults: [],
      trajectory: makeTrajectory({
        usage: { input: 1400, output: 100, cacheRead: 0, cacheWrite: 0, total: 1500 },
      }),
    };
    expect(compareToBaseline(entry, noStats).tokenDeltaSignificance).toBeUndefined();
  });

  it("reports pass-rate movement and renders it", () => {
    const entry = entryWithTokens(1000, 50);
    entry.sampling = { ...entry.sampling!, passes: 3, runs: 5 };
    entry.status = "fail";
    const c = compareToBaseline(entry, baseline);
    expect(c.baselinePassRate).toBe(1);
    expect(c.currentPassRate).toBeCloseTo(0.6, 6);
    const rendered = formatScorecard([entry], { comparisons: [c] });
    expect(rendered).toContain("pass rate 100% -> 60%");
    expect(rendered).toContain("runs 3/5");
  });
});

describe("temperature seam", () => {
  it("threads the case temperature into the model call", async () => {
    const faux = registerFauxProvider({ provider: "sampling-5" });
    let seenTemperature: number | undefined;
    faux.setResponses([
      (_context, options) => {
        seenTemperature = options?.temperature;
        return fauxAssistantMessage("good output");
      },
    ]);
    const dir = mkdtempSync(join(tmpdir(), "valet-eval-sampling-"));

    await runSuite([makeCase({ temperature: 0 })], { model: faux.getModel(), baselinesDir: dir });
    expect(seenTemperature).toBe(0);
    faux.unregister();
  });
});
