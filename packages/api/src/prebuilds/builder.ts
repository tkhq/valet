import type { RecipeStep } from "./recipe.js";

/**
 * Backend-agnostic port for building and pushing/loading a prebuilt sandbox
 * image (sandbox images v2 plan, spec decision 2 — verbatim contract).
 * Implementations: `DockerImageBuilder` (this task, daemon-local store, no
 * registry — spec decision 3) and a future kubernetes builder (T5).
 *
 * `null` at boot (unresolvable backend, e.g. `local`) means "prebuilds
 * unavailable" — callers must treat an absent builder as a no-op / disabled
 * feature, not an error.
 */
export interface ImageBuilder {
  /** Identifies which implementation is wired, e.g. "docker" | "kubernetes". */
  readonly backend: string;

  /** Enqueues a build. Resolves once the build is accepted (queued or
   * started), not once it finishes — poll `status(buildId)` for progress. */
  build(spec: PrebuildSpec): Promise<{ buildId: string }>;

  /** Current state of a previously-`build()`-ed image. */
  status(buildId: string): Promise<BuildStatus>;

  /** Best-effort cancellation. Implementations that can't interrupt an
   * in-flight build may omit this. */
  cancel?(buildId: string): Promise<void>;

  /** Best-effort delete of any cluster/host resources a build for
   * `prebuildId` may have left behind, keyed by the PERSISTED prebuild ROW
   * id (`prebuilds.id`) rather than the implementation's own `buildId`. This
   * exists for the restart-recovery path: after a process restart the
   * in-memory `buildId` mapping is gone, so `PrebuildService.sweepOrphanedBuilds`
   * can only address orphaned resources by the durable row id. Implementations
   * that leave nothing durable behind (e.g. the docker builder, whose temp
   * dirs die with the process) implement this as a no-op. Must swallow
   * "not found" — a resource that was already cleaned up is not an error. */
  cleanupOrphan?(prebuildId: string): Promise<void>;
}

export interface PrebuildSpec {
  /** Caller-assigned identifier for the prebuild config this build is for. */
  configId: string;
  /** The PERSISTED `prebuilds` ROW id this build is for. Backends that name
   * durable cluster resources (the kubernetes builder's Job/Secret/ConfigMap)
   * derive their names from this so an interrupted build's resources can be
   * cleaned up by row id after a restart — see `ImageBuilder.cleanupOrphan`. */
  prebuildId: string;
  cloneUrl: string;
  commitSha: string;
  baseImage: string;
  recipe: RecipeStep[];
  /** Extra setup commands from a `.valet/prebuild.yaml` override, run after
   * `recipe` steps. */
  setup?: string[];
  /** Fully-qualified image tag the builder must produce. Naming (including
   * the `valet-prebuild/<repo-slug>:<sha>` convention) is owned by the
   * caller/service layer, not the builder. */
  imageRef: string;
  /** Git token for cloning private repos, passed to the build as a
   * BuildKit secret — never written to argv or an image layer. */
  gitToken?: string;
}

/** `"pushed"` is the terminal success state even for backends with no
 * registry (docker-no-registry): it means "image available", not
 * necessarily "pushed to a registry". */
export interface BuildStatus {
  state: "queued" | "building" | "pushed" | "failed";
  logTail?: string;
  error?: string;
}
