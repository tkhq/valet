/**
 * Runtime asset resolution for the single-binary build.
 *
 * In a bundled artifact (`VALET_BUNDLED=1`) every module's `import.meta.url`
 * collapses to the bundle's own location, so binary/large assets that can't be
 * inlined (the web SPA, PGlite's wasm/data) are shipped in a sibling
 * `dist/assets/` tree and resolved through these helpers.
 *
 * In dev / tsx (`VALET_BUNDLED` unset) these fall back to today's behavior:
 * the web dist comes from `VALET_WEB_DIST_DIR` and PGlite loads its wasm the
 * normal way (no override).
 */
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** True only in the packaged single-binary artifact. */
export function isBundled(): boolean {
  return process.env.VALET_BUNDLED === "1";
}

/**
 * Root of the sibling asset tree. `VALET_ASSET_DIR` overrides (e.g. to point a
 * bundle at assets that live elsewhere); otherwise it's `assets/` beside the
 * bundle file this module was compiled into (`dist/valet-api.mjs` →
 * `dist/assets`).
 */
export function assetBase(): string {
  return process.env.VALET_ASSET_DIR ?? join(dirname(fileURLToPath(import.meta.url)), "assets");
}

/**
 * Directory the web SPA is served from. Bundled → the sibling `assets/web`.
 * Dev → `VALET_WEB_DIST_DIR` (unchanged behavior; may be undefined, in which
 * case `mountWebStatic` no-ops and Vite serves the app instead).
 */
export function webDistPath(): string | undefined {
  if (!isBundled()) return process.env.VALET_WEB_DIST_DIR;
  return join(assetBase(), "web");
}

/**
 * Directory holding PGlite's `pglite.wasm` / `pglite.data` / `initdb.wasm`.
 * Bundled → the sibling `assets/pglite`. Dev → `undefined`, signalling that
 * PGlite should load its wasm the default way (no constructor override).
 */
export function pgliteAssetDir(): string | undefined {
  if (!isBundled()) return undefined;
  return join(assetBase(), "pglite");
}

/** PGlite constructor overrides that point it at the sibling wasm/data. */
export interface PgliteWasmOptions {
  pgliteWasmModule: WebAssembly.Module;
  initdbWasmModule: WebAssembly.Module;
  fsBundle: Blob;
}

/**
 * Build the PGlite wasm/data override options from the sibling asset dir when
 * bundled, else `undefined` (default loading). PGlite 0.5.x accepts
 * `new PGlite(dataDir, { pgliteWasmModule, initdbWasmModule, fsBundle })` — see
 * PGliteOptions in @electric-sql/pglite's types.
 */
export async function pgliteWasmOptions(): Promise<PgliteWasmOptions | undefined> {
  const dir = pgliteAssetDir();
  if (!dir) return undefined;
  const [pgliteWasm, initdbWasm, dataBytes] = await Promise.all([
    readFile(join(dir, "pglite.wasm")),
    readFile(join(dir, "initdb.wasm")),
    readFile(join(dir, "pglite.data")),
  ]);
  const [pgliteWasmModule, initdbWasmModule] = await Promise.all([
    WebAssembly.compile(pgliteWasm),
    WebAssembly.compile(initdbWasm),
  ]);
  return { pgliteWasmModule, initdbWasmModule, fsBundle: new Blob([dataBytes]) };
}
