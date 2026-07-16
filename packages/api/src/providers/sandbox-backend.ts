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
 * right behavior is "use the kubeconfig's already-selected context, or an
 * operator-pinned one via `VALET_KUBE_CONTEXT`" — never a hardcoded
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
  podExecApiAdapter,
  podLivenessApiAdapter,
  podsApiAdapter,
  type K8sProviderConfig,
} from "@valet/sandbox-kubernetes";

export const SANDBOX_BACKENDS = ["docker", "local", "kubernetes"] as const;
export type SandboxBackend = (typeof SANDBOX_BACKENDS)[number];

function isSandboxBackend(value: string): value is SandboxBackend {
  return (SANDBOX_BACKENDS as readonly string[]).includes(value);
}

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
 * (`~/.kube/config` / `$KUBECONFIG`) and, if `VALET_KUBE_CONTEXT` is set,
 * pins that context explicitly — mirroring
 * `loadRancherDesktopKubeConfig`'s "never silently ride the ambient
 * current-context" caution, but driven by an operator-supplied env var
 * instead of a hardcoded dev-cluster name. When `VALET_KUBE_CONTEXT` is
 * unset, the kubeconfig's own `current-context` is used as-is (the
 * standard kubectl default).
 */
export function resolveKubeConfig(env: NodeJS.ProcessEnv): k8s.KubeConfig {
  const kc = new k8s.KubeConfig();
  if (env.KUBERNETES_SERVICE_HOST) {
    kc.loadFromCluster();
    return kc;
  }
  kc.loadFromDefault();
  const context = env.VALET_KUBE_CONTEXT;
  if (context) {
    if (kc.getContextObject(context) === null) {
      throw new Error(`VALET_KUBE_CONTEXT="${context}" is not a configured kubectl context.`);
    }
    kc.setCurrentContext(context);
  }
  return kc;
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
        throw new Error("VALET_SANDBOX_IMAGE is required when VALET_SANDBOX_BACKEND=kubernetes.");
      }
      const kc = deps.kubeConfig ?? resolveKubeConfig(env);
      const objectsApi = customObjectsApiAdapter(kc.makeApiClient(k8s.CustomObjectsApi));
      const podsApi = podsApiAdapter(kc.makeApiClient(k8s.CoreV1Api));
      const execApi = podExecApiAdapter(new k8s.Exec(kc));
      const livenessApi = podLivenessApiAdapter(kc.makeApiClient(k8s.CoreV1Api));
      const cfg: K8sProviderConfig = {
        namespace,
        defaultImage: image,
        apiVersion: SANDBOX_CR_API_VERSION,
      };
      return new KubernetesSandboxProvider({ objectsApi, podsApi, execApi, livenessApi }, cfg);
    }
  }
}
