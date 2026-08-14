import { describe, expect, it } from "vitest";
import { shouldSeedLocalIdentity } from "./node.js";

/**
 * The seeded stub identity is an ADMIN, and the middleware's stub rung is
 * inert whenever a real auth instance exists. Seeding it next to real auth
 * therefore adds an admin row nobody signed up for, and blocks
 * `evaluateAdmission`'s "zero users → first signup becomes admin" rule.
 */
describe("shouldSeedLocalIdentity", () => {
  it("seeds in stub-only mode (no auth config)", () => {
    expect(shouldSeedLocalIdentity(false)).toBe(true);
  });

  it("skips seeding when real auth is configured", () => {
    expect(shouldSeedLocalIdentity(true)).toBe(false);
  });
});
