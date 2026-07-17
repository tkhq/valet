/**
 * `VALET_IMAGE_BUILDER` selection (sandbox images v2 plan, Task 2). Mirrors
 * `sandbox-backend.ts`'s `VALET_SANDBOX_BACKEND` resolution pattern.
 *
 * Default pairing (no explicit `VALET_IMAGE_BUILDER`): `docker` sandbox
 * backend → `docker` image builder, `kubernetes` → `kubernetes`, `local` →
 * `none`. `VALET_IMAGE_BUILDER` overrides the default outright — set it to
 * `none` to disable prebuilds even when the sandbox backend is docker or
 * kubernetes.
 *
 * `resolveImageBuilder` returns `null` for `none` and for the (T5-pending)
 * `kubernetes` backend. Every caller must treat `imageBuilder: null` as
 * "prebuilds unavailable", not an error (port doc, `builder.ts`).
 */
import type { ImageBuilder } from "../prebuilds/builder.js";
import { DockerImageBuilder, type SpawnFn } from "../prebuilds/docker-builder.js";
import { parseSandboxBackend } from "./sandbox-backend.js";

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

export interface ResolveImageBuilderDeps {
  /** Injected `child_process.spawn` for the docker builder — tests
   * substitute a fake to avoid touching a real daemon. Ignored for other
   * backends. */
  spawnFn?: SpawnFn;
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
    case "kubernetes":
      // T5 (sandbox images v2 plan) fills this in with a kubernetes-native
      // builder (e.g. Kaniko/BuildKit-on-cluster job). Until then, treat it
      // the same as "unavailable" rather than throwing — a kubernetes
      // sandbox backend must still boot without prebuilds.
      return null;
    case "none":
      return null;
  }
}
