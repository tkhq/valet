/**
 * Types for the `@valet/sandbox-kubernetes` provider (decision 5 of
 * docs/specs/2026-07-15-kubernetes-deployment-design.md).
 *
 * The `SandboxCR` interfaces below are a hand-written subset of the
 * kubernetes-sigs/agent-sandbox `Sandbox` custom resource, API group
 * `agents.x-k8s.io`, version `v1beta1` (the CRD serves both v1alpha1 and
 * v1beta1; we pin v1beta1 here). They cover only the fields this package
 * emits or reads — NOT the full CRD schema. Verified against the vendored
 * CRD manifest at tag v0.5.1:
 *
 *   https://raw.githubusercontent.com/kubernetes-sigs/agent-sandbox/v0.5.1/helm/crds/agents.x-k8s.io_sandboxes.yaml
 *
 * Confirmed shape (spec.podTemplate is required; there is NO top-level
 * image/env/resources field on the CR — those live inside
 * `spec.podTemplate.spec`, a full `corev1.PodSpec`):
 *
 *   spec:
 *     operatingMode: Running | Suspended   # default Running
 *     podTemplate:
 *       metadata: { annotations?, labels? }
 *       spec: <corev1.PodSpec>             # containers required
 *     shutdownPolicy: Delete | Retain      # default Retain
 *     shutdownTime?: <RFC3339 timestamp>
 *     volumeClaimTemplates:
 *       - metadata: { name, annotations?, labels? }
 *         spec: <corev1.PersistentVolumeClaimSpec>
 *
 * We only type the PodSpec fields we actually construct (containers,
 * restartPolicy). Anything else on corev1.PodSpec is out of scope for the
 * manifest builder and intentionally omitted rather than typed as `any`.
 */

/** Pinned CRD API version — the one constant referenced by decision 5's
 * "churn containment" clause. Change this in one place if the provider
 * moves to a newer CRD version. */
export const SANDBOX_CR_API_VERSION = "agents.x-k8s.io/v1beta1" as const;

export interface K8sProviderConfig {
  /** Kubernetes namespace the Sandbox CRs (and their backing pods/PVCs) live in. */
  namespace: string;
  /** Container image used when SandboxCreateOpts.image is not provided. */
  defaultImage: string;
  /** Resource fallback used when SandboxCreateOpts.resources is not provided. */
  defaultResources?: { cpu?: number; memory?: string };
  /** Default workspace PVC size when not otherwise specified. Defaults to "2Gi" if omitted. */
  defaultStorage?: string;
  apiVersion: typeof SANDBOX_CR_API_VERSION;
  /** `corev1.PodSpec.imagePullSecrets` names, threaded onto every Sandbox
   * pod's spec unconditionally when set (sandbox images v2 plan, Task 5:
   * pulling a prebuilt image from an EXTERNAL registry that requires
   * authenticated pulls). Confirmed present on the vendored agent-sandbox
   * CRD's `spec.podTemplate.spec` (both v1alpha1/v1beta1 schema blocks
   * embed the full `corev1.PodSpec`, which includes `imagePullSecrets`) —
   * this is plain pass-through, not a new CRD capability. */
  imagePullSecrets?: { name: string }[];
}

/** `corev1.SeccompProfile` subset — only the two profile types the manifest
 * builder emits (Unconfined for rootless DinD, RuntimeDefault for future use). */
export interface SeccompProfile {
  type: "Unconfined" | "RuntimeDefault";
}

/** `corev1.SecurityContext` subset — container-level security context fields
 * the manifest builder sets for rootless DinD sandboxes. */
export interface ContainerSecurityContext {
  seccompProfile?: SeccompProfile;
}

/** `corev1.EnvVar` subset — name/value pairs only (we never emit valueFrom). */
export interface EnvVar {
  name: string;
  value: string;
}

/** `corev1.ResourceList` subset — cpu/memory quantities as strings, the wire
 * format Kubernetes expects (e.g. "500m", "2", "1Gi"). */
export interface ResourceList {
  cpu?: string;
  memory?: string;
}

