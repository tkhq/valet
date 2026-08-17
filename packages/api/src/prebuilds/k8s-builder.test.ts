import { describe, expect, it } from "vitest";
import type {
  CreateConfigMapParams,
  CreateJobParams,
  CreateSecretParams,
  DeleteConfigMapParams,
  DeleteJobParams,
  DeleteSecretParams,
  GetJobParams,
  JobStatusInfo,
  ListJobPodsParams,
  ReadPodLogParams,
  SandboxBatchJobsApi,
} from "@valet/sandbox-kubernetes";
import type { PrebuildSpec } from "./builder.js";
import { BUILDKIT_IMAGE, buildkitdToml, buildKitJobManifest, KubernetesImageBuilder, mapJobStatus, PREBUILD_LABEL_KEY, pushRefFor } from "./k8s-builder.js";

function baseSpec(overrides: Partial<PrebuildSpec> = {}): PrebuildSpec {
  return {
    configId: "cfg-1",
    prebuildId: "pb-1",
    cloneUrl: "https://github.com/octocat/Hello-World.git",
    commitSha: "abc123",
    baseImage: "alpine:3",
    recipe: [],
    imageRef: "valet-registry:5000/octocat-hello-world:abc123",
    ...overrides,
  };
}

// ── pushRefFor (pure host swap) ─────────────────────────────────────────

describe("pushRefFor", () => {
  it("swaps the pull-host prefix for the push host, path + tag untouched", () => {
    expect(pushRefFor("localhost:30500/octocat-hello-world:abc123", "valet-registry.valet-sandboxes.svc.cluster.local:5000")).toBe(
      "valet-registry.valet-sandboxes.svc.cluster.local:5000/octocat-hello-world:abc123",
    );
  });

  it("preserves the config-scoped path segment (splits on the FIRST slash only)", () => {
    // Org-scoped image paths (`<host>/<configSlug>/<owner>-<repo>:<tag>`) put a
    // config segment between host and repo — the host swap must keep it intact.
    expect(
      pushRefFor("localhost:30500/cfg-org-a/octocat-hello-world:abc123", "valet-registry.valet-sandboxes.svc.cluster.local:5000"),
    ).toBe("valet-registry.valet-sandboxes.svc.cluster.local:5000/cfg-org-a/octocat-hello-world:abc123");
  });

  it("is a no-op when the push host is undefined (no split configured)", () => {
    expect(pushRefFor("localhost:30500/octocat-hello-world:abc123", undefined)).toBe(
      "localhost:30500/octocat-hello-world:abc123",
    );
  });

  it("is a no-op when the pull host already equals the push host", () => {
    expect(pushRefFor("registry.example.com/acme-widgets:abc123", "registry.example.com")).toBe(
      "registry.example.com/acme-widgets:abc123",
    );
  });

  it("is a no-op for a hostless (docker-shaped) ref with no '/' segment", () => {
    // `valet-prebuild/foo:sha` DOES have a slash — a truly hostless ref is one
    // with no slash at all; defensive, never reached for k8s refs.
    expect(pushRefFor("no-slash-ref:tag", "push-host:5000")).toBe("no-slash-ref:tag");
  });
});

// ── buildkitdToml (pure) ────────────────────────────────────────────────

describe("buildkitdToml", () => {
  it("produces a valid TOML snippet that marks the host as HTTP", () => {
    const toml = buildkitdToml("valet-registry.valet-sandboxes.svc.cluster.local:5000");
    expect(toml).toBe('[registry."valet-registry.valet-sandboxes.svc.cluster.local:5000"]\n  http = true\n');
  });

  it("works for a simple host:port without DNS subdomain", () => {
    const toml = buildkitdToml("localhost:30500");
    expect(toml).toBe('[registry."localhost:30500"]\n  http = true\n');
  });
});

// ── buildKitJobManifest (pure) ──────────────────────────────────────────

