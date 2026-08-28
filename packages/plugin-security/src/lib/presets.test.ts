import { describe, expect, it } from "vitest";
import { cellDir, MAX_PLAN_CELLS } from "./plan.js";
import { parsePlan } from "./plan.js";
import { expandTriads } from "./triad.js";
import {
  CODE_REVIEW_PERSONA,
  codeReviewPresetPlan,
  isKnownPreset,
  KNOWN_PERSONAS,
  presetPlan,
  SECURITY_PRESETS,
  securityKickoffPrompt,
  securitySessionTitle,
  serializePlan,
} from "./presets.js";

describe("codeReviewPresetPlan", () => {
  it("round-trips through parsePlan without error", () => {
    const plan = parsePlan(codeReviewPresetPlan(), KNOWN_PERSONAS);
    expect(plan.cells).toHaveLength(6);
    // The five review cells are the code-review persona; the sixth is the report.
    expect(plan.cells.slice(0, 5).every((c) => c.persona === CODE_REVIEW_PERSONA)).toBe(true);
    expect(plan.cells[5].persona).toBe("report");
    expect(plan.cells.map((c) => c.ordinal)).toEqual([1, 2, 3, 4, 5, 6]);
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
    expect(plan.cells.map((c) => c.review === true)).toEqual([false, false, false, false, true, false]);
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
      "report",
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
      "report",
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
      "06-report",
    ]);
    // Dirs are unique and filesystem-safe.
    expect(new Set(dirs).size).toBe(dirs.length);
    for (const dir of dirs) expect(dir).toMatch(/^\d{2}-[a-z0-9-]+$/);
  });
});

describe("SECURITY_PRESETS + isKnownPreset", () => {
  it("lists the presets and gates ids", () => {
    expect(SECURITY_PRESETS.map((p) => p.id)).toEqual([
      "code-review",
      "secrets-config",
      "access-injection",
      "full-pentest",
    ]);
    for (const p of SECURITY_PRESETS) expect(isKnownPreset(p.id)).toBe(true);
    expect(isKnownPreset("nope")).toBe(false);
    expect(isKnownPreset("")).toBe(false);
  });
});

describe("presetPlan", () => {
  // Expected cell shapes. `code-review` ends in a report cell; the narrow
  // presets do not (they stay fast).
  const shapes: Record<string, { names: string[]; report?: boolean }> = {
    "code-review": {
      names: ["recon", "authz-sweep", "injection-sweep", "secrets-config", "verify", "report"],
      report: true,
    },
    "secrets-config": { names: ["recon", "secrets-config", "verify"] },
    "access-injection": { names: ["recon", "authz-sweep", "injection-sweep", "verify"] },
  };

  for (const [id, shape] of Object.entries(shapes)) {
    it(`${id} round-trips through parsePlan with dense ordinals and the right cells`, () => {
      const plan = parsePlan(presetPlan(id), KNOWN_PERSONAS);
      const count = shape.names.length;
      expect(plan.cells).toHaveLength(count);
      expect(plan.cells.map((c) => c.ordinal)).toEqual(
        Array.from({ length: count }, (_, i) => i + 1),
      );
      expect(plan.cells.map((c) => c.name)).toEqual(shape.names);
      // recon reads nothing.
      expect(plan.cells[0].reads).toEqual([]);
      // The verify cell has review:true and reads every prior sweep.
      const verifyIdx = shape.names.indexOf("verify");
      const verify = plan.cells[verifyIdx];
      expect(verify.review).toBe(true);
      expect(verify.reads).toEqual(Array.from({ length: verifyIdx }, (_, i) => i + 1));
      // Every middle sweep (between recon and verify) reads recon [1].
      for (let i = 1; i < verifyIdx; i++) {
        expect(plan.cells[i].reads).toEqual([1]);
      }
      if (shape.report) {
        // The report cell is last, the report persona, no review, reads all prior.
        const report = plan.cells[count - 1];
        expect(report.name).toBe("report");
        expect(report.persona).toBe("report");
        expect(report.review).not.toBe(true);
        expect(report.reads).toEqual(Array.from({ length: count - 1 }, (_, i) => i + 1));
        expect(plan.cells.slice(0, -1).every((c) => c.persona === CODE_REVIEW_PERSONA)).toBe(true);
      } else {
        expect(plan.cells.every((c) => c.persona === CODE_REVIEW_PERSONA)).toBe(true);
      }
    });
  }

  it("keeps preset playbooks aligned to their sweeps", () => {
    expect(parsePlan(presetPlan("secrets-config"), KNOWN_PERSONAS).cells.map((c) => c.playbook)).toEqual([
      "recon",
      "secrets-config",
      "verify",
    ]);
    expect(parsePlan(presetPlan("access-injection"), KNOWN_PERSONAS).cells.map((c) => c.playbook)).toEqual([
      "recon",
      "authz",
      "injection",
      "verify",
    ]);
  });

  it("code-review with no paths is byte-identical to codeReviewPresetPlan", () => {
    expect(presetPlan("code-review")).toBe(codeReviewPresetPlan());
  });

  it("injects paths onto the sweep cells only, not recon/verify/report", () => {
    const paths = ["packages/api"];
    for (const id of ["code-review", "secrets-config", "access-injection"]) {
      const plan = parsePlan(presetPlan(id, { paths }), KNOWN_PERSONAS);
      for (const cell of plan.cells) {
        // recon, verify, and the report cell stay repo-wide; the sweeps carry
        // the include globs.
        const bookend =
          cell.name === "recon" || cell.name === "verify" || cell.name === "report";
        if (bookend) expect(cell.paths).toBeUndefined();
        else expect(cell.paths).toEqual(paths);
      }
    }
  });

  it("ignores an empty paths list (repo-wide, delegates to codeReviewPresetPlan)", () => {
    expect(presetPlan("code-review", { paths: [] })).toBe(codeReviewPresetPlan());
  });

  it("throws on an unknown preset id", () => {
    expect(() => presetPlan("nope")).toThrow(/Unknown security preset/);
  });
});

