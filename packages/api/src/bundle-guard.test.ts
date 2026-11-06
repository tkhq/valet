import { describe, it, expect } from "vitest";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const apiRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bundlePath = resolve(apiRoot, "dist/valet-api.mjs");
const bundleExists = existsSync(bundlePath);

describe.skipIf(!bundleExists)("built bundle guards", () => {
  it("lists coding tools from a bare directory without installed dependencies", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "valet-proxy-bundle-"));
    try {
      const entry = resolve(dir, "valet-api.mjs");
      copyFileSync(bundlePath, entry);
      const result = spawnSync(process.execPath, [entry, "proxy", "list"], {
        cwd: dir,
        encoding: "utf8",
        env: { ...process.env, VALET_DATA_DIR: resolve(dir, "state") },
        timeout: 15_000,
      });
      expect(result.status, result.stderr).toBe(0);
      for (const tool of ["claude-code", "codex", "opencode"]) expect(result.stdout).toContain(tool);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not scan a migrations directory at runtime (assets are inlined)", () => {
    const src = readFileSync(bundlePath, "utf8");
    // A directory scan of migrations would defeat the inlining strategy.
    expect(src).not.toMatch(/readdirSync\([^)]*migrations/);
    expect(src).not.toMatch(/new URL\(\s*["'][^"']*migrations\/pg\//);
  });

  it("does not import or spawn tsx at runtime", () => {
    const src = readFileSync(bundlePath, "utf8");
    expect(src).not.toMatch(/from ["']tsx["']/);
    expect(src).not.toMatch(/require\(["']tsx["']\)/);
    expect(src).not.toMatch(/["']tsx["']\s*,/); // spawn("tsx", ...) / execa
  });

  it("inlined the engine + app migration SQL into the bundle", () => {
    const src = readFileSync(bundlePath, "utf8");
    // DDL text that lives ONLY in the .sql files (not in any .ts source),
    // proving the migration bytes are embedded rather than read from disk.
    expect(src).toContain('CREATE TABLE "engine_decision_gate_refs"');
    expect(src).toContain('CREATE TABLE "orgs"');
  });

  it("keeps every static import resolvable without node_modules", () => {
    const src = readFileSync(bundlePath, "utf8");
    // The bundle must run from a bare directory (`node valet-api.mjs serve`).
    // Statically importing an externalized package breaks that at load time.
    // yauzl is pure JS and must stay bundled; @firecrawl/pdf-inspector is
    // native and external, so its only references must be dynamic import()
    // (lazy — a missing module fails PDF extraction, not boot).
    expect(src).not.toMatch(/from\s*["']yauzl["']/);
    expect(src).not.toMatch(/require\(["']yauzl["']\)/);
    expect(src).not.toMatch(/from\s*["']@firecrawl\/pdf-inspector["']/);
    expect(src).toContain('import("@firecrawl/pdf-inspector")');
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
