/**
 * CRD lifecycle module (decision 5's "churn containment" clause — all
 * agent-sandbox CRD-facing code lives here, behind narrow hand-written
 * interfaces, so a swap-back to plain pods+PVCs is a one-module change).
 *
 * Talks to the kubernetes-sigs/agent-sandbox `Sandbox` CRD (API group
 * `agents.x-k8s.io`, pinned `v1beta1`) via `@kubernetes/client-node`'s
 * `CustomObjectsApi` (schemaless — every method is typed `any` in/out
 * upstream) and `CoreV1Api` (properly typed) for the pod-name
 * list-fallback. `@kubernetes/client-node`'s `CustomObjectsApi` has no
 * generated response types because CRDs are arbitrary JSON to the
 * client — this module's job is to turn that `any` into the honest,
 * hand-written `SandboxCRRead` shape (see `./types.ts`) via runtime
 * validation (`parseSandboxCRRead`), never a blind cast.
 *
 * ── Context safety (decision 2, BINDING) ──────────────────────────────
 * The developer machine's ambient `kubectl` current-context is a
 * PRODUCTION cluster (verified: `gke_labrat-glitch-prod_...`). Every
 * cluster-touching call in this module goes through a `KubeConfig` that
 * has `setCurrentContext("rancher-desktop")` called on it explicitly —
 * see `loadRancherDesktopKubeConfig`. Nothing in this module ever reads
 * or relies on the ambient current-context.
 *
 * ── Teardown semantics (decision 5, NON-NEGOTIABLE) ────────────────────
 * `applySandbox` is upsert-shaped: an existing CR of the same name is
 * adopted (GET + replace preserving `resourceVersion`), never an error.
 * Nothing in this module ever deletes a CR except `deleteSandbox`, which
 * is TERMINAL — only the session-deletion path may call it. Recovery /
 * re-provision paths call `applySandbox` or `getSandbox`, never
 * `deleteSandbox`.
 *
 * ── restartPolicy verdict (empirical, 2026-07-16, live rancher-desktop
 * cluster, agent-sandbox v0.5.1) ───────────────────────────────────────
 * Task 1's reviewer flagged `restartPolicy: Always` (the manifest
 * builder's default, see ./manifest.ts) against upstream's example CRs,
 * which use `Never`, and asked whether the controller fights a
 * long-running pod under `Always`, and whether a dead container under
 * `Never` actually gets recovered. Tested both directly against the live
 * controller in a throwaway namespace (four Sandboxes: `sleep 3600` under
 * each policy, and `sleep 5 && exit 1` — a crashing container — under
 * each policy):
 *
 *   - **Ready condition is agnostic to restartPolicy.** Both `sleep 3600`
 *     Sandboxes (`Always` and `Never`) reached `Ready: True, reason:
 *     DependenciesReady` immediately and stayed there. Neither flipped to
 *     a terminal/"Finished"-style condition while the container kept
 *     running. Settles requirement (a) for BOTH policies — this was not
 *     the deciding factor.
 *   - **Pod DELETION (`kubectl delete pod`) is always reconciled by the
 *     agent-sandbox CONTROLLER, regardless of restartPolicy.** Deleting
 *     the backing pod of both the `Always` and the `Never` long-running
 *     Sandbox resulted in a fresh Pod object (new `metadata.uid`,
 *     confirmed via `kubectl get pod -o jsonpath='{.metadata.uid}'`
 *     before/after) within ~15s, in both cases. The pod NAME stayed
 *     identical to the Sandbox name in both cases (matches Task 3's
 *     "exact name match" observation — the design doc's phrase "mints a
 *     FRESH pod name" describes a fresh pod OBJECT, not a changed name
 *     string; `resolvePodName` re-resolves every call regardless, so this
 *     doesn't change its contract). This is the kubectl-delete-the-pod
 *     scenario the exit criteria's dogfood exercises, and what an
 *     evicted/OOM-killed sandbox pod looks like — the kubelet cannot
 *     resurrect a fully deleted Pod object no matter what restartPolicy
 *     says, so this recovery path is controller-owned either way and
 *     restartPolicy does not affect it.
 *   - **The deciding factor: an in-place container CRASH (pod stays
 *     alive, container exits non-zero) is handled completely differently
 *     by the two policies, and only ONE of them self-heals.** Under
 *     `restartPolicy: Always`, the KUBELET restarted the crashing
 *     container in place — `kubectl get pod` showed `phase: Running`
 *     throughout, with `restartCount` climbing (2, then 3, ...) — the
 *     pod object and its name/uid never changed, and the controller was
 *     never involved. Under `restartPolicy: Never`, the container was
 *     NOT restarted by anything: the pod went `phase: Failed` and the
 *     Sandbox's own `Ready` condition surfaced this explicitly
 *     (`status: "False", reason: PodFailed` — a NEW reason, distinct
 *     from `DependenciesReady`/`DependenciesNotReady`). Critically, the
 *     agent-sandbox CONTROLLER did not recreate the Failed pod on its
 *     own either — it sat in `phase: Failed` with the same `uid` for the
 *     full observation window (30s+). Manually `kubectl delete pod`-ing
 *     the Failed `Never` pod DID get the controller to create a fresh
 *     pod (confirming controller recreate only triggers on pod
 *     *deletion*, not on pod *failure*) — but that requires something
 *     else (us) to notice the Failed state and delete it; there is no
 *     free recovery under `Never` for an in-place crash.
 *
 *   **Verdict: keep `restartPolicy: Always`** (manifest.ts's existing
 *   default is correct, no change needed). Both policies satisfy
 *   requirement (a) equally and both get controller-recreate on outright
 *   pod deletion/eviction (requirement (b)'s primary case). The
 *   deciding factor is the in-place-crash case: our sandbox containers
 *   are non-terminating `sleep`-loop placeholders (see
 *   `SANDBOX_CONTAINER_NAME`'s `tail -f /dev/null` in ./manifest.ts) that
 *   are never expected to exit, so a crash is always an anomaly (image
 *   issue, OOM inside the container, etc.) — under `Always` the kubelet
 *   heals that for free with zero controller/attachment-layer
 *   involvement; under `Never` it is a silent, permanently-dead sandbox
 *   until something external polls status and force-deletes the pod.
 *   `Always` is strictly better for this workload shape.
 */