describe("serializePlan", () => {
  it("round-trips parsed plans stably (serialize ∘ parse is idempotent)", () => {
    for (const id of ["code-review", "secrets-config", "access-injection"]) {
      const once = presetPlan(id, { paths: ["src/auth"] });
      const parsed = parsePlan(once, KNOWN_PERSONAS);
      const twice = serializePlan(parsed.cells);
      // The re-serialized plan parses to the same cells and is byte-stable.
      expect(parsePlan(twice, KNOWN_PERSONAS)).toEqual(parsed);
      expect(serializePlan(parsePlan(twice, KNOWN_PERSONAS).cells)).toBe(twice);
    }
  });

  it("round-trips a multi-line goal (a folded `>` config step) without breaking the scalar", () => {
    // A `.valet/security.yml` step commonly uses a folded (`>`) goal, so the
    // parsed goal holds real newlines (and can hold tabs). serializePlan must
    // escape them, or the re-parse throws "missing closing quote".
    const cells = [
      {
        ordinal: 1,
        persona: "code-review",
        mode: "fresh" as const,
        name: "recon",
        goal: "Map the surface.\nThen the trust boundaries.\n\tNote each sink.",
        reads: [],
      },
    ];
    const yaml = serializePlan(cells);
    const reparsed = parsePlan(yaml, KNOWN_PERSONAS);
    expect(reparsed.cells[0].goal).toBe("Map the surface.\nThen the trust boundaries.\n\tNote each sink.");
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
    const p = securityKickoffPrompt("acme/api", { focusNotes: "skip the secrets sweep" });
    expect(p).toContain("Focus notes");
    expect(p).toContain("skip the secrets sweep");
  });

  it("omits the focus block for blank notes", () => {
    expect(securityKickoffPrompt("acme/api", { focusNotes: "   " })).not.toContain("Focus notes");
  });

  it("tells the runner NOT to call sec_start on the already-started path", () => {
    const p = securityKickoffPrompt("acme/api", { alreadyStarted: true });
    expect(p).toContain("acme/api");
    expect(p).toContain("sec_status");
    expect(p).toContain("sec_dispatch");
    // The copy names sec_start only to forbid it; it never instructs a call.
    expect(p).toContain("do NOT call sec_start");
    expect(p).not.toContain("call sec_start to request approval");
  });

  it("folds focus notes in on the already-started path", () => {
    const p = securityKickoffPrompt("acme/api", {
      focusNotes: "watch the auth routes",
      alreadyStarted: true,
    });
    expect(p).toContain("Focus notes");
    expect(p).toContain("watch the auth routes");
    expect(p).not.toContain("call sec_start to request approval");
  });
});

describe("securitySessionTitle", () => {
  it("names the repo without a ref for the default branch", () => {
    expect(securitySessionTitle("acme/api")).toBe("Security review · acme/api");
    expect(securitySessionTitle("acme/api", null)).toBe("Security review · acme/api");
    expect(securitySessionTitle("acme/api", "  ")).toBe("Security review · acme/api");
  });

  it("appends a non-default ref", () => {
    expect(securitySessionTitle("acme/api", "release")).toBe("Security review · acme/api@release");
  });

  it("shortens a 40-hex SHA to 7 chars", () => {
    const sha = "abcdef0123456789abcdef0123456789abcdef01";
    expect(securitySessionTitle("acme/api", sha)).toBe("Security review · acme/api@abcdef0");
  });

  it("drops the ref suffix when it would overrun the length cap", () => {
    const longRef = "feature/a-very-long-branch-name-that-blows-the-cap";
    expect(securitySessionTitle("acme/api", longRef)).toBe("Security review · acme/api");
  });
});