export interface ResourceRequirements {
  requests?: ResourceList;
  limits?: ResourceList;
}

export interface VolumeMount {
  name: string;
  mountPath: string;
}

/** `corev1.Volume` subset — only the secret-backed volume shape the
 * manifest builder emits for the creds mount. */
export interface SecretVolumeSource {
  /** Name of the Secret object in the same namespace. */
  secretName: string;
  /** When true, a missing Secret does not block pod scheduling. */
  optional?: boolean;
}

export interface Volume {
  name: string;
  secret?: SecretVolumeSource;
  emptyDir?: Record<string, never>;
  /** `corev1.HostPathVolumeSource` subset — only the /dev/fuse char device. */
  hostPath?: { path: string; type: "CharDevice" };
}

/** `corev1.Container` subset — only the fields the manifest builder sets. */
export interface SandboxContainer {
  name: string;
  image: string;
  command?: string[];
  args?: string[];
  env?: EnvVar[];
  resources?: ResourceRequirements;
  volumeMounts?: VolumeMount[];
  securityContext?: ContainerSecurityContext;
  /** `corev1.Container.workingDir` — set to `WORKSPACE_MOUNT_PATH` by the
   * manifest builder so relative paths in `exec`/file ops resolve against
   * the persistent `/workspace` volume by default (the k8s `pods/exec` API
   * has no per-call `--workdir` the way `docker exec` does; without this,
   * `exec`'s default working directory is the container's ephemeral
   * rootfs, and any relative-path write silently lands off the PVC and is
   * lost on pod recreate — caught live by the conformance suite's
   * "workspace survives destroy + recreate" case). */
  workingDir?: string;
}

/** `corev1.PodSpec` subset — only the fields the manifest builder sets. */
export interface SandboxPodSpec {
  containers: SandboxContainer[];
  restartPolicy?: "Always" | "OnFailure" | "Never";
  /** See `K8sProviderConfig.imagePullSecrets`'s docblock. */
  imagePullSecrets?: { name: string }[];
  /** `corev1.PodSpec.volumes` — volumes available to containers in this pod.
   * The manifest builder adds the creds volume when credsFiles are requested. */
  volumes?: Volume[];
}

export interface SandboxPodTemplate {
  metadata?: {
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
  };
  spec: SandboxPodSpec;
}

/** `corev1.PersistentVolumeClaimSpec` subset — only what we emit for the
 * workspace volume claim template. */
export interface VolumeClaimTemplate {
  metadata: { name: string };
  spec: {
    accessModes: string[];
    resources: {
      requests: { storage: string };
    };
  };
}

export interface SandboxCRSpec {
  podTemplate: SandboxPodTemplate;
  volumeClaimTemplates: VolumeClaimTemplate[];
  shutdownPolicy?: "Delete" | "Retain";
  operatingMode?: "Running" | "Suspended";
  /** When true, the agent-sandbox controller provisions a ClusterIP Service
   * fronting the pod (Task 3: `full`-profile sandboxes expose the in-pod
   * auth gateway on :9000 this way). Omitted entirely for headless sandboxes
   * — undefined, not false, to keep the manifest byte-identical to the
   * pre-Task-3 shape when no service is requested. */
  service?: boolean;
}

export interface SandboxCR {
  apiVersion: typeof SANDBOX_CR_API_VERSION;
  kind: "Sandbox";
  metadata: {
    name: string;
    labels: Record<string, string>;
  };
  spec: SandboxCRSpec;
}

/**
 * Types below back `src/lifecycle.ts` — the CustomObjectsApi/CoreV1Api
 * wrapper (Task 2). Verified against Task 3's live-cluster observations
 * (`deploy/agent-sandbox/README.md` "Smoke test observations"):
 *
 *   - the pod-name annotation (`agents.x-k8s.io/pod-name`) lives on the
 *     Sandbox object's own `metadata.annotations`, not on the pod;
 *   - `status.conditions` is a standard Kubernetes conditions array; the
 *     only condition observed in the smoke test was `type: Ready`,
 *     `status: "True"`, `reason: DependenciesReady`;
 *   - `status.selector` is a label-selector string
 *     (`agents.x-k8s.io/sandbox-name-hash=<hash>`) the controller puts on
 *     the backing pod — usable as a list-fallback selector distinct from
 *     our own `valet.dev/session-id` label (which is NOT guaranteed to be
 *     propagated onto the pod by the controller).
 */

