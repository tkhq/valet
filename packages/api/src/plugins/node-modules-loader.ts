/**
 * node_modules plugin loader (plugin-system-v2 plan Task 4).
 *
 * Scans a set of `node_modules`-style directories for packages that declare
 * the `valet.plugin` marker in their `package.json`, dynamically imports
 * the marker module, validates the result as a `ValetPlugin`, and returns
 * both the good plugins and a quarantine list for anything that failed —
 * a bad third-party plugin package must never crash boot.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { validateValetPlugin, type ValetPlugin } from "@valet/engine";

export interface LoadNodeModulesPluginsOpts {
  /** Directories to scan, each treated as a `node_modules` root. */
  searchPaths: string[];
  /** When non-empty, only these exact package names are loaded. */
  allowlist?: string[];
  /** Exact package names to skip, regardless of allowlist. */
  denylist?: string[];
}

export interface QuarantinedPlugin {
  pkg: string;
  reason: string;
}

export interface LoadNodeModulesPluginsResult {
  plugins: ValetPlugin[];
  quarantined: QuarantinedPlugin[];
}

interface PackageJson {
  name?: unknown;
  valet?: { plugin?: unknown };
}

/**
 * Scans every `searchPaths` entry for candidate packages (top-level dirs,
 * plus one level into `@scope/` dirs) and loads each candidate's declared
 * plugin marker module. Never throws — failures land in `quarantined`.
 */
export async function loadNodeModulesPlugins(
  opts: LoadNodeModulesPluginsOpts,
): Promise<LoadNodeModulesPluginsResult> {
  const allowlist = opts.allowlist && opts.allowlist.length > 0 ? new Set(opts.allowlist) : null;
  const denylist = new Set(opts.denylist ?? []);

  const plugins: ValetPlugin[] = [];
  const quarantined: QuarantinedPlugin[] = [];

  for (const searchPath of opts.searchPaths) {
    const dirs = await findPackageDirs(searchPath);
    for (const { pkgName, pkgDir } of dirs) {
      const marker = await readPluginMarker(pkgDir);
      if (marker === null) continue; // not a plugin package — not a candidate, not quarantined

      if (denylist.has(pkgName)) continue;
      if (allowlist && !allowlist.has(pkgName)) continue;

      const result = await loadOnePlugin(pkgDir, marker);
      if (result.ok) {
        plugins.push(result.plugin);
      } else {
        quarantined.push({ pkg: pkgName, reason: result.reason });
        console.error(`[plugins] quarantined ${pkgName}: ${result.reason}`);
      }
    }
  }

  return { plugins, quarantined };
}

async function findPackageDirs(
  searchPath: string,
): Promise<Array<{ pkgName: string; pkgDir: string }>> {
  const entries = await safeReaddir(searchPath);
  const out: Array<{ pkgName: string; pkgDir: string }> = [];

  for (const entry of entries) {
    // pnpm installs packages as symlinks into the .pnpm store, and
    // Dirent.isDirectory() is false for symlinks — so candidates must be
    // gated on isSymbolicLink() as well, then confirmed via stat() (which
    // follows the link) before being treated as a directory.
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const entryPath = join(searchPath, entry.name);
    if (!(await isDirectory(entryPath))) continue;

    if (entry.name.startsWith("@")) {
      const scopeDir = entryPath;
      const scoped = await safeReaddir(scopeDir);
      for (const s of scoped) {
        if (!s.isDirectory() && !s.isSymbolicLink()) continue;
        const scopedPath = join(scopeDir, s.name);
        if (!(await isDirectory(scopedPath))) continue;
        out.push({ pkgName: `${entry.name}/${s.name}`, pkgDir: scopedPath });
      }
      continue;
    }
    out.push({ pkgName: entry.name, pkgDir: entryPath });
  }

  return out;
}

async function safeReaddir(
  dir: string,
): Promise<Array<{ name: string; isDirectory: () => boolean; isSymbolicLink: () => boolean }>> {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** Resolves symlinks (via stat) to determine whether `path` is a directory.
 * A dangling symlink causes stat to reject — treated as "not a directory"
 * rather than thrown. */
async function isDirectory(path: string): Promise<boolean> {
  try {
    const s = await stat(path);
    return s.isDirectory();
  } catch {
    return false;
  }
}

/** Reads `package.json`'s `valet.plugin` marker; `null` when the package is
 * not a plugin candidate at all (missing/unreadable package.json, or no
 * marker) — that is not a failure worth quarantining, just "not a plugin". */
async function readPluginMarker(pkgDir: string): Promise<string | null> {
  let pkgJson: PackageJson;
  try {
    const raw = await readFile(join(pkgDir, "package.json"), "utf-8");
    pkgJson = JSON.parse(raw) as PackageJson;
  } catch {
    return null;
  }
  const marker = pkgJson.valet?.plugin;
  return typeof marker === "string" && marker.length > 0 ? marker : null;
}

type LoadOneResult = { ok: true; plugin: ValetPlugin } | { ok: false; reason: string };

async function loadOnePlugin(pkgDir: string, marker: string): Promise<LoadOneResult> {
  let mod: unknown;
  try {
    const moduleUrl = pathToFileURL(join(pkgDir, marker)).href;
    mod = await import(moduleUrl);
  } catch (err) {
    return { ok: false, reason: `import failed: ${errorMessage(err)}` };
  }

  const exported = isRecord(mod) && "default" in mod ? mod.default : mod;

  let manifest: unknown;
  try {
    manifest = typeof exported === "function" ? await exported() : exported;
  } catch (err) {
    return { ok: false, reason: `plugin factory threw: ${errorMessage(err)}` };
  }

  const validated = validateValetPlugin(manifest);
  if (!validated.ok) {
    const detail = validated.issues.map((i) => `${i.path || "/"}: ${i.message}`).join("; ");
    return { ok: false, reason: `invalid manifest: ${detail}` };
  }

  return { ok: true, plugin: validated.plugin };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
