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
    // spawn-shaped uses only. A bare /["']tsx["']\s*,/ also matched marp's
    // syntax-highlighter language aliases (["ts", "tsx", ...]) — data, not
    // an invocation.
    expect(src).not.toMatch(/(?:spawn|spawnSync|execFile|execFileSync|execa|fork)\s*\(\s*["']tsx["']/);
    expect(src).not.toMatch(/\[\s*["']tsx["']\s*,/); // command arrays: ["tsx", "script.ts"]
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
