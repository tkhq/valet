/**
 * The dependency review's offline parts: the manifest and lockfile parsers,
 * the package diff, typosquat and license checks, the findings builder and
 * OSV record reading.
 */
import { describe, expect, it } from "vitest";
import {
  compareVersions,
  dependencyChanges,
  dependencyFile,
  dependencyFindings,
  editDistanceAtMostOne,
  licenseClass,
  lookupAdvisories,
  parseCargoToml,
  parseGoMod,
  parseGoSum,
  parsePackageJson,
  parsePackageLock,
  parsePnpmLock,
  parsePyproject,
  parseRequirements,
  parseTomlPackages,
  parseYarnLock,
  sameLicense,
  toAdvisory,
  typosquatOf,
  withReachability,
  type Advisory,
  type PackageChange,
} from "../src/index.js";

const pick = <T extends { name: string }>(entries: T[], name: string): T | undefined => entries.find((e) => e.name === name);

describe("dependencyFile", () => {
  it("knows each manifest and lockfile by its base name, at any depth", () => {
    expect(dependencyFile("package.json")).toMatchObject({ ecosystem: "npm", kind: "manifest" });
    expect(dependencyFile("apps/web/pnpm-lock.yaml")).toMatchObject({ ecosystem: "npm", kind: "lockfile" });
    expect(dependencyFile("svc/go.sum")).toMatchObject({ ecosystem: "Go" });
    expect(dependencyFile("Cargo.lock")).toMatchObject({ ecosystem: "crates.io", kind: "lockfile" });
    expect(dependencyFile("requirements-dev.txt")).toMatchObject({ ecosystem: "PyPI", kind: "manifest" });
    expect(dependencyFile("uv.lock")).toMatchObject({ ecosystem: "PyPI", kind: "lockfile" });
    expect(dependencyFile("src/package.ts")).toBeUndefined();
    expect(dependencyFile("docs/requirements.md")).toBeUndefined();
  });
});

