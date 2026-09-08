import { describe, expect, it } from "vitest";
import { pathMatchesGlobs } from "./paths.js";

describe("pathMatchesGlobs", () => {
  it("matches a directory-prefix `**` glob", () => {
    expect(pathMatchesGlobs("packages/api/src/routes/x.ts", ["packages/api/**"])).toBe(true);
    expect(pathMatchesGlobs("packages/web/src/x.ts", ["packages/api/**"])).toBe(false);
  });

  it("matches files below a literal directory scope but not its sibling prefix", () => {
    const scope = ["src/rust/ump/"];
    expect(pathMatchesGlobs("src/rust/ump/README.md", scope)).toBe(true);
    expect(pathMatchesGlobs("src/rust/ump/app/src/routes/decider.rs", scope)).toBe(true);
    expect(pathMatchesGlobs("src/rust/umpx/app/src/cli.rs", scope)).toBe(false);
  });

  it("matches any of several literal scopes", () => {
    expect(pathMatchesGlobs("src/rust/ump/app/src/cli.rs", ["src/go", "src/rust/ump"])).toBe(true);
  });

  it("matches a literal scope-as-file exactly", () => {
    expect(pathMatchesGlobs("src/rust/ump/app/src/cli.rs", ["src/rust/ump/app/src/cli.rs"])).toBe(true);
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
