import { describe, expect, it } from "vitest";
import { isValidSandboxCpu, MAX_SANDBOX_CPU, sandboxCpuRange } from "./sandbox-resources.js";
import { ScratchRequestError, validateScratchRequest } from "./sandbox-resources.js";

describe("sandbox CPU policy", () => {
  it("accepts fractional CPU and the exact ceiling", () => {
    expect(isValidSandboxCpu(0.5)).toBe(true);
    expect(isValidSandboxCpu(MAX_SANDBOX_CPU)).toBe(true);
  });

  it("rejects values above the ceiling and non-finite exponent results", () => {
    expect(isValidSandboxCpu(MAX_SANDBOX_CPU + 0.001)).toBe(false);
    expect(isValidSandboxCpu(Number("1e309"))).toBe(false);
  });

  it("generates the user-facing range from the ceiling", () => {
    expect(sandboxCpuRange()).toBe(`greater than 0 and at most ${MAX_SANDBOX_CPU}`);
  });
});

describe("validateScratchRequest", () => {
  const caps = { max: "1Ti", agentMax: "100Gi" };

  it("returns the trimmed quantity when inside every cap", () => {
    expect(validateScratchRequest(" 200Gi ", "prebuild", caps)).toBe("200Gi");
    expect(validateScratchRequest("50Gi", "task", caps)).toBe("50Gi");
  });

  it("refuses a non-quantity or a value below 1Gi with the A4 text", () => {
    for (const bad of ["nope", 4, "500Mi", "0", "-1Gi"]) {
      expect(() => validateScratchRequest(bad, "prebuild", caps)).toThrow(
        `scratch "${String(bad)}" is not a Kubernetes quantity of at least 1Gi. Use a form like "200Gi".`,
      );
    }
  });

  it("refuses when scratch is disabled", () => {
    expect(() => validateScratchRequest("10Gi", "prebuild", {})).toThrow(
      "scratch is not enabled on this deployment. Set sandbox.scratchMax in the Valet chart (an admin task), or VALET_SANDBOX_SCRATCH_MAX in a dev stack.",
    );
  });

  it("refuses over the deploy cap, never clamps", () => {
    expect(() => validateScratchRequest("2Ti", "prebuild", caps)).toThrow(
      "scratch 2Ti exceeds the 1Ti deploy cap (sandbox.scratchMax). Request at most 1Ti, or set a higher sandbox.scratchMax in the Valet chart (an admin task).",
    );
  });

  it("refuses a task request over the agent cap with the agent text", () => {
    let err: unknown;
    try { validateScratchRequest("200Gi", "task", caps); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(ScratchRequestError);
    expect((err as ScratchRequestError).reason).toBe("agent_cap");
    expect((err as ScratchRequestError).message).toBe(
      "scratch 200Gi exceeds the 100Gi agent cap (sandbox.scratchAgentMax). Declare it in .valet/prebuild.yaml, or ask an admin to raise the cap.",
    );
  });

  it("applies the agent cap only to the task source", () => {
    expect(validateScratchRequest("200Gi", "saved", caps)).toBe("200Gi");
  });
});
