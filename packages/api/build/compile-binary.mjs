// Compiles the embedded-asset Bun wrapper (build/compile-entry.mjs) into a
// self-contained single-file `valet` binary via `bun build --compile`.
//
// Assumes the bundle (dist/valet-api.mjs) and the asset tar (dist/assets.tar)
// already exist — the `build:binary` npm script runs build:assets → build:bundle
// → make-assets-tar first.
//
// Usage:
//   node build/compile-binary.mjs                 # host platform
//   node build/compile-binary.mjs --target bun-linux-x64
//
// Bun cross-compiles JS + embeds the asset tar for the target (the embedded
// assets — PGlite's platform-agnostic wasm/data + the static web SPA — are the
// same across platforms, so cross-compilation is safe). Output is named
// `dist/valet-<os>-<arch>` derived from the target (or the host when unset).
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const apiRoot = resolve(here, "..");
const entry = resolve(here, "compile-entry.mjs");
const tar = resolve(apiRoot, "dist/assets.tar");
const bundle = resolve(apiRoot, "dist/valet-api.mjs");

for (const [label, p] of [
  ["bundle", bundle],
  ["asset tar", tar],
]) {
  if (!existsSync(p)) {
    throw new Error(`compile-binary: ${label} missing at ${p} — run build:assets/build:bundle/make-assets-tar first`);
  }
}

/** Read `--target <t>` / `--target=<t>` from argv, else undefined (host build). */
function parseTarget(argv) {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--target") return argv[i + 1];
    if (a.startsWith("--target=")) return a.slice("--target=".length);
  }
  return undefined;
}

/** Map a Bun `--target` (e.g. `bun-linux-x64`) to our `<os>-<arch>` suffix. */
function outSuffixFor(target) {
  if (!target) return `${process.platform}-${process.arch}`;
  const m = /^bun-([a-z]+)-([a-z0-9]+)$/.exec(target);
  if (!m) throw new Error(`compile-binary: unrecognized --target "${target}" (expected e.g. bun-linux-x64)`);
  return `${m[1]}-${m[2]}`;
}

const target = parseTarget(process.argv.slice(2));
const outName = `valet-${outSuffixFor(target)}`;
const outFile = resolve(apiRoot, "dist", outName);

const outOs = outSuffixFor(target).split("-")[0];
if (outOs === "darwin" && process.platform !== "darwin") {
  throw new Error("compile-binary: macOS binaries need codesign. Compile darwin targets on a macOS host.");
}

// compile-entry.mjs loads Sharp from the extracted assets with a bare
// `require("sharp")`. Resolving a package's "main" needs its package.json.
// Bun 1.3+ compiled binaries skip package.json at runtime unless this flag is
// set; Bun 1.2 reads it by default and accepts the flag.
const args = ["build", "--compile", "--compile-autoload-package-json", entry, "--outfile", outFile];
if (target) args.push(`--target=${target}`);

const res = spawnSync("bun", args, { stdio: "inherit", cwd: apiRoot });
if (res.error) throw res.error;
if (res.status !== 0) process.exit(res.status ?? 1);

/** Run a command and exit with its status on failure. */
function run(cmd, cmdArgs) {
  const r = spawnSync(cmd, cmdArgs, { stdio: "inherit" });
  if (r.error) throw r.error;
  if (r.status !== 0) process.exit(r.status ?? 1);
}

// `bun build --compile` writes its ad-hoc signature before it finishes the
// file, so one signed page no longer matches its hash (Bun 1.2.17 and 1.3.14).
// `codesign --verify` reports "code or signature have been modified", and
// some Macs kill the binary at launch ("Killed: 9"). Sign the final bytes,
// then verify, so a bad signature fails the build instead of shipping.
if (outOs === "darwin") {
  run("codesign", ["--force", "--sign", "-", outFile]);
  run("codesign", ["--verify", "--strict", outFile]);
}

console.log(`compile-binary -> packages/api/dist/${outName}${target ? ` (target ${target})` : ""}`);
