/**
 * Tests for the applied-state module (packages/engine/src/sandbox/applied-state.ts).
 *
 * Uses VirtualSandbox so no containers are needed.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  APPLIED_PATH,
  readAppliedState,
  diffSteps,
  applyPlan,
} from "../src/sandbox/applied-state.js";
import type { AppliedState } from "../src/sandbox/applied-state.js";
import { VirtualSandbox } from "../src/providers/sandbox/virtual.js";
import type { PrepStep, DesiredSandboxSpec } from "../src/types.js";

// ── Helpers ───────────────────────────────────────────────────────────

function makeStep(
  id: string,
  hash: string,
  critical: boolean,
  applyFn?: (sb: ReturnType<typeof makeSandbox>) => Promise<void>,
): PrepStep {
  return {
    id,
    hash,
    critical,
    apply: applyFn ?? (async () => {}),
  };
}

function makeSandbox(): VirtualSandbox {
  return new VirtualSandbox("test-vsb");
}

function makeSpec(steps: PrepStep[], specHash = "spec-hash-1"): DesiredSandboxSpec {
  return { specHash, steps };
}

// ── Test 1: full apply when applied state is null ─────────────────────

describe("readAppliedState", () => {
  it("returns null when file is missing", async () => {
    const sb = makeSandbox();
    const result = await readAppliedState(sb);
    expect(result).toBeNull();
  });

  it("returns null when file contains corrupt JSON", async () => {
    const sb = makeSandbox();
    await sb.writeFile(APPLIED_PATH, "not valid json {{{{");
    const result = await readAppliedState(sb);
    expect(result).toBeNull();
  });

  it("returns parsed state when file is valid", async () => {
    const sb = makeSandbox();
    const state: AppliedState = {
      image: "img:v1",
      specHash: "abc123",
      steps: { step1: "hash-a", step2: "hash-b" },
    };
    await sb.writeFile(APPLIED_PATH, JSON.stringify(state));
    const result = await readAppliedState(sb);
    expect(result).toEqual(state);
  });
});

// ── Test 2: diffSteps ──────────────────────────────────────────────────

describe("diffSteps", () => {
  it("returns all steps when applied is null", () => {
    const steps = [makeStep("a", "h1", false), makeStep("b", "h2", true)];
    const result = diffSteps(steps, null);
    expect(result).toEqual(steps);
  });

  it("returns only steps whose hash drifted or are missing from applied", () => {
    const steps = [
      makeStep("a", "h1", false), // unchanged
      makeStep("b", "h2-NEW", false), // hash drifted
      makeStep("c", "h3", true), // missing from applied
    ];
    const applied: AppliedState = {
      image: "img:v1",
      specHash: "old-spec",
      steps: { a: "h1", b: "h2" },
    };
    const result = diffSteps(steps, applied);
    const ids = result.map((s) => s.id);
    expect(ids).toContain("b");
    expect(ids).toContain("c");
    expect(ids).not.toContain("a");
  });

  it("returns empty array when all steps match applied", () => {
    const steps = [makeStep("a", "h1", false), makeStep("b", "h2", true)];
    const applied: AppliedState = {
      image: "img:v1",
      specHash: "spec1",
      steps: { a: "h1", b: "h2" },
    };
    const result = diffSteps(steps, applied);
    expect(result).toHaveLength(0);
  });
});

// ── Test 3: applyPlan — full apply on null applied ────────────────────

describe("applyPlan — full apply on null applied", () => {
  it("runs all steps and writes applied file after each one", async () => {
    const sb = makeSandbox();
    const order: string[] = [];
    const steps = [
      makeStep("s1", "h1", false, async () => { order.push("s1"); }),
      makeStep("s2", "h2", false, async () => { order.push("s2"); }),
      makeStep("s3", "h3", false, async () => { order.push("s3"); }),
    ];
    const spec = makeSpec(steps, "spec-abc");

    await applyPlan(sb, spec, "img:v1", null);

    expect(order).toEqual(["s1", "s2", "s3"]);

    // Applied file must reflect all three steps
    const written = await readAppliedState(sb);
    expect(written).not.toBeNull();
    expect(written!.image).toBe("img:v1");
    expect(written!.specHash).toBe("spec-abc");
    expect(written!.steps).toEqual({ s1: "h1", s2: "h2", s3: "h3" });
  });
});

// ── Test 4: subset re-run when one hash drifts ─────────────────────────

describe("applyPlan — subset re-run", () => {
  it("only re-runs the step whose hash changed", async () => {
    const sb = makeSandbox();

    // Seed applied state: s1 correct, s2 has stale hash
    const prior: AppliedState = {
      image: "img:v1",
      specHash: "spec-old",
      steps: { s1: "h1", s2: "h2-STALE" },
    };
    await sb.writeFile(APPLIED_PATH, JSON.stringify(prior));

    const applied: string[] = [];
    const steps = [
      makeStep("s1", "h1", false, async () => { applied.push("s1"); }),
      makeStep("s2", "h2-NEW", false, async () => { applied.push("s2"); }),
    ];
    const spec = makeSpec(steps, "spec-new");

    await applyPlan(sb, spec, "img:v1", prior);

    // Only s2 should have run
    expect(applied).toEqual(["s2"]);

    // The final applied file merges s1's existing hash + s2's new hash
    const written = await readAppliedState(sb);
    expect(written!.steps).toEqual({ s1: "h1", s2: "h2-NEW" });
    expect(written!.specHash).toBe("spec-new");
  });
});

// ── Test 5: per-step persistence (kill after step 2 of 3) ─────────────

describe("applyPlan — per-step persistence", () => {
  it("writes applied file after each step so partial progress survives a kill", async () => {
    const sb = makeSandbox();
    const snapshots: Record<string, string>[] = [];

    const steps = [
      makeStep("s1", "h1", false, async () => {
        // Snapshot state AFTER step 1 would write
      }),
      makeStep("s2", "h2", false, async () => {
        // Snapshot mid-plan to verify s1 was already persisted
        const state = await readAppliedState(sb);
        if (state) snapshots.push({ ...state.steps });
      }),
      makeStep("s3", "h3", false, async () => {}),
    ];
    const spec = makeSpec(steps, "spec-xyz");

    await applyPlan(sb, spec, "img:v1", null);

    // When s2 ran, s1 must already be in the applied file
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toHaveProperty("s1", "h1");
    // s2 not yet in the snapshot at the time s2 started
    expect(snapshots[0]).not.toHaveProperty("s2");
  });
});

// ── Test 6: critical throw stops plan, applied keeps successes ─────────

describe("applyPlan — critical failure", () => {
  it("throws on critical step failure and applied file retains prior successes", async () => {
    const sb = makeSandbox();
    const ranSteps: string[] = [];

    const steps = [
      makeStep("s1", "h1", false, async () => { ranSteps.push("s1"); }),
      makeStep("s2", "h2", true, async () => {
        ranSteps.push("s2");
        throw new Error("critical boom");
      }),
      makeStep("s3", "h3", false, async () => { ranSteps.push("s3"); }),
    ];
    const spec = makeSpec(steps, "spec-crit");

    await expect(applyPlan(sb, spec, "img:v1", null)).rejects.toThrow("critical boom");

    // s3 must NOT have run
    expect(ranSteps).toEqual(["s1", "s2"]);

    // Applied file keeps s1 (success before critical failure); s2 and s3 absent
    const written = await readAppliedState(sb);
    expect(written!.steps).toHaveProperty("s1", "h1");
    expect(written!.steps).not.toHaveProperty("s2");
    expect(written!.steps).not.toHaveProperty("s3");
  });

  it("logs and continues on non-critical step failure", async () => {
    const sb = makeSandbox();
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const ranSteps: string[] = [];

    const steps = [
      makeStep("s1", "h1", false, async () => { ranSteps.push("s1"); }),
      makeStep("s2", "h2", false, async () => {
        ranSteps.push("s2");
        throw new Error("non-critical oops");
      }),
      makeStep("s3", "h3", false, async () => { ranSteps.push("s3"); }),
    ];
    const spec = makeSpec(steps, "spec-noncrit");

    // Should NOT throw
    await applyPlan(sb, spec, "img:v1", null);

    expect(ranSteps).toEqual(["s1", "s2", "s3"]);
    expect(consoleErrorSpy).toHaveBeenCalledOnce();

    // s1 and s3 in applied; s2 absent (failed)
    const written = await readAppliedState(sb);
    expect(written!.steps).toHaveProperty("s1", "h1");
    expect(written!.steps).not.toHaveProperty("s2");
    expect(written!.steps).toHaveProperty("s3", "h3");

    consoleErrorSpy.mockRestore();
  });
});

// ── Test 7: corrupt file → full re-apply ──────────────────────────────

describe("applyPlan — corrupt applied file", () => {
  it("treats corrupt JSON as null and re-applies all steps", async () => {
    const sb = makeSandbox();
    await sb.writeFile(APPLIED_PATH, "{{corrupt");

    const applied: string[] = [];
    const steps = [
      makeStep("s1", "h1", false, async () => { applied.push("s1"); }),
      makeStep("s2", "h2", false, async () => { applied.push("s2"); }),
    ];
    const spec = makeSpec(steps, "spec-corrupt");

    // Pass null as applied (caller read null from corrupt file)
    await applyPlan(sb, spec, "img:v1", null);

    expect(applied).toEqual(["s1", "s2"]);
  });
});
