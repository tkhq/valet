import { describe, expect, it } from "vitest";
import * as k8s from "@kubernetes/client-node";
import { DockerImageBuilder } from "../prebuilds/docker-builder.js";
import { KubernetesImageBuilder } from "../prebuilds/k8s-builder.js";
import { parseImageBuilderBackend, resolveImageBuilder } from "./image-builder.js";

/** Fake-but-structurally-valid `KubeConfig` (mirrors
 * `sandbox-backend.test.ts`'s `fakeKubeConfig`) — `resolveImageBuilder`
 * only *constructs* the kubernetes builder here, it never invokes any of
 * its methods, so no network call ever happens. */
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

describe("parseImageBuilderBackend", () => {
  it("returns undefined for unset/empty", () => {
    expect(parseImageBuilderBackend(undefined)).toBeUndefined();
    expect(parseImageBuilderBackend("")).toBeUndefined();
  });

  it("accepts the known backends", () => {
    expect(parseImageBuilderBackend("docker")).toBe("docker");
    expect(parseImageBuilderBackend("kubernetes")).toBe("kubernetes");
    expect(parseImageBuilderBackend("none")).toBe("none");
  });

  it("throws on an unrecognized value", () => {
    expect(() => parseImageBuilderBackend("bogus")).toThrow(/Invalid VALET_IMAGE_BUILDER/);
  });
});

describe("resolveImageBuilder", () => {
  it("defaults to docker when VALET_SANDBOX_BACKEND is docker (or unset)", () => {
    expect(resolveImageBuilder({})).toBeInstanceOf(DockerImageBuilder);
    expect(resolveImageBuilder({ VALET_SANDBOX_BACKEND: "docker" })).toBeInstanceOf(DockerImageBuilder);
  });

  it("defaults to a KubernetesImageBuilder when VALET_SANDBOX_BACKEND is kubernetes", () => {
    const result = resolveImageBuilder({ VALET_SANDBOX_BACKEND: "kubernetes" }, { kubeConfig: fakeKubeConfig() });
    expect(result).toBeInstanceOf(KubernetesImageBuilder);
    expect(result?.backend).toBe("kubernetes");
  });

  it("throws the same VALET_KUBE_CONTEXT guidance as the sandbox backend when no kubeConfig is injected and running out-of-cluster", () => {
    expect(() => resolveImageBuilder({ VALET_SANDBOX_BACKEND: "kubernetes" })).toThrow(/VALET_KUBE_CONTEXT is required/);
  });

  it("defaults to null when VALET_SANDBOX_BACKEND is local", () => {
    expect(resolveImageBuilder({ VALET_SANDBOX_BACKEND: "local" })).toBeNull();
  });

  it("VALET_IMAGE_BUILDER=none overrides a docker sandbox backend to null", () => {
    const result = resolveImageBuilder({ VALET_SANDBOX_BACKEND: "docker", VALET_IMAGE_BUILDER: "none" });
    expect(result).toBeNull();
  });

  it("VALET_IMAGE_BUILDER=docker overrides a local sandbox backend to a docker builder", () => {
    const result = resolveImageBuilder({ VALET_SANDBOX_BACKEND: "local", VALET_IMAGE_BUILDER: "docker" });
    expect(result).toBeInstanceOf(DockerImageBuilder);
  });

  it("returned builder's backend property matches", () => {
    const builder = resolveImageBuilder({});
    expect(builder?.backend).toBe("docker");
  });
});
