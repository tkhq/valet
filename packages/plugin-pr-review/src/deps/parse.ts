/**
 * Parsers for dependency manifests and lockfiles. Each parser reads one
 * file's text and lists the packages it names, with the line where each
 * package's version appears. The parsers read text only: they never run a
 * package manager, so a pull request cannot run code through them.
 *
 * A manifest (`package.json`, `Cargo.toml`, `pyproject.toml`) names version
 * ranges; a lockfile names the resolved versions. `go.mod` and pinned
 * `requirements*.txt` lines name exact versions.
 */

/** OSV ecosystem names. */
export type Ecosystem = "npm" | "Go" | "crates.io" | "PyPI";

/** `manifest`: declares direct dependencies. `lockfile`: resolved versions, transitive included. */
export type FileKind = "manifest" | "lockfile";

export interface DependencyFile {
  ecosystem: Ecosystem;
  kind: FileKind;
  /** Lower rank wins when two files in one directory give versions: a lockfile beats its manifest. */
  rank: number;
}

/** One package a file names. */
export interface PackageEntry {
  ecosystem: Ecosystem;
  name: string;
  /** A resolved version, or the lower bound of a range when `exact` is false. Empty: no version could be read. */
  version: string;
  /** False: `version` is the lower bound of a range in a manifest. */
  exact: boolean;
  /** The file lists it as a direct dependency. Undefined: the file cannot tell. */
  direct?: boolean;
  /** 1-based line of the version (or of the entry) in the file. */
  line?: number;
  /** The lockfile says the package runs a script at install time. */
  installScript?: boolean;
  /** The license the lockfile records. */
  license?: string;
}

const FILES: Record<string, DependencyFile> = {
  "package.json": { ecosystem: "npm", kind: "manifest", rank: 2 },
  "package-lock.json": { ecosystem: "npm", kind: "lockfile", rank: 1 },
  "npm-shrinkwrap.json": { ecosystem: "npm", kind: "lockfile", rank: 1 },
  "pnpm-lock.yaml": { ecosystem: "npm", kind: "lockfile", rank: 1 },
  "yarn.lock": { ecosystem: "npm", kind: "lockfile", rank: 1 },
  "go.mod": { ecosystem: "Go", kind: "lockfile", rank: 1 },
  "go.sum": { ecosystem: "Go", kind: "lockfile", rank: 3 },
  "Cargo.toml": { ecosystem: "crates.io", kind: "manifest", rank: 2 },
  "Cargo.lock": { ecosystem: "crates.io", kind: "lockfile", rank: 1 },
  "pyproject.toml": { ecosystem: "PyPI", kind: "manifest", rank: 2 },
  "uv.lock": { ecosystem: "PyPI", kind: "lockfile", rank: 1 },
  "poetry.lock": { ecosystem: "PyPI", kind: "lockfile", rank: 1 },
};

/** What kind of dependency file `path` is, or undefined for any other file. */
export function dependencyFile(path: string): DependencyFile | undefined {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const known = FILES[base];
  if (known) return known;
  // requirements.txt, requirements-dev.txt, requirements/prod.txt is not matched (directory name).
  if (/^requirements[\w.-]*\.txt$/.test(base)) return { ecosystem: "PyPI", kind: "manifest", rank: 2 };
  return undefined;
}

/** The packages a dependency file names. `path` picks the parser. Text that does not parse gives no entries. */
export function parseDependencyFile(path: string, text: string): PackageEntry[] {
  const base = path.slice(path.lastIndexOf("/") + 1);
  switch (base) {
    case "package.json":
      return parsePackageJson(text);
    case "package-lock.json":
    case "npm-shrinkwrap.json":
      return parsePackageLock(text);
    case "pnpm-lock.yaml":
      return parsePnpmLock(text);
    case "yarn.lock":
      return parseYarnLock(text);
    case "go.mod":
      return parseGoMod(text);
    case "go.sum":
      return parseGoSum(text);
    case "Cargo.toml":
      return parseCargoToml(text);
    case "Cargo.lock":
    case "uv.lock":
    case "poetry.lock":
      return parseTomlPackages(text, base === "Cargo.lock" ? "crates.io" : "PyPI");
    case "pyproject.toml":
      return parsePyproject(text);
    default:
      return dependencyFile(path) ? parseRequirements(text) : [];
  }
}

const NPM_SECTIONS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];