describe("parsers", () => {
  it("package.json: each dependency section, with range lower bounds and lines; URLs, tags and workspaces are skipped", () => {
    const text = JSON.stringify(
      {
        name: "app",
        dependencies: { lodash: "4.17.20", react: "^18.2", local: "workspace:*", gh: "github:a/b", tagged: "latest" },
        devDependencies: { typescript: "~5.3.3" },
      },
      null,
      2,
    );
    const entries = parsePackageJson(text);
    expect(entries.map((e) => e.name).sort()).toEqual(["lodash", "react", "typescript"]);
    expect(pick(entries, "lodash")).toMatchObject({ version: "4.17.20", exact: true, direct: true, line: 4 });
    expect(pick(entries, "react")).toMatchObject({ version: "18.2.0", exact: false });
    expect(pick(entries, "typescript")).toMatchObject({ version: "5.3.3", exact: false, line: 11 });
  });

  it("package-lock.json v3: nested copies are transitive; install scripts, licenses and version lines are read", () => {
    const text = JSON.stringify(
      {
        lockfileVersion: 3,
        packages: {
          "": { name: "app", dependencies: { lodash: "4.17.20", esbuild: "0.20.0" } },
          "node_modules/lodash": { version: "4.17.20", license: "MIT" },
          "node_modules/esbuild": { version: "0.20.0", hasInstallScript: true, license: "MIT" },
          "node_modules/esbuild/node_modules/lodash": { version: "3.10.1" },
          "packages/lib": { version: "1.0.0" },
          "node_modules/lib": { link: true, resolved: "packages/lib" },
        },
      },
      null,
      2,
    );
    const entries = parsePackageLock(text);
    expect(entries.map((e) => `${e.name}@${e.version}:${e.direct}`)).toEqual(["lodash@4.17.20:true", "esbuild@0.20.0:true", "lodash@3.10.1:false"]);
    expect(pick(entries, "esbuild")).toMatchObject({ installScript: true, license: "MIT" });
    const lines = text.split("\n");
    expect(lines[(entries[0].line ?? 0) - 1]).toContain('"version": "4.17.20"');
  });

  it("package-lock.json v1: nested dependencies", () => {
    const entries = parsePackageLock(JSON.stringify({ lockfileVersion: 1, dependencies: { a: { version: "1.0.0", dependencies: { b: { version: "2.0.0" } } } } }));
    expect(entries.map((e) => `${e.name}@${e.version}`)).toEqual(["a@1.0.0", "b@2.0.0"]);
    expect(pick(entries, "b")?.direct).toBe(false);
  });

  it("pnpm-lock.yaml v9: package keys, importers mark direct dependencies", () => {
    const text = [
      "lockfileVersion: '9.0'",
      "",
      "importers:",
      "",
      "  .:",
      "    dependencies:",
      "      lodash:",
      "        specifier: 4.17.20",
      "        version: 4.17.20",
      "",
      "packages:",
      "",
      "  lodash@4.17.20:",
      "    resolution: {integrity: sha512-x}",
      "",
      "  '@scope/pkg@1.2.3':",
      "    resolution: {integrity: sha512-y}",
      "",
      "snapshots:",
      "",
      "  lodash@4.17.20: {}",
    ].join("\n");
    const entries = parsePnpmLock(text);
    expect(entries.map((e) => `${e.name}@${e.version}:${e.direct}`)).toEqual(["lodash@4.17.20:true", "@scope/pkg@1.2.3:false"]);
    expect(pick(entries, "lodash")?.line).toBe(13);
  });

  it("pnpm-lock.yaml v5 and v6 keys, with peer suffixes and requiresBuild", () => {
    const v6 = ["lockfileVersion: '6.0'", "dependencies:", "  a:", "    specifier: ^1", "    version: 1.0.0", "packages:", "  /a@1.0.0(react@18.2.0):", "    requiresBuild: true", "  /@s/b@2.0.0:", "    dev: false"].join("\n");
    expect(parsePnpmLock(v6).map((e) => `${e.name}@${e.version}:${e.direct}:${e.installScript ?? false}`)).toEqual(["a@1.0.0:true:true", "@s/b@2.0.0:false:false"]);
    const v5 = ["lockfileVersion: 5.4", "packages:", "  /a/1.0.0_react@18.2.0:", "    dev: false", "  /@s/b/2.0.0:", "    dev: true"].join("\n");
    expect(parsePnpmLock(v5).map((e) => `${e.name}@${e.version}`)).toEqual(["a@1.0.0", "@s/b@2.0.0"]);
  });

  it("yarn.lock classic and Berry; workspace entries are skipped", () => {
    const classic = ['# yarn lockfile v1', "", '"@babel/core@^7.0.0", "@babel/core@^7.1.0":', '  version "7.22.0"', '  resolved "https://x"', "", "lodash@^4.17.0:", '  version "4.17.20"'].join("\n");
    expect(parseYarnLock(classic).map((e) => `${e.name}@${e.version}@${e.line}`)).toEqual(["@babel/core@7.22.0@4", "lodash@4.17.20@8"]);
    const berry = ["__metadata:", "  version: 6", "", '"lodash@npm:^4.17.0":', "  version: 4.17.21", "", '"app@workspace:.":', "  version: 0.0.0-use.local"].join("\n");
    expect(parseYarnLock(berry).map((e) => `${e.name}@${e.version}`)).toEqual(["lodash@4.17.21"]);
  });

  it("go.mod require lines and go.sum source hashes", () => {
    const mod = ["module example.com/app", "", "go 1.22", "", "require github.com/gin-gonic/gin v1.6.0", "", "require (", "\tgolang.org/x/net v0.17.0 // indirect", "\tgithub.com/google/uuid v1.6.0", ")"].join("\n");
    expect(parseGoMod(mod).map((e) => `${e.name}@${e.version}:${e.direct}:${e.line}`)).toEqual([
      "github.com/gin-gonic/gin@v1.6.0:true:5",
      "golang.org/x/net@v0.17.0:false:8",
      "github.com/google/uuid@v1.6.0:true:9",
    ]);
    const sum = ["github.com/gin-gonic/gin v1.6.0 h1:abc=", "github.com/gin-gonic/gin v1.6.0/go.mod h1:def=", "github.com/old/x v0.1.0/go.mod h1:ghi="].join("\n");
    expect(parseGoSum(sum).map((e) => `${e.name}@${e.version}`)).toEqual(["github.com/gin-gonic/gin@v1.6.0"]);
  });

  it("Cargo.toml dependency tables, inline tables, renamed packages and target tables", () => {
    const text = [
      "[package]",
      'name = "app"',
      'version = "0.1.0"',
      "",
      "[dependencies]",
      'serde = "1.0"',
      'tokio = { version = "1.35", features = ["full"] } # comment',
      'local = { path = "../local" }',
      'json = { package = "serde_json", version = "=1.0.100" }',
      "",
      "[target.'cfg(unix)'.dev-dependencies]",
      'libc = "0.2"',
      "",
      "[dependencies.regex]",
      'version = "1.10"',
    ].join("\n");
    const entries = parseCargoToml(text);
    expect(entries.map((e) => `${e.name}@${e.version}:${e.exact}`)).toEqual(["serde@1.0.0:false", "tokio@1.35.0:false", "serde_json@1.0.100:true", "libc@0.2.0:false", "regex@1.10.0:false"]);
  });

  it("Cargo.lock skips workspace members; uv.lock skips editable and virtual packages", () => {
    const cargo = ['[[package]]', 'name = "app"', 'version = "0.1.0"', "", "[[package]]", 'name = "serde"', 'version = "1.0.190"', 'source = "registry+https://github.com/rust-lang/crates.io-index"'].join("\n");
    expect(parseTomlPackages(cargo, "crates.io").map((e) => `${e.name}@${e.version}@${e.line}`)).toEqual(["serde@1.0.190@7"]);
    const uv = ["version = 1", "", "[[package]]", 'name = "app"', 'version = "0.1.0"', 'source = { editable = "." }', "", "[[package]]", 'name = "requests"', 'version = "2.31.0"', 'source = { registry = "https://pypi.org/simple" }', "", "[[package.wheels]]", 'url = "https://x"'].join("\n");
    expect(parseTomlPackages(uv, "PyPI").map((e) => `${e.name}@${e.version}`)).toEqual(["requests@2.31.0"]);
  });

  it("pyproject.toml: PEP 621 arrays, optional dependencies and Poetry tables, names normalized", () => {
    const text = [
      "[project]",
      'name = "app"',
      "dependencies = [",
      '  "requests>=2.31",',
      '  "Django_Rest.Framework==3.14.0 ; python_version > \'3.8\'",',
      "]",
      "",
      "[project.optional-dependencies]",
      'dev = ["pytest~=7.4"]',
      "",
      "[tool.poetry.dependencies]",
      'python = "^3.11"',
      'httpx = { version = "^0.25", extras = ["http2"] }',
    ].join("\n");
    expect(parsePyproject(text).map((e) => `${e.name}@${e.version}:${e.exact}`)).toEqual([
      "requests@2.31:false",
      "django-rest-framework@3.14.0:true",
      "pytest@7.4:false",
      "httpx@0.25:false",
    ]);
  });

  it("requirements.txt: pins, ranges, extras and markers; options, includes and URLs are skipped", () => {
    const text = ["# comment", "-r base.txt", "--index-url https://x", "requests==2.31.0  # pinned", "urllib3[socks]>=1.26,<3 ; python_version >= '3.8'", "git+https://github.com/a/b.git", "./local", "pkg @ https://x/pkg.whl"].join("\n");
    expect(parseRequirements(text).map((e) => `${e.name}@${e.version}:${e.exact}@${e.line}`)).toEqual(["requests@2.31.0:true@4", "urllib3@1.26:false@5"]);
  });

  it("text that does not parse gives no entries", () => {
    expect(parsePackageJson("{ not json")).toEqual([]);
    expect(parsePackageLock("")).toEqual([]);
  });
});

