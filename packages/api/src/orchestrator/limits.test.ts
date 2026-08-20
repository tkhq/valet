import { describe, expect, it } from "vitest";

import { resolveOrgSessionCeiling } from "./limits.js";

describe("resolveOrgSessionCeiling", () => {
  it("returns the default when VALET_ORG_SESSION_CEILING is unset", () => {
    expect(resolveOrgSessionCeiling({})).toBe(100);
  });

  it("returns the default when VALET_ORG_SESSION_CEILING is empty", () => {
    expect(resolveOrgSessionCeiling({ VALET_ORG_SESSION_CEILING: "" })).toBe(100);
  });

  it("returns the configured value", () => {
    expect(resolveOrgSessionCeiling({ VALET_ORG_SESSION_CEILING: "250" })).toBe(250);
  });

  it.each(["abc", "0", "-5", "2.5"])("throws on invalid value %j", (raw) => {
    expect(() => resolveOrgSessionCeiling({ VALET_ORG_SESSION_CEILING: raw })).toThrow(
      /Set VALET_ORG_SESSION_CEILING to a positive integer/,
    );
  });
});