/** `package.json`: the four dependency sections. Each range gives its lower bound. */
export function parsePackageJson(text: string): PackageEntry[] {
  const doc = parseJson(text);
  if (!doc) return [];
  const lines = text.split("\n");
  const out: PackageEntry[] = [];
  for (const section of NPM_SECTIONS) {
    const deps = doc[section];
    if (!isRecord(deps)) continue;
    const start = lines.findIndex((l) => l.includes(`"${section}"`));
    for (const [name, spec] of Object.entries(deps)) {
      if (typeof spec !== "string") continue;
      const range = npmRange(spec);
      if (range === undefined) continue;
      out.push({ ecosystem: "npm", name, ...range, direct: true, ...lineOf(lines, (l) => l.includes(`"${name}"`), start) });
    }
  }
  return out;
}

/**
 * `package-lock.json` (or `npm-shrinkwrap.json`). Version 2 and 3 list every
 * installed path under `packages`, with `hasInstallScript` and `license`.
 * Version 1 nests `dependencies`.
 */
export function parsePackageLock(text: string): PackageEntry[] {
  const doc = parseJson(text);
  if (!doc) return [];
  const lines = text.split("\n");
  const out: PackageEntry[] = [];
  const packages = doc.packages;
  if (isRecord(packages)) {
    const root = isRecord(packages[""]) ? packages[""] : {};
    const direct = new Set(NPM_SECTIONS.flatMap((s) => (isRecord(root[s]) ? Object.keys(root[s]) : [])));
    const keyLines = new Map<string, number>();
    lines.forEach((l, i) => {
      const m = /^\s*"((?:[^"]*\/)?node_modules\/[^"]+)": \{/.exec(l);
      if (m) keyLines.set(m[1], i);
    });
    for (const [key, entry] of Object.entries(packages)) {
      const at = key.lastIndexOf("node_modules/");
      if (at === -1 || !isRecord(entry) || entry.link === true || typeof entry.version !== "string") continue;
      const name = key.slice(at + "node_modules/".length);
      const keyLine = keyLines.get(key);
      out.push({
        ecosystem: "npm",
        name,
        version: entry.version,
        exact: true,
        // A top-level copy of a root dependency is the direct one; nested copies are transitive.
        direct: key === `node_modules/${name}` && direct.has(name),
        ...(keyLine !== undefined ? lineOf(lines, (l) => /^\s*"version":/.test(l), keyLine, keyLine + 12) : {}),
        ...(entry.hasInstallScript === true ? { installScript: true } : {}),
        ...(typeof entry.license === "string" ? { license: entry.license } : {}),
      });
    }
    return out;
  }
  const walk = (deps: unknown, top: boolean): void => {
    if (!isRecord(deps)) return;
    for (const [name, entry] of Object.entries(deps)) {
      if (!isRecord(entry) || typeof entry.version !== "string" || entry.version.includes(":")) continue;
      out.push({ ecosystem: "npm", name, version: entry.version, exact: true, ...(top ? {} : { direct: false }) });
      walk(entry.dependencies, false);
    }
  };
  walk(doc.dependencies, true);
  return out;
}

/**
 * `pnpm-lock.yaml`, lockfile versions 5 to 9, read line by line. Keys under
 * `packages:` are `/name/1.0.0` (v5), `/name@1.0.0(peer@2)` (v6) or
 * `name@1.0.0` (v9). Names under `importers:` or a top-level
 * `dependencies:` section are direct.
 */
export function parsePnpmLock(text: string): PackageEntry[] {
  const lines = text.split("\n");
  const out: PackageEntry[] = [];
  const direct = new Set<string>();
  let section = "";
  let importerSection = "";
  let current: PackageEntry | undefined;
  lines.forEach((raw, i) => {
    const line = raw.replace(/\r$/, "");
    if (/^\S/.test(line)) {
      section = line.replace(/:.*$/, "");
      current = undefined;
      return;
    }
    if (section === "packages") {
      const key = /^ {2}(\S.*):\s*$/.exec(line);
      if (key) {
        current = pnpmKey(unquote(key[1]), i + 1);
        if (current) out.push(current);
        return;
      }
      if (current && /^ {4}requiresBuild: true/.test(line)) current.installScript = true;
      return;
    }
    if (section === "importers") {
      const sub = /^ {4}(dependencies|devDependencies|optionalDependencies):\s*$/.exec(line);
      if (sub) importerSection = sub[1];
      else if (/^ {4}\S/.test(line) || /^ {2}\S/.test(line)) importerSection = "";
      const dep = /^ {6}(\S[^:]*):/.exec(line);
      if (importerSection && dep) direct.add(unquote(dep[1]));
      return;
    }
    if (section === "dependencies" || section === "devDependencies" || section === "optionalDependencies") {
      const dep = /^ {2}(\S[^:]*):/.exec(line);
      if (dep) direct.add(unquote(dep[1]));
    }
  });
  for (const e of out) e.direct = direct.has(e.name);
  return out;
}

