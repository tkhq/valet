import { describe, expect, it } from "vitest";
import { isValidSandboxCpu, MAX_SANDBOX_CPU, sandboxCpuRange } from "./sandbox-resources.js";

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
