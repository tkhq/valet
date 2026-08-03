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
import { generateBaseDockerfile, generateDockerfile } from "./recipe.js";

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
const BUILDKITD_TOML_KEY = "buildkitd.toml";
const GIT_TOKEN_MOUNT_PATH = "/run/valet/git-token";
const DOCKERFILE_MOUNT_DIR = "/dockerfile";
const CONTEXT_MOUNT_DIR = "/ctx";
/** Mount path for the buildkitd config file inside the container.
 * Mounted from the same ConfigMap as the Dockerfile via `subPath`. */
const BUILDKITD_TOML_MOUNT_PATH = "/buildkitd/buildkitd.toml";
const LOG_TAIL_LINES = 200;
const BUILDKIT_CONTAINER_NAME = "buildkit";
/** Belt-and-suspenders for the poll-side Secret/ConfigMap cleanup and the
 * restart sweep: even if BOTH miss (api never observes the terminal poll AND
 * never restarts to run the sweep), the Job — and via `Background`
 * propagation its pod — is garbage-collected by the TTL-after-finished
 * controller an hour after completion, so nothing lingers unbounded. */
const TTL_SECONDS_AFTER_FINISHED = 3600;

/** Row ids (`prebuilds.id`, e.g. `pb_<uuid>`) carry characters (`_`) that are
 * invalid in a Kubernetes resource name (DNS-1123). Normalize to lowercase
 * alphanumeric + `-`, collapsing invalid runs and trimming edge dashes, so the
 * SAME row id maps to the SAME resource names at both `build()` and
 * `cleanupOrphan()` time. */
export function prebuildResourceId(prebuildId: string): string {
  return prebuildId
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Swap the registry HOST prefix of a fully-qualified pull ref for the PUSH
 * host, leaving the image path + tag untouched. Pure, no I/O.
 *
 * Prebuild image refs are stored PULL-hosted (the host kubelet resolves when
 * pulling the image onto a sandbox pod — for the bundled registry that's a
 * node-reachable `localhost:<nodePort>`). BuildKit Jobs and the api pod's
 * retention deletes, however, reach the SAME registry over the in-cluster
 * Service DNS (the PUSH host). This helper rewrites `<pullHost>/<path>:<tag>`
 * to `<pushHost>/<path>:<tag>`.
 *
 * No-ops (returns the ref unchanged) when `pushHost` is undefined/empty (no
 * split configured — push and pull are the same host, e.g. an external
 * registry or a raw dev cluster), when the pull host already equals the push
 * host, or when the ref has no `/` host segment (a docker-backend-shaped ref
 * like `valet-prebuild/foo:sha`, never expected here — defensive).
 */
export function pushRefFor(pullRef: string, pushHost: string | undefined): string {
  if (!pushHost) return pullRef;
  const slash = pullRef.indexOf("/");
  if (slash < 0) return pullRef;
  const pullHost = pullRef.slice(0, slash);
  if (pullHost === pushHost) return pullRef;
  return `${pushHost}${pullRef.slice(slash)}`;
}

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
  /** The PUSH host (in-cluster Service DNS) BuildKit reaches the registry at.
   * `imageRef` is PULL-hosted (what kubelet later pulls the image by); the
   * `--output name=` swaps this host in via `pushRefFor`. `undefined` = no
   * split (push == pull host), so the ref is pushed as-is. */
  registryPushHost?: string;
  resources?: BuildKitResources;
}

/**
 * Generate a minimal `buildkitd.toml` that marks `host` as a plain-HTTP
 * registry. Only called when `registryInsecure` is true (the bundled
 * in-cluster registry). Pure, no I/O.
 *
 * `buildctl-daemonless.sh` starts a short-lived buildkitd in the background
 * and passes `$BUILDKITD_FLAGS` as extra flags. Appending
 * `--config=<path>` points buildkitd at this file, which makes it resolve
 * FROM pulls (and any cache imports) over HTTP rather than HTTPS — the same
 * trust boundary already applied to the output push via `registry.insecure=true`
 * in `--output`. Without this, BuildKit attempts HTTPS for the base-image
 * pull and fails with "server gave HTTP response to HTTPS client".
 */