function pnpmKey(key: string, line: number): PackageEntry | undefined {
  const bare = key.replace(/^\//, "").replace(/\(.*$/, "");
  // v5: name/version, with an optional _peer@x suffix after the version.
  const v5 = /^((?:@[^/]+\/)?[^/@]+)\/(\d[^_]*)/.exec(bare);
  const at = bare.lastIndexOf("@");
  let name: string;
  let version: string;
  if (v5) {
    name = v5[1];
    version = v5[2];
  } else if (at > 0) {
    name = bare.slice(0, at);
    version = bare.slice(at + 1);
  } else return undefined;
  if (!/^\d/.test(version)) return undefined; // link:, file:, git refs
  return { ecosystem: "npm", name, version, exact: true, line };
}

/**
 * `yarn.lock`, classic (v1) and Berry. An entry starts with its specifiers
 * (`"a@^1", a@^1.1:`) and has a `version "1.2.3"` (v1) or `version: 1.2.3`
 * (Berry) line.
 */
export function parseYarnLock(text: string): PackageEntry[] {
  const lines = text.split("\n");
  const out: PackageEntry[] = [];
  let names: string[] = [];
  lines.forEach((raw, i) => {
    const line = raw.replace(/\r$/, "");
    if (/^\S.*:\s*$/.test(line) && !line.startsWith("#") && !line.startsWith("__metadata")) {
      names = [...new Set(line.replace(/:\s*$/, "").split(/,\s*/).map((s) => yarnName(unquote(s.trim()))).filter((n): n is string => n !== undefined))];
      return;
    }
    const v = /^ {2}version:? "?([^"\s]+)"?\s*$/.exec(line);
    if (v && names.length > 0) {
      if (/^\d/.test(v[1])) for (const name of names) out.push({ ecosystem: "npm", name, version: v[1], exact: true, line: i + 1 });
      names = [];
    }
  });
  return out;
}

function yarnName(spec: string): string | undefined {
  const at = spec.indexOf("@", spec.startsWith("@") ? 1 : 0);
  if (at <= 0) return undefined;
  const range = spec.slice(at + 1);
  // workspace:, link:, portal:, file: and patch: name local code, not a registry package.
  if (/^(workspace|link|portal|file|patch|exec):/.test(range)) return undefined;
  return spec.slice(0, at);
}

/** `go.mod`: every `require` line, direct unless marked `// indirect`. */
export function parseGoMod(text: string): PackageEntry[] {
  const out: PackageEntry[] = [];
  let block = false;
  text.split("\n").forEach((raw, i) => {
    const line = raw.trim();
    if (/^require\s*\($/.test(line)) return void (block = true);
    if (block && line === ")") return void (block = false);
    const m = block ? /^(\S+)\s+(v\S+)(.*)$/.exec(line) : /^require\s+(\S+)\s+(v\S+)(.*)$/.exec(line);
    if (!m) return;
    out.push({ ecosystem: "Go", name: m[1], version: m[2], exact: true, direct: !/\/\/\s*indirect/.test(m[3]), line: i + 1 });
  });
  return out;
}

/** `go.sum`: each module version with a source hash. `/go.mod`-only lines name versions the build does not use. */
export function parseGoSum(text: string): PackageEntry[] {
  const out: PackageEntry[] = [];
  text.split("\n").forEach((raw, i) => {
    const m = /^(\S+)\s+(v[^\s/]+)\s+h1:/.exec(raw.trim());
    if (m) out.push({ ecosystem: "Go", name: m[1], version: m[2], exact: true, line: i + 1 });
  });
  return out;
}

/**
 * `Cargo.toml`: the `[dependencies]`, `[dev-dependencies]` and
 * `[build-dependencies]` tables, also under `[target.*]` and
 * `[workspace.dependencies]`. A `path` or `git` dependency without a version is skipped.
 */
export function parseCargoToml(text: string): PackageEntry[] {
  const out: PackageEntry[] = [];
  let inDeps = false;
  let tableDep: { name: string; line: number } | undefined;
  text.split("\n").forEach((raw, i) => {
    const line = stripTomlComment(raw).trim();
    const table = /^\[([^\]]+)\]$/.exec(line);
    if (table) {
      const name = table[1].trim();
      inDeps = /(^|\.)(dev-|build-)?dependencies$/.test(name);
      // [dependencies.serde] holds one dependency's keys.
      const sub = /(?:^|\.)(?:dev-|build-)?dependencies\.([\w-]+)$/.exec(name);
      tableDep = sub ? { name: sub[1], line: i + 1 } : undefined;
      return;
    }
    if (tableDep) {
      const v = /^version\s*=\s*"([^"]+)"/.exec(line);
      if (v) {
        const range = cargoRange(v[1]);
        if (range) out.push({ ecosystem: "crates.io", name: tableDep.name, ...range, direct: true, line: i + 1 });
      }
      return;
    }
    if (!inDeps) return;
    const simple = /^([\w-]+)\s*=\s*"([^"]+)"/.exec(line);
    const inline = /^([\w-]+)\s*=\s*\{(.*)\}/.exec(line);
    const spec = simple ? simple[2] : inline ? /version\s*=\s*"([^"]+)"/.exec(inline[2])?.[1] : undefined;
    const name = simple?.[1] ?? inline?.[1];
    if (!name || spec === undefined) return;
    const pkg = inline ? /package\s*=\s*"([^"]+)"/.exec(inline[2])?.[1] : undefined;
    const range = cargoRange(spec);
    if (range) out.push({ ecosystem: "crates.io", name: pkg ?? name, ...range, direct: true, line: i + 1 });
  });
  return out;
}

