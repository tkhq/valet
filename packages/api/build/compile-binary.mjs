// Compiles the embedded-asset Bun wrapper (build/compile-entry.mjs) into a
// self-contained single-file `valet` binary via `bun build --compile`.
//
// Assumes the bundle (dist/valet-api.mjs) and the asset tar (dist/assets.tar)
// already exist — the `build:binary` npm script runs build:assets → build:bundle
// → make-assets-tar first. Target defaults to the host platform (cross-target
// builds are a later concern); the output is named `dist/valet-<platform>-<arch>`.
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

// e.g. valet-darwin-arm64 / valet-linux-x64
const outName = `valet-${process.platform}-${process.arch}`;
const outFile = resolve(apiRoot, "dist", outName);

const res = spawnSync(
  "bun",
  ["build", "--compile", entry, "--outfile", outFile],
  { stdio: "inherit", cwd: apiRoot },
);
if (res.error) throw res.error;
if (res.status !== 0) process.exit(res.status ?? 1);

console.log(`compile-binary -> packages/api/dist/${outName}`);
