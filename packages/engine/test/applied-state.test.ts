/**
 * Tests for the applied-state module (packages/engine/src/sandbox/applied-state.ts).
 *
 * Uses VirtualSandbox so no containers are needed. File seeding uses exec so
 * the tests exercise the same code path as the real implementation — which is
 * exec-based because provider readFile/writeFile semantics differ for
 * container-fs paths outside /workspace.
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

/**
 * Seed the applied-state file via exec so tests exercise the same path as
 * the real implementation (which uses exec, not writeFile).
 */
async function seedAppliedState(sb: VirtualSandbox, state: AppliedState): Promise<void> {
  const json = JSON.stringify(state).replace(/'/g, "'\\''");
  const result = await sb.exec(`mkdir -p /etc/valet && printf '%s' '${json}' > ${APPLIED_PATH}`);
  if (result.exitCode !== 0) {
    throw new Error(`seedAppliedState exec failed (exit ${result.exitCode}): ${result.stderr}`);
  }
}

/**
 * Seed raw (potentially corrupt) content via exec.
 */
async function seedRawContent(sb: VirtualSandbox, content: string): Promise<void> {
  // Use writeFile directly for raw/corrupt content — this is test infrastructure only.
  // The content may be intentionally corrupt so we bypass the normal write path.
  await sb.writeFile(APPLIED_PATH, content);
}

// ── readAppliedState ──────────────────────────────────────────────────

describe("readAppliedState", () => {
  it("returns null when file is missing", async () => {
    const sb = makeSandbox();
    const result = await readAppliedState(sb);
    expect(result).toBeNull();
  });

  it("returns null when file contains corrupt JSON", async () => {
    const sb = makeSandbox();
    await seedRawContent(sb, "not valid json {{{{");
    const result = await readAppliedState(sb);
    expect(result).toBeNull();
  });

  it("returns null when parsed object fails shape validation", async () => {
    const sb = makeSandbox();
    // Valid JSON but missing required fields
    await seedRawContent(sb, JSON.stringify({ image: "img:v1" }));
    expect(await readAppliedState(sb)).toBeNull();

    // steps contains a non-string value
    const sb2 = makeSandbox();
    await seedRawContent(sb2, JSON.stringify({ image: "img:v1", specHash: "h", steps: { a: 42 } }));
    expect(await readAppliedState(sb2)).toBeNull();
  });

  it("returns parsed state when file is valid", async () => {
    const sb = makeSandbox();
    const state: AppliedState = {
      image: "img:v1",
      specHash: "abc123",
      steps: { step1: "hash-a", step2: "hash-b" },
    };
    await seedAppliedState(sb, state);
    const result = await readAppliedState(sb);
    expect(result).toEqual(state);
  });
});

// ── diffSteps ──────────────────────────────────────────────────────────

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

// ── applyPlan — full apply on null applied ────────────────────────────

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

// ── applyPlan — subset re-run when one hash drifts ─────────────────────

describe("applyPlan — subset re-run", () => {
  it("only re-runs the step whose hash changed", async () => {
    const sb = makeSandbox();

    // Seed applied state: s1 correct, s2 has stale hash
    const prior: AppliedState = {
      image: "img:v1",
      specHash: "spec-old",
      steps: { s1: "h1", s2: "h2-STALE" },
    };
    await seedAppliedState(sb, prior);

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

// ── applyPlan — per-step persistence (kill after step 2 of 3) ──────────

describe("applyPlan — per-step persistence", () => {
  it("writes applied file after each step so partial progress survives a kill", async () => {
    const sb = makeSandbox();
    const snapshots: Record<string, string>[] = [];

    const steps = [
      makeStep("s1", "h1", false, async () => {
        // s1 runs; writeAppliedState is called after this returns
      }),
      makeStep("s2", "h2", false, async () => {
        // When s2 runs, s1 must already be persisted
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

// ── applyPlan — critical failure ────────────────────────────────────────

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

// ── applyPlan — corrupt applied file (e2e) ────────────────────────────

describe("applyPlan — corrupt applied file e2e", () => {
  it("seeds corrupt content, reads null, re-applies all steps, then reads valid rewritten state", async () => {
    const sb = makeSandbox();

    // Seed corrupt content directly (simulates a partial write or schema mismatch)
    await seedRawContent(sb, "{{corrupt");

    // Caller reads the file and gets null
    const readResult = await readAppliedState(sb);
    expect(readResult).toBeNull();

    // Caller passes null to applyPlan — all steps must re-run
    const applied: string[] = [];
    const steps = [
      makeStep("s1", "h1", false, async () => { applied.push("s1"); }),
      makeStep("s2", "h2", false, async () => { applied.push("s2"); }),
    ];
    const spec = makeSpec(steps, "spec-corrupt-recovery");

    await applyPlan(sb, spec, "img:v1", null);

    expect(applied).toEqual(["s1", "s2"]);

    // After applyPlan, the file must be overwritten with valid state
    const recovered = await readAppliedState(sb);
    expect(recovered).not.toBeNull();
    expect(recovered!.image).toBe("img:v1");
    expect(recovered!.specHash).toBe("spec-corrupt-recovery");
    expect(recovered!.steps).toEqual({ s1: "h1", s2: "h2" });
  });
});
