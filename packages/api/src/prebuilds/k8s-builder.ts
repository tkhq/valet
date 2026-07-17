/**
 * Kubernetes-backed `ImageBuilder` (sandbox images v2 plan, Task 5). Each
 * `build()` call creates three namespaced resources in the sandbox
 * namespace: a ConfigMap holding the generated Dockerfile, a Secret holding
 * the git clone token (omitted entirely when the build is tokenless — see
 * `buildKitJobManifest`'s docblock), and a `batch/v1` Job running
 * `moby/buildkit:rootless` in daemonless mode
 * (`buildctl-daemonless.sh build ...`) that clones+builds+pushes the image
 * to the configured registry.
 *
 * Unlike `DockerImageBuilder`, there is no in-process FIFO queue: each
 * build is its own Kubernetes Job, and the cluster scheduler is the
 * concurrency authority. `concurrency` (default 1) is enforced by this
 * class as a soft in-process cap on how many Jobs it will have
 * outstanding at once — extra `build()` calls queue exactly like the
 * docker builder's own FIFO, so a misconfigured caller can't flood the
 * cluster with unbounded simultaneous BuildKit Jobs.
 *
 * `status()` polls the Job's `.status` (active/succeeded/failed counts +
 * conditions) and best-effort-tails the backing pod's log. The Secret +
 * ConfigMap are deleted as soon as `status()` observes a terminal state
 * (`pushed`/`failed`) — poll-side cleanup, not a background sweep — so the
 * git token secret does not outlive the build by more than one poll
 * interval (the prebuild service polls every 10s by default, see
 * `service.ts`'s `DEFAULT_POLL_INTERVAL_MS`). `cancel()` deletes all three
 * resources immediately.
 */
import type { V1Job } from "@kubernetes/client-node";
import type { SandboxBatchJobsApi } from "@valet/sandbox-kubernetes";
import type { BuildStatus, ImageBuilder, PrebuildSpec } from "./builder.js";
import { generateDockerfile } from "./recipe.js";

/** Pinned BuildKit rootless image tag — bump deliberately, never `:latest`
 * (reproducibility: two builds of the same recipe should use the same
 * BuildKit version). */
export const BUILDKIT_IMAGE = "moby/buildkit:v0.23.2-rootless";

/** Label selector key used on both the Job and its Pod template — the
 * pod-log tail in `status()` lists pods by this selector rather than
 * assuming a pod-name convention (a Job's pod name has a random suffix). */
export const PREBUILD_LABEL_KEY = "valet.dev/prebuild";

const GIT_TOKEN_SECRET_KEY = "token";
const DOCKERFILE_CONFIGMAP_KEY = "Dockerfile";
const GIT_TOKEN_MOUNT_PATH = "/run/valet/git-token";
const DOCKERFILE_MOUNT_DIR = "/dockerfile";
const CONTEXT_MOUNT_DIR = "/ctx";
const LOG_TAIL_LINES = 200;

function jobName(id: string): string {
  return `valet-prebuild-${id}`;
}
function secretName(id: string): string {
  return `valet-prebuild-${id}-token`;
}
function configMapName(id: string): string {
  return `valet-prebuild-${id}-dockerfile`;
}

export interface BuildKitResources {
  requests?: { cpu?: string; memory?: string };
  limits?: { cpu?: string; memory?: string };
}

export interface BuildKitJobSpec {
  id: string;
  namespace: string;
  imageRef: string;
  /** `undefined` = tokenless build — no Secret is created, no `--secret`
   * flag is passed to buildctl, and the Dockerfile's `RUN
   * --mount=type=secret,id=git-token` mounts nothing (BuildKit treats an
   * unsupplied, non-`required=true` secret mount as an empty/absent file,
   * not an error — see `recipe.ts`'s `generateDockerfile`). */
  hasGitToken: boolean;
  buildkitImage: string;
  activeDeadlineSeconds: number;
  /** Only true for the bundled in-cluster registry — pushing to an
   * external registry over TLS must never set this. */
  registryInsecure: boolean;
  resources?: BuildKitResources;
}

/**
 * Pure manifest builder (no I/O) — the shape asserted by the unit tests.
 * `backoffLimit: 0` (a failed build should surface as failed immediately,
 * not silently retry with a fresh pod that resets the log tail) and
 * `restartPolicy: "Never"` (required in combination with `backoffLimit: 0`
 * — Kubernetes Jobs only accept `Never`/`OnFailure`).
 */
