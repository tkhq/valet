/**
 * `VALET_SANDBOX_BACKEND` selection (kubernetes-deployment plan Task 6,
 * spec decision 7 of `docs/specs/2026-07-15-kubernetes-deployment-design.md`).
 *
 * `docker` (default, unchanged behavior) → `DockerSandboxProvider`.
 * `local` → `LocalSandboxProvider` (dev/test, no isolation).
 * `kubernetes` → `KubernetesSandboxProvider`, wired from env.
 *
 * ── Context safety (decision 2, BINDING) ────────────────────────────────
 * `@valet/sandbox-kubernetes`'s own `loadRancherDesktopKubeConfig` is
 * test-only — scoped to that package's live-cluster test suite, which pins
 * a specific local dev context on purpose. This module must NOT reuse it:
 * the api process runs either (a) IN-CLUSTER as a pod, where the only
 * correct credential source is the mounted service-account
 * (`KubeConfig.loadFromCluster()`), or (b) out-of-cluster in dev, where the
 * context MUST be named explicitly via `VALET_KUBE_CONTEXT` — we never ride
 * the ambient current-context (decision 2, binding) and never hardcode a
 * personal dev-cluster name.
 */
import * as k8s from "@kubernetes/client-node";
import type { SandboxProvider } from "@valet/engine";
import { DockerSandboxProvider } from "@valet/sandbox-docker";
import { LocalSandboxProvider } from "@valet/sandbox-local";
import {
  KubernetesSandboxProvider,
  SANDBOX_CR_API_VERSION,
  customObjectsApiAdapter,
  podDeleteApiAdapter,
  podExecApiAdapter,
  podLivenessApiAdapter,
  podStatusApiAdapter,
  podsApiAdapter,
  sandboxSecretsApiAdapter,
  type K8sProviderConfig,
} from "@valet/sandbox-kubernetes";

export const SANDBOX_BACKENDS = ["docker", "local", "kubernetes"] as const;
export type SandboxBackend = (typeof SANDBOX_BACKENDS)[number];

function isSandboxBackend(value: string): value is SandboxBackend {
  return (SANDBOX_BACKENDS as readonly string[]).includes(value);
}

/** Default CI-published sandbox base image — the SINGLE image lineage every
 * sandbox and bake chains on (agent tooling, gateway, ttyd, code-server,
 * rootless docker toolchain, start scripts). Overridden by
 * VALET_FULL_BASE_IMAGE env var. */
export const DEFAULT_FULL_BASE_IMAGE = "ghcr.io/tkhq/valet-sandbox:latest";

/** Parses `VALET_SANDBOX_BACKEND`. Unset → `"docker"` (today's only
 * behavior, unchanged). Throws a clear error on anything else unrecognized. */
export function parseSandboxBackend(value: string | undefined): SandboxBackend {
  if (value === undefined || value === "") return "docker";
  if (isSandboxBackend(value)) return value;
  throw new Error(
    `Invalid VALET_SANDBOX_BACKEND "${value}": expected one of ${SANDBOX_BACKENDS.join(", ")}.`,
  );
}

/**
 * Resolves the `KubeConfig` the kubernetes sandbox provider is built from.
 *
 * IN-CLUSTER (api runs as a pod — `KUBERNETES_SERVICE_HOST` is set by
 * kubelet on every pod): loads the mounted service-account credentials via
 * `loadFromCluster()`.
 *
 * OUT-OF-CLUSTER (dev, or any host process): loads the default kubeconfig
 * (`~/.kube/config` / `$KUBECONFIG`) and pins the context named by
 * `VALET_KUBE_CONTEXT`, which is **REQUIRED** in this mode. Decision 2 is
 * binding: "nothing ever operates on the ambient current-context." A
 * developer's ambient `current-context` is routinely a production cluster
 * (on the reference machine it is a prod GKE cluster), so silently riding
 * it would create/destroy sandbox pods in production the moment someone
 * runs the api locally with `VALET_SANDBOX_BACKEND=kubernetes` and forgets
 * to pin a context. We therefore refuse to guess — out-of-cluster callers
 * must name the context explicitly. In-cluster there is no ambient-context
 * hazard (the only credential is the pod's own service account).
 */
