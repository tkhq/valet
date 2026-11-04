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
import type { V1Toleration } from "@kubernetes/client-node";
import { batchJobsApiAdapter } from "@valet/sandbox-kubernetes";
import type { ImageBuilder } from "../prebuilds/builder.js";
import type { PrebuildPreflightOpts } from "../prebuilds/registry.js";
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const LABEL_NAME = /^[A-Za-z0-9]([-A-Za-z0-9_.]{0,61}[A-Za-z0-9])?$/;
const DNS_SUBDOMAIN = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/;

/** A Kubernetes label key: an optional DNS-subdomain prefix (at most 253
 * characters) and `/`, then a name of at most 63 characters. Kubernetes
 * rejects any other key when it admits the Job, so check it at boot. */
export function isLabelKey(key: string): boolean {
  const slash = key.lastIndexOf("/");
  const name = slash === -1 ? key : key.slice(slash + 1);
  const prefix = slash === -1 ? undefined : key.slice(0, slash);
  if (prefix !== undefined && (prefix.length === 0 || prefix.length > 253 || !DNS_SUBDOMAIN.test(prefix))) return false;
  return LABEL_NAME.test(name);
}

/** A Kubernetes label value: empty, or a name of at most 63 characters. */
export function isLabelValue(value: string): boolean {
  return value === "" || LABEL_NAME.test(value);
}

/**
 * Parses `VALET_PREBUILD_BUILD_NODE_SELECTOR`: a JSON object of string
 * values, or `key=value` pairs separated by commas. Unset or empty returns
 * undefined (no selector). Throws at boot on any other shape.
 */
export function parseBuildNodeSelector(value: string | undefined): Record<string, string> | undefined {
  const raw = value?.trim();
  if (!raw) return undefined;
  const fail = (detail: string): never => {
    throw new Error(
      `Invalid VALET_PREBUILD_BUILD_NODE_SELECTOR: ${detail}. Set it to a JSON object such as {"pool":"builds"} or to key=value pairs such as pool=builds,zone=a.`,
    );
  };
  const out: Record<string, string> = {};
  if (raw.startsWith("{") || raw.startsWith("[")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return fail("the value is not valid JSON");
    }
    if (!isRecord(parsed)) return fail("the JSON value is not an object");
    for (const [key, entry] of Object.entries(parsed)) {
      if (typeof entry !== "string") return fail(`the value for "${key}" is not a string`);
      out[key] = entry;
    }
  } else {
    for (const pair of raw.split(",")) {
      const eq = pair.indexOf("=");
      if (eq < 0) return fail(`"${pair.trim()}" has no "="`);
      out[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
    }
  }
  for (const [key, label] of Object.entries(out)) {
    if (!isLabelKey(key)) return fail(`"${key}" is not a valid Kubernetes label key`);
    if (!isLabelValue(label)) return fail(`"${label}" (for "${key}") is not a valid Kubernetes label value`);
  }
  if (Object.keys(out).length === 0) return fail("the object has no labels");
  return out;
}

const TOLERATION_FIELDS = new Set(["key", "operator", "value", "effect", "tolerationSeconds"]);
const TOLERATION_OPERATORS = new Set(["Exists", "Equal"]);
const TOLERATION_EFFECTS = new Set(["NoSchedule", "PreferNoSchedule", "NoExecute"]);

/**
 * Parses `VALET_PREBUILD_BUILD_TOLERATIONS`: a JSON array of Kubernetes
 * tolerations. Unset or empty returns undefined (no tolerations). Throws at
 * boot on an unknown field, operator, or effect, so a typo does not
 * silently leave builds off the tainted build pool.
 */
