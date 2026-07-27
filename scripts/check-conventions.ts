/**
 * `conventions` row of `make e2e`: run the executable code-review rules from
 * `scripts/e2e/conventions.ts` over the v2 source tree. Exit 1 with
 * repair-focused messages on any violation.
 *
 * Scope: `packages/*` and `scripts/`, EXCLUDING the frozen legacy packages
 * (worker, client, runner — slated for deletion, not held to v2 rules),
 * build output, declaration files, and node_modules.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkBannedPatterns,
  checkWsTypes,
  renderViolations,
  type PackageManifest,
  type SourceFile,
} from "./e2e/conventions.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LEGACY_PACKAGES = new Set(["worker", "client", "runner"]);
// The checker's own regexes, messages, and test fixtures contain the banned
// patterns as text — scanning them is pure self-reference.
const SELF = new Set([
  "scripts/check-conventions.ts",
  "scripts/e2e/conventions.ts",
  "scripts/e2e/conventions.test.ts",
]);

// Manual walk, NOT `readdirSync({recursive:true})`: the recursive flag
// FOLLOWS symlinked directories, so it descends through every workspace
// package's node_modules symlink farm into pnpm's store (with cross-package
// cycles like packages/api/node_modules/@valet/engine → ../../engine) and
// never returns. Prune during traversal and skip symlinks entirely.
const SKIP_DIRS = new Set(["node_modules", "dist", ".git"]);

function walk(relDir: string, files: SourceFile[]): void {
  for (const entry of readdirSync(join(ROOT, relDir), { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const rel = `${relDir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const pkg = rel.match(/^packages\/([^/]+)$/)?.[1];
      if (pkg !== undefined && LEGACY_PACKAGES.has(pkg)) continue;
      walk(rel, files);
    } else if (entry.isFile()) {
      if (!/\.(ts|tsx)$/.test(entry.name) || entry.name.endsWith(".d.ts")) continue;
      if (SELF.has(rel)) continue;
      files.push({ path: rel, content: readFileSync(join(ROOT, rel), "utf8") });
    }
  }
}

function collectSources(): SourceFile[] {
  const files: SourceFile[] = [];
  for (const base of ["packages", "scripts"]) walk(base, files);
  return files;
}

function collectManifests(): PackageManifest[] {
  const manifests: PackageManifest[] = [];
  for (const entry of readdirSync(join(ROOT, "packages"), { withFileTypes: true })) {
    if (!entry.isDirectory() || LEGACY_PACKAGES.has(entry.name)) continue;
    const rel = `packages/${entry.name}/package.json`;
    try {
      manifests.push({
        path: rel,
        json: JSON.parse(readFileSync(join(ROOT, rel), "utf8")) as PackageManifest["json"],
      });
    } catch {
      // content-only plugins without a package.json are fine
    }
  }
  manifests.push({
    path: "package.json",
    json: JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as PackageManifest["json"],
  });
  return manifests;
}

const violations = [...checkBannedPatterns(collectSources()), ...checkWsTypes(collectManifests())];
console.log(renderViolations(violations));
process.exit(violations.length > 0 ? 1 : 0);
