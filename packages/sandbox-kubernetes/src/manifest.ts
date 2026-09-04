/**
 * Pure Sandbox CR name derivation + manifest construction (decision 5).
 *
 * No Kubernetes client calls happen in this module — it only builds plain
 * objects. Verified against the vendored agent-sandbox v0.5.1 CRD (see
 * ./types.ts docblock for the source URL and confirmed shape).
 */
import { createHash } from "node:crypto";
import type { SandboxCreateOpts } from "@valet/engine";
import { DEFAULT_WORKSPACE_STORAGE_MAX, clampStorageRequest, parseStorageQuantity } from "./quantity.js";
import type {
  K8sProviderConfig,
  ResourceList,
  ResourceRequirements,
  SandboxContainer,
  SandboxCR,
  SandboxResourceOpts,
  Volume,
} from "./types.js";

const MAX_NAME_LENGTH = 63;
const HASH_SUFFIX_LENGTH = 8;
/** Fallback `/workspace` claim size when the provider config names none.
 * Kept equal to the api's `resolveSandboxWorkspaceStorage` default so a
 * caller that skips the env knob gets the same volume a deploy does. */
const DEFAULT_STORAGE = "1Gi";

/** `full`-profile container command — starts the interactive services (ttyd,
 * code-server, auth gateway) instead of the bare `tail -f /dev/null`
 * placeholder. The image ENTRYPOINT is bypassed by this explicit `command`. */
// Probe-and-degrade, matching sandbox-docker's full-profile command
// (packages/sandbox-docker/src/sandbox.ts): an image without /start-full.sh
// (stale pre-unification bake, custom override) degrades to the tail
// placeholder instead of PID 1 exiting 127 forever (CrashLoopBackOff). The
// agent still works over the exec surface; the gateway-fronted tabs 502
// until a full-capable image lands.
const FULL_PROFILE_COMMAND = [
  "sh",
  "-c",
  "[ -f /start-full.sh ] && exec /bin/bash /start-full.sh || exec tail -f /dev/null",
];

export const WORKSPACE_VOLUME_NAME = "workspace";
export const WORKSPACE_MOUNT_PATH = "/workspace";
export const SESSION_LABEL_KEY = "valet.dev/session-id";
/** Pod-template label every sandbox pod carries. The topology spread
 * constraint's labelSelector counts pods by it, so sandboxes spread across
 * nodes as one group. Set on the POD template (not just the CR): the
 * controller is not guaranteed to propagate CR labels onto the pod. */
export const SANDBOX_POD_LABEL_KEY = "valet.dev/sandbox";
/** CR annotation carrying the owning session's id (`SandboxCreateOpts.sessionId`).
 * An annotation, not a label: session ids contain characters a label value
 * rejects (`:` in `wf:{runId}:{nodeId}`). The reconcile sweep reads it back
 * through `SandboxProvider.list` to map a CR to its session; absent on CRs
 * created before session stamping existed. */
export const SESSION_ANNOTATION_KEY = "valet.dev/session";
export const SANDBOX_CONTAINER_NAME = "sandbox";

/** Mount path for the per-sandbox credential files (see `SandboxCreateOpts.credsFiles`). */
export const CREDS_MOUNT_PATH = "/etc/valet/creds";
/** Volume name for the per-sandbox credential Secret volume. */
export const CREDS_VOLUME_NAME = "valet-creds";

/** Volume name for the rootless Docker data-root emptyDir (rootless DinD). */
export const DOCKER_STATE_VOLUME_NAME = "docker-state";
/** Mount path for the rootless Docker data-root inside the container. */
export const DOCKER_STATE_MOUNT_PATH = "/home/dockerd/.local/share/docker";
/** CR label marking a docker-enabled sandbox. `restore()` re-derives the
 * exec-identity flag from this label (the CR is the only state that
 * survives an api restart — mirrors how `spec.service` records the
 * profile). Value is always "true"; the label is absent otherwise. */
