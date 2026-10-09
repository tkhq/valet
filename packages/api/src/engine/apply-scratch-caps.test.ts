import { describe, expect, it } from "vitest";
import { applyScratchCaps } from "./apply-scratch-caps.js";

describe("applyScratchCaps", () => {
  it("keeps scratch inside the cap", () => {
    const r = applyScratchCaps(
      { docker: false, outcome: "declared", resources: { scratch: "100Gi" }, initialResources: { scratch: "100Gi" } },
      { max: "1Ti", agentMax: "100Gi" },
    );
    expect(r.flags.resources).toEqual({ scratch: "100Gi" });
    expect(r.warning).toBeUndefined();
  });

  it("drops scratch over the deploy cap and returns the warning", () => {
    const r = applyScratchCaps(
      { docker: false, outcome: "declared", resources: { cpu: 2, scratch: "2Ti" }, initialResources: { cpu: 2, scratch: "2Ti" } },
      { max: "1Ti" },
    );
    expect(r.flags.resources).toEqual({ cpu: 2 });
    expect(r.flags.initialResources).toEqual({ cpu: 2 });
    expect(r.warning).toBe(
      "Valet did not apply the repository's scratch setting. scratch 2Ti exceeds the 1Ti deploy cap (sandbox.scratchMax). Request at most 1Ti, or ask an admin to raise the cap.",
    );
  });

  it("drops scratch when scratch is disabled", () => {
    const r = applyScratchCaps(
      { docker: false, outcome: "declared", resources: { scratch: "10Gi" }, initialResources: { scratch: "10Gi" } },
      {},
    );
    expect(r.flags.resources).toEqual({});
    expect(r.flags.initialResources).toEqual({});
    expect(r.warning).toBe(
      "Valet did not apply the repository's scratch setting. scratch is not enabled on this deployment. Ask an admin to set sandbox.scratchMax.",
    );
  });

  it("passes through flags with no declared scratch", () => {
    const r = applyScratchCaps(
      { docker: false, outcome: "declared", resources: { cpu: 2 }, initialResources: { cpu: 2 } },
      { max: "1Ti" },
    );
    expect(r.flags.resources).toEqual({ cpu: 2 });
    expect(r.flags.initialResources).toEqual({ cpu: 2 });
    expect(r.warning).toBeUndefined();
  });
});