export function resolveKubeConfig(env: NodeJS.ProcessEnv): k8s.KubeConfig {
  const kc = new k8s.KubeConfig();
  if (env.KUBERNETES_SERVICE_HOST) {
    kc.loadFromCluster();
    return kc;
  }
  kc.loadFromDefault();
  const context = env.VALET_KUBE_CONTEXT;
  if (!context) {
    throw new Error(
      "VALET_KUBE_CONTEXT is required when VALET_SANDBOX_BACKEND=kubernetes and the api runs out-of-cluster. " +
        "Refusing to use the ambient kubectl current-context (it may point at a production cluster). " +
        "Set VALET_KUBE_CONTEXT to the intended context, or run the api in-cluster.",
    );
  }
  if (kc.getContextObject(context) === null) {
    throw new Error(`VALET_KUBE_CONTEXT="${context}" is not a configured kubectl context.`);
  }
  kc.setCurrentContext(context);
  return kc;
}

/**
 * Resolves `EngineHostOpts.defaultImage` from `VALET_SANDBOX_IMAGE` — the
 * seam that lets it reach `SandboxCreateOpts.image` (`EngineHost` threads
 * `opts.defaultImage` into every `sandbox: {..., image, ...}` it builds,
 * and `DockerSandboxProvider.create` falls back to its own
 * `node:20-bookworm` default whenever `opts.image` is unset — so without
 * this, `VALET_SANDBOX_IMAGE` was read for the kubernetes backend only and
 * silently ignored for docker).
 *
 * Wiring it unconditionally (not just for the docker backend) is harmless
 * for kubernetes: `buildSandboxProvider`'s kubernetes branch already reads
 * the same env var into `K8sProviderConfig.defaultImage`, and
 * `KubernetesSandboxProvider.create` prefers an explicit `opts.image` over
 * `cfg.defaultImage` when both are set — they're always equal here, so the
 * resolved image never changes.
 */
export function resolveDefaultImage(env: NodeJS.ProcessEnv): string | undefined {
  return env.VALET_SANDBOX_IMAGE;
}

/**
 * Resolves `EngineHostOpts.idleMinutes` from `VALET_SANDBOX_IDLE_MINUTES`
 * (sandbox hibernation plan, Task 3). Unset → `30` (the default idle
 * window). `0`, negative, or non-numeric → `0`, which `EngineHost` reads as
 * "idle sweep disabled" — it only starts the sweep interval when
 * `idleMinutes > 0` AND the sandbox provider reports
 * `capabilities().hibernation === true`.
 */
export function resolveIdleMinutes(env: NodeJS.ProcessEnv): number {
  const raw = env.VALET_SANDBOX_IDLE_MINUTES;
  if (raw === undefined || raw === "") return 30;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n;
}

/**
 * Retention window for a settled child's suspended sandbox
 * (`VALET_CHILD_SANDBOX_RETENTION_HOURS`, default 72). `0`, a negative
 * number, or a non-number disables retention: settled children get the
 * eager destroy-on-settle. Only consulted on hibernation-capable backends —
 * elsewhere the child watcher never parks in the first place.
 */
export function resolveChildRetentionMs(env: NodeJS.ProcessEnv): number {
  const raw = env.VALET_CHILD_SANDBOX_RETENTION_HOURS;
  if (raw === undefined || raw === "") return 72 * 3_600_000;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n * 3_600_000;
}

/**
 * How long a session may sit `hibernated` before the reaper
 * (`engine/hibernation-reaper.ts`) destroys its sandbox
 * (`VALET_SANDBOX_HIBERNATED_RETENTION_MINUTES`, default 72h). The default
 * outlasts a weekend: reaping only resets the workspace volume (chat
 * history and memories live in postgres), but a Monday-morning user should
 * still find Friday's uncommitted work. Zero, negative, or non-numeric
 * disables the reaper entirely.
 */