export const DOCKER_LABEL_KEY = "valet.dev/docker";
/** The `dockerd` workload user's uid/gid (docker/Dockerfile.sandbox-k8s
 * `useradd -m -u 1500 dockerd`). Used as the pod-level `fsGroup` so the
 * kubelet makes the workspace PVC group-writable by that user. */
export const DOCKER_WORKLOAD_FS_GROUP = 1500;

/** Returns the name of the Kubernetes Secret backing the creds volume for a sandbox. */
export function credsSecretName(sandboxName: string): string {
  return `valet-creds-${sandboxName}`;
}

/** Lowercases and strips everything outside `[a-z0-9-]`, collapsing runs of
 * dashes and trimming leading/trailing dashes. Does NOT enforce the length
 * bound — callers apply truncation + hash suffixing separately. */
function sanitizeToRfc1123Chars(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Short, deterministic hash of the original (pre-sanitization) input, used
 * as a collision-resistant suffix whenever truncation could otherwise make
 * two distinct inputs produce the same name. */
function shortHash(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, HASH_SUFFIX_LENGTH);
}

/** Derives a deterministic, RFC1123-safe (lowercase alphanumeric + dashes,
 * no leading/trailing dash), <=63-char identifier from an arbitrary input
 * string (e.g. a session key like "orchestrator:user123"). When sanitization
 * or truncation would risk a collision, a hash suffix derived from the
 * original input is appended so that two inputs differing only past the
 * truncation point still resolve to distinct names. */
function deterministicRfc1123(input: string): string {
  const sanitized = sanitizeToRfc1123Chars(input);

  if (sanitized.length === 0) {
    return `x-${shortHash(input)}`;
  }

  if (sanitized.length <= MAX_NAME_LENGTH) {
    return sanitized;
  }

  const hash = shortHash(input);
  const budget = MAX_NAME_LENGTH - HASH_SUFFIX_LENGTH - 1; // 1 for the joining dash
  const truncated = sanitized.slice(0, budget).replace(/-+$/g, "");
  return `${truncated}-${hash}`;
}

/** Deterministic, RFC1123-safe Sandbox CR name for a session key. Two
 * distinct session keys that only diverge after the truncation point still
 * produce distinct names (collision resistance via the hash suffix). */
export function sandboxCrName(sessionKey: string): string {
  return deterministicRfc1123(sessionKey);
}

/** Per-field merge of `cfg.defaultResources` under `opts.resources` — an
 * opts field wins only when it is defined. Merged per-field, not
 * all-or-nothing: the ephemeral-storage defaults are node-disk protection
 * (TKAI-349) and must survive a caller that only picks cpu/memory. */
function mergeResourceOpts(
  defaults: SandboxResourceOpts | undefined,
  overrides: SandboxResourceOpts | undefined,
): SandboxResourceOpts | undefined {
  if (!defaults && !overrides) return undefined;
  const merged: SandboxResourceOpts = { ...defaults };
  if (overrides?.cpu !== undefined) merged.cpu = overrides.cpu;
  if (overrides?.memory !== undefined) merged.memory = overrides.memory;
  if (overrides?.ephemeralStorage !== undefined) merged.ephemeralStorage = overrides.ephemeralStorage;
  if (overrides?.ephemeralStorageLimit !== undefined) {
    merged.ephemeralStorageLimit = overrides.ephemeralStorageLimit;
  }
  return merged;
}

/** Maps merged resource opts to `corev1.ResourceRequirements`. cpu/memory
 * request equals limit (Guaranteed-style, unchanged). ephemeral-storage
 * request and limit are independent and differ on purpose: the request caps
 * how many sandboxes the scheduler stacks per node; the limit makes the
 * kubelet evict one runaway sandbox instead of the node going NotReady. An
 * absent side is omitted — no fallback from one to the other, so an
 * operator can disable either knob ("0" in sandbox-backend.ts) alone. */