/**
 * `Cargo.lock`, `uv.lock` and `poetry.lock`: `[[package]]` tables with
 * `name` and `version`. A package with no registry source (a workspace
 * member, a path or editable package) is skipped.
 */
export function parseTomlPackages(text: string, ecosystem: "crates.io" | "PyPI"): PackageEntry[] {
  const out: PackageEntry[] = [];
  let current: { name?: string; version?: string; line?: number; local?: boolean; hasSource?: boolean } | undefined;
  const flush = (): void => {
    if (current?.name && current.version && !current.local && (ecosystem === "PyPI" || current.hasSource)) {
      out.push({ ecosystem, name: current.name, version: current.version, exact: true, ...(current.line !== undefined ? { line: current.line } : {}) });
    }
  };
  text.split("\n").forEach((raw, i) => {
    const line = raw.trim();
    if (line === "[[package]]") {
      flush();
      current = {};
      return;
    }
    if (/^\[/.test(line)) {
      // A sub-table ([package.source], [[package.wheels]]) ends the key lines.
      if (current && !line.startsWith("[package.") && !line.startsWith("[[package.")) {
        flush();
        current = undefined;
      }
      return;
    }
    if (!current) return;
    const kv = /^(name|version|source)\s*=\s*(.*)$/.exec(line);
    if (!kv) return;
    if (kv[1] === "name") current.name = unquote(kv[2]);
    else if (kv[1] === "version") {
      current.version = unquote(kv[2]);
      current.line = i + 1;
    } else {
      current.hasSource = true;
      // uv: source = { editable = "." }, { virtual = "." }, { path = "..." }, { workspace = true }.
      if (/\b(editable|virtual|path|directory|workspace)\s*=/.test(kv[2])) current.local = true;
    }
  });
  flush();
  return out;
}

/** `pyproject.toml`: PEP 621 `dependencies` and `optional-dependencies`, and Poetry dependency tables. */
export function parsePyproject(text: string): PackageEntry[] {
  const out: PackageEntry[] = [];
  let table = "";
  let inArray = false;
  text.split("\n").forEach((raw, i) => {
    const line = stripTomlComment(raw).trim();
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) {
      table = header[1].trim();
      inArray = false;
      return;
    }
    const poetry = /^tool\.poetry\.(?:(?:group\.[\w-]+\.)?dependencies|dev-dependencies)$/.test(table);
    if (poetry) {
      const m = /^([\w.-]+)\s*=\s*(?:"([^"]+)"|\{.*version\s*=\s*"([^"]+)".*\})/.exec(line);
      if (m && m[1].toLowerCase() !== "python") {
        const range = pep440Range(m[2] ?? m[3] ?? "");
        out.push({ ecosystem: "PyPI", name: normalizePypi(m[1]), ...range, direct: true, line: i + 1 });
      }
      return;
    }
    const pep621 = table === "project" || table === "project.optional-dependencies" || table === "dependency-groups";
    if (!pep621) return;
    const opens = table === "project" ? /^dependencies\s*=\s*\[/.test(line) : /^[\w-]+\s*=\s*\[/.test(line);
    if (opens) inArray = true;
    if (!inArray) return;
    for (const m of line.matchAll(/"([^"]+)"|'([^']+)'/g)) {
      const req = requirement(m[1] ?? m[2]);
      if (req) out.push({ ...req, direct: true, line: i + 1 });
    }
    if (line.includes("]")) inArray = false;
  });
  return out;
}

