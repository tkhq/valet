import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const apiRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bundlePath = resolve(apiRoot, "dist/valet-api.mjs");
const bundleExists = existsSync(bundlePath);

describe.skipIf(!bundleExists)("built bundle guards", () => {
  it("does not scan a migrations directory at runtime (assets are inlined)", () => {
    const src = readFileSync(bundlePath, "utf8");
    // A directory scan of migrations would defeat the inlining strategy.
    expect(src).not.toMatch(/readdirSync\([^)]*migrations/);
  });

  it("does not import or spawn tsx at runtime", () => {
    const src = readFileSync(bundlePath, "utf8");
    expect(src).not.toMatch(/from ["']tsx["']/);
    expect(src).not.toMatch(/require\(["']tsx["']\)/);
    // Broad sweep, kept deliberately: it catches spawn("tsx", ...) under any
    // callee name (esbuild renames collided imports to spawn2/spawn3, which
    // a callee-name alternation can never track), mid-array forms like
    // ["exec", "tsx", file], and option objects. Its one known false
    // positive is a syntax-highlighter language-alias list ("ts", "tsx",
    // "mts", "cts" — via marp-core); that exact context is excluded below.
    // A new match means a runtime tsx dependency unless it is provably data;
    // if so, extend the exclusion with its context, do not weaken the sweep.
    const matches = [...src.matchAll(/["']tsx["']\s*,/g)].filter((m) => {
      const before = src.slice(Math.max(0, m.index - 30), m.index);
      return !/["']ts["']\s*,\s*$/.test(before); // highlighter alias list
    });
    expect(
      matches.map((m) => src.slice(Math.max(0, m.index - 60), m.index + 40)),
    ).toEqual([]);
  });

  it("inlined the engine + app migration SQL into the bundle", () => {
    const src = readFileSync(bundlePath, "utf8");
    // DDL text that lives ONLY in the .sql files (not in any .ts source),
    // proving the migration bytes are embedded rather than read from disk.
    expect(src).toContain('CREATE TABLE "engine_decision_gate_refs"');
    expect(src).toContain('CREATE TABLE "orgs"');
  });
});

describe("copied sibling assets", () => {
  const webDir = resolve(apiRoot, "dist/assets/web");
  const pgliteDir = resolve(apiRoot, "dist/assets/pglite");
  const assetsBuilt = existsSync(webDir) || existsSync(pgliteDir);

  it.skipIf(!assetsBuilt)("has dist/assets/web with an index.html", () => {
    expect(existsSync(resolve(webDir, "index.html"))).toBe(true);
  });

  it.skipIf(!assetsBuilt)("has dist/assets/pglite wasm + data", () => {
    for (const f of ["pglite.wasm", "pglite.data", "initdb.wasm"]) {
      const p = resolve(pgliteDir, f);
      expect(existsSync(p)).toBe(true);
      expect(statSync(p).size).toBeGreaterThan(0);
    }
  });
});