describe("full-pentest preset (M-P2c)", () => {
  it("round-trips through parsePlan with the model personas in order", () => {
    const plan = parsePlan(presetPlan("full-pentest"), KNOWN_PERSONAS);
    // Recon, threat-model, four sweeps, attack-tree, verify, report — 9
    // pre-expansion. The report cell (M-P3) is the final cell after verify.
    expect(plan.cells.map((c) => c.name)).toEqual([
      "recon",
      "threat-model",
      "code-review",
      "sast",
      "authz-sweep",
      "injection-sweep",
      "attack-tree",
      "verify",
      "report",
    ]);
    expect(plan.cells.map((c) => c.persona)).toEqual([
      "code-review",
      "threat-model",
      "code-review",
      "sast",
      "code-review",
      "code-review",
      "attack-tree",
      "code-review",
      "report",
    ]);
    // Each cell names its own playbook.
    expect(plan.cells.map((c) => c.playbook)).toEqual([
      "recon",
      "threat-model",
      "authz",
      "sast",
      "authz",
      "injection",
      "attack-tree",
      "verify",
      "report",
    ]);
    // The report cell is last, reads every prior ordinal, and is NOT a review
    // cell — it composes over the whole engagement, it does not flip statuses.
    const report = plan.cells[plan.cells.length - 1];
    expect(report.name).toBe("report");
    // A non-review cell — the report composes, it does not flip statuses. The
    // parser leaves `review` unset (never `true`) for a cell that omits it.
    expect(report.review).not.toBe(true);
    expect(report.triad).toBeUndefined();
    expect(report.reads).toEqual(Array.from({ length: plan.cells.length - 1 }, (_, i) => i + 1));
  });

  it("marks the code-heavy sweeps as triads and the model cells as single", () => {
    const plan = parsePlan(presetPlan("full-pentest"), KNOWN_PERSONAS);
    const byName = new Map(plan.cells.map((c) => [c.name, c]));
    // Model-only cells run single (no triad); code sweeps expand.
    expect(byName.get("threat-model")?.triad).toBeUndefined();
    expect(byName.get("attack-tree")?.triad).toBeUndefined();
    expect(byName.get("recon")?.triad).toBeUndefined();
    expect(byName.get("verify")?.triad).toBeUndefined();
    expect(byName.get("report")?.triad).toBeUndefined();
    for (const name of ["code-review", "sast", "authz-sweep", "injection-sweep"]) {
      expect(byName.get(name)?.triad).toBe(true);
    }
  });

  it("expands the four triads within MAX_PLAN_CELLS with the right persona ordering", () => {
    const plan = parsePlan(presetPlan("full-pentest"), KNOWN_PERSONAS);
    const expanded = expandTriads(plan.cells);
    // 1 recon + 1 threat-model + 4*3 triad cells + 1 attack-tree + 1 verify +
    // 1 report (M-P3, the final cell).
    expect(expanded).toHaveLength(17);
    expect(expanded.length).toBeLessThanOrEqual(MAX_PLAN_CELLS);
    // Dense ordinals, no triad flags survive, earlier-only reads (re-parses).
    expect(expanded.map((c) => c.ordinal)).toEqual(
      Array.from({ length: 17 }, (_, i) => i + 1),
    );
    expect(expanded.every((c) => c.triad === undefined)).toBe(true);
    // The expanded plan is itself a valid plan.
    const reparsed = parsePlan(serializePlan(expanded), KNOWN_PERSONAS);
    expect(reparsed.cells).toHaveLength(17);
    // Persona ordering after expansion: recon, threat-model, then each triad as
    // architect → worker → verifier, then attack-tree, then verify, then report.
    expect(expanded.map((c) => c.persona)).toEqual([
      "code-review", // recon
      "threat-model", // model cell
      "architect", // code-review triad
      "code-review",
      "verifier",
      "architect", // sast triad
      "sast",
      "verifier",
      "architect", // authz triad
      "code-review",
      "verifier",
      "architect", // injection triad
      "code-review",
      "verifier",
      "attack-tree", // model cell
      "code-review", // verify
      "report", // the report cell
    ]);
  });
});
