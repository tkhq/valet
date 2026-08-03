/**
 * Build-cache bounding helpers for the docker image builder.
 *
 * After each `docker build`, call `pruneBuildCache` to keep the moby build
 * cache under the configured limit. Pruning is best-effort: a failure never
 * propagates to the caller and never fails a bake.
 *
 * `buildCachePruneArgs` is extracted and exported so the CLI shape can be
 * unit-tested without spawning anything — the same pattern as
 * `buildDockerBuildArgs` in docker-builder.ts.
 */
import type { SpawnFn } from "./docker-builder.js";

/**
 * Returns the argv for `docker builder prune` that keeps at most `capGb` GB
 * of build cache, removing the rest.
 *
 * Example: `buildCachePruneArgs(10)` →
 * `["builder","prune","-f","--keep-storage","10GB"]`
 */
export function buildCachePruneArgs(capGb: number): string[] {
  return ["builder", "prune", "-f", "--keep-storage", `${capGb}GB`];
}

/**
 * Runs `docker builder prune --keep-storage=<capGb>GB` via the supplied
 * `spawnFn`. Always resolves — a non-zero exit or a synchronous spawn throw
 * logs one line via `console.error` and resolves normally so a prune failure
 * can never fail a bake.
 */
export function pruneBuildCache(spawnFn: SpawnFn, capGb: number): Promise<void> {
  return new Promise<void>((resolve) => {
    let child;
    try {
      child = spawnFn("docker", buildCachePruneArgs(capGb), {
        stdio: ["pipe", "pipe", "pipe"],
        env: process.env,
      });
    } catch (err) {
      console.error(
        `[valet] build-cache prune failed (spawn error): ${err instanceof Error ? err.message : String(err)}`,
      );
      resolve();
      return;
    }

    child.on("error", (err) => {
      console.error(
        `[valet] build-cache prune failed (process error): ${err.message}`,
      );
      resolve();
    });

    child.on("close", (code) => {
      if (code !== 0) {
        console.error(
          `[valet] build-cache prune exited with code ${code} — cache may exceed ${capGb}GB`,
        );
      }
      resolve();
    });
  });
}
