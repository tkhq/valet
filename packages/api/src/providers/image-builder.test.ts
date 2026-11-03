import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import * as k8s from "@kubernetes/client-node";
import { DockerImageBuilder, type SpawnedProcess, type SpawnFn } from "../prebuilds/docker-builder.js";
import { KubernetesImageBuilder } from "../prebuilds/k8s-builder.js";
import { parseBuildNodeSelector, parseBuildTolerations, parseImageBuilderBackend, resolveImageBuilder } from "./image-builder.js";

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

describe("parseBuildNodeSelector", () => {
  it("returns undefined when unset or empty", () => {
    expect(parseBuildNodeSelector(undefined)).toBeUndefined();
    expect(parseBuildNodeSelector("  ")).toBeUndefined();
  });

  it("accepts a JSON object and key=value pairs", () => {
    expect(parseBuildNodeSelector('{"pool":"builds","valet.dev/tier":"untrusted"}')).toEqual({ pool: "builds", "valet.dev/tier": "untrusted" });
    expect(parseBuildNodeSelector("pool=builds, zone=a")).toEqual({ pool: "builds", zone: "a" });
    expect(parseBuildNodeSelector('{"node.kubernetes.io/instance-type":"m7i.large","empty":""}')).toEqual({ "node.kubernetes.io/instance-type": "m7i.large", empty: "" });
  });

  it.each([
    ["{not json", /not valid JSON/],
    ["[\"pool\"]", /not an object/],
    ['{"pool":1}', /value for "pool" is not a string/],
    ["{}", /no labels/],
    ["pool", /has no "="/],
    ["=builds", /not a valid Kubernetes label key/],
    ["pool=two words", /not a valid Kubernetes label value/],
    ['{"pool?":"builds"}', /"pool\?" is not a valid Kubernetes label key/],
    ['{"Valet.Dev/pool":"builds"}', /not a valid Kubernetes label key/],
    ['{"/pool":"builds"}', /not a valid Kubernetes label key/],
    [`{"${"a".repeat(64)}":"builds"}`, /not a valid Kubernetes label key/],
    ['{"pool":"-builds"}', /not a valid Kubernetes label value/],
    [`{"pool":"${"b".repeat(64)}"}`, /not a valid Kubernetes label value/],
  ])("throws a boot error that names the fix for %j", (value, detail) => {
    expect(() => parseBuildNodeSelector(value)).toThrow(detail);
    expect(() => parseBuildNodeSelector(value)).toThrow(/Set it to a JSON object such as/);
  });
});

