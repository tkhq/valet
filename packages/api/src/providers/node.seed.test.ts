import { describe, expect, it } from "vitest";
import { shouldSeedLocalIdentity } from "./node.js";

/**
 * The mixed-mode regression (dogfood find): BETTER_AUTH_SECRET set (auth
 * configured) AND VALET_LOCAL_AUTH=1 left the stub identity resolvable by
 * the middleware but unseeded in the db, so `/api/me` 404'd "user not
 * found" for every session-less dev request.
 */
describe("shouldSeedLocalIdentity", () => {
  it("seeds in stub-only mode (no auth config)", () => {
    expect(shouldSeedLocalIdentity(false, {})).toBe(true);
    expect(shouldSeedLocalIdentity(false, { VALET_LOCAL_AUTH: "1" })).toBe(true);
  });

  it("skips seeding when real auth is configured and the stub rung is off", () => {
    expect(shouldSeedLocalIdentity(true, {})).toBe(false);
    expect(shouldSeedLocalIdentity(true, { VALET_LOCAL_AUTH: "0" })).toBe(false);
  });

  it("seeds in mixed mode: real auth configured but stub rung enabled", () => {
    expect(shouldSeedLocalIdentity(true, { VALET_LOCAL_AUTH: "1" })).toBe(true);
  });
});