describe("buildKitJobManifest", () => {
  it("builds the expected Job shape: name, labels, deadline, backoffLimit", () => {
    const job = buildKitJobManifest({
      id: "1",
      namespace: "valet-sandboxes",
      imageRef: "valet-registry:5000/acme-widgets:abc123",
      hasGitToken: true,
      buildkitImage: BUILDKIT_IMAGE,
      activeDeadlineSeconds: 1800,
      registryInsecure: true,
    });

    expect(job.metadata?.name).toBe("valet-prebuild-1");
    expect(job.metadata?.namespace).toBe("valet-sandboxes");
    expect(job.metadata?.labels).toEqual({ [PREBUILD_LABEL_KEY]: "1" });
    expect(job.spec?.activeDeadlineSeconds).toBe(1800);
    expect(job.spec?.backoffLimit).toBe(0);
    expect(job.spec?.template.spec?.restartPolicy).toBe("Never");
    expect(job.spec?.template.metadata?.labels).toEqual({ [PREBUILD_LABEL_KEY]: "1" });
  });

  it("mounts the git-token secret at /run/valet/git-token and passes --secret when a token is present", () => {
    const job = buildKitJobManifest({
      id: "2",
      namespace: "ns",
      imageRef: "reg/foo:bar",
      hasGitToken: true,
      buildkitImage: BUILDKIT_IMAGE,
      activeDeadlineSeconds: 1800,
      registryInsecure: false,
    });
    const container = job.spec?.template.spec?.containers[0];
    expect(container?.args).toContain("--secret");
    // src must be the token FILE inside the mount dir, not the dir itself —
    // a k8s Secret volume mounts as a directory (key-per-file).
    expect(container?.args).toContain("id=git-token,src=/run/valet/git-token/token");
    const secretMount = container?.volumeMounts?.find((m) => m.mountPath === "/run/valet/git-token");
    expect(secretMount).toBeDefined();
    const secretVolume = job.spec?.template.spec?.volumes?.find((v) => v.name === secretMount?.name);
    expect(secretVolume?.secret?.secretName).toBe("valet-prebuild-2-token");
  });

  it("omits the secret mount and --secret flag entirely when tokenless", () => {
    const job = buildKitJobManifest({
      id: "3",
      namespace: "ns",
      imageRef: "reg/foo:bar",
      hasGitToken: false,
      buildkitImage: BUILDKIT_IMAGE,
      activeDeadlineSeconds: 1800,
      registryInsecure: false,
    });
    const container = job.spec?.template.spec?.containers[0];
    expect(container?.args).not.toContain("--secret");
    expect(container?.args?.join(" ")).not.toContain("git-token,src=");
    expect(job.spec?.template.spec?.volumes?.some((v) => v.secret)).toBe(false);
  });

  it("mounts the Dockerfile ConfigMap at /dockerfile", () => {
    const job = buildKitJobManifest({
      id: "4",
      namespace: "ns",
      imageRef: "reg/foo:bar",
      hasGitToken: false,
      buildkitImage: BUILDKIT_IMAGE,
      activeDeadlineSeconds: 1800,
      registryInsecure: false,
    });
    const container = job.spec?.template.spec?.containers[0];
    const cmMount = container?.volumeMounts?.find((m) => m.mountPath === "/dockerfile");
    expect(cmMount).toBeDefined();
    const cmVolume = job.spec?.template.spec?.volumes?.find((v) => v.name === cmMount?.name);
    expect(cmVolume?.configMap?.name).toBe("valet-prebuild-4-dockerfile");
  });

  it("passes registry.insecure=true only when registryInsecure is set", () => {
    const insecure = buildKitJobManifest({
      id: "5",
      namespace: "ns",
      imageRef: "reg/foo:bar",
      hasGitToken: false,
      buildkitImage: BUILDKIT_IMAGE,
      activeDeadlineSeconds: 1800,
      registryInsecure: true,
    });
    const secure = buildKitJobManifest({
      id: "6",
      namespace: "ns",
      imageRef: "reg/foo:bar",
      hasGitToken: false,
      buildkitImage: BUILDKIT_IMAGE,
      activeDeadlineSeconds: 1800,
      registryInsecure: false,
    });
    const insecureArgs = insecure.spec?.template.spec?.containers[0].args?.join(" ") ?? "";
    const secureArgs = secure.spec?.template.spec?.containers[0].args?.join(" ") ?? "";
    expect(insecureArgs).toContain("registry.insecure=true");
    expect(secureArgs).not.toContain("registry.insecure=true");
    expect(insecureArgs).toContain("name=reg/foo:bar");
  });

  it("output name uses the PUSH host (swapped in) while imageRef stays pull-hosted", () => {
    const job = buildKitJobManifest({
      id: "12",
      namespace: "valet-sandboxes",
      // pull-hosted ref (what lands on the row + sandbox pod image)
      imageRef: "localhost:30500/octocat-hello-world:abc123",
      hasGitToken: false,
      buildkitImage: BUILDKIT_IMAGE,
      activeDeadlineSeconds: 1800,
      registryInsecure: true,
      registryPushHost: "valet-registry.valet-sandboxes.svc.cluster.local:5000",
    });
    const args = job.spec?.template.spec?.containers[0].args?.join(" ") ?? "";
    // buildctl pushes to the PUSH host...
    expect(args).toContain("name=valet-registry.valet-sandboxes.svc.cluster.local:5000/octocat-hello-world:abc123");
    // ...never to the pull host.
    expect(args).not.toContain("name=localhost:30500/");
  });

  it("output name equals imageRef when no push host is configured (no split)", () => {
    const job = buildKitJobManifest({
      id: "13",
      namespace: "ns",
      imageRef: "registry.example.com/acme-widgets:abc123",
      hasGitToken: false,
      buildkitImage: BUILDKIT_IMAGE,
      activeDeadlineSeconds: 1800,
      registryInsecure: false,
    });
    const args = job.spec?.template.spec?.containers[0].args?.join(" ") ?? "";
    expect(args).toContain("name=registry.example.com/acme-widgets:abc123");
  });

  it("uses the pinned buildkit image and rootless securityContext", () => {
    const job = buildKitJobManifest({
      id: "7",
      namespace: "ns",
      imageRef: "reg/foo:bar",
      hasGitToken: false,
      buildkitImage: BUILDKIT_IMAGE,
      activeDeadlineSeconds: 1800,
      registryInsecure: false,
    });
    expect(job.spec?.template.spec?.containers[0].image).toBe(BUILDKIT_IMAGE);
    expect(job.spec?.template.spec?.securityContext?.seccompProfile?.type).toBe("Unconfined");
    expect(job.spec?.template.spec?.securityContext?.runAsUser).toBe(1000);
    expect(job.spec?.template.spec?.securityContext?.runAsGroup).toBe(1000);
  });

  it("sets BUILDKITD_FLAGS=--oci-worker-no-process-sandbox (rootless-on-k8s requirement, unprivileged)", () => {
    const job = buildKitJobManifest({
      id: "11",
      namespace: "ns",
      imageRef: "reg/foo:bar",
      hasGitToken: false,
      buildkitImage: BUILDKIT_IMAGE,
      activeDeadlineSeconds: 1800,
      registryInsecure: false,
    });
    expect(job.spec?.template.spec?.containers[0].env).toMatchObject([
      { name: "BUILDKITD_FLAGS", value: "--oci-worker-no-process-sandbox" },
    ]);
  });

  it("insecure registry: BUILDKITD_FLAGS includes --config= pointing at the mounted toml", () => {
    const job = buildKitJobManifest({
      id: "14",
      namespace: "ns",
      imageRef: "localhost:30500/foo:bar",
      hasGitToken: false,
      buildkitImage: BUILDKIT_IMAGE,
      activeDeadlineSeconds: 1800,
      registryInsecure: true,
      registryPushHost: "valet-registry.valet-sandboxes.svc.cluster.local:5000",
    });
    const flags = job.spec?.template.spec?.containers[0].env?.find((e) => e.name === "BUILDKITD_FLAGS")?.value ?? "";
    expect(flags).toContain("--oci-worker-no-process-sandbox");
    expect(flags).toContain("--config=/buildkitd/buildkitd.toml");
  });

  it("insecure registry: container mounts buildkitd.toml from the ConfigMap via subPath", () => {
    const job = buildKitJobManifest({
      id: "15",
      namespace: "ns",
      imageRef: "localhost:30500/foo:bar",
      hasGitToken: false,
      buildkitImage: BUILDKIT_IMAGE,
      activeDeadlineSeconds: 1800,
      registryInsecure: true,
      registryPushHost: "valet-registry.valet-sandboxes.svc.cluster.local:5000",
    });
    const mounts = job.spec?.template.spec?.containers[0].volumeMounts ?? [];
    const tomlMount = mounts.find((m) => m.mountPath === "/buildkitd/buildkitd.toml");
    expect(tomlMount).toBeDefined();
    expect(tomlMount?.subPath).toBe("buildkitd.toml");
    // Reuses the "dockerfile" volume — no extra volume is added for TLS.
    expect(tomlMount?.name).toBe("dockerfile");
    // A secure registry must not have this mount.
  });

  it("secure/external registry: no buildkitd.toml mount and BUILDKITD_FLAGS unchanged", () => {
    const job = buildKitJobManifest({
      id: "16",
      namespace: "ns",
      imageRef: "registry.example.com/foo:bar",
      hasGitToken: false,
      buildkitImage: BUILDKIT_IMAGE,
      activeDeadlineSeconds: 1800,
      registryInsecure: false,
    });
    const flags = job.spec?.template.spec?.containers[0].env?.find((e) => e.name === "BUILDKITD_FLAGS")?.value ?? "";
    expect(flags).toBe("--oci-worker-no-process-sandbox");
    expect(flags).not.toContain("--config=");
    const mounts = job.spec?.template.spec?.containers[0].volumeMounts ?? [];
    expect(mounts.some((m) => m.subPath === "buildkitd.toml")).toBe(false);
  });

  it("sets the AppArmor-unconfined pod annotation for the buildkit container (rootless requirement)", () => {
    const job = buildKitJobManifest({
      id: "9",
      namespace: "ns",
      imageRef: "reg/foo:bar",
      hasGitToken: false,
      buildkitImage: BUILDKIT_IMAGE,
      activeDeadlineSeconds: 1800,
      registryInsecure: false,
    });
    expect(job.spec?.template.metadata?.annotations).toMatchObject({
      "container.apparmor.security.beta.kubernetes.io/buildkit": "unconfined",
    });
  });

  it("sets ttlSecondsAfterFinished so a Job (and its pod) can't linger unbounded if cleanup is missed", () => {
    const job = buildKitJobManifest({
      id: "10",
      namespace: "ns",
      imageRef: "reg/foo:bar",
      hasGitToken: false,
      buildkitImage: BUILDKIT_IMAGE,
      activeDeadlineSeconds: 1800,
      registryInsecure: false,
    });
    expect(job.spec?.ttlSecondsAfterFinished).toBe(3600);
  });

  it("threads resource requests/limits through to the container", () => {
    const job = buildKitJobManifest({
      id: "8",
      namespace: "ns",
      imageRef: "reg/foo:bar",
      hasGitToken: false,
      buildkitImage: BUILDKIT_IMAGE,
      activeDeadlineSeconds: 1800,
      registryInsecure: false,
      resources: { requests: { cpu: "1", memory: "2Gi" }, limits: { cpu: "2", memory: "4Gi" } },
    });
    expect(job.spec?.template.spec?.containers[0].resources).toEqual({
      requests: { cpu: "1", memory: "2Gi" },
      limits: { cpu: "2", memory: "4Gi" },
    });
  });
});