describe("parseBuildTolerations", () => {
  it("returns undefined when unset or empty", () => {
    expect(parseBuildTolerations(undefined)).toBeUndefined();
    expect(parseBuildTolerations("")).toBeUndefined();
  });

  it("accepts a JSON array of tolerations", () => {
    const value = '[{"key":"valet.dev/build","operator":"Exists","effect":"NoSchedule"},{"key":"k","operator":"Equal","value":"v","effect":"NoExecute","tolerationSeconds":60}]';
    expect(parseBuildTolerations(value)).toEqual([
      { key: "valet.dev/build", operator: "Exists", effect: "NoSchedule" },
      { key: "k", operator: "Equal", value: "v", effect: "NoExecute", tolerationSeconds: 60 },
    ]);
  });

  it.each([
    ["nope", /not valid JSON/],
    ['{"key":"k"}', /not an array/],
    ['["k"]', /entry 0 is not an object/],
    ['[{"key":"k","efect":"NoSchedule"}]', /unknown field "efect"/],
    ['[{"key":"k","operator":"In"}]', /operator must be/],
    ['[{"key":"k","effect":"Never"}]', /effect must be/],
    ['[{"key":1}]', /field "key" is not a string/],
    ['[{"key":"k","tolerationSeconds":"60"}]', /tolerationSeconds is not an integer/],
    ['[{"key":"k","operator":"Exists","value":"v"}]', /sets a value with operator "Exists"/],
    ['[{"key":"pool?","operator":"Exists"}]', /key "pool\?" is not a valid Kubernetes label key/],
    ['[{"key":"k","operator":"Equal","value":"a b"}]', /value "a b" is not a valid Kubernetes label value/],
  ])("throws a boot error that names the fix for %j", (value, detail) => {
    expect(() => parseBuildTolerations(value)).toThrow(detail);
    expect(() => parseBuildTolerations(value)).toThrow(/Set it to a JSON array such as/);
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

  it("fails at boot on an invalid build placement value", () => {
    expect(() =>
      resolveImageBuilder(
        { VALET_SANDBOX_BACKEND: "kubernetes", VALET_PREBUILD_BUILD_TOLERATIONS: "{" },
        { kubeConfig: fakeKubeConfig() },
      ),
    ).toThrow(/Invalid VALET_PREBUILD_BUILD_TOLERATIONS/);
    expect(() =>
      resolveImageBuilder(
        { VALET_SANDBOX_BACKEND: "kubernetes", VALET_PREBUILD_BUILD_NODE_SELECTOR: "pool" },
        { kubeConfig: fakeKubeConfig() },
      ),
    ).toThrow(/Invalid VALET_PREBUILD_BUILD_NODE_SELECTOR/);
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

// ---------------------------------------------------------------------------
// VALET_PREBUILD_BUILD_CACHE_GB env parsing
// ---------------------------------------------------------------------------

/** Minimal fake SpawnedProcess — lets tests capture prune argv without a
 * real daemon. Always resolves close immediately. */
class FakeChild extends EventEmitter implements SpawnedProcess {
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin = new PassThrough();
  killed = false;
  kill(): boolean {
    this.killed = true;
    process.nextTick(() => this.emit("close", null, "SIGKILL"));
    return true;
  }
}

/** Returns a fake SpawnFn that records prune argv and closes immediately. */
function makeFakeSpawnFn(): { spawnFn: SpawnFn; pruneArgsList: string[][] } {
  const pruneArgsList: string[][] = [];
  const spawnFn: SpawnFn = (_command, args) => {
    const child = new FakeChild();
    child.stdin.on("data", () => {});
    setImmediate(() => {
      if (args[0] === "builder") pruneArgsList.push(args);
      child.emit("close", 0, null);
    });
    return child;
  };
  return { spawnFn, pruneArgsList };
}

/** Runs one build against a DockerImageBuilder constructed via
 * `resolveImageBuilder(env)` and returns the prune argv captured. */
async function capturePruneArgs(envOverride: NodeJS.ProcessEnv): Promise<string[]> {
  const { spawnFn, pruneArgsList } = makeFakeSpawnFn();
  const builder = resolveImageBuilder(envOverride, { spawnFn });
  if (!(builder instanceof DockerImageBuilder)) throw new Error("expected DockerImageBuilder");

  const spec = {
    configId: "cfg-env-test",
    prebuildId: "pb-env-test",
    cloneUrl: "https://github.com/octocat/Hello-World.git",
    commitSha: "abc123",
    baseImage: "alpine:3",
    recipe: [] as [],
    imageRef: "valet-prebuild-test/env:test",
  };
  const { buildId } = await builder.build(spec);

  // Wait for both the build spawn and the prune spawn to complete.
  const deadline = Date.now() + 5000;
  while (pruneArgsList.length < 1) {
    if (Date.now() > deadline) throw new Error("prune never fired");
    await new Promise((r) => setTimeout(r, 10));
  }
  // Also wait for the build record to leave building state.
  let status = await builder.status(buildId);
  while (status.state === "queued" || status.state === "building") {
    if (Date.now() > deadline) throw new Error("build did not finish");
    await new Promise((r) => setTimeout(r, 10));
    status = await builder.status(buildId);
  }

  return pruneArgsList[0] ?? [];
}

describe("VALET_PREBUILD_BUILD_CACHE_GB env parsing", () => {
  it("uses the 10 GB default when the env var is unset", async () => {
    const args = await capturePruneArgs({});
    expect(args).toContain("10GB");
  });

  it("uses the 10 GB default when the env var is an empty string", async () => {
    const args = await capturePruneArgs({ VALET_PREBUILD_BUILD_CACHE_GB: "" });
    expect(args).toContain("10GB");
  });

  it("uses the 10 GB default when the env var is '0' (zero is not a valid cap)", async () => {
    const args = await capturePruneArgs({ VALET_PREBUILD_BUILD_CACHE_GB: "0" });
    expect(args).toContain("10GB");
  });

  it("uses the supplied value when VALET_PREBUILD_BUILD_CACHE_GB is a positive integer", async () => {
    const args = await capturePruneArgs({ VALET_PREBUILD_BUILD_CACHE_GB: "5" });
    expect(args).toContain("5GB");
  });
});
