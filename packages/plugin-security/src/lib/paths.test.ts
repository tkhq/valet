import { describe, expect, it } from "vitest";
import { pathMatchesGlobs } from "./paths.js";

describe("pathMatchesGlobs", () => {
  it("matches a directory-prefix `**` glob", () => {
    expect(pathMatchesGlobs("packages/api/src/routes/x.ts", ["packages/api/**"])).toBe(true);
    expect(pathMatchesGlobs("packages/web/src/x.ts", ["packages/api/**"])).toBe(false);
  });

  it("matches a repo-wide `**` glob", () => {
    expect(pathMatchesGlobs("anything/here.ts", ["**"])).toBe(true);
  });

  it("keeps `*` within one segment", () => {
    expect(pathMatchesGlobs("src/a.ts", ["src/*.ts"])).toBe(true);
    expect(pathMatchesGlobs("src/nested/a.ts", ["src/*.ts"])).toBe(false);
  });

  it("matches any of several globs", () => {
    const globs = ["packages/api/**", "packages/payments/**"];
    expect(pathMatchesGlobs("packages/payments/charge.ts", globs)).toBe(true);
    expect(pathMatchesGlobs("packages/web/x.ts", globs)).toBe(false);
  });

  it("drops a leading ./ before matching", () => {
    expect(pathMatchesGlobs("./packages/api/x.ts", ["packages/api/**"])).toBe(true);
  });

  it("treats an empty glob list as unscoped (every path matches)", () => {
    expect(pathMatchesGlobs("packages/api/x.ts", [])).toBe(true);
  });
});