import type * as k8s from "@kubernetes/client-node";
import type { SandboxStatus } from "@valet/engine";
import type {
  K8sProviderConfig,
  PodOwnerReference,
  PodSummary,
  SandboxCondition,
  SandboxCR,
  SandboxCRRead,
  SandboxCRStatus,
} from "./types.js";

/** The one place the kubectl context to operate against is named
 * (decision 2, binding). Never read the ambient current-context. */
export const RANCHER_DESKTOP_CONTEXT = "rancher-desktop";

/** Plural name of the vendored CRD (`sandboxes.agents.x-k8s.io`). */
export const SANDBOX_PLURAL = "sandboxes";

/** Kind the agent-sandbox controller sets as `ownerReferences[].kind` on
 * the backing pod. */
export const SANDBOX_KIND = "Sandbox";

/** Annotation the controller writes on the Sandbox object (not the pod —
 * see Task 3's smoke-test observations) once it has provisioned a backing
 * pod. */
const POD_NAME_ANNOTATION = "agents.x-k8s.io/pod-name";

// ── Context-safe KubeConfig loading (decision 2) ───────────────────────

/**
 * Loads the default kubeconfig and pins the current context to
 * `rancher-desktop` explicitly. Throws immediately if that context isn't
 * configured — never silently falls through to whatever the ambient
 * current-context happens to be (which, on this project's dev machine, is
 * a production GKE cluster).
 */
export function loadRancherDesktopKubeConfig(kubeConfigCtor: new () => k8s.KubeConfig): k8s.KubeConfig {
  const kc = new kubeConfigCtor();
  kc.loadFromDefault();
  if (kc.getContextObject(RANCHER_DESKTOP_CONTEXT) === null) {
    throw new Error(
      `kubectl context "${RANCHER_DESKTOP_CONTEXT}" is not configured. ` +
        "Refusing to fall back to the ambient current-context (it may be a production cluster).",
    );
  }
  kc.setCurrentContext(RANCHER_DESKTOP_CONTEXT);
  return kc;
}

