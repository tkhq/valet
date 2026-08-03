/**
 * Thin impure gatherer that assembles a `ResolveSnapshot` from I/O sources
 * (sandbox-reconciliation plan, Task 2). Calls `resolvePrebuildImage` to check
 * for a fresh prebuild, `resolveBaseImage` to find the org's base bake, and
 * returns a fully-populated `ResolveSnapshot` for the pure
 * `computeSpec`/`specHash` pipeline.
 */
import { and, desc, eq } from "drizzle-orm";
import type { SandboxProvider } from "@valet/engine";
import type { AppDb } from "../lib/drizzle.js";
import type { ResolveSnapshot } from "./sandbox-spec.js";
import type { SessionMeta } from "./host.js";
import { resolvePrebuildImage } from "../prebuilds/resolve.js";
import { prebuildImagePullable, type PrebuildPreflightOpts } from "../prebuilds/registry.js";
import { imageSources, bakes } from "../schema/index.js";

export interface ResolveSnapshotDeps {
  db?: AppDb;
  provider: SandboxProvider;
  meta: SessionMeta;
  apiUrl: string;
  stockImage: string;
  preflight?: PrebuildPreflightOpts;
}

/**
 * Resolves the org's base image ref from the kind='base' source's newest
 * pushed bake. Returns null when: no base source exists, no pushed bake,
 * the source is disabled, or the kubernetes pull preflight fails.
 *
 * Follows the same degradation contract as `resolvePrebuildImage`: a broken
 * registry or missing base bake must degrade to null (stock), never brick
 * provisioning. Never throws.
 */
async function resolveBaseImage(
  db: AppDb,
  orgId: string,
  provider: SandboxProvider,
  preflight?: PrebuildPreflightOpts,
): Promise<string | null> {
  try {
    if (!provider.capabilities().customImage) return null;

    const sourceRows = await db
      .select()
      .from(imageSources)
      .where(and(eq(imageSources.orgId, orgId), eq(imageSources.kind, "base")))
      .limit(1);
    const source = sourceRows[0];
    if (!source || !source.enabled) return null;

    const bakeRows = await db
      .select()
      .from(bakes)
      .where(and(eq(bakes.sourceId, source.id), eq(bakes.status, "pushed")))
      .orderBy(desc(bakes.createdAt))
      .limit(1);
    const bake = bakeRows[0];
    if (!bake) return null;

    // Pull preflight (kubernetes only) — mirrors the repo-bake preflight in
    // `resolvePrebuildImage`. A down/slow registry or pruned image degrades to
    // null (stock), never blocks provisioning.
    if (provider.backend === "kubernetes" && preflight) {
      const pullable = await prebuildImagePullable(bake.imageRef, preflight);
      if (!pullable) {
        console.warn(
          `base bake image ${bake.imageRef} failed pull preflight (registry down or image pruned) — falling back to stock image`,
        );
        return null;
      }
    }

    return bake.imageRef;
  } catch (err) {
    console.error(`base image resolution failed for org ${orgId}:`, err);
    return null;
  }
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
 * `baseBakeRef` is populated from the org's kind='base' source's newest pushed
 * bake; null when: no base source, no pushed bake, source disabled, or k8s
 * pull preflight fails. An unpullable base ref degrades to null (stock), never
 * bricks provisioning.
 */
export async function resolveSnapshot(deps: ResolveSnapshotDeps): Promise<ResolveSnapshot> {
  const { db, provider, meta, apiUrl, stockImage, preflight } = deps;

  const repos = meta.repos ?? [];

  const [prebuild, baseBakeRef] = await Promise.all([
    resolvePrebuildImage(db, meta, provider, preflight),
    db ? resolveBaseImage(db, meta.orgId, provider, preflight) : Promise.resolve(null),
  ]);

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
    baseBakeRef,
    // Bindings already carry targetDir from meta (loadSessionMeta supplies it).
    repos: repos.map((binding) => ({ ...binding })),
    userName: meta.userName,
    userEmail: meta.userEmail,
  };
}