export function buildKitJobManifest(spec: BuildKitJobSpec): V1Job {
  const labels = { [PREBUILD_LABEL_KEY]: spec.id };

  const args = [
    "build",
    "--frontend",
    "dockerfile.v0",
    "--local",
    `context=${CONTEXT_MOUNT_DIR}`,
    "--local",
    `dockerfile=${DOCKERFILE_MOUNT_DIR}`,
  ];
  if (spec.hasGitToken) {
    args.push("--secret", `id=git-token,src=${GIT_TOKEN_MOUNT_PATH}`);
  }
  const outputOpts = ["type=image", `name=${spec.imageRef}`, "push=true"];
  if (spec.registryInsecure) outputOpts.push("registry.insecure=true");
  args.push("--output", outputOpts.join(","));

  const volumeMounts = [
    { name: "dockerfile", mountPath: DOCKERFILE_MOUNT_DIR },
    { name: "ctx", mountPath: CONTEXT_MOUNT_DIR },
  ];

  const podVolumes: { name: string; configMap?: { name: string }; secret?: { secretName: string }; emptyDir?: Record<string, never> }[] = [
    { name: "dockerfile", configMap: { name: configMapName(spec.id) } },
    { name: "ctx", emptyDir: {} },
  ];
  if (spec.hasGitToken) {
    volumeMounts.push({ name: "git-token", mountPath: GIT_TOKEN_MOUNT_PATH });
    podVolumes.push({ name: "git-token", secret: { secretName: secretName(spec.id) } });
  }

  return {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: {
      name: jobName(spec.id),
      namespace: spec.namespace,
      labels,
    },
    spec: {
      activeDeadlineSeconds: spec.activeDeadlineSeconds,
      backoffLimit: 0,
      template: {
        metadata: { labels },
        spec: {
          restartPolicy: "Never",
          // moby/buildkit:rootless needs an unconfined seccomp profile to
          // create user namespaces for its rootless runtime — documented
          // upstream requirement (github.com/moby/buildkit rootless docs),
          // not a Valet-specific choice.
          securityContext: { seccompProfile: { type: "Unconfined" } },
          containers: [
            {
              name: "buildkit",
              image: spec.buildkitImage,
              command: ["buildctl-daemonless.sh"],
              args,
              ...(spec.resources ? { resources: spec.resources } : {}),
              volumeMounts,
            },
          ],
          volumes: podVolumes,
        },
      },
    },
  };
}

/** Pure mapping of a Job's `.status` to `BuildStatus["state"]`. No I/O.
 *   - a `Failed` condition with `status: "True"`, or `failed > 0` →
 *     "failed"
 *   - a `Complete` condition with `status: "True"`, or `succeeded > 0` →
 *     "pushed"
 *   - `active` and `active > 0` → "building"
 *   - otherwise (freshly created, controller hasn't scheduled a pod yet) →
 *     "queued"
 */
export function mapJobStatus(status: {
  active?: number;
  succeeded?: number;
  failed?: number;
  conditions?: { type: string; status: "True" | "False" | "Unknown" }[];
}): BuildStatus["state"] {
  const conditions = status.conditions ?? [];
  if (conditions.some((c) => c.type === "Failed" && c.status === "True") || (status.failed ?? 0) > 0) {
    return "failed";
  }
  if (conditions.some((c) => c.type === "Complete" && c.status === "True") || (status.succeeded ?? 0) > 0) {
    return "pushed";
  }
  if ((status.active ?? 0) > 0) {
    return "building";
  }
  return "queued";
}

interface BuildRecord {
  id: string;
  spec: PrebuildSpec;
  state: BuildStatus["state"];
  error?: string;
  cleanedUp: boolean;
  hasGitToken: boolean;
}

export interface KubernetesImageBuilderOpts {
  jobsApi: SandboxBatchJobsApi;
  namespace: string;
  /** Only true for the bundled in-cluster registry. */
  registryInsecure: boolean;
  buildkitImage?: string;
  activeDeadlineSeconds?: number;
  resources?: BuildKitResources;
  /** Soft in-process cap on outstanding Jobs — extra `build()` calls queue
   * FIFO like `DockerImageBuilder`. Defaults to 1. */
  concurrency?: number;
  newId?: () => string;
}

