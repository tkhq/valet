import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * INV-6 (spec 2026-10-08): only the WakeWatcher and `wakeup_cancel` release
 * a lease. This test is the invariant's mechanism. It scans every package's
 * `src` for `releaseLease(` in any case, so `transitionWakeupAndReleaseLease(`
 * matches too (fix wave 3, data L2), and fails on a caller outside the
 * allowed set.
 * The stores define the method, the engine types declare it, and the store
 * contract suite exercises it.
 */
const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

const ALLOWED = new Set([
  "packages/api/src/engine/wake-watcher.ts",
  "packages/api/src/engine/wakeups-seam.ts",
  "packages/engine/src/types.ts",
  "packages/engine/src/providers/in-memory/store.ts",
  "packages/engine/src/test-helpers/store-contract.ts",
  "packages/store-postgres/src/store.ts",
]);

async function sourceFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await sourceFiles(path)));
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(path);
  }
  return out;
}

describe("INV-6: lease releasers", () => {
  it("calls releaseLease( or transitionWakeupAndReleaseLease( only from the WakeWatcher, the wakeups seam, and the stores", async () => {
    const packagesDir = join(REPO_ROOT, "packages");
    const callers: string[] = [];
    for (const pkg of await readdir(packagesDir, { withFileTypes: true })) {
      if (!pkg.isDirectory()) continue;
      const src = join(packagesDir, pkg.name, "src");
      let files: string[];
      try {
        files = await sourceFiles(src);
      } catch {
        continue;
      }
      for (const file of files) {
        if (/releaselease\(/i.test(await readFile(file, "utf8"))) callers.push(relative(REPO_ROOT, file));
      }
    }
    expect(callers.length).toBeGreaterThan(0);
    expect(callers.filter((file) => !ALLOWED.has(file))).toEqual([]);
  });
});