describe("dependencyChanges", () => {
  const lock = (pkgs: Record<string, string>, direct: string[] = Object.keys(pkgs)): string =>
    JSON.stringify(
      {
        lockfileVersion: 3,
        packages: {
          "": { dependencies: Object.fromEntries(direct.map((d) => [d, "*"])) },
          ...Object.fromEntries(Object.entries(pkgs).map(([k, v]) => [k.includes("node_modules/") ? k : `node_modules/${k}`, { version: v }])),
        },
      },
      null,
      2,
    );

  it("lists added, upgraded, downgraded and removed packages; the lockfile gives versions and the manifest gives the anchor", () => {
    const { changes } = dependencyChanges([
      { path: "package.json", base: JSON.stringify({ dependencies: { a: "^1.0.0", b: "^2.0.0", c: "1.0.0" } }, null, 2), head: JSON.stringify({ dependencies: { a: "^1.1.0", b: "^2.0.0", d: "^1.0.0" } }, null, 2) },
      { path: "package-lock.json", base: lock({ a: "1.0.5", b: "2.3.0", c: "1.0.0", e: "1.0.0" }, ["a", "b", "c"]), head: lock({ a: "1.1.0", b: "2.1.0", d: "1.0.0", e: "1.0.0", t: "0.1.0" }, ["a", "b", "d"]) },
    ]);
    const by = (name: string): PackageChange | undefined => changes.find((c) => c.name === name);
    expect(by("a")).toMatchObject({ kind: "upgraded", from: "1.0.5", to: "1.1.0", exact: true, direct: true });
    expect(by("a")?.locations[0]).toEqual({ path: "package.json", line: 3 });
    expect(by("a")?.locations[1]?.path).toBe("package-lock.json");
    expect(by("b")).toMatchObject({ kind: "downgraded", from: "2.3.0", to: "2.1.0" });
    expect(by("c")).toMatchObject({ kind: "removed", from: "1.0.0" });
    expect(by("d")).toMatchObject({ kind: "added", to: "1.0.0", direct: true });
    expect(by("t")).toMatchObject({ kind: "added", direct: false });
    expect(by("e")).toBeUndefined();
    // Direct dependencies first.
    expect(changes.findIndex((c) => !c.direct)).toBeGreaterThan(changes.findIndex((c) => c.name === "d"));
  });

  it("a manifest change without its lockfile reports range lower bounds", () => {
    const { changes } = dependencyChanges([{ path: "package.json", base: JSON.stringify({ dependencies: {} }), head: JSON.stringify({ dependencies: { lodash: "^4.17.20" } }) }]);
    expect(changes).toEqual([expect.objectContaining({ name: "lodash", kind: "added", to: "4.17.20", exact: false, direct: true })]);
  });

  it("a manifest edit that changes no dependency changes nothing", () => {
    const deps = { dependencies: { a: "1.0.0" } };
    expect(dependencyChanges([{ path: "package.json", base: JSON.stringify({ ...deps, scripts: { a: "x" } }), head: JSON.stringify({ ...deps, scripts: { a: "y" } }) }]).changes).toEqual([]);
  });

  it("an added nested copy of a package counts once per new version", () => {
    const { changes } = dependencyChanges([{ path: "package-lock.json", base: lock({ x: "1.0.0" }), head: lock({ x: "1.0.0", "node_modules/y/node_modules/x": "2.0.0", "node_modules/z/node_modules/x": "2.0.0" }) }]);
    expect(changes.filter((c) => c.name === "x")).toEqual([expect.objectContaining({ kind: "upgraded", from: "1.0.0", to: "2.0.0" })]);
  });

  it("files group by directory: go.mod beats go.sum, and two modules do not mix", () => {
    const { changes } = dependencyChanges([
      { path: "svc/go.mod", base: "module a\n\nrequire github.com/x/y v1.0.0\n", head: "module a\n\nrequire github.com/x/y v1.2.0\n" },
      { path: "svc/go.sum", base: "github.com/x/y v1.0.0 h1:a=\n", head: "github.com/x/y v1.0.0 h1:a=\ngithub.com/x/y v1.2.0 h1:b=\ngithub.com/q/r v0.1.0 h1:c=\n" },
      { path: "tool/go.mod", base: undefined, head: "module t\n\nrequire github.com/x/y v1.0.0\n" },
    ]);
    expect(changes.map((c) => `${c.locations[0]?.path}:${c.name}:${c.kind}:${c.to}`).sort()).toEqual(["svc/go.mod:github.com/x/y:upgraded:v1.2.0", "tool/go.mod:github.com/x/y:added:v1.0.0"]);
  });

  it("moving from one lockfile format to another shows only real changes", () => {
    const pnpm = ["lockfileVersion: '9.0'", "packages:", "  a@1.0.0:", "    resolution: {}", "  b@2.0.0:", "    resolution: {}"].join("\n");
    const { changes } = dependencyChanges([
      { path: "package-lock.json", base: lock({ a: "1.0.0" }), head: undefined },
      { path: "pnpm-lock.yaml", base: undefined, head: pnpm },
    ]);
    expect(changes.map((c) => `${c.name}:${c.kind}`)).toEqual(["b:added"]);
  });

  it("compareVersions orders numeric parts and puts a pre-release first", () => {
    expect(compareVersions("v1.10.0", "v1.9.2")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0-rc.1", "1.0.0")).toBeLessThan(0);
    expect(compareVersions("2.0", "2.0.0")).toBe(0);
  });
});

describe("typosquats and licenses", () => {
  it("flags one edit or separator changes from a popular name, never the popular name itself", () => {
    expect(typosquatOf("npm", "lodahs")).toEqual({ of: "lodash", how: "edit" });
    expect(typosquatOf("npm", "expresss")).toEqual({ of: "express", how: "edit" });
    expect(typosquatOf("npm", "reactdom")).toEqual({ of: "react-dom", how: "separator" });
    expect(typosquatOf("npm", "react")).toBeUndefined();
    expect(typosquatOf("npm", "preact")).toBeUndefined();
    expect(typosquatOf("npm", "left-pad")).toBeUndefined();
    expect(typosquatOf("PyPI", "reqeusts")).toEqual({ of: "requests", how: "edit" });
    // PyPI treats separators and case as the same name.
    expect(typosquatOf("PyPI", "Python_Dateutil")).toBeUndefined();
    expect(typosquatOf("crates.io", "serde-json")).toEqual({ of: "serde_json", how: "separator" });
    expect(typosquatOf("Go", "github.com/gin-gonlc/gin")).toEqual({ of: "github.com/gin-gonic/gin", how: "edit" });
    // Short names are not compared by edits.
    expect(typosquatOf("npm", "chai2")).toBeUndefined();
  });

  it("editDistanceAtMostOne counts insertions, deletions, substitutions and swaps", () => {
    expect(editDistanceAtMostOne("abcd", "abd")).toBe(true);
    expect(editDistanceAtMostOne("abcd", "abdc")).toBe(true);
    expect(editDistanceAtMostOne("abcd", "abxd")).toBe(true);
    expect(editDistanceAtMostOne("abcd", "axyd")).toBe(false);
  });

  it("classifies licenses, and an OR choice counts its most permissive option", () => {
    expect(licenseClass("MIT")).toBe("permissive");
    expect(licenseClass("AGPL-3.0-only")).toBe("strong-copyleft");
    expect(licenseClass("LGPL-3.0")).toBe("copyleft");
    expect(licenseClass("(MIT OR GPL-3.0)")).toBe("permissive");
    expect(licenseClass(undefined)).toBe("unknown");
    expect(sameLicense("Apache-2.0", "apache-2.0")).toBe(true);
    expect(sameLicense("GPL-3.0-only", "GPL-3.0")).toBe(true);
  });
});

const advisory = (over: Partial<Advisory> = {}): Advisory => ({
  id: "GHSA-35jh-r3h4-6jhm",
  aliases: ["CVE-2021-23337"],
  summary: "Command Injection in lodash",
  details: "lodash versions prior to 4.17.21 are vulnerable to Command Injection via the template function.",
  severity: "high",
  fixed: "4.17.21",
  symbols: [],
  url: "https://osv.dev/vulnerability/GHSA-35jh-r3h4-6jhm",
  ...over,
});

const change = (over: Partial<PackageChange>): PackageChange => ({ ecosystem: "npm", name: "lodash", kind: "added", to: "4.17.20", exact: true, direct: true, locations: [{ path: "package.json", line: 3 }], ...over });

describe("dependencyFindings", () => {
  const now = new Date("2026-11-20T00:00:00Z");

  it("gives one advisory finding per advisory, keyed by package, version and id", () => {
    const [f] = dependencyFindings([change({})], [[advisory()]], [{}], { newPackageDays: 30, now });
    expect(f).toMatchObject({ key: "npm:lodash@4.17.20:advisory:GHSA-35jh-r3h4-6jhm", kind: "advisory", severity: "high", direct: true });
    expect(f.title).toBe("lodash 4.17.20 has advisory GHSA-35jh-r3h4-6jhm: Command Injection in lodash");
    expect(f.body).toContain("Upgrade to 4.17.21 or later.");
  });

  it("flags new packages, typosquats and install scripts on added packages", () => {
    const findings = dependencyFindings(
      [change({ name: "lodahs", to: "1.0.0" })],
      [[]],
      [{ to: { createdAt: "2026-11-18T00:00:00Z", installScripts: { postinstall: "node steal.js" }, maintainers: [] } }],
      { newPackageDays: 30, now },
    );
    expect(findings.map((f) => `${f.kind}:${f.severity}`)).toEqual(["typosquat:medium", "new-package:medium", "install-script:medium"]);
    expect(findings[2].body).toContain("`postinstall`: `node steal.js`");
  });

  it("flags a license change, a new maintainer and a new install script on an upgrade", () => {
    const findings = dependencyFindings(
      [change({ kind: "upgraded", from: "1.0.0", to: "1.1.0", name: "left-pad" })],
      [[]],
      [{ from: { license: "MIT", maintainers: ["alice"], publisher: "alice", installScripts: {} }, to: { license: "AGPL-3.0", maintainers: ["alice", "mallory"], publisher: "mallory", installScripts: { install: "sh x" } } }],
      { newPackageDays: 30, now },
    );
    expect(findings.map((f) => `${f.kind}:${f.severity}`)).toEqual(["install-script:medium", "maintainer:medium", "license:high"]);
  });

  it("an upgrade with the same facts and a removed package give no findings", () => {
    const same = { license: "MIT", maintainers: ["alice"], publisher: "alice", installScripts: {} };
    expect(dependencyFindings([change({ kind: "upgraded", from: "1.0.0", to: "1.1.0", name: "left-pad" }), change({ kind: "removed", to: undefined, from: "1.0.0" })], [[], []], [{ from: same, to: same }, {}], { newPackageDays: 30, now })).toEqual([]);
  });

  it("merges one package's finding from two directories into one finding with both locations", () => {
    const findings = dependencyFindings([change({}), change({ locations: [{ path: "apps/web/package.json", line: 9 }] })], [[advisory()], [advisory()]], [{}, {}], { newPackageDays: 30, now });
    expect(findings).toHaveLength(1);
    expect(findings[0].locations.map((l) => l.path)).toEqual(["package.json", "apps/web/package.json"]);
  });

  it("an advisory the code does not reach posts one level lower; a reached one keeps its severity", () => {
    const [f] = dependencyFindings([change({})], [[advisory()]], [{}], { newPackageDays: 30, now });
    expect(withReachability(f, { reachable: "no", evidence: "rg found no import", reason: "lodash is not imported." })).toMatchObject({ severity: "medium" });
    const yes = withReachability(f, { reachable: "yes", evidence: "src/render.ts:3", reason: "render calls _.template." });
    expect(yes.severity).toBe("high");
    expect(yes.body).toContain("**Reachable.** render calls _.template. src/render.ts:3");
  });
});

describe("OSV", () => {
  it("reads the fixed version above the queried one, the affected symbols and the severity label", () => {
    const a = toAdvisory(
      {
        id: "GO-2021-0052",
        aliases: ["GHSA-h395-qcrw-5vmq"],
        summary: "Proxy spoofing in gin",
        affected: [
          { package: { ecosystem: "Go", name: "github.com/gin-gonic/gin" }, ranges: [{ events: [{ introduced: "0" }, { fixed: "1.7.7" }, { introduced: "2.0.0" }, { fixed: "2.0.3" }] }], ecosystem_specific: { imports: [{ symbols: ["Context.ClientIP"] }] } },
        ],
        severity: [{ type: "CVSS_V3", score: "CVSS:3.1/AV:N" }],
      },
      { ecosystem: "Go", name: "github.com/gin-gonic/gin", version: "v1.6.0" },
    );
    expect(a).toMatchObject({ fixed: "1.7.7", symbols: ["Context.ClientIP"], severity: "medium" });
  });

  it("queries in one batch and counts an advisory and its alias once", async () => {
    const calls: string[] = [];
    const fake: typeof fetch = async (input, init) => {
      const url = String(input);
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (url.endsWith("/querybatch")) return Response.json({ results: [{ vulns: [{ id: "GO-1" }, { id: "GHSA-1" }] }, {}] });
      if (url.endsWith("/vulns/GO-1")) return Response.json({ id: "GO-1", aliases: ["GHSA-1"], summary: "one", database_specific: { severity: "HIGH" } });
      return Response.json({ id: "GHSA-1", aliases: ["GO-1"], summary: "one again", affected: [{ package: { ecosystem: "Go", name: "m" }, ecosystem_specific: { imports: [{ symbols: ["Parse"] }] } }] });
    };
    const out = await lookupAdvisories([{ ecosystem: "Go", name: "m", version: "v1.0.0" }, { ecosystem: "npm", name: "n", version: "1.0.0" }], { fetch: fake });
    expect(out.map((a) => a.map((x) => x.id))).toEqual([["GO-1"], []]);
    // The alias's affected functions join the kept advisory.
    expect(out[0][0].symbols).toEqual(["Parse"]);
    expect(calls.filter((c) => c.includes("querybatch"))).toHaveLength(1);
  });

  it("fails loudly when OSV fails, so the delivery retries", async () => {
    const fake: typeof fetch = async () => new Response("down", { status: 503 });
    await expect(lookupAdvisories([{ ecosystem: "npm", name: "n", version: "1.0.0" }], { fetch: fake })).rejects.toThrow(/Retry the delivery/);
  });
});