export function buildkitdToml(host: string): string {
  return `[registry."${host}"]\n  http = true\n`;
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
  // Push target = the PULL ref with its host swapped for the in-cluster PUSH
  // host (BuildKit reaches the registry over Service DNS, not the node-facing
  // pull host). No-op when no push host is configured.
  const pushRef = pushRefFor(spec.imageRef, spec.registryPushHost);
  const outputOpts = ["type=image", `name=${pushRef}`, "push=true"];
  if (spec.registryInsecure) outputOpts.push("registry.insecure=true");
  args.push("--output", outputOpts.join(","));

  // When the registry is insecure (bundled in-cluster registry), buildkitd
  // needs a config file to resolve FROM pulls over HTTP. The toml is stored as
  // a second key in the Dockerfile ConfigMap and mounted via subPath so it
  // does not interfere with the Dockerfile mount. BUILDKITD_FLAGS is extended
  // to point buildctl-daemonless.sh's background buildkitd at the config file.
  // A TLS external registry must never get http=true — this block is gated on
  // the same `registryInsecure` flag that gates `registry.insecure=true` on
  // the output side.
  const volumeMounts: { name: string; mountPath: string; subPath?: string }[] = [
    { name: "dockerfile", mountPath: DOCKERFILE_MOUNT_DIR },
    { name: "ctx", mountPath: CONTEXT_MOUNT_DIR },
  ];
  if (spec.registryInsecure) {
    // Mount only the toml key from the ConfigMap — the Dockerfile key is already
    // mounted at the directory level above. subPath mounts survive ConfigMap
    // updates and do not expose other keys.
    volumeMounts.push({ name: "dockerfile", mountPath: BUILDKITD_TOML_MOUNT_PATH, subPath: BUILDKITD_TOML_KEY });
  }

  const podVolumes: { name: string; configMap?: { name: string }; secret?: { secretName: string }; emptyDir?: Record<string, never> }[] = [
    { name: "dockerfile", configMap: { name: configMapName(spec.id) } },
    { name: "ctx", emptyDir: {} },
  ];
  if (spec.hasGitToken) {
    volumeMounts.push({ name: "git-token", mountPath: GIT_TOKEN_MOUNT_PATH });
    podVolumes.push({ name: "git-token", secret: { secretName: secretName(spec.id) } });
  }

  // `buildctl-daemonless.sh` passes BUILDKITD_FLAGS to the backgrounded
  // buildkitd process. When insecure, append `--config=` so buildkitd reads
  // the toml that marks the push host as HTTP — this covers FROM pulls, cache
  // imports, and any other registry interaction buildkitd makes, not just the
  // output push (which is covered by `registry.insecure=true` in --output).
  const buildkitdFlags = spec.registryInsecure
    ? `--oci-worker-no-process-sandbox --config=${BUILDKITD_TOML_MOUNT_PATH}`
    : "--oci-worker-no-process-sandbox";

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
      ttlSecondsAfterFinished: TTL_SECONDS_AFTER_FINISHED,
      template: {
        metadata: {
          labels,
          // moby/buildkit:rootless also needs AppArmor unconfined (alongside
          // the seccomp profile below) to set up its rootless user namespace
          // on AppArmor-enforcing nodes (Ubuntu/Debian defaults). Use the
          // per-container ANNOTATION form (keyed by container name) rather
          // than the newer securityContext.appArmorProfile field: the field
          // only exists on k8s >= 1.30, whereas the annotation is honored
          // across the versions this chart targets.
          annotations: {
            [`container.apparmor.security.beta.kubernetes.io/${BUILDKIT_CONTAINER_NAME}`]: "unconfined",
          },
        },
        spec: {
          restartPolicy: "Never",
          // moby/buildkit:rootless needs an unconfined seccomp profile to
          // create user namespaces for its rootless runtime, PLUS
          // runAsUser/runAsGroup 1000 (the rootless image's built-in
          // unprivileged user) — documented upstream requirement
          // (moby/buildkit kubernetes rootless examples:
          // https://github.com/moby/buildkit/blob/master/docs/rootless.md
          // and examples/kubernetes/), not a Valet-specific choice.
          // Consolidated at pod level since it applies to the single
          // buildkit container.
          securityContext: { runAsUser: 1000, runAsGroup: 1000, seccompProfile: { type: "Unconfined" } },
          containers: [
            {
              name: BUILDKIT_CONTAINER_NAME,
              image: spec.buildkitImage,
              command: ["buildctl-daemonless.sh"],
              args,
              // Also required for rootless BuildKit on Kubernetes when not
              // running privileged: without this, the first RUN step fails
              // with "runc run failed: ... error mounting proc to rootfs at
              // /proc: operation not permitted" (moby/buildkit rootless
              // docs/examples).
              env: [{ name: "BUILDKITD_FLAGS", value: buildkitdFlags }],
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
  /** DNS-safe resource-name stem derived from the PERSISTED prebuild ROW id
   * (`prebuildResourceId(spec.prebuildId)`). Job/Secret/ConfigMap names +
   * the pod label selector are all built from this — NOT from the internal
   * counter `id` — so `cleanupOrphan(prebuildId)` can address the same
   * resources by row id after a restart drops the in-memory build map. */
  resourceId: string;
  spec: PrebuildSpec;
  state: BuildStatus["state"];
  error?: string;
  cleanedUp: boolean;
  hasGitToken: boolean;
  /** Set true the instant `dispatch()`'s `createNamespacedJob` call
   * succeeds. `status()` uses this — NOT `rec.state` — to tell "the Job
   * hasn't been created yet (dispatch still creating the ConfigMap/Secret,
   * or not yet scheduled)" apart from "the Job WAS created and is now gone
   * out-of-band". Only the latter is a real failure; the former is a race
   * between a `status()` poll landing right after `build()`/`pump()` return
   * and the fire-and-forget `dispatch()` that hasn't reached
   * `createNamespacedJob` yet — see the `status()` null-Job branch. */
  jobCreated: boolean;
}

export interface KubernetesImageBuilderOpts {
  jobsApi: SandboxBatchJobsApi;
  namespace: string;
  /** Only true for the bundled in-cluster registry. */
  registryInsecure: boolean;
  /** In-cluster Service DNS host BuildKit pushes to (swapped into the pull
   * ref's `--output name=`). `VALET_PREBUILD_REGISTRY_PUSH`; undefined = push
   * to the pull host as-is (external registry / no split). */
  registryPushHost?: string;
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
  private readonly registryPushHost?: string;
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
    this.registryPushHost = opts.registryPushHost;
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
      resourceId: prebuildResourceId(spec.prebuildId),
      spec,
      state: "queued",
      cleanedUp: false,
      hasGitToken: Boolean(spec.gitToken),
      jobCreated: false,
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

    const jobStatus = await this.jobsApi.getNamespacedJob({ namespace: this.namespace, name: jobName(rec.resourceId) });
    if (jobStatus === null) {
      if (rec.state === "pushed" || rec.state === "failed") {
        // Already terminal (typically `cancel()`, which sets rec.state to
        // "failed" itself before deleting the Job) — nothing new to map.
        return { state: rec.state, error: rec.error };
      }
      if (!rec.jobCreated) {
        // `dispatch()` hasn't reached `createNamespacedJob` yet (it's still
        // creating the ConfigMap/Secret, or hasn't run at all) — this
        // `status()` call raced `build()`/`pump()`. There is no Job to have
        // gone missing; report the current (queued/building) state
        // untouched. Do NOT run cleanup here — the ConfigMap dispatch just
        // created (or is about to) must not be deleted out from under it,
        // or the Job dispatch creates next fails to mount it.
        return { state: rec.state, error: rec.error };
      }
      // We believed this build was queued-and-dispatched or actively
      // building, but the Job is gone — e.g. someone ran `kubectl delete
      // job` directly on the in-flight Job rather than going through our
      // `cancel()`. Map that to a terminal failure (and run the same
      // cleanup + queue-release path a normal terminal poll takes) instead
      // of leaving the row stuck at its last-observed state forever, which
      // would also wedge the concurrency slot it occupies.
      rec.state = "failed";
      rec.error = rec.error ?? "build job deleted";
      if (!rec.cleanedUp) {
        rec.cleanedUp = true;
        await this.cleanupSecretsAndConfig(rec);
        this.running.delete(buildId);
        void this.pump();
      }
      return { state: rec.state, error: rec.error };
    }

    const state = mapJobStatus(jobStatus);
    rec.state = state;

    let logTail: string | undefined;
    try {
      const pods = await this.jobsApi.listPodsForJob({
        namespace: this.namespace,
        labelSelector: `${PREBUILD_LABEL_KEY}=${rec.resourceId}`,
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
      rec.error = rec.error ?? `buildkit Job "${jobName(rec.resourceId)}" failed`;
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
    await this.jobsApi.deleteNamespacedJob({ namespace: this.namespace, name: jobName(rec.resourceId) });
    await this.cleanupSecretsAndConfig(rec);
    this.running.delete(buildId);
    void this.pump();
  }

  private async cleanupSecretsAndConfig(rec: BuildRecord): Promise<void> {
    if (rec.hasGitToken) {
      await this.jobsApi.deleteSecret({ namespace: this.namespace, name: secretName(rec.resourceId) });
    }
    await this.jobsApi.deleteConfigMap({ namespace: this.namespace, name: configMapName(rec.resourceId) });
  }

  /** Restart-recovery cleanup (see `ImageBuilder.cleanupOrphan`). Addresses
   * the Job + Secret + ConfigMap by the DURABLE prebuild ROW id — not the
   * in-memory `buildId`, which a restart drops — so `sweepOrphanedBuilds`
   * can reclaim resources an interrupted build left behind. Each delete is
   * best-effort and independent: a 404 is already treated as success by the
   * adapter, and any other per-resource failure is swallowed so one stuck
   * delete never blocks the other two. */
  async cleanupOrphan(prebuildId: string): Promise<void> {
    const name = prebuildResourceId(prebuildId);
    await this.jobsApi
      .deleteNamespacedJob({ namespace: this.namespace, name: jobName(name) })
      .catch(() => {});
    await this.jobsApi
      .deleteSecret({ namespace: this.namespace, name: secretName(name) })
      .catch(() => {});
    await this.jobsApi
      .deleteConfigMap({ namespace: this.namespace, name: configMapName(name) })
      .catch(() => {});
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
      // Rewrite the base image's pull host to the push host so BuildKit can
      // fetch it over in-cluster Service DNS rather than the node-local pull
      // host (unreachable from a BuildKit pod). Mirrors the output-ref rewrite
      // (`pushRefFor` on `imageRef` → `--output name=`) applied below in
      // `buildKitJobManifest`. Host-agnostic generation stays in recipe.ts —
      // the rewrite lives here at the builder boundary only.
      const baseImage = pushRefFor(rec.spec.baseImage, this.registryPushHost);
      const dockerfile =
        rec.spec.kind === "base"
          ? generateBaseDockerfile({ baseImage, setup: rec.spec.setup ?? [] })
          : generateDockerfile({
              baseImage,
              cloneUrl: rec.spec.cloneUrl,
              commitSha: rec.spec.commitSha,
              recipe: rec.spec.recipe,
              setup: rec.spec.setup,
            });

      // When the registry is insecure, include a buildkitd.toml in the ConfigMap
      // so BuildKit can resolve FROM pulls over HTTP. The push host drives the
      // toml — it is the host BuildKit contacts for all registry operations
      // (output push AND base-image pull), so it must be marked http=true.
      // When no push host is configured, fall back to the pull host extracted
      // from imageRef (push == pull host in that case). Gate on registryInsecure
      // so a TLS external registry never gets an http=true entry.
      const configMapData: Record<string, string> = { [DOCKERFILE_CONFIGMAP_KEY]: dockerfile };
      if (this.registryInsecure) {
        const tomlHost =
          this.registryPushHost ??
          (() => {
            const slash = rec.spec.imageRef.indexOf("/");
            return slash >= 0 ? rec.spec.imageRef.slice(0, slash) : rec.spec.imageRef;
          })();
        configMapData[BUILDKITD_TOML_KEY] = buildkitdToml(tomlHost);
      }

      await this.jobsApi.createConfigMap({
        namespace: this.namespace,
        name: configMapName(rec.resourceId),
        data: configMapData,
        labels: { [PREBUILD_LABEL_KEY]: rec.resourceId },
      });
      if (this.cancelled.has(buildId)) {
        await this.jobsApi.deleteConfigMap({ namespace: this.namespace, name: configMapName(rec.resourceId) });
        return;
      }

      if (rec.hasGitToken) {
        await this.jobsApi.createSecret({
          namespace: this.namespace,
          name: secretName(rec.resourceId),
          // `gitToken` is guaranteed defined here (`hasGitToken` mirrors
          // `Boolean(spec.gitToken)` at `build()` time).
          stringData: { [GIT_TOKEN_SECRET_KEY]: rec.spec.gitToken as string },
          labels: { [PREBUILD_LABEL_KEY]: rec.resourceId },
        });
        if (this.cancelled.has(buildId)) {
          await this.cleanupSecretsAndConfig(rec);
          return;
        }
      }

      const manifest = buildKitJobManifest({
        id: rec.resourceId,
        namespace: this.namespace,
        imageRef: rec.spec.imageRef,
        hasGitToken: rec.hasGitToken,
        buildkitImage: this.buildkitImage,
        activeDeadlineSeconds: this.activeDeadlineSeconds,
        registryInsecure: this.registryInsecure,
        registryPushHost: this.registryPushHost,
        resources: this.resources,
      });
      await this.jobsApi.createNamespacedJob({ namespace: this.namespace, body: manifest });
      // From this point on, a `status()` poll that sees a missing Job means
      // the Job WAS created and is now gone out-of-band — not that dispatch
      // is still in flight. Set this before the cancelled-check below so a
      // `cancel()` racing right here still sees a Job it needs to delete.
      rec.jobCreated = true;
      if (this.cancelled.has(buildId)) {
        await this.jobsApi.deleteNamespacedJob({ namespace: this.namespace, name: jobName(rec.resourceId) });
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