function resourceRequirementsFrom(resources: SandboxResourceOpts): ResourceRequirements | undefined {
  const requests: ResourceList = {};
  const limits: ResourceList = {};
  if (resources.cpu !== undefined) {
    requests.cpu = String(resources.cpu);
    limits.cpu = String(resources.cpu);
  }
  if (resources.memory !== undefined) {
    requests.memory = resources.memory;
    limits.memory = resources.memory;
  }
  if (resources.ephemeralStorage !== undefined) {
    requests["ephemeral-storage"] = resources.ephemeralStorage;
  }
  if (resources.ephemeralStorageLimit !== undefined) {
    limits["ephemeral-storage"] = resources.ephemeralStorageLimit;
  }
  if (Object.keys(requests).length === 0 && Object.keys(limits).length === 0) return undefined;
  return {
    ...(Object.keys(requests).length > 0 ? { requests } : {}),
    ...(Object.keys(limits).length > 0 ? { limits } : {}),
  };
}

/**
 * Workspace claim target (TKAI-385): a repo-declared request
 * (`SandboxCreateOpts.workspaceStorage`) wins over the deploy default,
 * CLAMPED to the growth cap. A repo cannot request unbounded storage. An
 * unparseable request or cap falls back to the default with a log. A fresh
 * claim starts at this target. During adoption, the provider uses this target
 * for a best-effort grow of an undersized claim. It never shrinks a claim or
 * waits for volume readiness. Exported for direct unit coverage.
 */
export function resolveWorkspaceStorageRequest(
  cfg: K8sProviderConfig,
  opts: SandboxCreateOpts,
  name: string,
): string {
  const fallback = cfg.defaultStorage ?? DEFAULT_STORAGE;
  if (!opts.workspaceStorage) return fallback;
  const max = cfg.workspaceStorageMax ?? DEFAULT_WORKSPACE_STORAGE_MAX;
  const clamp = clampStorageRequest(opts.workspaceStorage, max);
  if (clamp === null) {
    console.error(
      `k8s sandbox ${name}: workspaceStorage "${opts.workspaceStorage}" (cap "${max}") is not a parseable quantity — using ${fallback}`,
    );
    return fallback;
  }
  if (clamp.clamped) {
    console.warn(
      `k8s sandbox ${name}: repo-declared workspaceStorage ${opts.workspaceStorage} exceeds the ${max} cap — clamped`,
    );
  }
  // The deploy default is a FLOOR (TKAI-403): a repo may grow its workspace,
  // never shrink it below what the deploy provisions for undeclared repos —
  // a below-default claim just burns the one ~6h EBS grow on a size the
  // deploy already knew was too small. The floor itself is capped: a config
  // that carries a default ABOVE the cap (the boot check catches the env
  // route, but direct configs exist) must not let the floor un-do the clamp.
  const fallbackBytes = parseStorageQuantity(fallback);
  const clampBytes = parseStorageQuantity(clamp.storage);
  if (fallbackBytes !== null && clampBytes !== null && clampBytes < fallbackBytes) {
    const maxBytes = parseStorageQuantity(max);
    const floor = maxBytes !== null && maxBytes < fallbackBytes ? max.trim() : fallback.trim();
    console.log(
      `k8s sandbox ${name}: repo-declared workspaceStorage ${opts.workspaceStorage} is below the ${floor} deploy floor — using the floor`,
    );
    return floor;
  }
  return clamp.storage;
}

/**
 * Builds the Sandbox custom resource for a session. `name` is expected to
 * already be a valid CR name (typically the output of `sandboxCrName`); it
 * is reused as the `valet.dev/session-id` label value since it is already
 * RFC1123-safe and within the 63-char label-value bound.
 *
 * There is intentionally NO top-level image/env/resources field — those all
 * live inside `spec.podTemplate.spec` (a full corev1.PodSpec), matching the
 * real CRD shape (see ./types.ts).
 */
