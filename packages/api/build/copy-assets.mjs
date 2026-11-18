// Copies the non-inlinable binary/large assets that must sit BESIDE the
// single-file bundle:
//   - the built web SPA  (packages/web/dist        -> dist/assets/web)
//   - PGlite's wasm/data (@electric-sql/pglite dist -> dist/assets/pglite)
//
// Text assets (.md/.sql) are NOT copied — they're inlined into the bundle by
// build/inline-assets.mjs. Run via `pnpm --filter @valet/api run build:assets`.
import { cpSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { stageSharpNative } from "./sharp-platforms.mjs";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const apiRoot = resolve(here, ".."); // packages/api
const outDir = resolve(apiRoot, "dist/assets");

// ── Web SPA ────────────────────────────────────────────────────────────────
const webDist = resolve(apiRoot, "../web/dist");
if (!existsSync(resolve(webDist, "index.html"))) {
  throw new Error(
    `copy-assets: web build missing at ${webDist}/index.html — run \`pnpm --filter @valet/web build\` first`,
  );
}
const webOut = resolve(outDir, "web");
rmSync(webOut, { recursive: true, force: true });
mkdirSync(webOut, { recursive: true });
cpSync(webDist, webOut, { recursive: true });
console.log(`copy-assets: web  -> ${webOut}`);

// ── PGlite wasm/data ─────────────────────────────────────────────────────────
// Resolve the installed package's dist dir off its own entry point rather than
// hardcoding a node_modules layout (pnpm nests under .pnpm/...).
const pgliteEntry = require.resolve("@electric-sql/pglite");
const pgliteDist = dirname(pgliteEntry);
const PGLITE_FILES = ["pglite.wasm", "pglite.data", "initdb.wasm"];
const pgliteOut = resolve(outDir, "pglite");
rmSync(pgliteOut, { recursive: true, force: true });
mkdirSync(pgliteOut, { recursive: true });
for (const f of PGLITE_FILES) {
  const src = resolve(pgliteDist, f);
  if (!existsSync(src)) {
    throw new Error(`copy-assets: expected PGlite asset missing: ${src}`);
  }
  cpSync(src, resolve(pgliteOut, f));
}
console.log(`copy-assets: pglite (${PGLITE_FILES.join(", ")}) -> ${pgliteOut}`);

// ── Sharp JS runtime ────────────────────────────────────────────────────────
// The Node bundle loads Sharp from node_modules. The standalone executable
// instead extracts Sharp beside the other assets. Only the platform-neutral
// JS packages go in dist/assets/sharp. The native addon and libvips differ per
// target, so build/sharp-platforms.mjs stages them under dist/sharp-native/
// and make-assets-tar.mjs adds the ones that match each compiled target.
const sharpEntry = require.resolve("sharp");
const sharpRequire = createRequire(sharpEntry);
const sharpRoot = resolve(outDir, "sharp");
const sharpModules = resolve(sharpRoot, "node_modules");
rmSync(sharpRoot, { recursive: true, force: true });
mkdirSync(sharpModules, { recursive: true });
cpSync(resolve(dirname(sharpEntry), ".."), resolve(sharpModules, "sharp"), { recursive: true });
for (const name of ["detect-libc", "semver", "@img/colour"]) {
  const packageJson = sharpRequire.resolve(`${name}/package.json`);
  cpSync(dirname(packageJson), resolve(sharpModules, name), { recursive: true });
}
console.log(`copy-assets: sharp JS -> ${sharpRoot}`);

// ── Sharp native packages for every supported binary target ─────────────────
await stageSharpNative(resolve(apiRoot, "dist/sharp-native"), sharpEntry);