// ── Narrow client interfaces (interface-extraction: the fake in
// test/lifecycle.test.ts implements exactly these, so it's an honest
// stand-in for what this module actually calls) ────────────────────────

export interface CreateSandboxParams {
  group: string;
  version: string;
  namespace: string;
  plural: string;
  body: SandboxCR;
}

export interface GetSandboxParams {
  group: string;
  version: string;
  namespace: string;
  plural: string;
  name: string;
}

export interface ReplaceSandboxParams {
  group: string;
  version: string;
  namespace: string;
  plural: string;
  name: string;
  body: SandboxCRRead;
}

export interface DeleteSandboxParams {
  group: string;
  version: string;
  namespace: string;
  plural: string;
  name: string;
}

export interface ListSandboxParams {
  group: string;
  version: string;
  namespace: string;
  plural: string;
  labelSelector?: string;
}

/** The subset of `@kubernetes/client-node`'s `CustomObjectsApi` this
 * module drives. Every real method here is typed `any` in/out upstream
 * (CRDs are schemaless to the client) — we narrow to `unknown` and
 * validate at the boundary (`parseSandboxCRRead`) rather than trusting
 * the wire shape. */
export interface SandboxCustomObjectsApi {
  createNamespacedCustomObject(params: CreateSandboxParams): Promise<unknown>;
  getNamespacedCustomObject(params: GetSandboxParams): Promise<unknown>;
  replaceNamespacedCustomObject(params: ReplaceSandboxParams): Promise<unknown>;
  deleteNamespacedCustomObject(params: DeleteSandboxParams): Promise<unknown>;
  listNamespacedCustomObject(params: ListSandboxParams): Promise<unknown>;
}

export interface ListPodsParams {
  namespace: string;
  labelSelector?: string;
}

/** The subset of `@kubernetes/client-node`'s `CoreV1Api` this module
 * drives — just enough for `resolvePodName`'s ownerReference-scan
 * fallback. Real `CoreV1Api` returns a properly typed `V1PodList`, so
 * (unlike `SandboxCustomObjectsApi`) no runtime validation is needed here
 * beyond the adapter's own defensive field access. */
export interface SandboxPodsApi {
  listNamespacedPod(params: ListPodsParams): Promise<{ items: PodSummary[] }>;
}

// ── Production adapters over the real client-node classes ─────────────

/** Wraps a real `k8s.CustomObjectsApi` instance. No casts: the real
 * client's methods return `Promise<any>`, which is assignable to
 * `Promise<unknown>` without a cast (the honest direction — `any` can
 * flow into `unknown`, never trusted as a concrete shape without
 * validation). */
export function customObjectsApiAdapter(api: k8s.CustomObjectsApi): SandboxCustomObjectsApi {
  return {
    createNamespacedCustomObject: (params) => api.createNamespacedCustomObject(params),
    getNamespacedCustomObject: (params) => api.getNamespacedCustomObject(params),
    replaceNamespacedCustomObject: (params) => api.replaceNamespacedCustomObject(params),
    deleteNamespacedCustomObject: (params) => api.deleteNamespacedCustomObject(params),
    listNamespacedCustomObject: (params) => api.listNamespacedCustomObject(params),
  };
}

function podOwnerReferencesFrom(refs: k8s.V1OwnerReference[] | undefined): PodOwnerReference[] | undefined {
  if (!refs) return undefined;
  return refs.map((ref) => ({ kind: ref.kind, name: ref.name, controller: ref.controller }));
}

/** Wraps a real `k8s.CoreV1Api` instance, projecting `V1Pod` down to the
 * minimal `PodSummary` shape `resolvePodName` needs. */
