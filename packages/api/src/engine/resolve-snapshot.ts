/**
 * Thin impure gatherer that assembles a `ResolveSnapshot` from I/O sources
 * (sandbox-reconciliation plan, Task 2). Calls `resolvePrebuildImage` to check
 * for a fresh prebuild and `computeTargetDirs` to assign workspace directories,
 * then returns a fully-populated `ResolveSnapshot` for the pure
 * `computeSpec`/`specHash` pipeline.
 *
 * `baseBakeRef` is hardcoded `null` — see Task 16 (phase 4).
 */
import type { SandboxProvider } from "@valet/engine";
import type { AppDb } from "../lib/drizzle.js";
import type { ResolveSnapshot } from "./sandbox-spec.js";
import type { SessionMeta } from "./host.js";
import { resolvePrebuildImage } from "../prebuilds/resolve.js";
import type { PrebuildPreflightOpts } from "../prebuilds/registry.js";

export interface ResolveSnapshotDeps {
  db?: AppDb;
  provider: SandboxProvider;
  meta: SessionMeta;
  apiUrl: string;
  stockImage: string;
  preflight?: PrebuildPreflightOpts;
}

/**
 * Assembles the `ResolveSnapshot` inputs needed to compute a `SandboxSpec`.
 *
 * Repo bindings come from `meta.repos`; each binding already carries its
 * `targetDir` (computed once at bind time and persisted — spec decision 15).
 * When there are no bindings the `repos` array is empty.
 *
 * `repoBake` is populated from `resolvePrebuildImage`; null when no fresh
 * prebuild is available or when any failure occurs (the resolver never throws).
 *
 * `baseBakeRef` is always null — phase 4, Task 16.
 */
export async function resolveSnapshot(deps: ResolveSnapshotDeps): Promise<ResolveSnapshot> {
  const { db, provider, meta, apiUrl, stockImage, preflight } = deps;

  const repos = meta.repos ?? [];

  const prebuild = await resolvePrebuildImage(db, meta, provider, preflight);

  return {
    apiUrl,
    stockImage,
    repoBake: prebuild
      ? {
          imageRef: prebuild.imageRef,
          bakedSha: prebuild.bakedSha,
          recipe: prebuild.recipe,
          bakeId: prebuild.prebuildId,
        }
      : null,
    // phase 4 — Task 16 will populate this from an org base bake table.
    baseBakeRef: null,
    // Bindings already carry targetDir from meta (loadSessionMeta supplies it).
    repos: repos.map((binding) => ({ ...binding })),
    userName: meta.userName,
    userEmail: meta.userEmail,
  };
}