export function parseBuildTolerations(value: string | undefined): V1Toleration[] | undefined {
  const raw = value?.trim();
  if (!raw) return undefined;
  const fail = (detail: string): never => {
    throw new Error(
      `Invalid VALET_PREBUILD_BUILD_TOLERATIONS: ${detail}. Set it to a JSON array such as [{"key":"valet.dev/build","operator":"Exists","effect":"NoSchedule"}].`,
    );
  };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return fail("the value is not valid JSON");
  }
  if (!Array.isArray(parsed)) return fail("the JSON value is not an array");
  return parsed.map((entry, index) => {
    if (!isRecord(entry)) return fail(`entry ${index} is not an object`);
    for (const field of Object.keys(entry)) {
      if (!TOLERATION_FIELDS.has(field)) return fail(`entry ${index} has the unknown field "${field}"`);
    }
    const toleration: V1Toleration = {};
    for (const field of ["key", "value"] as const) {
      const fieldValue = entry[field];
      if (fieldValue === undefined) continue;
      if (typeof fieldValue !== "string") return fail(`entry ${index} field "${field}" is not a string`);
      toleration[field] = fieldValue;
    }
    if (entry.operator !== undefined) {
      if (typeof entry.operator !== "string" || !TOLERATION_OPERATORS.has(entry.operator)) {
        return fail(`entry ${index} operator must be "Exists" or "Equal"`);
      }
      toleration.operator = entry.operator;
    }
    if (entry.effect !== undefined) {
      if (typeof entry.effect !== "string" || !TOLERATION_EFFECTS.has(entry.effect)) {
        return fail(`entry ${index} effect must be "NoSchedule", "PreferNoSchedule", or "NoExecute"`);
      }
      toleration.effect = entry.effect;
    }
    if (entry.tolerationSeconds !== undefined) {
      if (typeof entry.tolerationSeconds !== "number" || !Number.isInteger(entry.tolerationSeconds) || entry.tolerationSeconds < 0) {
        return fail(`entry ${index} tolerationSeconds is not a non-negative integer`);
      }
      toleration.tolerationSeconds = entry.tolerationSeconds;
    }
    if (toleration.key !== undefined && !isLabelKey(toleration.key)) {
      return fail(`entry ${index} key "${toleration.key}" is not a valid Kubernetes label key`);
    }
    if (toleration.value !== undefined && !isLabelValue(toleration.value)) {
      return fail(`entry ${index} value "${toleration.value}" is not a valid Kubernetes label value`);
    }
    // An empty key matches every taint, which Kubernetes allows only with
    // operator Exists. An omitted operator means Equal.
    if (!toleration.key && toleration.operator !== "Exists") {
      return fail(`entry ${index} has no key, which needs operator "Exists"`);
    }
    if (toleration.tolerationSeconds !== undefined && toleration.effect !== "NoExecute") {
      return fail(`entry ${index} sets tolerationSeconds without effect "NoExecute"`);
    }
    if (toleration.operator === "Exists" && toleration.value !== undefined) {
      return fail(`entry ${index} sets a value with operator "Exists"`);
    }
    return toleration;
  });
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
    case "docker": {
      const raw = Number(env.VALET_PREBUILD_BUILD_CACHE_GB);
      // Guard: Number("") === 0 and Number(undefined) === NaN; an explicit "0"
      // would prune ALL cache on every bake (the opposite of the goal). Any
      // non-positive or non-finite value falls back to the 10 GB default.
      const buildCacheCapGb = Number.isFinite(raw) && raw > 0 ? raw : 10;
      return new DockerImageBuilder({
        spawnFn: deps.spawnFn,
        buildCacheCapGb,
      });
    }
    case "kubernetes": {
      const namespace = env.VALET_SANDBOX_NAMESPACE ?? "valet-sandboxes";
      const kc = deps.kubeConfig ?? resolveKubeConfig(env);
      const jobsApi = batchJobsApiAdapter(kc.makeApiClient(k8s.BatchV1Api), kc.makeApiClient(k8s.CoreV1Api));
      // PUSH host BuildKit reaches the registry at (in-cluster Service DNS),
      // distinct from the PULL host (`VALET_PREBUILD_REGISTRY`) that lands on
      // image refs + sandbox pod images. Unset = no split (push == pull host):
      // external registry, or a raw dev cluster without the chart's wiring.
      const registryPushHost = env.VALET_PREBUILD_REGISTRY_PUSH || undefined;
      // PULL host (host segment of VALET_PREBUILD_REGISTRY) — identifies the
      // bundled-registry refs the builder may rewrite to the push host; an
      // external base ref must never be rewritten even if it happens to
      // share a host with the output ref.
      const registryPullHost = env.VALET_PREBUILD_REGISTRY
        ? env.VALET_PREBUILD_REGISTRY.split("/")[0]
        : undefined;
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
      // Bakes run untrusted setup commands. These place build pods on an
      // isolated, tainted node pool; unset keeps the scheduler's choice.
      const nodeSelector = parseBuildNodeSelector(env.VALET_PREBUILD_BUILD_NODE_SELECTOR);
      const tolerations = parseBuildTolerations(env.VALET_PREBUILD_BUILD_TOLERATIONS);
      return new KubernetesImageBuilder({
        jobsApi,
        namespace,
        registryInsecure,
        ...(registryPushHost ? { registryPushHost } : {}),
        ...(registryPullHost ? { registryPullHost } : {}),
        ...(activeDeadlineSeconds !== undefined && !Number.isNaN(activeDeadlineSeconds) ? { activeDeadlineSeconds } : {}),
        ...(resources ? { resources } : {}),
        ...(nodeSelector ? { nodeSelector } : {}),
        ...(tolerations ? { tolerations } : {}),
      });
    }
    case "none":
      return null;
  }
}

/**
 * Registry pull-preflight config for `resolvePrebuildImage` (sandbox images v2
 * final-review Fix 3). Returns `undefined` for any non-kubernetes sandbox
 * backend (docker images are daemon-local — no registry pull, nothing to
 * preflight). For kubernetes, mirrors `resolveImageBuilder`'s own registry env
 * resolution (`VALET_PREBUILD_REGISTRY_INSECURE`, `VALET_PREBUILD_REGISTRY_PUSH`)
 * so the preflight HEADs the SAME registry, over the SAME in-cluster PUSH host,
 * with the SAME scheme the builder pushed with.
 */
export function resolvePrebuildPreflight(env: NodeJS.ProcessEnv): PrebuildPreflightOpts | undefined {
  if (parseSandboxBackend(env.VALET_SANDBOX_BACKEND) !== "kubernetes") return undefined;
  const registryInsecure =
    env.VALET_PREBUILD_REGISTRY_INSECURE !== undefined
      ? env.VALET_PREBUILD_REGISTRY_INSECURE === "true"
      : env.VALET_PREBUILD_REGISTRY === undefined;
  const registryPushHost = env.VALET_PREBUILD_REGISTRY_PUSH || undefined;
  return { registryInsecure, ...(registryPushHost ? { registryPushHost } : {}) };
}