export function podsApiAdapter(api: k8s.CoreV1Api): SandboxPodsApi {
  return {
    listNamespacedPod: async (params) => {
      const result = await api.listNamespacedPod({
        namespace: params.namespace,
        labelSelector: params.labelSelector,
      });
      const items: PodSummary[] = (result.items ?? [])
        .filter((pod): pod is k8s.V1Pod & { metadata: { name: string } } => typeof pod.metadata?.name === "string")
        .map((pod) => ({
          name: pod.metadata.name,
          ownerReferences: podOwnerReferencesFrom(pod.metadata.ownerReferences),
        }));
      return { items };
    },
  };
}

// ── Runtime validation of CustomObjectsApi's `any` responses ──────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseCondition(value: unknown): SandboxCondition | null {
  if (!isRecord(value)) return null;
  const { type, status } = value;
  if (typeof type !== "string") return null;
  if (status !== "True" && status !== "False" && status !== "Unknown") return null;
  const condition: SandboxCondition = { type, status };
  if (typeof value.reason === "string") condition.reason = value.reason;
  if (typeof value.message === "string") condition.message = value.message;
  if (typeof value.lastTransitionTime === "string") condition.lastTransitionTime = value.lastTransitionTime;
  if (typeof value.observedGeneration === "number") condition.observedGeneration = value.observedGeneration;
  return condition;
}

function parseStatus(value: unknown): SandboxCRStatus | undefined {
  if (!isRecord(value)) return undefined;
  const status: SandboxCRStatus = {};
  if (Array.isArray(value.conditions)) {
    const conditions = value.conditions.map(parseCondition).filter((c): c is SandboxCondition => c !== null);
    status.conditions = conditions;
  }
  if (typeof value.selector === "string") status.selector = value.selector;
  return status;
}

/**
 * Validates and narrows the `unknown` payload `CustomObjectsApi` hands
 * back into the hand-written `SandboxCRRead` shape. Throws (rather than
 * returning a best-effort partial) when the minimum required fields
 * (`metadata.name`, `spec`) are missing — a malformed response here means
 * something is badly wrong (wrong CRD version, webhook misbehaving) and
 * callers should fail loudly, not silently degrade.
 */
export function parseSandboxCRRead(value: unknown): SandboxCRRead {
  if (!isRecord(value)) {
    throw new Error("Sandbox CR response is not an object");
  }
  const metadataValue = value.metadata;
  if (!isRecord(metadataValue) || typeof metadataValue.name !== "string") {
    throw new Error("Sandbox CR response is missing metadata.name");
  }
  const specValue = value.spec;
  if (!isRecord(specValue) || !isRecord(specValue.podTemplate) || !Array.isArray(specValue.volumeClaimTemplates)) {
    throw new Error("Sandbox CR response is missing spec.podTemplate or spec.volumeClaimTemplates");
  }

  const metadata: SandboxCRRead["metadata"] = { name: metadataValue.name };
  if (typeof metadataValue.namespace === "string") metadata.namespace = metadataValue.namespace;
  if (typeof metadataValue.resourceVersion === "string") metadata.resourceVersion = metadataValue.resourceVersion;
  if (typeof metadataValue.uid === "string") metadata.uid = metadataValue.uid;
  if (isRecord(metadataValue.labels)) {
    const labels: Record<string, string> = {};
    for (const [k, v] of Object.entries(metadataValue.labels)) {
      if (typeof v === "string") labels[k] = v;
    }
    metadata.labels = labels;
  }
  if (isRecord(metadataValue.annotations)) {
    const annotations: Record<string, string> = {};
    for (const [k, v] of Object.entries(metadataValue.annotations)) {
      if (typeof v === "string") annotations[k] = v;
    }
    metadata.annotations = annotations;
  }

  // spec.podTemplate/volumeClaimTemplates are intentionally typed `unknown`
  // on SandboxCRReadSpec (see types.ts) — we only validate their presence
  // above, never their internal shape, since nothing here reads into
  // podTemplate.spec.
  const spec: SandboxCRRead["spec"] = {
    podTemplate: specValue.podTemplate,
    volumeClaimTemplates: specValue.volumeClaimTemplates,
  };
  if (specValue.shutdownPolicy === "Delete" || specValue.shutdownPolicy === "Retain") {
    spec.shutdownPolicy = specValue.shutdownPolicy;
  }
  if (specValue.operatingMode === "Running" || specValue.operatingMode === "Suspended") {
    spec.operatingMode = specValue.operatingMode;
  }

  return {
    apiVersion: "agents.x-k8s.io/v1beta1",
    kind: "Sandbox",
    metadata,
    spec,
    status: parseStatus(value.status),
  };
}