// ── mapJobStatus (pure) ──────────────────────────────────────────────────

describe("mapJobStatus", () => {
  it("queued: no active/succeeded/failed and no conditions", () => {
    expect(mapJobStatus({})).toBe("queued");
  });
  it("building: active > 0", () => {
    expect(mapJobStatus({ active: 1 })).toBe("building");
  });
  it("pushed: Complete condition True", () => {
    expect(mapJobStatus({ conditions: [{ type: "Complete", status: "True" }] })).toBe("pushed");
  });
  it("pushed: succeeded count > 0 without a condition yet", () => {
    expect(mapJobStatus({ succeeded: 1 })).toBe("pushed");
  });
  it("failed: Failed condition True", () => {
    expect(mapJobStatus({ conditions: [{ type: "Failed", status: "True" }] })).toBe("failed");
  });
  it("failed: failed count > 0 without a condition yet", () => {
    expect(mapJobStatus({ failed: 1 })).toBe("failed");
  });
  it("failed takes precedence over a stale active count", () => {
    expect(mapJobStatus({ active: 0, failed: 1, conditions: [{ type: "Failed", status: "True" }] })).toBe("failed");
  });
});

// ── KubernetesImageBuilder (fake jobs api) ───────────────────────────────

interface FakeJobRecord {
  params: CreateJobParams;
  status: JobStatusInfo;
  deleted: boolean;
}

