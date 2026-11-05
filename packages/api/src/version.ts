import { readFileSync } from "node:fs";
import { join } from "node:path";
import bundledRelease from "./changelog/release.json";

/**
 * The CLI/product version. Kept as a literal in sync with
 * `packages/api/package.json` `version` (pre-1.0 this is fine; a later task
 * can bake it from package.json at build time if we want). Consumed by the
 * dispatcher's `--version` handler and any command that reports the version.
 */
export const VALET_VERSION = "0.0.1";

let cachedBuild: string | null | undefined;

/** This server's source commit. Uses the same sources as the changelog
 * (`VALET_RELEASE_SHA`, then the `release.json` that CI writes into the
 * image), then a `BUILD_SHA` file in the working directory for deploys that
 * build on the host. Undefined for a local checkout. */
export function valetBuildSha(): string | undefined {
  if (cachedBuild !== undefined) return cachedBuild ?? undefined;
  let sha = process.env.VALET_RELEASE_SHA?.trim() || bundledRelease.sha || undefined;
  if (!sha) {
    try { sha = readFileSync(join(process.cwd(), "BUILD_SHA"), "utf8").trim(); }
    catch { sha = undefined; }
  }
  cachedBuild = sha && /^[0-9a-f]{7,64}$/i.test(sha) ? sha.toLowerCase() : null;
  return cachedBuild ?? undefined;
}