function isApiError(err: unknown): err is { code: number } {
  return isRecord(err) && typeof err.code === "number";
}

function parseApiVersion(apiVersion: K8sProviderConfig["apiVersion"]): { group: string; version: string } {
  const slash = apiVersion.indexOf("/");
  return { group: apiVersion.slice(0, slash), version: apiVersion.slice(slash + 1) };
}

// ── Lifecycle operations ────────────────────────────────────────────

/**
 * Create-or-adopt (decision 5, NON-NEGOTIABLE): if the CR already exists
 * (409 on create), GET the existing object and replace it, preserving
 * `resourceVersion` for optimistic concurrency. Never treats "already
 * exists" as an error — the attachment layer's recovery path calls this
 * again with the same manifest and must not fail.
 */
export async function applySandbox(
  api: SandboxCustomObjectsApi,
  cfg: K8sProviderConfig,
  manifest: SandboxCR,
): Promise<SandboxCRRead> {
  const { group, version } = parseApiVersion(cfg.apiVersion);
  try {
    const created = await api.createNamespacedCustomObject({
      group,
      version,
      namespace: cfg.namespace,
      plural: SANDBOX_PLURAL,
      body: manifest,
    });
    return parseSandboxCRRead(created);
  } catch (err) {
    if (!isApiError(err) || err.code !== 409) throw err;
  }

  // Adopt: GET the existing CR and replace it, carrying its resourceVersion.
  const existing = await getSandbox(api, cfg, manifest.metadata.name);
  if (existing === null) {
    // Lost a create/delete race — the 409 was real but the object is gone
    // now. Surface as a normal error; callers retry via their own policy.
    throw new Error(`applySandbox: 409 on create but "${manifest.metadata.name}" is not gettable afterward`);
  }
  const replaced = await api.replaceNamespacedCustomObject({
    group,
    version,
    namespace: cfg.namespace,
    plural: SANDBOX_PLURAL,
    name: manifest.metadata.name,
    body: {
      apiVersion: manifest.apiVersion,
      kind: manifest.kind,
      metadata: { ...manifest.metadata, resourceVersion: existing.metadata.resourceVersion },
      spec: manifest.spec,
    },
  });
  return parseSandboxCRRead(replaced);
}

/** Returns `null` when the CR does not exist (404) — never throws for the
 * "absent" case, since that's the expected shape of a released sandbox. */
export async function getSandbox(
  api: SandboxCustomObjectsApi,
  cfg: K8sProviderConfig,
  name: string,
): Promise<SandboxCRRead | null> {
  const { group, version } = parseApiVersion(cfg.apiVersion);
  try {
    const result = await api.getNamespacedCustomObject({
      group,
      version,
      namespace: cfg.namespace,
      plural: SANDBOX_PLURAL,
      name,
    });
    return parseSandboxCRRead(result);
  } catch (err) {
    if (isApiError(err) && err.code === 404) return null;
    throw err;
  }
}

/**
 * TERMINAL (decision 5, NON-NEGOTIABLE): deletes the CR, which cascades to
 * the backing pod and PVC via the controller's owner references. Only the
 * session-deletion path may call this — recovery/re-provision paths must
 * use `applySandbox`/`getSandbox` instead. Idempotent: a 404 (already
 * gone) is treated as success.
 */
export async function deleteSandbox(api: SandboxCustomObjectsApi, cfg: K8sProviderConfig, name: string): Promise<void> {
  const { group, version } = parseApiVersion(cfg.apiVersion);
  try {
    await api.deleteNamespacedCustomObject({ group, version, namespace: cfg.namespace, plural: SANDBOX_PLURAL, name });
  } catch (err) {
    if (isApiError(err) && err.code === 404) return;
    throw err;
  }
}