const DEFAULT_ACTIVE_DEADLINE_SECONDS = 1800;

export class KubernetesImageBuilder implements ImageBuilder {
  readonly backend = "kubernetes";

  private readonly jobsApi: SandboxBatchJobsApi;
  private readonly namespace: string;
  private readonly registryInsecure: boolean;
  private readonly buildkitImage: string;
  private readonly activeDeadlineSeconds: number;
  private readonly resources?: BuildKitResources;
  private readonly concurrency: number;
  private readonly newId: () => string;

  private readonly builds = new Map<string, BuildRecord>();
  private readonly queue: string[] = [];
  private running = new Set<string>();
  /** buildIds `cancel()` has marked while `dispatch()` was still in flight
   * (i.e. the create-ConfigMap/Secret/Job calls hadn't all landed yet).
   * `dispatch()` checks this after each create so a build cancelled mid-
   * dispatch doesn't resurrect a Job cancel() already tried to delete. */
  private readonly cancelled = new Set<string>();
  private nextId = 1;

  constructor(opts: KubernetesImageBuilderOpts) {
    this.jobsApi = opts.jobsApi;
    this.namespace = opts.namespace;
    this.registryInsecure = opts.registryInsecure;
    this.buildkitImage = opts.buildkitImage ?? BUILDKIT_IMAGE;
    this.activeDeadlineSeconds = opts.activeDeadlineSeconds ?? DEFAULT_ACTIVE_DEADLINE_SECONDS;
    this.resources = opts.resources;
    this.concurrency = opts.concurrency ?? 1;
    this.newId = opts.newId ?? (() => String(this.nextId++));
  }

  async build(spec: PrebuildSpec): Promise<{ buildId: string }> {
    const id = this.newId();
    const buildId = `k8s-build-${id}`;
    this.builds.set(buildId, {
      id,
      spec,
      state: "queued",
      cleanedUp: false,
      hasGitToken: Boolean(spec.gitToken),
    });
    this.queue.push(buildId);
    void this.pump();
    return { buildId };
  }

  async status(buildId: string): Promise<BuildStatus> {
    const rec = this.builds.get(buildId);
    if (!rec) throw new Error(`KubernetesImageBuilder: unknown buildId "${buildId}"`);

    if (rec.state === "queued" && !this.running.has(buildId)) {
      // Still sitting in the local FIFO — no Job exists yet.
      return { state: "queued" };
    }

    const jobStatus = await this.jobsApi.getNamespacedJob({ namespace: this.namespace, name: jobName(rec.id) });
    if (jobStatus === null) {
      // Job already deleted (cancel, or a previous terminal poll's
      // cleanup raced a caller's status() — cleanup only removes the
      // Secret/ConfigMap, never the Job itself, so this indicates cancel).
      return { state: rec.state, error: rec.error };
    }

    const state = mapJobStatus(jobStatus);
    rec.state = state;

    let logTail: string | undefined;
    try {
      const pods = await this.jobsApi.listPodsForJob({
        namespace: this.namespace,
        labelSelector: `${PREBUILD_LABEL_KEY}=${rec.id}`,
      });
      const pod = pods.items[0];
      if (pod) {
        const log = await this.jobsApi.readPodLog({ namespace: this.namespace, podName: pod.name, tailLines: LOG_TAIL_LINES });
        logTail = log.length > 0 ? log : undefined;
      }
    } catch {
      // best-effort — pod not started yet, or log fetch failed transiently
    }

    if (state === "failed") {
      rec.error = rec.error ?? `buildkit Job "${jobName(rec.id)}" failed`;
    }

    if ((state === "pushed" || state === "failed") && !rec.cleanedUp) {
      rec.cleanedUp = true;
      await this.cleanupSecretsAndConfig(rec);
      this.running.delete(buildId);
      void this.pump();
    }

    return { state, logTail, error: rec.error };
  }