class FakeJobsApi implements SandboxBatchJobsApi {
  jobs = new Map<string, FakeJobRecord>();
  configMaps = new Map<string, CreateConfigMapParams>();
  secrets = new Map<string, CreateSecretParams>();
  deletedConfigMaps: string[] = [];
  deletedSecrets: string[] = [];
  podLog = "some build log\n";

  async createNamespacedJob(params: CreateJobParams): Promise<void> {
    const name = params.body.metadata?.name;
    if (!name) throw new Error("fake: job body missing metadata.name");
    if (this.jobs.has(name)) throw { code: 409 };
    this.jobs.set(name, { params, status: {}, deleted: false });
  }

  async getNamespacedJob(params: GetJobParams): Promise<JobStatusInfo | null> {
    const rec = this.jobs.get(params.name);
    if (!rec || rec.deleted) return null;
    return rec.status;
  }

  async deleteNamespacedJob(params: DeleteJobParams): Promise<void> {
    const rec = this.jobs.get(params.name);
    if (rec) rec.deleted = true;
  }

  async listPodsForJob(_params: ListJobPodsParams): Promise<{ items: { name: string; ownerReferences?: never }[] }> {
    return { items: [{ name: "fake-pod-abcde" }] };
  }

  async readPodLog(_params: ReadPodLogParams): Promise<string> {
    return this.podLog;
  }

  async createConfigMap(params: CreateConfigMapParams): Promise<void> {
    this.configMaps.set(params.name, params);
  }

  async deleteConfigMap(params: DeleteConfigMapParams): Promise<void> {
    this.configMaps.delete(params.name);
    this.deletedConfigMaps.push(params.name);
  }

  async createSecret(params: CreateSecretParams): Promise<void> {
    this.secrets.set(params.name, params);
  }

  async deleteSecret(params: DeleteSecretParams): Promise<void> {
    this.secrets.delete(params.name);
    this.deletedSecrets.push(params.name);
  }

  /** Test helper: flips a Job to a terminal state as the controller would. */
  setStatus(jobName: string, status: JobStatusInfo): void {
    const rec = this.jobs.get(jobName);
    if (!rec) throw new Error(`fake: no job "${jobName}"`);
    rec.status = status;
  }
}

function newBuilder(jobsApi: FakeJobsApi, overrides: Partial<{ registryInsecure: boolean; registryPushHost: string }> = {}) {
  let counter = 0;
  return new KubernetesImageBuilder({
    jobsApi,
    namespace: "valet-sandboxes",
    registryInsecure: overrides.registryInsecure ?? true,
    ...(overrides.registryPushHost ? { registryPushHost: overrides.registryPushHost } : {}),
    newId: () => String(++counter),
  });
}

