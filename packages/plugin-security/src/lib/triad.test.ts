import { describe, expect, it } from "vitest";
import { cellDir, parsePlan, type PlanCell } from "./plan.js";
import { expandTriads, hasTriad } from "./triad.js";
import { presetPlan, serializePlan } from "./presets.js";
import { KNOWN_PERSONAS } from "./presets.js";

/** A phase cell with `triad: true`, plus a recon predecessor and a verify. */
function planWithTriad(): PlanCell[] {
  return parsePlan(
    serializePlan([
      { ordinal: 1, persona: "code-review", mode: "fresh", name: "recon", goal: "Map", reads: [] },
      {
        ordinal: 2,
        persona: "code-review",
        mode: "fresh",
        name: "authz-sweep",
        playbook: "authz",
        goal: "Sweep authz",
        reads: [1],
        triad: true,
      },
      {
        ordinal: 3,
        persona: "code-review",
        mode: "fresh",
        name: "verify",
        goal: "Attack findings",
        reads: [1, 2],
        review: true,
      },
    ]),
    KNOWN_PERSONAS,
  ).cells;
}

describe("expandTriads", () => {
  it("expands one triad phase into architect → worker → verifier", () => {
    const expanded = expandTriads(planWithTriad());
    // 1 recon + 3 (triad) + 1 verify = 5 cells.
    expect(expanded).toHaveLength(5);
    expect(expanded.map((c) => c.persona)).toEqual([
      "code-review", // recon (single)
      "architect", // authz-plan
      "code-review", // authz-sweep (worker)
      "verifier", // authz-verify
      "code-review", // verify (single)
    ]);
  });

  it("names the triad cells <base>-plan / <base> / <base>-verify", () => {
    const expanded = expandTriads(planWithTriad());
    expect(expanded.map((c) => c.name)).toEqual([
      "recon",
      "authz-sweep-plan",
      "authz-sweep",
      "authz-sweep-verify",
      "verify",
    ]);
  });

  it("renumbers ordinals densely 1..N with no triad flag left", () => {
    const expanded = expandTriads(planWithTriad());
    expect(expanded.map((c) => c.ordinal)).toEqual([1, 2, 3, 4, 5]);
    expect(expanded.every((c) => c.triad === undefined)).toBe(true);
  });

  it("wires the reads edges: worker reads architect, verifier reads worker", () => {
    const expanded = expandTriads(planWithTriad());
    const [recon, architect, worker, verifier, verify] = expanded;
    expect(recon.reads).toEqual([]);
    // Architect keeps the phase's original predecessor (recon, remapped to 1).
    expect(architect.reads).toEqual([1]);
    // Worker reads recon (1) plus the architect (2).
    expect(worker.reads).toEqual([1, 2]);
    // Verifier reads only the worker (3).
    expect(verifier.reads).toEqual([3]);
    // The final verify read [1, 2] (recon + the phase). Ordinal 2 was the
    // phase, which now maps to the WORKER (ordinal 3), so verify reads [1, 3].
    expect(verify.reads).toEqual([1, 3]);
  });

  it("marks review on the verifier, not the architect or worker", () => {
    const expanded = expandTriads(planWithTriad());
    // recon (no), authz-plan (no), authz-sweep worker (no), authz-verify (yes),
    // final engagement verify (yes — it was already a review cell).
    expect(expanded.map((c) => c.review === true)).toEqual([false, false, false, true, true]);
  });

  it("carries the phase playbook, mode, and paths to the worker", () => {
    const cells = planWithTriad();
    cells[1].paths = ["packages/api"];
    const expanded = expandTriads(cells);
    const worker = expanded[2];
    expect(worker.playbook).toBe("authz");
    expect(worker.mode).toBe("fresh");
    expect(worker.paths).toEqual(["packages/api"]);
    // The architect inherits the playbook + paths context too.
    expect(expanded[1].playbook).toBe("authz");
    expect(expanded[1].paths).toEqual(["packages/api"]);
  });

  it("gives the architect and verifier goals derived from the phase goal", () => {
    const expanded = expandTriads(planWithTriad());
    expect(expanded[1].goal).toContain("Sweep authz");
    expect(expanded[1].goal).toMatch(/^Plan this phase:/);
    expect(expanded[2].goal).toBe("Sweep authz");
    expect(expanded[3].goal).toMatch(/^Verify this phase:/);
  });

  it("is identity on a plan with no triad cells", () => {
    const plain: PlanCell[] = [
      { ordinal: 1, persona: "code-review", mode: "fresh", name: "recon", goal: "Map", reads: [] },
      {
        ordinal: 2,
        persona: "code-review",
        mode: "fresh",
        name: "verify",
        goal: "Attack",
        reads: [1],
        review: true,
      },
    ];
    expect(expandTriads(plain)).toEqual(plain);
  });

  it("produces a plan that re-parses (dense ordinals, earlier-only reads)", () => {
    const expanded = expandTriads(planWithTriad());
    const reparsed = parsePlan(serializePlan(expanded), KNOWN_PERSONAS);
    expect(reparsed.cells).toEqual(expanded);
    // Every reads edge is below its cell's ordinal.
    for (const cell of reparsed.cells) {
      for (const r of cell.reads) expect(r).toBeLessThan(cell.ordinal);
    }
  });

  it("produces filesystem-safe, unique cell dirs", () => {
    const expanded = expandTriads(planWithTriad());
    const dirs = expanded.map((c) => cellDir(c));
    expect(dirs).toEqual([
      "01-recon",
      "02-authz-sweep-plan",
      "03-authz-sweep",
      "04-authz-sweep-verify",
      "05-verify",
    ]);
    expect(new Set(dirs).size).toBe(dirs.length);
  });

  it("expands two triad phases back to back with correct edges", () => {
    const cells = parsePlan(
      serializePlan([
        { ordinal: 1, persona: "code-review", mode: "fresh", name: "recon", goal: "Map", reads: [] },
        { ordinal: 2, persona: "code-review", mode: "fresh", name: "authz", playbook: "authz", goal: "A", reads: [1], triad: true },
        { ordinal: 3, persona: "code-review", mode: "fresh", name: "inj", playbook: "injection", goal: "I", reads: [1], triad: true },
        { ordinal: 4, persona: "code-review", mode: "fresh", name: "verify", goal: "V", reads: [1, 2, 3], review: true },
      ]),
      KNOWN_PERSONAS,
    ).cells;
    const expanded = expandTriads(cells);
    // 1 + 3 + 3 + 1 = 8.
    expect(expanded).toHaveLength(8);
    expect(expanded.map((c) => c.name)).toEqual([
      "recon",
      "authz-plan",
      "authz",
      "authz-verify",
      "inj-plan",
      "inj",
      "inj-verify",
      "verify",
    ]);
    // Final verify read [1, 2, 3] → recon (1), authz worker (3), inj worker (6).
    expect(expanded[7].reads).toEqual([1, 3, 6]);
    // inj-plan (ordinal 5) reads recon (1) only — the phase's original reads.
    expect(expanded[4].reads).toEqual([1]);
    // inj worker (6) reads recon (1) + its architect (5).
    expect(expanded[5].reads).toEqual([1, 5]);
    // inj-verify (7) reads its worker (6).
    expect(expanded[6].reads).toEqual([6]);
  });
});