export async function listSandboxes(
  api: SandboxCustomObjectsApi,
  cfg: K8sProviderConfig,
  labelSelector?: string,
): Promise<SandboxCRRead[]> {
  const { group, version } = parseApiVersion(cfg.apiVersion);
  const result = await api.listNamespacedCustomObject({
    group,
    version,
    namespace: cfg.namespace,
    plural: SANDBOX_PLURAL,
    labelSelector,
  });
  if (!isRecord(result) || !Array.isArray(result.items)) {
    throw new Error("Sandbox CR list response is missing items[]");
  }
  return result.items.map(parseSandboxCRRead);
}

/**
 * Pure mapping of a Sandbox CR's `status.conditions` to the engine's
 * `SandboxStatus.state`. Extracted as a pure function (no I/O) so it's
 * directly unit-testable without a fake API client — see decision from
 * CLAUDE.md's "extract pure functions to avoid testing private members".
 *
 * Mapping (per the brief, defensive since Task 3 only observed the happy
 * path):
 *   - no `Ready` condition at all → "provisioning" (CR just created,
 *     controller hasn't reconciled yet)
 *   - a condition whose `type` looks like an error/failure signal
 *     (`/error|fail/i`) and is `status: "True"` → "error"
 *   - `Ready` condition present with `status: "True"` → "ready"
 *   - `Ready` condition present but `status` is `"False"`/`"Unknown"` →
 *     "provisioning"
 */
export function mapConditionsToStatus(id: string, conditions: SandboxCondition[]): SandboxStatus {
  const errorCondition = conditions.find((c) => c.status === "True" && /error|fail/i.test(c.type));
  if (errorCondition) {
    return { id, state: "error", error: errorCondition.message ?? errorCondition.reason ?? errorCondition.type };
  }
  const ready = conditions.find((c) => c.type === "Ready");
  if (ready?.status === "True") {
    return { id, state: "ready" };
  }
  return { id, state: "provisioning" };
}

/** Absent CR → "released" (per the brief); otherwise delegates to
 * `mapConditionsToStatus`. */
export async function sandboxStatus(
  api: SandboxCustomObjectsApi,
  cfg: K8sProviderConfig,
  name: string,
): Promise<SandboxStatus> {
  const cr = await getSandbox(api, cfg, name);
  if (cr === null) {
    return { id: name, state: "released" };
  }
  return mapConditionsToStatus(name, cr.status?.conditions ?? []);
}

/**
 * Resolves the backing pod's current name. Never cached across calls —
 * the controller mints a FRESH pod name after pod-level recovery (decision
 * 5's exec-targeting note), so callers must re-resolve per operation.
 *
 * Resolution order:
 *   1. `agents.x-k8s.io/pod-name` annotation on the Sandbox object itself
 *      (confirmed primary source — Task 3's smoke test).
 *   2. List-fallback: list pods in the namespace (narrowed by
 *      `status.selector` when the CR reports one) and find the one whose
 *      `ownerReferences` names this Sandbox as its controller.
 *   3. `null` — CR absent, or present but not yet reconciled to a pod.
 */
export async function resolvePodName(
  objectsApi: SandboxCustomObjectsApi,
  podsApi: SandboxPodsApi,
  cfg: K8sProviderConfig,
  name: string,
): Promise<string | null> {
  const cr = await getSandbox(objectsApi, cfg, name);
  if (cr === null) return null;

  const annotated = cr.metadata.annotations?.[POD_NAME_ANNOTATION];
  if (annotated) return annotated;

  const { items } = await podsApi.listNamespacedPod({
    namespace: cfg.namespace,
    labelSelector: cr.status?.selector,
  });
  const owned = items.find((pod) =>
    pod.ownerReferences?.some((ref) => ref.kind === SANDBOX_KIND && ref.name === name && ref.controller === true),
  );
  return owned?.name ?? null;
}
