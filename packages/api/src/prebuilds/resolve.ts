/**
 * Session-create prebuild resolution (sandbox images v2 plan, Task 4, spec
 * decisions 1/8). Given a session's assembled meta and its sandbox provider,
 * decide whether the session should boot from a prebuilt image instead of the
 * stock runtime.
 *
 * A session resolves to a prebuild when ALL of:
 *   - the provider reports `capabilities().customImage` (docker/kubernetes;
 *     local/virtual always boot the stock image and ignore any catalog ref);
 *   - the session has a PRIMARY (position-0) repo binding;
 *   - an ENABLED `prebuild_configs` row matches that binding's
 *     (orgId, host, fullName);
 *   - that config has at least one `pushed` prebuild (newest by `createdAt`).
 *
 * The newest pushed prebuild's `imageRef` becomes the sandbox image and its
 * `id` is recorded on `agent_sessions.prebuild_id` by the caller. The baked
 * commit sha + resolved recipe snapshot travel back so fetch-on-start prep
 * (`workspace-prep.ts`) can refresh the in-image repo and conditionally
 * re-run installs whose lockfiles drifted.
 *
 * PULL PREFLIGHT (kubernetes only): before committing to a resolved image ref,
 * the registry is asked (manifest HEAD, short timeout) whether the image is
 * still pullable. A down/slow registry or a pruned image yields `null` (cold
 * start) instead of booting a sandbox that then `ImagePullBackOff`s — a
 * prebuild is an optimization, never a dependency, so a broken registry must
 * degrade to cold boot, never make a session LESS available than unconfigured.
 * The docker backend skips the preflight: its images are daemon-LOCAL (no
 * registry pull), so there is no ImagePullBackOff failure mode to guard, and a
 * manifest HEAD against a registry host would be meaningless.
 *
 * NEVER throws: any failure (DB error, malformed snapshot, preflight error) is
 * logged and yields `null` — a cold-start session, never a failed session
 * build (pin).
 */
import { and, desc, eq } from "drizzle-orm";
import type { SandboxProvider } from "@valet/engine";
import type { AppDb } from "../lib/drizzle.js";
import { imageSources, bakes } from "../schema/index.js";
import type { RecipeStep } from "./recipe.js";
import { prebuildImagePullable, type PrebuildPreflightOpts } from "./registry.js";
import type { SessionMeta } from "../engine/host.js";

export interface PrebuildResolution {
  /** The prebuilt image ref to boot the sandbox from. */
  imageRef: string;
  /** `prebuilds.id` — persisted on `agent_sessions.prebuild_id`. */
  prebuildId: string;
  /** Commit the image baked the repo at (`prebuilds.commit_sha`). The
   * fetch-on-start diff keys install re-runs off `<bakedSha>..HEAD`. */
  bakedSha: string;
  /** Lockfile-detected install steps snapshotted at build time
   * (`prebuilds.recipe.recipe`). Empty when the snapshot had none or was
   * unparseable — fetch-on-start then skips conditional reinstall. */
  recipe: RecipeStep[];
}

/** Best-effort extraction of `RecipeStep[]` from the `prebuilds.recipe` jsonb
 * snapshot (`{ recipe, setup, image }`). Anything that isn't a well-formed
 * step array yields `[]` — a stale/odd snapshot degrades to "no conditional
 * reinstall", never a throw. */
function parseRecipeSteps(snapshot: unknown): RecipeStep[] {
  if (typeof snapshot !== "object" || snapshot === null) return [];
  const recipe = (snapshot as { recipe?: unknown }).recipe;
  if (!Array.isArray(recipe)) return [];
  const steps: RecipeStep[] = [];
  for (const entry of recipe) {
    if (typeof entry !== "object" || entry === null) continue;
    const { id, lockfile, command } = entry as Record<string, unknown>;
    if (typeof id === "string" && typeof lockfile === "string" && typeof command === "string") {
      steps.push({ id, lockfile, command });
    }
  }
  return steps;
}

/**
 * Resolve the prebuild (if any) a session should boot from. See the module
 * header for the full predicate. `db` absent (tests without an app db) or the
 * provider lacking `customImage` short-circuits to `null` before any query.
 */
export async function resolvePrebuildImage(
  db: AppDb | undefined,
  meta: SessionMeta,
  provider: SandboxProvider,
  preflight?: PrebuildPreflightOpts,
): Promise<PrebuildResolution | null> {
  try {
    if (!db) return null;
    if (!provider.capabilities().customImage) return null;
    const primary = meta.repos?.[0];
    if (!primary) return null;

    const host = primary.host ?? "github";
    const sourceRows = await db
      .select()
      .from(imageSources)
      .where(
        and(
          eq(imageSources.orgId, meta.orgId),
          eq(imageSources.kind, "repo"),
          eq(imageSources.repoHost, host),
          eq(imageSources.repoFullName, primary.fullName),
        ),
      )
      .limit(1);
    const source = sourceRows[0];
    if (!source || !source.enabled) return null;

    const pushedRows = await db
      .select()
      .from(bakes)
      .where(and(eq(bakes.sourceId, source.id), eq(bakes.status, "pushed")))
      .orderBy(desc(bakes.createdAt))
      .limit(1);
    const prebuild = pushedRows[0];
    if (!prebuild) return null;

    // Pull preflight (kubernetes only) — see the module header. Docker images
    // are daemon-local; skip. When no preflight config is wired (tests, or a
    // deployment that opts out), resolve as before — the preflight is a
    // safety net, its absence must never block a legitimate prebuild.
    if (provider.backend === "kubernetes" && preflight) {
      const pullable = await prebuildImagePullable(prebuild.imageRef, preflight);
      if (!pullable) {
        console.warn(
          `prebuild image ${prebuild.imageRef} failed pull preflight (registry down or image pruned) — cold-starting instead`,
        );
        return null;
      }
    }

    // `commitSha` is nullable in the `bakes` schema (kind='external'/'base'
    // bakes may omit it), but a kind='repo' bake always carries a sha. Treat
    // a missing sha as "no prebuild" — same degraded-to-cold-start contract.
    if (!prebuild.commitSha) return null;

    return {
      imageRef: prebuild.imageRef,
      prebuildId: prebuild.id,
      bakedSha: prebuild.commitSha,
      recipe: parseRecipeSteps(prebuild.recipe),
    };
  } catch (err) {
    console.error(`prebuild resolution failed for session ${meta.orgId}/${meta.repos?.[0]?.fullName ?? "?"}:`, err);
    return null;
  }
}