describe("hasTriad", () => {
  it("is true when any cell declares a triad, false otherwise", () => {
    expect(hasTriad(planWithTriad())).toBe(true);
    expect(
      hasTriad([
        { ordinal: 1, persona: "code-review", mode: "fresh", goal: "x", reads: [] },
      ]),
    ).toBe(false);
  });
});

describe("preset triad expansion", () => {
  // The code-review preset's three sweeps (authz, injection, secrets-config)
  // are triads; recon and verify stay single. So the 5-cell plan materializes
  // to 1 + 3*3 + 1 = 11 cells.
  it("expands the code-review preset's sweeps to eleven cells", () => {
    const plan = parsePlan(presetPlan("code-review"), KNOWN_PERSONAS);
    expect(hasTriad(plan.cells)).toBe(true);
    const expanded = expandTriads(plan.cells);
    expect(expanded).toHaveLength(11);
    expect(expanded.filter((c) => c.persona === "architect")).toHaveLength(3);
    expect(expanded.filter((c) => c.persona === "verifier")).toHaveLength(3);
    // review is set on the three verifier cells + the final engagement verify.
    expect(expanded.filter((c) => c.review === true)).toHaveLength(4);
    // Dense ordinals, no triad flags.
    expect(expanded.map((c) => c.ordinal)).toEqual(
      Array.from({ length: 11 }, (_, i) => i + 1),
    );
  });

  it("keeps the count within MAX_PLAN_CELLS for every preset", () => {
    for (const id of ["code-review", "secrets-config", "access-injection"]) {
      const expanded = expandTriads(parsePlan(presetPlan(id), KNOWN_PERSONAS).cells);
      expect(expanded.length).toBeLessThanOrEqual(32);
    }
  });

  it("names the authz-sweep triad with the right personas and edges", () => {
    const expanded = expandTriads(parsePlan(presetPlan("access-injection"), KNOWN_PERSONAS).cells);
    // access-injection: recon, authz(triad), injection(triad), verify.
    // → recon, authz-plan, authz-sweep, authz-verify, injection-plan,
    //   injection-sweep, injection-verify, verify. = 8 cells.
    expect(expanded).toHaveLength(8);
    const authzPlan = expanded[1];
    const authzWorker = expanded[2];
    const authzVerify = expanded[3];
    expect(authzPlan.persona).toBe("architect");
    expect(authzWorker.persona).toBe("code-review");
    expect(authzVerify.persona).toBe("verifier");
    // Worker reads recon + architect; verifier reads worker; review only on verify.
    expect(authzWorker.reads).toEqual([1, 2]);
    expect(authzVerify.reads).toEqual([3]);
    expect(authzPlan.review).toBeUndefined();
    expect(authzWorker.review).toBeUndefined();
    expect(authzVerify.review).toBe(true);
  });
});
