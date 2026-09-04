/**
 * Emits `sw.js` (from the `sw.js` template beside this file) into the
 * production build with its exact asset allowlist and a hash of those paths.
 * Asset names are content-hashed, so the build id changes exactly when the
 * bundle changes. The worker's `activate` step evicts the previous build's
 * cache. Build-only: the dev server has no `sw.js` and `register.ts` skips
 * registration outside production.
 */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import type { Plugin } from "vite";

const TEMPLATE_URL = new URL("./sw.js", import.meta.url);

export function buildServiceWorkerSource(assetNames: string[]): string {
  const assetPaths = [
    ...new Set(
      assetNames.filter((name) => name.startsWith("assets/")).map((name) => `/${name}`),
    ),
  ].sort();
  const buildId = createHash("sha256")
    .update(assetPaths.join("\n"))
    .digest("hex")
    .slice(0, 12);
  return readFileSync(TEMPLATE_URL, "utf-8")
    .replaceAll("__BUILD_ID__", buildId)
    .replace("__ASSET_PATHS__", JSON.stringify(assetPaths));
}

export function valetServiceWorker(): Plugin {
  return {
    name: "valet-service-worker",
    apply: "build",
    generateBundle(_options, bundle) {
      this.emitFile({
        type: "asset",
        fileName: "sw.js",
        source: buildServiceWorkerSource(Object.keys(bundle)),
      });
    },
  };
}
