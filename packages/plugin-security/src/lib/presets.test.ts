import { describe, expect, it } from "vitest";
import { cellDirSlug } from "./plan.js";
import { parsePlan } from "./plan.js";
import { CODE_REVIEW_PERSONA, codeReviewPresetPlan, KNOWN_PERSONAS } from "./presets.js";

describe("codeReviewPresetPlan", () => {
  it("round-trips through parsePlan without error", () => {
    const plan = parsePlan(codeReviewPresetPlan(), KNOWN_PERSONAS);
    expect(plan.cells).toHaveLength(5);
    expect(plan.cells.every((c) => c.persona === CODE_REVIEW_PERSONA)).toBe(true);
    expect(plan.cells.map((c) => c.ordinal)).toEqual([1, 2, 3, 4, 5]);
  });

  it("wires the reads DAG: recon feeds the sweeps, verify reads everything", () => {
    const plan = parsePlan(codeReviewPresetPlan(), KNOWN_PERSONAS);
    expect(plan.cells[0].reads).toEqual([]);
    expect(plan.cells[1].reads).toEqual([1]);
    expect(plan.cells[2].reads).toEqual([1]);
    expect(plan.cells[3].reads).toEqual([1]);
    expect(plan.cells[4].reads).toEqual([1, 2, 3, 4]);
  });

  it("marks only the verify cell review: true", () => {
    const plan = parsePlan(codeReviewPresetPlan(), KNOWN_PERSONAS);
    expect(plan.cells.map((c) => c.review === true)).toEqual([false, false, false, false, true]);
  });

  it("mentions the pre-baked scanners in the triage cell's goal", () => {
    const plan = parsePlan(codeReviewPresetPlan(), KNOWN_PERSONAS);
    expect(plan.cells[3].goal).toMatch(/gitleaks/);
    expect(plan.cells[3].goal).toMatch(/semgrep/);
  });

  it("produces stable cell dir slugs", () => {
    const plan = parsePlan(codeReviewPresetPlan(), KNOWN_PERSONAS);
    const dirs = plan.cells.map((c) => cellDirSlug(c.ordinal, c.goal));
    expect(dirs).toEqual([
      "01-map-the-codebase-seed-the-checklist-from",
      "02-sweep-authorization-on-every-route-mutat",
      "03-sweep-injection-paths-across-sql-command",
      "04-run-the-pre-baked-scanners-gitleaks-semg",
      "05-attack-every-open-finding-sec-finding-re",
    ]);
    // Dirs are unique and filesystem-safe.
    expect(new Set(dirs).size).toBe(dirs.length);
    for (const dir of dirs) expect(dir).toMatch(/^\d{2}-[a-z0-9-]+$/);
  });
});
