/**
 * The dependency change of a pull request: packages added, upgraded,
 * downgraded and removed, from the dependency files it changes, read at the
 * merge base and at the head.
 */
import { dependencyFile, parseDependencyFile, type Ecosystem, type PackageEntry } from "./parse.js";

/** One changed dependency file, read at both ends. Undefined text: the file is absent at that end. */
export interface ChangedFile {
  path: string;
  base: string | undefined;
  head: string | undefined;
}

export interface PackageLocation {
  path: string;
  /** In the head file. Absent: the file gives no line for it. */
  line?: number;
}

export interface PackageChange {
  ecosystem: Ecosystem;
  name: string;
  kind: "added" | "upgraded" | "downgraded" | "removed";
  /** The version at the merge base. Absent for an added package. */
  from?: string;
  /** The version at the head. Absent for a removed package. */
  to?: string;
  /** False: `to` is the lower bound of a manifest range, not a resolved version. */
  exact: boolean;
  /** A manifest or the lockfile names it as a direct dependency. False: it arrives through another package. */
  direct: boolean;
  /** Where the head files name it, best anchor first: the manifest line, then the lockfile line. */
  locations: PackageLocation[];
  installScript?: boolean;
  /** `installScript` of the `from` version. */
  fromInstallScript?: boolean;
  license?: string;
  /** `license` of the `from` version. */
  fromLicense?: string;
}

/** Changes listed per pull request at most. The summary says when more were cut. */
export const MAX_CHANGES = 3000;

/**
 * The package changes across `files`. Files group by directory and
 * ecosystem. In each group the changed file with the best rank gives the
 * versions: a lockfile, else `go.mod`, else a manifest's range lower
 * bounds. A changed manifest still marks direct dependencies and gives the
 * first anchor line. A manifest edit that changes no dependency (a script
 * or a version field) changes nothing here.
 */
export function dependencyChanges(files: ChangedFile[]): { changes: PackageChange[]; truncated: boolean } {
  const groups = new Map<string, ChangedFile[]>();
  for (const f of files) {
    const kind = dependencyFile(f.path);
    if (!kind) continue;
    const key = `${dirname(f.path)}\0${kind.ecosystem}`;
    groups.set(key, [...(groups.get(key) ?? []), f]);
  }
  const changes: PackageChange[] = [];
  for (const group of groups.values()) changes.push(...groupChanges(group));
  changes.sort((a, b) => Number(b.direct) - Number(a.direct) || a.ecosystem.localeCompare(b.ecosystem) || a.name.localeCompare(b.name) || (a.to ?? "").localeCompare(b.to ?? ""));
  return { changes: changes.slice(0, MAX_CHANGES), truncated: changes.length > MAX_CHANGES };
}

function groupChanges(group: ChangedFile[]): PackageChange[] {
  const ranked = [...group].sort((a, b) => (dependencyFile(a.path)?.rank ?? 9) - (dependencyFile(b.path)?.rank ?? 9));
  // Files of the same rank together give the versions, so moving from one lockfile format to another shows only real changes.
  const best = dependencyFile(ranked[0].path)?.rank;
  const sources = ranked.filter((f) => dependencyFile(f.path)?.rank === best);
  const manifests = group.filter((f) => dependencyFile(f.path)?.kind === "manifest");
  const tagged = (end: "base" | "head") => sources.flatMap((f) => parseDependencyFile(f.path, f[end] ?? "").map((e) => ({ ...e, path: f.path })));
  const baseEntries = tagged("base");
  const headEntries = tagged("head");
  // Names a changed manifest declares at the head, with their lines.
  const declared = new Map<string, PackageLocation>();
  for (const m of manifests) {
    for (const e of parseDependencyFile(m.path, m.head ?? "")) {
      if (!declared.has(e.name)) declared.set(e.name, { path: m.path, ...(e.line !== undefined ? { line: e.line } : {}) });
    }
  }
  type Entry = PackageEntry & { path: string };
  const byName = (entries: Entry[]): Map<string, Entry[]> => {
    const out = new Map<string, Entry[]>();
    for (const e of entries) out.set(e.name, [...(out.get(e.name) ?? []), e]);
    return out;
  };
  const base = byName(baseEntries);
  const head = byName(headEntries);
  const out: PackageChange[] = [];
  for (const [name, now] of head) {
    const was = base.get(name) ?? [];
    const before = new Set(was.map((e) => e.version));
    const fresh = uniqueBy(now.filter((e) => !before.has(e.version)), (e) => e.version);
    const gone = was.filter((e) => !now.some((n) => n.version === e.version));
    for (const e of fresh) {
      const prev = was.length === 0 ? undefined : closest(gone.length > 0 ? gone : was, e.version);
      const decl = declared.get(name);
      const own: PackageLocation = { path: e.path, ...(e.line !== undefined ? { line: e.line } : {}) };
      out.push({
        ecosystem: e.ecosystem,
        name,
        kind: prev === undefined ? "added" : compareVersions(e.version, prev.version) < 0 ? "downgraded" : "upgraded",
        ...(prev !== undefined ? { from: prev.version } : {}),
        to: e.version,
        exact: e.exact,
        direct: e.direct === true || decl !== undefined,
        locations: decl !== undefined && decl.path !== e.path ? [decl, own] : [own],
        ...(e.installScript ? { installScript: true } : {}),
        ...(prev?.installScript ? { fromInstallScript: true } : {}),
        ...(e.license !== undefined ? { license: e.license } : {}),
        ...(prev?.license !== undefined ? { fromLicense: prev.license } : {}),
      });
    }
  }
  for (const [name, was] of base) {
    if (head.has(name)) continue;
    const last = was.reduce((a, b) => (compareVersions(b.version, a.version) > 0 ? b : a));
    out.push({ ecosystem: last.ecosystem, name, kind: "removed", from: last.version, exact: last.exact, direct: last.direct === true, locations: [] });
  }
  return out;
}

/** The entry whose version is nearest below `version`, else the lowest one above it. */
function closest<T extends PackageEntry>(entries: T[], version: string): T {
  const below = entries.filter((e) => compareVersions(e.version, version) <= 0).sort((a, b) => compareVersions(b.version, a.version));
  return below[0] ?? [...entries].sort((a, b) => compareVersions(a.version, b.version))[0];
}

/**
 * Orders two versions by their numeric parts (`v1.10.0` after `v1.9.2`). A
 * version with a pre-release suffix sorts before the same version without one.
 */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string): { nums: number[]; pre: boolean } => {
    const core = v.replace(/^v/, "").split(/[+]/)[0];
    const [main, ...pre] = core.split("-");
    return { nums: main.split(/[.]/).map((p) => Number.parseInt(p, 10) || 0), pre: pre.length > 0 };
  };
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d !== 0) return d;
  }
  return Number(y.pre) - Number(x.pre);
}

function uniqueBy<T>(items: T[], key: (t: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((t) => (seen.has(key(t)) ? false : (seen.add(key(t)), true)));
}

function dirname(path: string): string {
  const at = path.lastIndexOf("/");
  return at === -1 ? "" : path.slice(0, at);
}
