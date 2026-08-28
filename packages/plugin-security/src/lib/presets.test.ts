import { describe, expect, it } from "vitest";
import { cellDir } from "./plan.js";
import { parsePlan } from "./plan.js";
import {
  CODE_REVIEW_PERSONA,
  codeReviewPresetPlan,
  KNOWN_PERSONAS,
  securityKickoffPrompt,
} from "./presets.js";

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

  it("mentions the pre-baked scanner in the triage cell's goal", () => {
    const plan = parsePlan(codeReviewPresetPlan(), KNOWN_PERSONAS);
    // gitleaks-only in the stock image (M9); semgrep needs a Python
    // toolchain the base image does not carry.
    expect(plan.cells[3].goal).toMatch(/gitleaks/);
  });

  it("assigns a methodology playbook to every preset cell", () => {
    const plan = parsePlan(codeReviewPresetPlan(), KNOWN_PERSONAS);
    expect(plan.cells.map((c) => c.playbook)).toEqual([
      "recon",
      "authz",
      "injection",
      "secrets-config",
      "verify",
    ]);
  });

  it("names every cell so the dirs stay short and stable", () => {
    const plan = parsePlan(codeReviewPresetPlan(), KNOWN_PERSONAS);
    expect(plan.cells.map((c) => c.name)).toEqual([
      "recon",
      "authz-sweep",
      "injection-sweep",
      "secrets-config",
      "verify",
    ]);
  });

  it("produces short stable cell dirs from the names", () => {
    const plan = parsePlan(codeReviewPresetPlan(), KNOWN_PERSONAS);
    const dirs = plan.cells.map((c) => cellDir(c));
    expect(dirs).toEqual([
      "01-recon",
      "02-authz-sweep",
      "03-injection-sweep",
      "04-secrets-config",
      "05-verify",
    ]);
    // Dirs are unique and filesystem-safe.
    expect(new Set(dirs).size).toBe(dirs.length);
    for (const dir of dirs) expect(dir).toMatch(/^\d{2}-[a-z0-9-]+$/);
  });
});

describe("securityKickoffPrompt", () => {
  it("names the repo and points the runner at sec_status then sec_start", () => {
    const p = securityKickoffPrompt("acme/api");
    expect(p).toContain("acme/api");
    expect(p).toContain("sec_status");
    expect(p).toContain("sec_start");
    expect(p).not.toContain("Focus notes");
  });

  it("folds the user's focus notes in when present", () => {
    const p = securityKickoffPrompt("acme/api", "skip the secrets sweep");
    expect(p).toContain("Focus notes");
    expect(p).toContain("skip the secrets sweep");
  });

  it("omits the focus block for blank notes", () => {
    expect(securityKickoffPrompt("acme/api", "   ")).not.toContain("Focus notes");
  });
});
