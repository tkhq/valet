/**
 * verify_command coverage: loader rules (full-profile only, engine drive
 * only), handler scoring against harness-recorded verifications, and the
 * runner executing verifications in a real-exec sandbox before teardown.
 */
import { describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@valet/engine/test-helpers";
import { LocalSandboxProvider } from "@valet/sandbox-local";
import { parseEvalCase, runCase, runDeterministicCheck } from "../src/index.js";
import type { EvalCase, Trajectory } from "../src/index.js";

const FULL_BASE = {
  id: "b-case",
  profile: "full",
  turns: [{ role: "user", content: "build it" }],
};

describe("loader rules", () => {
  it("accepts verify_command on a full-profile case", () => {
    const c = parseEvalCase(
      {
        ...FULL_BASE,
        checks: [{ type: "verify_command", command: "node x.js", expect_output: "ok", timeout_s: 30 }],
      },
      "t.yaml",
    );
    expect(c.checks[0]).toEqual({
      type: "verify_command",
      command: "node x.js",
      expect_output: "ok",
      timeout_s: 30,
    });
  });

  it("rejects verify_command off the full profile and on product drive", () => {
    expect(() =>
      parseEvalCase(
        { ...FULL_BASE, profile: "unit", checks: [{ type: "verify_command", command: "x" }] },
        "t.yaml",
      ),
    ).toThrow(/profile: full/);
    expect(() =>
      parseEvalCase(
        {
          ...FULL_BASE,
          drive: "product",
          session_type: "orchestrator",
          checks: [{ type: "verify_command", command: "x" }],
        },
        "t.yaml",
      ),
    ).toThrow(/drive: product/);
  });

  it("rejects a bad expect_output regex and a bad timeout", () => {
    expect(() =>
      parseEvalCase(
        { ...FULL_BASE, checks: [{ type: "verify_command", command: "x", expect_output: "(" }] },
        "t.yaml",
      ),
    ).toThrow(/expect_output/);
    expect(() =>
      parseEvalCase(
        { ...FULL_BASE, checks: [{ type: "verify_command", command: "x", timeout_s: 0 }] },
        "t.yaml",
      ),
    ).toThrow(/timeout_s/);
  });
});

describe("handler scoring", () => {
  function trajectoryWith(verifications: Trajectory["verifications"]): Trajectory {
    return {
      caseId: "t",
      prompt: "p",
      model: "m",
      turns: [],
      toolCalls: [],
      finalOutput: "",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      durationMs: 1,
      ...(verifications !== undefined ? { verifications } : {}),
    };
  }

  it("passes on exit code and output match; fails on each mismatch", () => {
    const t = trajectoryWith([{ command: "node t.js", exitCode: 0, output: "3 tests passed" }]);
    expect(
      runDeterministicCheck({ type: "verify_command", command: "node t.js", expect_output: "passed" }, t).pass,
    ).toBe(true);
    expect(
      runDeterministicCheck({ type: "verify_command", command: "node t.js", expect_output: "FAILED" }, t).pass,
    ).toBe(false);
    const wrongExit = runDeterministicCheck(
      { type: "verify_command", command: "node t.js", expect_exit_code: 2 },
      t,
    );
    expect(wrongExit.pass).toBe(false);
    expect(wrongExit.detail).toContain("exited 0");
  });

  it("fails with a corrective detail when the harness never ran the command", () => {
    const r = runDeterministicCheck(
      { type: "verify_command", command: "node t.js" },
      trajectoryWith(undefined),
    );
    expect(r.pass).toBe(false);
    expect(r.detail).toContain("profile: full");
  });

  it("reports a timeout distinctly", () => {
    const t = trajectoryWith([{ command: "sleep 999", exitCode: 1, output: "", timedOut: true }]);
    const r = runDeterministicCheck({ type: "verify_command", command: "sleep 999", timeout_s: 5 }, t);
    expect(r.pass).toBe(false);
    expect(r.detail).toContain("timed out after 5s");
  });
});

describe("runner executes verifications against the produced files", () => {
  it("runs verify commands in the sandbox after settlement (local provider, real exec)", async () => {
    const faux = registerFauxProvider({ provider: "verify-1" });
    faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall(
            "write",
            // Relative to the workspace root: the /workspace alias is a
            // Docker mapping the local provider does not implement.
            { path: "answer.js", content: "console.log(6 * 7);" },
            { id: "w1" },
          ),
        ],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("done"),
    ]);

    const evalCase: EvalCase = {
      id: "verify-runner-case",
      profile: "full",
      turns: [{ role: "user", content: "write answer.js" }],
      checks: [
        { type: "verify_command", command: "node answer.js", expect_output: "^42" },
        { type: "verify_command", command: "cat missing.js", expect_exit_code: 1 },
      ],
    };
    // LocalSandboxProvider: real exec on the host, no Docker needed in unit
    // tests. The suite's full-profile path uses Docker; the runner code is
    // identical either way.
    const result = await runCase(evalCase, {
      model: faux.getModel(),
      realPlugins: [{ name: "none", version: "0", description: "none", actions: [] }],
      sandboxProvider: new LocalSandboxProvider(),
    });

    expect(result.outcome).toBe("completed");
    expect(result.trajectory.verifications).toHaveLength(2);
    const [run, missing] = result.trajectory.verifications ?? [];
    expect(run.exitCode).toBe(0);
    expect(run.output).toContain("42");
    expect(missing.exitCode).not.toBe(0);

    const checkPass = runDeterministicCheck(
      { type: "verify_command", command: "node answer.js", expect_output: "^42" },
      result.trajectory,
    );
    expect(checkPass.pass).toBe(true);
    faux.unregister();
  });
});