  async cancel(buildId: string): Promise<void> {
    const rec = this.builds.get(buildId);
    if (!rec) return;
    if (rec.state === "queued" && !this.running.has(buildId)) {
      // Never dispatched — just drop it from the local FIFO, nothing to
      // delete cluster-side.
      const idx = this.queue.indexOf(buildId);
      if (idx >= 0) this.queue.splice(idx, 1);
      rec.state = "failed";
      rec.error = "cancelled";
      return;
    }
    // Mark cancelled BEFORE the deletes below: if `dispatch()` is still
    // mid-flight (e.g. it just created the ConfigMap but hasn't created the
    // Job yet), it checks this set after each create and tears down
    // whatever it already made instead of finishing the dispatch — without
    // this flag, a create landing after this function's deletes would
    // resurrect resources cancel() just removed.
    this.cancelled.add(buildId);
    rec.cleanedUp = true;
    rec.state = "failed";
    rec.error = "cancelled";
    await this.jobsApi.deleteNamespacedJob({ namespace: this.namespace, name: jobName(rec.id) });
    await this.cleanupSecretsAndConfig(rec);
    this.running.delete(buildId);
    void this.pump();
  }

  private async cleanupSecretsAndConfig(rec: BuildRecord): Promise<void> {
    if (rec.hasGitToken) {
      await this.jobsApi.deleteSecret({ namespace: this.namespace, name: secretName(rec.id) });
    }
    await this.jobsApi.deleteConfigMap({ namespace: this.namespace, name: configMapName(rec.id) });
  }

  /** Drains the FIFO queue up to `concurrency` outstanding Jobs at once. */
  private async pump(): Promise<void> {
    while (this.running.size < this.concurrency) {
      const buildId = this.queue.shift();
      if (!buildId) return;
      const rec = this.builds.get(buildId);
      if (!rec) continue;
      this.running.add(buildId);
      // Fire-and-forget: dispatch is async, but `build()`'s own contract
      // (port doc) is "accepted", not "finished" — errors land in
      // `rec.state`/`rec.error`, never as an unhandled rejection.
      void this.dispatch(buildId, rec);
    }
  }

  private async dispatch(buildId: string, rec: BuildRecord): Promise<void> {
    try {
      const dockerfile = generateDockerfile({
        baseImage: rec.spec.baseImage,
        cloneUrl: rec.spec.cloneUrl,
        commitSha: rec.spec.commitSha,
        recipe: rec.spec.recipe,
        setup: rec.spec.setup,
      });

      await this.jobsApi.createConfigMap({
        namespace: this.namespace,
        name: configMapName(rec.id),
        data: { [DOCKERFILE_CONFIGMAP_KEY]: dockerfile },
        labels: { [PREBUILD_LABEL_KEY]: rec.id },
      });
      if (this.cancelled.has(buildId)) {
        await this.jobsApi.deleteConfigMap({ namespace: this.namespace, name: configMapName(rec.id) });
        return;
      }

      if (rec.hasGitToken) {
        await this.jobsApi.createSecret({
          namespace: this.namespace,
          name: secretName(rec.id),
          // `gitToken` is guaranteed defined here (`hasGitToken` mirrors
          // `Boolean(spec.gitToken)` at `build()` time).
          stringData: { [GIT_TOKEN_SECRET_KEY]: rec.spec.gitToken as string },
          labels: { [PREBUILD_LABEL_KEY]: rec.id },
        });
        if (this.cancelled.has(buildId)) {
          await this.cleanupSecretsAndConfig(rec);
          return;
        }
      }

      const manifest = buildKitJobManifest({
        id: rec.id,
        namespace: this.namespace,
        imageRef: rec.spec.imageRef,
        hasGitToken: rec.hasGitToken,
        buildkitImage: this.buildkitImage,
        activeDeadlineSeconds: this.activeDeadlineSeconds,
        registryInsecure: this.registryInsecure,
        resources: this.resources,
      });
      await this.jobsApi.createNamespacedJob({ namespace: this.namespace, body: manifest });
      if (this.cancelled.has(buildId)) {
        await this.jobsApi.deleteNamespacedJob({ namespace: this.namespace, name: jobName(rec.id) });
        await this.cleanupSecretsAndConfig(rec);
        return;
      }
      rec.state = "building";
    } catch (err) {
      rec.state = "failed";
      rec.error = err instanceof Error ? err.message : String(err);
      rec.cleanedUp = true;
      await this.cleanupSecretsAndConfig(rec).catch(() => {});
      this.running.delete(buildId);
      void this.pump();
    }
  }
}
