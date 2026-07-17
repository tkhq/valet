/**
 * `VALET_IMAGE_BUILDER` selection (sandbox images v2 plan, Task 2/5). Mirrors
 * `sandbox-backend.ts`'s `VALET_SANDBOX_BACKEND` resolution pattern.
 *
 * Default pairing (no explicit `VALET_IMAGE_BUILDER`): `docker` sandbox
 * backend → `docker` image builder, `kubernetes` → `kubernetes`, `local` →
 * `none`. `VALET_IMAGE_BUILDER` overrides the default outright — set it to
 * `none` to disable prebuilds even when the sandbox backend is docker or
 * kubernetes.
 *
 * `resolveImageBuilder` returns `null` for `none`. `"kubernetes"` builds a
 * `KubernetesImageBuilder` (Task 5) — see that class's docblock
 * (`../prebuilds/k8s-builder.ts`) for what it dispatches (BuildKit `batch/v1`
 * Jobs). Every caller must treat `imageBuilder: null` as "prebuilds
 * unavailable", not an error (port doc, `builder.ts`).
 */
import * as k8s from "@kubernetes/client-node";
import { batchJobsApiAdapter } from "@valet/sandbox-kubernetes";
import type { ImageBuilder } from "../prebuilds/builder.js";
import { DockerImageBuilder, type SpawnFn } from "../prebuilds/docker-builder.js";
import { KubernetesImageBuilder } from "../prebuilds/k8s-builder.js";
import { parseSandboxBackend, resolveKubeConfig } from "./sandbox-backend.js";

export const IMAGE_BUILDER_BACKENDS = ["docker", "kubernetes", "none"] as const;
export type ImageBuilderBackend = (typeof IMAGE_BUILDER_BACKENDS)[number];

function isImageBuilderBackend(value: string): value is ImageBuilderBackend {
  return (IMAGE_BUILDER_BACKENDS as readonly string[]).includes(value);
}

/** Parses `VALET_IMAGE_BUILDER`. Unset/empty → `undefined` (caller falls
 * back to the sandbox-backend-paired default). Throws on anything else
 * unrecognized. */
export function parseImageBuilderBackend(value: string | undefined): ImageBuilderBackend | undefined {
  if (value === undefined || value === "") return undefined;
  if (isImageBuilderBackend(value)) return value;
  throw new Error(
    `Invalid VALET_IMAGE_BUILDER "${value}": expected one of ${IMAGE_BUILDER_BACKENDS.join(", ")}.`,
  );
}

/** Default image-builder backend paired with a resolved sandbox backend. */
function defaultBackendFor(sandboxBackend: ReturnType<typeof parseSandboxBackend>): ImageBuilderBackend {
  switch (sandboxBackend) {
    case "docker":
      return "docker";
    case "kubernetes":
      return "kubernetes";
    case "local":
      return "none";
  }
}

/** Default bundled in-cluster registry Service DNS name — mirrors
 * `../prebuilds/service.ts`'s `DEFAULT_PREBUILD_REGISTRY_HOST` (kept as a
 * separate literal rather than an import to avoid a providers → prebuilds
 * → providers cycle; both must be bumped together if the chart's Service
 * name ever changes). */
const DEFAULT_PREBUILD_REGISTRY_HOST = "valet-registry:5000";

export interface ResolveImageBuilderDeps {
  /** Injected `child_process.spawn` for the docker builder — tests
   * substitute a fake to avoid touching a real daemon. Ignored for other
   * backends. */
  spawnFn?: SpawnFn;
  /** Injected `KubeConfig` for the kubernetes builder — mirrors
   * `BuildSandboxProviderDeps.kubeConfig` (`./sandbox-backend.ts`). Defaults
   * to `resolveKubeConfig(env)`. Ignored for other backends. */
  kubeConfig?: k8s.KubeConfig;
}

/**
 * Resolves the `ImageBuilder` for `env.VALET_IMAGE_BUILDER` (or, when
 * unset, the default paired with `env.VALET_SANDBOX_BACKEND`).
 */
export function resolveImageBuilder(
  env: NodeJS.ProcessEnv,
  deps: ResolveImageBuilderDeps = {},
): ImageBuilder | null {
  const backend = parseImageBuilderBackend(env.VALET_IMAGE_BUILDER) ?? defaultBackendFor(parseSandboxBackend(env.VALET_SANDBOX_BACKEND));
  switch (backend) {
    case "docker":
      return new DockerImageBuilder({ spawnFn: deps.spawnFn });
    case "kubernetes": {
      const namespace = env.VALET_SANDBOX_NAMESPACE ?? "valet-sandboxes";
      const kc = deps.kubeConfig ?? resolveKubeConfig(env);
      const jobsApi = batchJobsApiAdapter(kc.makeApiClient(k8s.BatchV1Api), kc.makeApiClient(k8s.CoreV1Api));
      const registryHost = env.VALET_PREBUILD_REGISTRY ?? DEFAULT_PREBUILD_REGISTRY_HOST;
      // Explicit flag (chart-injected), not inferred from the host string —
      // see the k8s-builder task brief: insecure only when the endpoint is
      // the bundled in-cluster registry, and a raw dev cluster without the
      // chart's env wiring defaults to "insecure" since the bundled
      // registry (this function's own default host above) has no TLS.
      const registryInsecure =
        env.VALET_PREBUILD_REGISTRY_INSECURE !== undefined
          ? env.VALET_PREBUILD_REGISTRY_INSECURE === "true"
          : env.VALET_PREBUILD_REGISTRY === undefined;
      const activeDeadlineSeconds = env.VALET_PREBUILD_BUILD_DEADLINE_SECONDS
        ? Number(env.VALET_PREBUILD_BUILD_DEADLINE_SECONDS)
        : undefined;
      const resources =
        env.VALET_PREBUILD_BUILD_CPU_REQUEST ||
        env.VALET_PREBUILD_BUILD_CPU_LIMIT ||
        env.VALET_PREBUILD_BUILD_MEMORY_REQUEST ||
        env.VALET_PREBUILD_BUILD_MEMORY_LIMIT
          ? {
              requests: {
                cpu: env.VALET_PREBUILD_BUILD_CPU_REQUEST,
                memory: env.VALET_PREBUILD_BUILD_MEMORY_REQUEST,
              },
              limits: {
                cpu: env.VALET_PREBUILD_BUILD_CPU_LIMIT,
                memory: env.VALET_PREBUILD_BUILD_MEMORY_LIMIT,
              },
            }
          : undefined;
      return new KubernetesImageBuilder({
        jobsApi,
        namespace,
        registryInsecure,
        ...(activeDeadlineSeconds !== undefined && !Number.isNaN(activeDeadlineSeconds) ? { activeDeadlineSeconds } : {}),
        ...(resources ? { resources } : {}),
      });
    }
    case "none":
      return null;
  }
}