/** `requirements*.txt`: one requirement per line. Options, includes, URLs and local paths are skipped. */
export function parseRequirements(text: string): PackageEntry[] {
  const out: PackageEntry[] = [];
  text.split("\n").forEach((raw, i) => {
    const line = raw.replace(/\s+#.*$/, "").replace(/\\$/, "").trim();
    if (!line || line.startsWith("#") || line.startsWith("-") || /^[\w+.-]+:\/\//.test(line) || line.startsWith(".")) return;
    const req = requirement(line);
    if (req) out.push({ ...req, direct: true, line: i + 1 });
  });
  return out;
}

/** One PEP 508 requirement: name, extras, version specifiers and markers. A direct URL reference gives none. */
function requirement(spec: string): PackageEntry | undefined {
  const m = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:\[[^\]]*\])?\s*(.*)$/.exec(spec);
  if (!m || m[2].trim().startsWith("@")) return undefined;
  const versions = m[2].split(";")[0].replace(/^\(|\)$/g, "");
  return { ecosystem: "PyPI", name: normalizePypi(m[1]), ...pep440Range(versions) };
}

/** PyPI names compare after PEP 503 normalization: lowercase, runs of `-_.` become `-`. */
export function normalizePypi(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, "-");
}

function pep440Range(spec: string): { version: string; exact: boolean } {
  const exact = /===?\s*([\w.!+-]+)/.exec(spec);
  if (exact && !exact[1].includes("*")) return { version: exact[1], exact: true };
  const lower = /(?:>=|~=|>|\^|~)\s*([\w.!+-]+)/.exec(spec) ?? /^\s*(\d[\w.!+-]*)/.exec(spec);
  return { version: lower?.[1].replace(/\.\*$/, "") ?? "", exact: false };
}

/** An npm range's lower bound. Undefined for a spec that names no registry version (a URL, path, alias, tag or workspace). */
function npmRange(spec: string): { version: string; exact: boolean } | undefined {
  const s = spec.trim();
  if (/^(workspace|link|file|portal|git|git\+\w+|github|http|https|npm):/.test(s) || s.includes("/")) return undefined;
  const exact = /^=?v?(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)$/.exec(s);
  if (exact) return { version: exact[1], exact: true };
  const lower = /(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?(-[\w.-]+)?/.exec(s);
  if (!lower) return undefined;
  const part = (p: string | undefined): string => (p === undefined || p === "x" || p === "*" ? "0" : p);
  return { version: `${lower[1]}.${part(lower[2])}.${part(lower[3])}${lower[4] ?? ""}`, exact: false };
}

/** A Cargo requirement's lower bound. `1.2` means `^1.2`, so its lower bound is `1.2.0`. */
function cargoRange(spec: string): { version: string; exact: boolean } | undefined {
  const m = /^\s*(=)?\s*[~^>]*=?\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?(-[\w.-]+)?/.exec(spec);
  if (!m) return undefined;
  const version = `${m[2]}.${m[3] ?? "0"}.${m[4] ?? "0"}${m[5] ?? ""}`;
  return { version, exact: m[1] === "=" && m[4] !== undefined };
}

function stripTomlComment(line: string): string {
  // A `#` inside a string is not a comment; dependency lines rarely have one, so cut at the first `#` outside quotes.
  let quote = "";
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) quote = "";
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "#") return line.slice(0, i);
  }
  return line;
}

function unquote(s: string): string {
  const t = s.trim();
  return /^(["']).*\1$/.test(t) ? t.slice(1, -1) : t;
}

function parseJson(text: string): Record<string, unknown> | undefined {
  try {
    const doc: unknown = JSON.parse(text);
    return isRecord(doc) ? doc : undefined;
  } catch {
    return undefined;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The 1-based line of the first line from `start` (inclusive, 0-based) to `end` that matches. */
function lineOf(lines: string[], match: (line: string) => boolean, start = 0, end = lines.length): { line?: number } {
  for (let i = Math.max(0, start); i < Math.min(end, lines.length); i++) if (match(lines[i])) return { line: i + 1 };
  return {};
}