describe("KubernetesImageBuilder", () => {
  it("build() creates a ConfigMap + Secret + Job named after the PERSISTED prebuild row id", async () => {
    const jobsApi = new FakeJobsApi();
    const builder = newBuilder(jobsApi);
    // buildId (in-memory, counter-based) is distinct from the resource names
    // (derived from the durable row id) on purpose — see cleanupOrphan.
    const { buildId } = await builder.build(baseSpec({ gitToken: "ghp_secret" }));
    expect(buildId).toBe("k8s-build-1");
    // dispatch is async — allow the microtask queue to flush.
    await new Promise((r) => setTimeout(r, 0));

    expect(jobsApi.jobs.has("valet-prebuild-pb-1")).toBe(true);
    expect(jobsApi.configMaps.has("valet-prebuild-pb-1-dockerfile")).toBe(true);
    expect(jobsApi.secrets.has("valet-prebuild-pb-1-token")).toBe(true);
    const secret = jobsApi.secrets.get("valet-prebuild-pb-1-token");
    expect(secret?.stringData.token).toBe("ghp_secret");
  });

  it("build() names resources from the row id even when it carries characters invalid in a k8s name", async () => {
    const jobsApi = new FakeJobsApi();
    const builder = newBuilder(jobsApi);
    // A real row id is `pb_<uuid>` — the underscore is invalid in a DNS-1123
    // resource name and must be normalized to `-`, consistently at build and
    // cleanup time.
    await builder.build(baseSpec({ prebuildId: "pb_AbC_123" }));
    await new Promise((r) => setTimeout(r, 0));
    expect(jobsApi.jobs.has("valet-prebuild-pb-abc-123")).toBe(true);
    expect(jobsApi.configMaps.has("valet-prebuild-pb-abc-123-dockerfile")).toBe(true);
  });

  it("dispatched Job pushes to the PUSH host while the spec's pull-hosted imageRef is unchanged", async () => {
    const jobsApi = new FakeJobsApi();
    const builder = newBuilder(jobsApi, {
      registryPushHost: "valet-registry.valet-sandboxes.svc.cluster.local:5000",
    });
    await builder.build(baseSpec({ imageRef: "localhost:30500/octocat-hello-world:abc123" }));
    await new Promise((r) => setTimeout(r, 0));
    const job = jobsApi.jobs.get("valet-prebuild-pb-1");
    const args = job?.params.body.spec?.template.spec?.containers[0].args?.join(" ") ?? "";
    expect(args).toContain("name=valet-registry.valet-sandboxes.svc.cluster.local:5000/octocat-hello-world:abc123");
    expect(args).not.toContain("name=localhost:30500/");
  });

  it("build() omits the Secret entirely when the spec has no gitToken", async () => {
    const jobsApi = new FakeJobsApi();
    const builder = newBuilder(jobsApi);
    await builder.build(baseSpec());
    await new Promise((r) => setTimeout(r, 0));
    expect(jobsApi.secrets.size).toBe(0);
    expect(jobsApi.configMaps.has("valet-prebuild-pb-1-dockerfile")).toBe(true);
  });

  it("status() reports building while the Job has active > 0, with a log tail", async () => {
    const jobsApi = new FakeJobsApi();
    const builder = newBuilder(jobsApi);
    const { buildId } = await builder.build(baseSpec());
    await new Promise((r) => setTimeout(r, 0));
    jobsApi.setStatus("valet-prebuild-pb-1", { active: 1 });

    const status = await builder.status(buildId);
    expect(status.state).toBe("building");
    expect(status.logTail).toBe("some build log\n");
  });

  it("status() reports pushed on a Complete condition and cleans up the Secret+ConfigMap", async () => {
    const jobsApi = new FakeJobsApi();
    const builder = newBuilder(jobsApi);
    const { buildId } = await builder.build(baseSpec({ gitToken: "tok" }));
    await new Promise((r) => setTimeout(r, 0));
    jobsApi.setStatus("valet-prebuild-pb-1", { succeeded: 1, conditions: [{ type: "Complete", status: "True" }] });

    const status = await builder.status(buildId);
    expect(status.state).toBe("pushed");
    expect(jobsApi.secrets.has("valet-prebuild-pb-1-token")).toBe(false);
    expect(jobsApi.configMaps.has("valet-prebuild-pb-1-dockerfile")).toBe(false);
    expect(jobsApi.deletedSecrets).toContain("valet-prebuild-pb-1-token");
    expect(jobsApi.deletedConfigMaps).toContain("valet-prebuild-pb-1-dockerfile");
    // The Job resource itself is NOT deleted on a terminal poll — only cancel() deletes it.
    expect(jobsApi.jobs.get("valet-prebuild-pb-1")?.deleted).toBe(false);
  });

  it("status() reports failed on a Failed condition and cleans up", async () => {
    const jobsApi = new FakeJobsApi();
    const builder = newBuilder(jobsApi);
    const { buildId } = await builder.build(baseSpec());
    await new Promise((r) => setTimeout(r, 0));
    jobsApi.setStatus("valet-prebuild-pb-1", { failed: 1, conditions: [{ type: "Failed", status: "True" }] });

    const status = await builder.status(buildId);
    expect(status.state).toBe("failed");
    expect(status.error).toBeDefined();
    expect(jobsApi.configMaps.has("valet-prebuild-pb-1-dockerfile")).toBe(false);
  });

  it("status() reports failed (not stuck) when the Job was deleted out-of-band (e.g. kubectl delete job) while building, and releases the queue slot", async () => {
    const jobsApi = new FakeJobsApi();
    const builder = newBuilder(jobsApi);
    const first = await builder.build(baseSpec());
    const second = await builder.build(baseSpec({ prebuildId: "pb-2" }));
    await new Promise((r) => setTimeout(r, 0));

    // First build is actively running.
    jobsApi.setStatus("valet-prebuild-pb-1", { active: 1 });
    const building = await builder.status(first.buildId);
    expect(building.state).toBe("building");
    // Second build is still parked in the local FIFO behind the concurrency cap.
    expect(jobsApi.jobs.has("valet-prebuild-pb-2")).toBe(false);

    // Someone runs `kubectl delete job` on the in-flight Job directly (not via
    // our own cancel()/cleanup path) — the Job vanishes out from under us.
    jobsApi.jobs.get("valet-prebuild-pb-1")!.deleted = true;

    const status = await builder.status(first.buildId);
    expect(status.state).toBe("failed");
    expect(status.error).toBe("build job deleted");
    // Terminal cleanup ran too, same as any other failed/pushed transition.
    expect(jobsApi.deletedConfigMaps).toContain("valet-prebuild-pb-1-dockerfile");

    // The queue slot the deleted build occupied must be released so the
    // second, still-queued build gets dispatched.
    await new Promise((r) => setTimeout(r, 0));
    expect(jobsApi.jobs.has("valet-prebuild-pb-2")).toBe(true);
  });

  it("status() called between build() and Job creation returns queued/building untouched — no ConfigMap delete, no false failure", async () => {
    const jobsApi = new FakeJobsApi();
    // Gate createNamespacedJob on a test-controlled promise so we can poll
    // status() while dispatch() is still in flight (has created the
    // ConfigMap but not yet the Job).
    let releaseJobCreate!: () => void;
    const jobCreateGate = new Promise<void>((resolve) => {
      releaseJobCreate = resolve;
    });
    const realCreateJob = jobsApi.createNamespacedJob.bind(jobsApi);
    jobsApi.createNamespacedJob = async (params) => {
      await jobCreateGate;
      return realCreateJob(params);
    };

    const builder = newBuilder(jobsApi);
    const { buildId } = await builder.build(baseSpec());
    // Let dispatch() run far enough to create the ConfigMap and block on the
    // gated createNamespacedJob call.
    await new Promise((r) => setTimeout(r, 0));
    expect(jobsApi.configMaps.has("valet-prebuild-pb-1-dockerfile")).toBe(true);
    expect(jobsApi.jobs.has("valet-prebuild-pb-1")).toBe(false);

    // The Job doesn't exist yet — getNamespacedJob would return null. Racing
    // status() here must NOT mark the build failed or delete the ConfigMap
    // dispatch just created.
    const raced = await builder.status(buildId);
    expect(raced.state === "queued" || raced.state === "building").toBe(true);
    expect(raced.error).toBeUndefined();
    expect(jobsApi.configMaps.has("valet-prebuild-pb-1-dockerfile")).toBe(true);
    expect(jobsApi.deletedConfigMaps).not.toContain("valet-prebuild-pb-1-dockerfile");

    // Release dispatch — the build should proceed normally to building/pushed.
    releaseJobCreate();
    await new Promise((r) => setTimeout(r, 0));
    expect(jobsApi.jobs.has("valet-prebuild-pb-1")).toBe(true);

    jobsApi.setStatus("valet-prebuild-pb-1", { active: 1 });
    const building = await builder.status(buildId);
    expect(building.state).toBe("building");

    jobsApi.setStatus("valet-prebuild-pb-1", { succeeded: 1, conditions: [{ type: "Complete", status: "True" }] });
    const pushed = await builder.status(buildId);
    expect(pushed.state).toBe("pushed");
    expect(jobsApi.configMaps.has("valet-prebuild-pb-1-dockerfile")).toBe(false);
  });

  it("cancel() deletes the Job, Secret, and ConfigMap", async () => {
    const jobsApi = new FakeJobsApi();
    const builder = newBuilder(jobsApi);
    const { buildId } = await builder.build(baseSpec({ gitToken: "tok" }));
    await new Promise((r) => setTimeout(r, 0));

    await builder.cancel(buildId);

    expect(jobsApi.jobs.get("valet-prebuild-pb-1")?.deleted).toBe(true);
    expect(jobsApi.secrets.has("valet-prebuild-pb-1-token")).toBe(false);
    expect(jobsApi.configMaps.has("valet-prebuild-pb-1-dockerfile")).toBe(false);
    const status = await builder.status(buildId);
    expect(status.state).toBe("failed");
    expect(status.error).toBe("cancelled");
  });

  it("cancel() on a build still sitting in the local FIFO (concurrency cap reached) never touches the jobs api", async () => {
    const jobsApi = new FakeJobsApi();
    const builder = newBuilder(jobsApi);
    await builder.build(baseSpec()); // occupies the concurrency-1 slot
    const second = await builder.build(baseSpec({ prebuildId: "pb-2" }));
    await new Promise((r) => setTimeout(r, 0));
    expect(jobsApi.jobs.has("valet-prebuild-pb-2")).toBe(false);

    await builder.cancel(second.buildId);

    expect(jobsApi.jobs.has("valet-prebuild-pb-2")).toBe(false);
    const status = await builder.status(second.buildId);
    expect(status.state).toBe("failed");
    expect(status.error).toBe("cancelled");
  });

  it("respects the concurrency cap: a second build queues until the first reaches a terminal state", async () => {
    const jobsApi = new FakeJobsApi();
    const builder = newBuilder(jobsApi);
    const first = await builder.build(baseSpec());
    const second = await builder.build(baseSpec({ prebuildId: "pb-2" }));
    await new Promise((r) => setTimeout(r, 0));

    expect(jobsApi.jobs.has("valet-prebuild-pb-1")).toBe(true);
    expect(jobsApi.jobs.has("valet-prebuild-pb-2")).toBe(false);
    expect((await builder.status(second.buildId)).state).toBe("queued");

    jobsApi.setStatus("valet-prebuild-pb-1", { succeeded: 1, conditions: [{ type: "Complete", status: "True" }] });
    await builder.status(first.buildId);
    await new Promise((r) => setTimeout(r, 0));

    expect(jobsApi.jobs.has("valet-prebuild-pb-2")).toBe(true);
  });

  it("cleanupOrphan(rowId) deletes the Job, Secret, and ConfigMap by the row-id-derived names", async () => {
    const jobsApi = new FakeJobsApi();
    const builder = newBuilder(jobsApi);
    // Simulate an interrupted build's leftovers standing in the cluster: seed
    // the three resources by their row-id names directly (the in-memory build
    // map is gone after a restart, so cleanupOrphan only has the row id).
    jobsApi.jobs.set("valet-prebuild-pb_xyz".replace("_", "-"), {
      params: { namespace: "valet-sandboxes", body: {} },
      status: {},
      deleted: false,
    });
    jobsApi.secrets.set("valet-prebuild-pb-xyz-token", {
      namespace: "valet-sandboxes",
      name: "valet-prebuild-pb-xyz-token",
      stringData: {},
    });
    jobsApi.configMaps.set("valet-prebuild-pb-xyz-dockerfile", {
      namespace: "valet-sandboxes",
      name: "valet-prebuild-pb-xyz-dockerfile",
      data: {},
    });

    await builder.cleanupOrphan("pb_xyz");

    expect(jobsApi.jobs.get("valet-prebuild-pb-xyz")?.deleted).toBe(true);
    expect(jobsApi.deletedSecrets).toContain("valet-prebuild-pb-xyz-token");
    expect(jobsApi.deletedConfigMaps).toContain("valet-prebuild-pb-xyz-dockerfile");
  });

  it("cleanupOrphan swallows NotFound (nothing to clean up) without throwing", async () => {
    const jobsApi = new FakeJobsApi();
    const builder = newBuilder(jobsApi);
    // Delete adapters already 404-swallow; additionally make one throw a
    // non-404 to confirm cleanupOrphan itself is best-effort and never rejects.
    jobsApi.deleteSecret = async () => {
      throw { code: 500 };
    };
    await expect(builder.cleanupOrphan("pb_never_existed")).resolves.toBeUndefined();
  });

  // ── base-image FROM rewriting (builder boundary, not recipe.ts) ─────────

  it("base bake: Dockerfile FROM uses push host when base image is pull-hosted", async () => {
    // A base bake whose baseImage is `localhost:30500/valet-sandbox:dev`
    // (the pull ref, stored on the row) must become
    // `valet-registry.ns.svc:5000/valet-sandbox:dev` in the generated
    // Dockerfile so BuildKit can fetch it via in-cluster DNS, not the
    // node-local pull host that's unreachable from the BuildKit pod.
    const jobsApi = new FakeJobsApi();
    const builder = newBuilder(jobsApi, {
      registryPushHost: "valet-registry.ns.svc:5000",
    });
    await builder.build(
      baseSpec({
        kind: "base",
        baseImage: "localhost:30500/valet-sandbox:dev",
        imageRef: "localhost:30500/valet-sandbox:custom",
      }),
    );
    await new Promise((r) => setTimeout(r, 0));

    const dockerfile = jobsApi.configMaps.get("valet-prebuild-pb-1-dockerfile")?.data?.["Dockerfile"] ?? "";
    expect(dockerfile).toContain("FROM valet-registry.ns.svc:5000/valet-sandbox:dev");
    expect(dockerfile).not.toContain("FROM localhost:30500/");
  });

  it("base bake: Dockerfile FROM is untouched for a public base image with no matching pull host", async () => {
    const jobsApi = new FakeJobsApi();
    const builder = newBuilder(jobsApi, {
      registryPushHost: "valet-registry.ns.svc:5000",
    });
    await builder.build(
      baseSpec({
        kind: "base",
        baseImage: "node:20-bookworm",
        imageRef: "localhost:30500/valet-sandbox:node20",
      }),
    );
    await new Promise((r) => setTimeout(r, 0));

    const dockerfile = jobsApi.configMaps.get("valet-prebuild-pb-1-dockerfile")?.data?.["Dockerfile"] ?? "";
    expect(dockerfile).toContain("FROM node:20-bookworm");
  });

  it("base bake: Dockerfile FROM is untouched for an EXTERNAL registry-hosted base image (ghcr.io)", async () => {
    // The full-profile stock base is an external ref like
    // `ghcr.io/tkhq/valet-sandbox:sha-x`. Rewriting its host to the bundled
    // push host produced `valet-registry…:5000/tkhq/valet-sandbox:sha-x`,
    // which nobody ever pushed — every full-base bake failed with
    // "not found" (dev-v2). Only bundled-registry (pull-hosted) refs may be
    // rewritten; any other host must pass through untouched.
    const jobsApi = new FakeJobsApi();
    const builder = newBuilder(jobsApi, {
      registryPushHost: "valet-registry.ns.svc:5000",
    });
    await builder.build(
      baseSpec({
        kind: "base",
        baseImage: "ghcr.io/tkhq/valet-sandbox:sha-b4e24e1",
        imageRef: "localhost:30500/src-x/base:abc",
      }),
    );
    await new Promise((r) => setTimeout(r, 0));

    const dockerfile = jobsApi.configMaps.get("valet-prebuild-pb-1-dockerfile")?.data?.["Dockerfile"] ?? "";
    expect(dockerfile).toContain("FROM ghcr.io/tkhq/valet-sandbox:sha-b4e24e1");
    expect(dockerfile).not.toContain("valet-registry.ns.svc:5000/tkhq/");
  });

  it("base bake: Dockerfile FROM is untouched when no push host is configured", async () => {
    const jobsApi = new FakeJobsApi();
    // No registryPushHost — push and pull host are the same (or external registry).
    const builder = newBuilder(jobsApi);
    await builder.build(
      baseSpec({
        kind: "base",
        baseImage: "localhost:30500/valet-sandbox:dev",
        imageRef: "localhost:30500/valet-sandbox:custom",
      }),
    );
    await new Promise((r) => setTimeout(r, 0));

    const dockerfile = jobsApi.configMaps.get("valet-prebuild-pb-1-dockerfile")?.data?.["Dockerfile"] ?? "";
    expect(dockerfile).toContain("FROM localhost:30500/valet-sandbox:dev");
  });

  // ── buildkitd.toml ConfigMap injection (insecure registry) ──────────────

  it("insecure registry with push host: ConfigMap includes buildkitd.toml keyed on the push host", async () => {
    const jobsApi = new FakeJobsApi();
    const builder = newBuilder(jobsApi, {
      registryInsecure: true,
      registryPushHost: "valet-registry.valet-sandboxes.svc.cluster.local:5000",
    });
    await builder.build(baseSpec({ imageRef: "localhost:30500/octocat-hello-world:abc123" }));
    await new Promise((r) => setTimeout(r, 0));

    const cm = jobsApi.configMaps.get("valet-prebuild-pb-1-dockerfile");
    expect(cm?.data?.["buildkitd.toml"]).toBe(
      '[registry."valet-registry.valet-sandboxes.svc.cluster.local:5000"]\n  http = true\n',
    );
    expect(cm?.data?.["Dockerfile"]).toBeDefined();
  });

  it("insecure registry without push host: ConfigMap includes buildkitd.toml keyed on the pull host", async () => {
    // When push host is absent, push == pull. The toml host is extracted from
    // imageRef so the correct registry gets the http=true entry.
    const jobsApi = new FakeJobsApi();
    const builder = newBuilder(jobsApi, { registryInsecure: true });
    await builder.build(baseSpec({ imageRef: "valet-registry:5000/octocat-hello-world:abc123" }));
    await new Promise((r) => setTimeout(r, 0));

    const cm = jobsApi.configMaps.get("valet-prebuild-pb-1-dockerfile");
    expect(cm?.data?.["buildkitd.toml"]).toBe('[registry."valet-registry:5000"]\n  http = true\n');
  });

  it("secure/external registry: ConfigMap contains only Dockerfile (no buildkitd.toml)", async () => {
    const jobsApi = new FakeJobsApi();
    const builder = newBuilder(jobsApi, { registryInsecure: false });
    await builder.build(baseSpec({ imageRef: "registry.example.com/acme-widgets:abc123" }));
    await new Promise((r) => setTimeout(r, 0));

    const cm = jobsApi.configMaps.get("valet-prebuild-pb-1-dockerfile");
    expect(cm?.data?.["buildkitd.toml"]).toBeUndefined();
    expect(cm?.data?.["Dockerfile"]).toBeDefined();
  });
});