export function buildSandboxManifest(
  cfg: K8sProviderConfig,
  name: string,
  opts: SandboxCreateOpts,
): SandboxCR {
  const image = opts.image ?? cfg.defaultImage;
  const resourceOpts = mergeResourceOpts(cfg.defaultResources, opts.resources);
  const resourceRequirements = resourceOpts ? resourceRequirementsFrom(resourceOpts) : undefined;

  const container: SandboxContainer = {
    name: SANDBOX_CONTAINER_NAME,
    image,
    // Non-terminating placeholder — mirrors sandbox-docker's
    // `sh -c "tail -f /dev/null"` idiom (packages/sandbox-docker/src/sandbox.ts).
    // The controller/exec surface does the actual work; this just keeps the
    // container's PID 1 alive.
    command: ["sh", "-c", "tail -f /dev/null"],
    volumeMounts: [{ name: WORKSPACE_VOLUME_NAME, mountPath: WORKSPACE_MOUNT_PATH }],
    // See SandboxContainer.workingDir's docblock (types.ts) — the k8s
    // pods/exec API has no per-call --workdir, so this container-level
    // default is what makes relative-path exec/file ops land on the
    // persistent /workspace volume instead of the ephemeral rootfs.
    workingDir: WORKSPACE_MOUNT_PATH,
  };

  if (opts.env && Object.keys(opts.env).length > 0) {
    container.env = Object.entries(opts.env).map(([envName, value]) => ({ name: envName, value }));
  }

  if (resourceRequirements) {
    container.resources = resourceRequirements;
  }

  const isFullProfile = opts.profile === "full";
  if (isFullProfile) {
    container.command = FULL_PROFILE_COMMAND;
  }

  // Creds volume mount — whole-directory mount (no subPath). subPath breaks
  // kubelet live-reload; the whole directory must be mounted for Secret
  // updates to propagate into a running pod without restart.
  const hasCredsFiles = opts.credsFiles && Object.keys(opts.credsFiles).length > 0;
  if (hasCredsFiles) {
    container.volumeMounts = [
      ...(container.volumeMounts ?? []),
      { name: CREDS_VOLUME_NAME, mountPath: CREDS_MOUNT_PATH },
    ];
  }

  // DinD, rootful-inside-the-pod-user-namespace: seccomp Unconfined,
  // VALET_SANDBOX_DOCKER env, docker-state emptyDir. The pod IS a user
  // namespace (hostUsers: false below), so dockerd runs as in-container
  // root — which holds NET_ADMIN over the pod netns (native bridge
  // networking, no slirp4netns/tun) and mounts overlayfs natively
  // (kernel >= 5.11 in-userns overlay, no fuse). No device hostPaths: a
  // hostPath char device cannot be idmap-mounted into a userns pod
  // (devtmpfs has no idmap support — runc fails with MOUNT_ATTR_IDMAP
  // EINVAL). VALET_DOCKER_USERNS=1 selects the rootful branch in
  // start-docker.sh; the docker (local dev) backend keeps rootlesskit.
  // Never sets privileged.
  if (opts.docker) {
    container.securityContext = {
      seccompProfile: { type: "Unconfined" },
      capabilities: { add: ["SYS_ADMIN", "NET_ADMIN"] },
      procMount: "Unmasked",
    };
    container.env = [
      ...(container.env ?? []),
      { name: "VALET_SANDBOX_DOCKER", value: "1" },
      { name: "VALET_DOCKER_USERNS", value: "1" },
    ];
    container.volumeMounts = [
      ...(container.volumeMounts ?? []),
      { name: DOCKER_STATE_VOLUME_NAME, mountPath: DOCKER_STATE_MOUNT_PATH },
    ];
    if (!isFullProfile) {
      container.command = [
        "sh",
        "-c",
        "[ -f /start-headless.sh ] && exec /bin/bash /start-headless.sh || exec tail -f /dev/null",
      ];
    }
  }

  const podSpec: SandboxCR["spec"]["podTemplate"]["spec"] = {
    containers: [container],
    restartPolicy: "Always",
    // Soft hostname spread over the shared sandbox pod label (TKAI-349).
    // ScheduleAnyway on purpose: sandboxes must still schedule under
    // pressure; the ephemeral-storage request above is the hard
    // concentration cap.
    topologySpreadConstraints: [
      {
        maxSkew: 1,
        topologyKey: "kubernetes.io/hostname",
        whenUnsatisfiable: "ScheduleAnyway",
        labelSelector: { matchLabels: { [SANDBOX_POD_LABEL_KEY]: "true" } },
      },
    ],
  };
  if (opts.docker) {
    // Pod-level fsGroup: the workspace PVC mounts group-owned by the
    // dockerd user's gid, so non-privileged (dockerd) execs can write
    // /workspace — the k8s analog of start-docker.sh's `chown /workspace`.
    podSpec.securityContext = { fsGroup: DOCKER_WORKLOAD_FS_GROUP };
    // Required companion of `procMount: Unmasked`: k8s validation ties the
    // two together ("hostUsers must be false to use Unmasked"), enforced
    // once the ProcMountType gate is on (default from 1.33). Clusters with
    // UserNamespacesSupport off drop the field on admission — inert there,
    // load-bearing after a cluster upgrade. The dockerd user's /etc/subuid
    // range must fit inside the pod user namespace (see
    // docker/Dockerfile.sandbox-k8s).
    podSpec.hostUsers = false;
    // Writable, delegated cgroups. The kubelet-default cgroupfs mount is
    // read-only AND owned by unmapped host root, so runc inside the
    // sandbox cannot create per-container groups — every `docker run`
    // fails ("mkdir /sys/fs/cgroup/docker: read-only file system", or
    // EACCES after a rw remount). The named RuntimeClass maps to a
    // containerd runtime with `cgroup_writable = true`, which fixes both
    // the mount flags and — under the systemd cgroup driver — the
    // ownership. See K8sProviderConfig.dockerRuntimeClassName.
    if (cfg.dockerRuntimeClassName) {
      podSpec.runtimeClassName = cfg.dockerRuntimeClassName;
    }
  }
  if (cfg.imagePullSecrets && cfg.imagePullSecrets.length > 0) {
    podSpec.imagePullSecrets = cfg.imagePullSecrets;
  }

  if (hasCredsFiles) {
    const credsVolume: Volume = {
      name: CREDS_VOLUME_NAME,
      secret: { secretName: credsSecretName(name), optional: true },
    };
    podSpec.volumes = [credsVolume];
  }

  if (opts.docker) {
    // sizeLimit pins the docker-state emptyDir (image layers + container
    // rootfs — the largest node-disk consumer, TKAI-349) at the container's
    // ephemeral-storage limit; emptyDir usage counts against that limit, so
    // a larger sizeLimit would be unreachable anyway. No limit configured →
    // unbounded emptyDir, unchanged.
    const dockerStateSizeLimit = resourceOpts?.ephemeralStorageLimit;
    podSpec.volumes = [
      ...(podSpec.volumes ?? []),
      {
        name: DOCKER_STATE_VOLUME_NAME,
        emptyDir: dockerStateSizeLimit ? { sizeLimit: dockerStateSizeLimit } : {},
      },
    ];
  }

  const spec: SandboxCR["spec"] = {
    podTemplate: {
      metadata: {
        // The spread constraint's labelSelector counts pods by this label —
        // see SANDBOX_POD_LABEL_KEY.
        labels: { [SANDBOX_POD_LABEL_KEY]: "true" },
        ...(opts.docker
          ? {
              annotations: {
                [`container.apparmor.security.beta.kubernetes.io/${SANDBOX_CONTAINER_NAME}`]: "unconfined",
              },
            }
          : {}),
      },
      spec: podSpec,
    },
    volumeClaimTemplates: [
      {
        metadata: { name: WORKSPACE_VOLUME_NAME },
        spec: {
          accessModes: ["ReadWriteOnce"],
          resources: {
            requests: { storage: resolveWorkspaceStorageRequest(cfg, opts, name) },
          },
        },
      },
    ],
  };
  if (isFullProfile) {
    spec.service = true;
  }

  const labels: Record<string, string> = { [SESSION_LABEL_KEY]: name };
  if (opts.docker) labels[DOCKER_LABEL_KEY] = "true";

  return {
    apiVersion: cfg.apiVersion,
    kind: "Sandbox",
    metadata: {
      name,
      labels,
      ...(opts.sessionId ? { annotations: { [SESSION_ANNOTATION_KEY]: opts.sessionId } } : {}),
    },
    spec,
  };
}
