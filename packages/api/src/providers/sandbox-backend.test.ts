/**
 * Selection-logic tests for Task 6 (kubernetes-deployment plan) —
 * `VALET_SANDBOX_BACKEND`'s docker/local/kubernetes/invalid branches.
 * No cluster required: the `kubernetes` case injects a fake-but-structurally
 * -valid `KubeConfig` (`loadFromOptions` against a dummy cluster) so
 * `KubernetesSandboxProvider` construction succeeds without ever making a
 * network call — `buildSandboxProvider` only *constructs* the provider
 * here, it never invokes any of its methods.
 */
import { describe, it, expect } from "vitest";
import * as k8s from "@kubernetes/client-node";
import { DockerSandboxProvider } from "@valet/sandbox-docker";
import { LocalSandboxProvider } from "@valet/sandbox-local";
import { KubernetesSandboxProvider } from "@valet/sandbox-kubernetes";
import { buildSandboxProvider, parseSandboxBackend, resolveKubeConfig } from "./sandbox-backend.js";

function fakeKubeConfig(): k8s.KubeConfig {
  const kc = new k8s.KubeConfig();
  kc.loadFromOptions({
    clusters: [{ name: "test-cluster", server: "https://example.invalid", skipTLSVerify: true }],
    users: [{ name: "test-user" }],
    contexts: [{ name: "test-context", cluster: "test-cluster", user: "test-user" }],
    currentContext: "test-context",
  });
  return kc;
}

describe("parseSandboxBackend", () => {
  it("defaults to docker when unset", () => {
    expect(parseSandboxBackend(undefined)).toBe("docker");
    expect(parseSandboxBackend("")).toBe("docker");
  });

  it("accepts docker/local/kubernetes", () => {
    expect(parseSandboxBackend("docker")).toBe("docker");
    expect(parseSandboxBackend("local")).toBe("local");
    expect(parseSandboxBackend("kubernetes")).toBe("kubernetes");
  });

  it("throws a clear error on an invalid value", () => {
    expect(() => parseSandboxBackend("modal")).toThrow(
      /Invalid VALET_SANDBOX_BACKEND "modal": expected one of docker, local, kubernetes/,
    );
  });
});

describe("buildSandboxProvider", () => {
  it("builds a DockerSandboxProvider when VALET_SANDBOX_BACKEND is unset", () => {
    const provider = buildSandboxProvider({});
    expect(provider).toBeInstanceOf(DockerSandboxProvider);
    expect(provider.backend).toBe("docker");
  });

  it("builds a DockerSandboxProvider when VALET_SANDBOX_BACKEND=docker", () => {
    const provider = buildSandboxProvider({ VALET_SANDBOX_BACKEND: "docker" });
    expect(provider).toBeInstanceOf(DockerSandboxProvider);
  });

  it("builds a LocalSandboxProvider when VALET_SANDBOX_BACKEND=local", () => {
    const provider = buildSandboxProvider({ VALET_SANDBOX_BACKEND: "local" });
    expect(provider).toBeInstanceOf(LocalSandboxProvider);
    expect(provider.backend).toBe("local");
  });

  it("builds a KubernetesSandboxProvider from env, using an injected KubeConfig", () => {
    const provider = buildSandboxProvider(
      {
        VALET_SANDBOX_BACKEND: "kubernetes",
        VALET_SANDBOX_NAMESPACE: "custom-namespace",
        VALET_SANDBOX_IMAGE: "ghcr.io/example/sandbox:latest",
      },
      { kubeConfig: fakeKubeConfig() },
    );
    expect(provider).toBeInstanceOf(KubernetesSandboxProvider);
    expect(provider.backend).toBe("kubernetes");
  });

  it("defaults the kubernetes namespace when VALET_SANDBOX_NAMESPACE is unset", () => {
    // Construction succeeding (no throw) is the assertion here — the
    // namespace/image aren't otherwise observable from outside the
    // provider without a live cluster round-trip, so this just proves the
    // default-namespace path doesn't require VALET_SANDBOX_NAMESPACE.
    expect(() =>
      buildSandboxProvider(
        { VALET_SANDBOX_BACKEND: "kubernetes", VALET_SANDBOX_IMAGE: "ghcr.io/example/sandbox:latest" },
        { kubeConfig: fakeKubeConfig() },
      ),
    ).not.toThrow();
  });

  it("throws when VALET_SANDBOX_BACKEND=kubernetes and VALET_SANDBOX_IMAGE is unset", () => {
    expect(() =>
      buildSandboxProvider({ VALET_SANDBOX_BACKEND: "kubernetes" }, { kubeConfig: fakeKubeConfig() }),
    ).toThrow(/VALET_SANDBOX_IMAGE is required/);
  });

  it("throws a clear error for an unrecognized backend", () => {
    expect(() => buildSandboxProvider({ VALET_SANDBOX_BACKEND: "ec2" })).toThrow(
      /Invalid VALET_SANDBOX_BACKEND "ec2"/,
    );
  });
});

describe("resolveKubeConfig", () => {
  it("takes the in-cluster branch when KUBERNETES_SERVICE_HOST is set", () => {
    // `loadFromCluster()` doesn't validate the mounted service-account
    // files exist (that's deferred to actual request time) — it just
    // synthesizes a cluster entry named "inCluster" pointing at
    // `/var/run/secrets/kubernetes.io/serviceaccount/...` and the
    // `KUBERNETES_SERVICE_HOST`/`_PORT` env pair. Asserting that shape is
    // present is the proof `resolveKubeConfig` took the in-cluster branch
    // rather than `loadFromDefault()` (whose cluster names come from the
    // ambient kubeconfig file, never "inCluster").
    const kc = resolveKubeConfig({ KUBERNETES_SERVICE_HOST: "10.0.0.1", KUBERNETES_SERVICE_PORT: "443" });
    expect(kc.getClusters().map((c) => c.name)).toContain("inCluster");
  });

  it("pins VALET_KUBE_CONTEXT when out-of-cluster and the context exists", () => {
    // loadFromDefault() reads the real ambient kubeconfig on this machine;
    // skip if none is configured (CI/sandbox without a kubeconfig file).
    const probe = new k8s.KubeConfig();
    try {
      probe.loadFromDefault();
    } catch {
      return;
    }
    const contexts = probe.getContexts();
    if (contexts.length === 0) return;
    const [{ name }] = contexts;
    const kc = resolveKubeConfig({ VALET_KUBE_CONTEXT: name });
    expect(kc.getCurrentContext()).toBe(name);
  });

  it("throws when VALET_KUBE_CONTEXT names a context that doesn't exist", () => {
    const probe = new k8s.KubeConfig();
    try {
      probe.loadFromDefault();
    } catch {
      return;
    }
    expect(() => resolveKubeConfig({ VALET_KUBE_CONTEXT: "definitely-not-a-real-context-xyz" })).toThrow(
      /VALET_KUBE_CONTEXT="definitely-not-a-real-context-xyz" is not a configured kubectl context/,
    );
  });

  it("REFUSES the ambient current-context out-of-cluster (decision 2): throws when VALET_KUBE_CONTEXT is unset", () => {
    // The whole point: a dev machine's ambient current-context is routinely
    // a production cluster. Out-of-cluster + backend=kubernetes with no
    // pinned context must throw, never silently target prod. No env vars →
    // not in-cluster (KUBERNETES_SERVICE_HOST absent), no pinned context.
    expect(() => resolveKubeConfig({})).toThrow(/VALET_KUBE_CONTEXT is required/);
  });
});