export function resolveHibernatedRetentionMs(env: NodeJS.ProcessEnv): number {
  const raw = env.VALET_SANDBOX_HIBERNATED_RETENTION_MINUTES;
  if (raw === undefined || raw === "") return 72 * 60 * 60_000;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n * 60_000;
}

export interface BuildSandboxProviderDeps {
  /**
   * Injected `KubeConfig` for the `kubernetes` backend. Tests supply a
   * fake-but-valid config (e.g. `loadFromOptions` with a dummy cluster) to
   * exercise provider construction without touching
   * `resolveKubeConfig`/real cluster credentials. Ignored for other
   * backends. Defaults to `resolveKubeConfig(env)`.
   */
  kubeConfig?: k8s.KubeConfig;
}

/**
 * Builds the `SandboxProvider` for `env.VALET_SANDBOX_BACKEND` (default
 * `"docker"`, identical to the pre-Task-6 unconditional
 * `new DockerSandboxProvider()`).
 */
export function buildSandboxProvider(
  env: NodeJS.ProcessEnv,
  deps: BuildSandboxProviderDeps = {},
): SandboxProvider {
  const backend = parseSandboxBackend(env.VALET_SANDBOX_BACKEND);
  switch (backend) {
    case "docker":
      return new DockerSandboxProvider();
    case "local":
      return new LocalSandboxProvider();
    case "kubernetes": {
      const namespace = env.VALET_SANDBOX_NAMESPACE ?? "valet-sandboxes";
      const image = env.VALET_SANDBOX_IMAGE;
      if (!image) {
        console.warn(
          "VALET_SANDBOX_IMAGE unset; falling back to seeded base sources. " +
          "Set VALET_FULL_BASE_IMAGE via chart values if you need to override.",
        );
      }
      const kc = deps.kubeConfig ?? resolveKubeConfig(env);
      const coreApi = kc.makeApiClient(k8s.CoreV1Api);
      const objectsApi = customObjectsApiAdapter(kc.makeApiClient(k8s.CustomObjectsApi));
      const podsApi = podsApiAdapter(coreApi);
      const execApi = podExecApiAdapter(new k8s.Exec(kc));
      const livenessApi = podLivenessApiAdapter(coreApi);
      const podStatusApi = podStatusApiAdapter(coreApi);
      const podDeleteApi = podDeleteApiAdapter(coreApi);
      const pullSecret = env.VALET_SANDBOX_IMAGE_PULL_SECRET;
      const cfg: K8sProviderConfig = {
        namespace,
        defaultImage: image ?? env.VALET_FULL_BASE_IMAGE ?? DEFAULT_FULL_BASE_IMAGE,
        apiVersion: SANDBOX_CR_API_VERSION,
        // Sandbox images v2 plan, Task 5: threaded when an external prebuild
        // registry requires authenticated pulls (`externalRegistry.pullSecret`
        // in the chart). Omitted (undefined, not []) for the bundled registry
        // — nothing to authenticate against an in-cluster insecure registry.
        ...(pullSecret ? { imagePullSecrets: [{ name: pullSecret }] } : {}),
        // RuntimeClass for docker-enabled sandboxes: a containerd runtime
        // with cgroup_writable=true, required for `docker run` to work in
        // hostUsers:false pods (K8sProviderConfig docblock has the story).
        ...(env.VALET_SANDBOX_DOCKER_RUNTIME_CLASS
          ? { dockerRuntimeClassName: env.VALET_SANDBOX_DOCKER_RUNTIME_CLASS }
          : {}),
      };
      const secretsApi = sandboxSecretsApiAdapter(coreApi);
      return new KubernetesSandboxProvider({ objectsApi, podsApi, execApi, livenessApi, podStatusApi, podDeleteApi, secretsApi }, cfg);
    }
  }
}
