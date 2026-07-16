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

/** `corev1.Container` subset — only the fields the manifest builder sets. */
export interface SandboxContainer {
  name: string;
  image: string;
  command?: string[];
  args?: string[];
  env?: EnvVar[];
  resources?: ResourceRequirements;
  volumeMounts?: VolumeMount[];
}

/** `corev1.PodSpec` subset — only the fields the manifest builder sets. */
export interface SandboxPodSpec {
  containers: SandboxContainer[];
  restartPolicy?: "Always" | "OnFailure" | "Never";
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