/** Standard Kubernetes condition shape (`type/status/reason/message/
 * lastTransitionTime/observedGeneration`). Only `type` and `status` are
 * required by us; the rest are surfaced when present since they carry the
 * human-readable detail for `SandboxStatus.error`. */
export interface SandboxCondition {
  type: string;
  status: "True" | "False" | "Unknown";
  reason?: string;
  message?: string;
  lastTransitionTime?: string;
  observedGeneration?: number;
}

/** `status` subset of the read-back Sandbox CR — only the fields the
 * lifecycle module consumes (conditions for status mapping, selector as a
 * resolvePodName list fallback). The full CRD status has more fields
 * (`nodeName`, `podIPs`, `service`, `serviceFQDN`) that we intentionally
 * don't type since nothing here reads them yet. */
export interface SandboxCRStatus {
  conditions?: SandboxCondition[];
  selector?: string;
  /** Name of the controller-provisioned Service (set only when `spec.service`
   * was requested and the controller has reconciled it). */
  service?: string;
  /** Cluster-internal FQDN of that Service — what `KubernetesSandbox.gatewayEndpoint()`
   * resolves against, port 9000 (Task 2 daemon default). */
  serviceFQDN?: string;
}

/** `metadata` subset of the read-back Sandbox CR — a superset of the
 * write-shape `SandboxCR["metadata"]` (adds the server-populated fields:
 * `resourceVersion` for optimistic-concurrency replace, `uid`,
 * `annotations` for the pod-name annotation). */
export interface SandboxCRMetadata {
  name: string;
  namespace?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  resourceVersion?: string;
  uid?: string;
}

/** `spec` subset of the read-back Sandbox CR. `podTemplate` and
 * `volumeClaimTemplates` are typed `unknown` deliberately — the lifecycle
 * module only ever *validates their presence* on a GET response (never
 * their internal shape), because it never reads into `podTemplate.spec`
 * from a read-back CR: `applySandbox`'s replace path re-sends the
 * caller's own already-typed `SandboxCRSpec`, it never round-trips a GET
 * response's spec back to the server. Claiming the fully-typed
 * `SandboxCRSpec` here would be dishonest precision this module doesn't
 * actually check. */
export interface SandboxCRReadSpec {
  podTemplate: unknown;
  volumeClaimTemplates: unknown[];
  shutdownPolicy?: "Delete" | "Retain";
  operatingMode?: "Running" | "Suspended";
  /** Mirrors `SandboxCRSpec.service` — whether this CR requested the
   * controller-provisioned Service. Read back so `gatewayEndpoint()` can
   * gate on "was a service actually requested" rather than inferring it
   * from `status.serviceFQDN` alone. */
  service?: boolean;
}

/** The shape returned by GET/create/replace against the live API server —
 * `SandboxCR` plus the server-populated `metadata` fields, `status`, and a
 * deliberately looser `spec` (see `SandboxCRReadSpec`). Hand-written and
 * intentionally partial (see field-level docs above); not a full
 * deserialization of the CRD schema. */
export interface SandboxCRRead {
  apiVersion: typeof SANDBOX_CR_API_VERSION;
  kind: "Sandbox";
  metadata: SandboxCRMetadata;
  spec: SandboxCRReadSpec;
  status?: SandboxCRStatus;
}

/** Minimal pod projection `resolvePodName`'s list-fallback needs — just
 * enough to match a pod back to its owning Sandbox CR via `ownerReferences`. */
export interface PodOwnerReference {
  kind: string;
  name: string;
  controller?: boolean;
}

export interface PodSummary {
  name: string;
  ownerReferences?: PodOwnerReference[];
}
