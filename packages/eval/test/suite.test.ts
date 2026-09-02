import { mkdtempSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fauxAssistantMessage, registerFauxProvider } from "@valet/engine/test-helpers";
import { filterCases, parseCliArgs, runSuite } from "../src/index.js";
import type { EvalCase } from "../src/index.js";

function makeCase(overrides: Partial<EvalCase>): EvalCase {
  return {
    id: "case-x",
    turns: [{ role: "user", content: "say something" }],
    checks: [{ type: "no_errors" }],
    ...overrides,
  };
}

describe("parseCliArgs", () => {
  it("applies defaults", () => {
    const opts = parseCliArgs([]);
    expect(opts.model).toBe("anthropic/claude-haiku-4-5");
    expect(opts.saveBaseline).toBe(false);
    expect(opts.json).toBe(false);
    expect(opts.verbose).toBe(false);
    expect(opts.casesDir.endsWith(join("evals", "cases"))).toBe(true);
    expect(opts.baselinesDir.endsWith(join("evals", "baselines"))).toBe(true);
  });

  it("parses every flag", () => {
    const opts = parseCliArgs([
      "--filter",
      "memory",
      "--model",
      "anthropic/claude-sonnet-5",
      "--save-baseline",
      "--json",
      "--verbose",
      "--timeout",
      "5000",
      "--cases",
      "/tmp/cases",
      "--baselines",
      "/tmp/baselines",
    ]);
    expect(opts).toMatchObject({
      filter: "memory",
      model: "anthropic/claude-sonnet-5",
      saveBaseline: true,
      json: true,
      verbose: true,
      timeoutMs: 5000,
      casesDir: "/tmp/cases",
      baselinesDir: "/tmp/baselines",
    });
  });

  it("rejects a non-numeric timeout", () => {
    expect(() => parseCliArgs(["--timeout", "soon"])).toThrow(/--timeout/);
  });
});

describe("filterCases", () => {
  const cases = [makeCase({ id: "memory-write-read" }), makeCase({ id: "tool-ordering" })];

  it("matches by substring and by regex", () => {
    expect(filterCases(cases, "memory").map((c) => c.id)).toEqual(["memory-write-read"]);
    expect(filterCases(cases, "^tool-").map((c) => c.id)).toEqual(["tool-ordering"]);
    expect(filterCases(cases, undefined)).toHaveLength(2);
    expect(filterCases(cases, "nope")).toHaveLength(0);
  });
});

describe("runSuite", () => {
  it("runs cases, scores checks, and reports pass/fail entries", async () => {
    const faux = registerFauxProvider({ provider: "suite-1" });
    faux.setResponses([fauxAssistantMessage("alpha output"), fauxAssistantMessage("beta output")]);
    const dir = mkdtempSync(join(tmpdir(), "valet-eval-suite-"));

    const result = await runSuite(
      [
        makeCase({ id: "passes", checks: [{ type: "output_contains", value: "alpha" }] }),
        makeCase({ id: "fails", checks: [{ type: "output_contains", value: "missing-string" }] }),
      ],
      { model: faux.getModel(), baselinesDir: dir },
    );

    expect(result.entries.map((e) => [e.caseId, e.status])).toEqual([
      ["passes", "pass"],
      ["fails", "fail"],
    ]);
    expect(result.entries[1].checkResults[0].detail).toContain("missing-string");
    faux.unregister();
  });

  it("skips unsupported profiles with a reason", async () => {
    const dir = mkdtempSync(join(tmpdir(), "valet-eval-suite-"));
    const result = await runSuite(
      [makeCase({ id: "mocked", profile: "mock" }), makeCase({ id: "integration", profile: "integration" })],
      { model: "anthropic/claude-haiku-4-5", baselinesDir: dir },
    );
    expect(result.entries.every((e) => e.status === "skip")).toBe(true);
    expect(result.entries[0].skipReason).toContain("TKAI-335");
  });

  it("saves baselines and compares the next run against them", async () => {
    const faux = registerFauxProvider({ provider: "suite-2" });
    faux.setResponses([fauxAssistantMessage("good output"), fauxAssistantMessage("bad output")]);
    const dir = mkdtempSync(join(tmpdir(), "valet-eval-suite-"));
    const cases = [makeCase({ id: "case-b", checks: [{ type: "output_contains", value: "good" }] })];

    const first = await runSuite(cases, {
      model: faux.getModel(),
      baselinesDir: dir,
      saveBaselines: true,
      now: () => new Date("2026-09-01T00:00:00.000Z"),
    });
    expect(first.entries[0].status).toBe("pass");
    expect(first.savedBaselinePaths).toHaveLength(1);
    expect(await readdir(join(dir, "case-b"))).toHaveLength(1);
    // No baseline existed before this run, so nothing to compare.
    expect(first.comparisons).toHaveLength(0);

    const second = await runSuite(cases, { model: faux.getModel(), baselinesDir: dir });
    expect(second.entries[0].status).toBe("fail");
    expect(second.comparisons).toHaveLength(1);
    expect(second.comparisons[0].verdict).toBe("regression");
    faux.unregister();
  });

  it("turns a thrown case error into a fail entry instead of aborting the suite", async () => {
    const faux = registerFauxProvider({ provider: "suite-3" });
    faux.setResponses([fauxAssistantMessage("ok")]);
    const dir = mkdtempSync(join(tmpdir(), "valet-eval-suite-"));

    const result = await runSuite(
      [
        makeCase({ id: "broken", tools: ["not_a_tool"] }),
        makeCase({ id: "healthy", checks: [{ type: "output_contains", value: "ok" }] }),
      ],
      { model: faux.getModel(), baselinesDir: dir },
    );

    expect(result.entries[0].status).toBe("fail");
    expect(result.entries[0].error).toContain("unknown tools");
    expect(result.entries[1].status).toBe("pass");
    faux.unregister();
  });
});
