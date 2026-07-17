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
import { setHeaderOptions } from "@kubernetes/client-node";
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

/** Params for the merge-patch `setOperatingMode` uses — `body` is
 * deliberately narrowed to exactly `{ spec: { operatingMode } }` (not the
 * broader `SandboxCR`/`SandboxCRRead` shapes) since a JSON merge-patch body
 * must contain ONLY the fields being changed; sending anything wider would
 * risk clobbering fields this call has no business touching. */
export interface PatchSandboxParams {
  group: string;
  version: string;
  namespace: string;
  plural: string;
  name: string;
  body: { spec: { operatingMode: "Running" | "Suspended" } };
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
  /** JSON merge-patch (`Content-Type: application/merge-patch+json`) —
   * NEVER a PUT-replace (see `applySandbox`'s docblock on why `replace` is
   * unsafe for controller-owned fields). Real adapter wires the
   * `application/merge-patch+json` content type explicitly, since
   * client-node's default patch content-type negotiation prefers
   * `application/json-patch+json` (see `customObjectsApiAdapter`). */
  patchNamespacedCustomObject(params: PatchSandboxParams): Promise<unknown>;
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
    // client-node's generated patch method negotiates Content-Type from
    // ["application/json-patch+json", "application/merge-patch+json"] and
    // always picks the FIRST supported one (json-patch) — there is no
    // per-call param for it on the request shape itself. `setHeaderOptions`
    // appends a middleware that overwrites the Content-Type header after
    // the request is built but before it is sent; the body bytes are
    // identical either way (both are plain JSON), only the server's
    // interpretation of the Content-Type header differs.
    patchNamespacedCustomObject: (params) =>
      api.patchNamespacedCustomObject(params, setHeaderOptions("Content-Type", "application/merge-patch+json")),
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
  if (typeof value.service === "string") status.service = value.service;
  if (typeof value.serviceFQDN === "string") status.serviceFQDN = value.serviceFQDN;
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
  if (typeof specValue.service === "boolean") {
    spec.service = specValue.service;
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
  // Adopt must satisfy create()'s postcondition: a READY sandbox. `create()`
  // unconditionally ends in `waitReady` (see provider.ts), so adopting a CR
  // AS Suspended can never satisfy the caller — the controller keeps the pod
  // scaled to zero and `waitReady` polls forever for a pod it will never
  // schedule. Every `create()` call is an explicit request for live compute
  // (fresh provision, liveness-triggered re-provision, or — the dogfood-found
  // case — a post-api-restart wake: a hibernated session is rebuilt with a
  // FRESH detached SandboxAttachment that has no memory of the suspension, so
  // its wake path goes through create()/applySandbox, NOT resume()). If an
  // adopted CR is Suspended, the replace body therefore EXPLICITLY resumes it
  // (operatingMode: Running), unless the incoming manifest itself asks for
  // Suspended — which it never does today (buildSandboxManifest emits no
  // operatingMode key). When the existing CR is Running/absent we keep today's
  // body byte-for-byte, adding no operatingMode key so the CRD's pin is
  // preserved. The earlier carry-forward (1a487a34) protected against a
  // recovery re-create silently un-suspending a sandbox, but that race is
  // mitigated one layer up — the engine's idle sweep re-checks state right
  // before suspending, and a reportFailure-triggered re-create means the
  // engine actively needs the sandbox live — so the provider's create-adopt
  // must resume, not preserve Suspended.
  const spec =
    existing.spec.operatingMode === "Suspended"
      ? { ...manifest.spec, operatingMode: manifest.spec.operatingMode ?? "Running" }
      : manifest.spec;

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
      spec,
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

/**
 * Merge-patches `spec.operatingMode`, driving the CRD's hibernation seam
 * (Task 2). The body is EXACTLY `{ spec: { operatingMode: mode } }` — a JSON
 * merge-patch, never a full-object PUT-replace (`applySandbox` is the wrong
 * tool here: it GETs+replaces the whole spec, which would clobber
 * controller-owned fields on a CR that's already been reconciled).
 * Idempotent: patching the same mode twice is a no-op from the caller's
 * perspective (the apiserver just re-applies the same merge).
 */
export async function setOperatingMode(
  api: SandboxCustomObjectsApi,
  cfg: K8sProviderConfig,
  name: string,
  mode: "Running" | "Suspended",
): Promise<void> {
  const { group, version } = parseApiVersion(cfg.apiVersion);
  await api.patchNamespacedCustomObject({
    group,
    version,
    namespace: cfg.namespace,
    plural: SANDBOX_PLURAL,
    name,
    body: { spec: { operatingMode: mode } },
  });
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
 *   - `operatingMode === "Suspended"` → "idle", BEFORE any condition
 *     inspection (Task 2: a suspended CR's backing pod is deliberately
 *     gone — without this branch first, the Ready condition going stale/
 *     False would misread as "provisioning", not the intentional hibernated
 *     state it actually is)
 *   - no `Ready` condition at all → "provisioning" (CR just created,
 *     controller hasn't reconciled yet)
 *   - a condition whose `type` looks like an error/failure signal
 *     (`/error|fail/i`) and is `status: "True"` → "error"
 *   - `Ready` condition present with `status: "True"` → "ready"
 *   - `Ready` condition present but `status` is `"False"`/`"Unknown"` →
 *     "provisioning"
 */
export function mapConditionsToStatus(
  id: string,
  conditions: SandboxCondition[],
  operatingMode?: "Running" | "Suspended",
): SandboxStatus {
  if (operatingMode === "Suspended") {
    return { id, state: "idle" };
  }
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

// ── Pod-failure classification (bug fix: a pod that FAILS to start must
// surface as a terminal error, not a generic 60s "provisioning" timeout) ──

/** `waiting.reason` values on a container status that mean the container
 * will never come up on its own — the image reference (or its pull
 * credentials/config) is simply bad. */
const IMAGE_PULL_WAITING_REASONS = new Set([
  "ImagePullBackOff",
  "ErrImagePull",
  "InvalidImageName",
  "CreateContainerConfigError",
]);

/** Minimal per-container status this module reads — just enough to detect
 * a stuck `waiting` state. Extracted separately from `PodSummary` (which is
 * scoped to `resolvePodName`'s ownerReference-scan) since this one carries
 * status/image detail that fallback never needs. */
export interface PodContainerStatus {
  name: string;
  image?: string;
  waitingReason?: string;
  waitingMessage?: string;
}

/** Standard Kubernetes pod condition shape (`type`/`status`/`reason`/
 * `message`) — same fields as `SandboxCondition`, kept as a separate type
 * since it describes the POD's conditions (e.g. `PodScheduled`), not the
 * Sandbox CR's. */
export interface PodStatusCondition {
  type: string;
  status: "True" | "False" | "Unknown";
  reason?: string;
  message?: string;
}

/** The subset of a `V1Pod`'s `.status` (plus per-container `image`, sourced
 * from `.spec.containers`) this module needs to classify a startup failure. */
export interface PodStatusInfo {
  phase?: string;
  containerStatuses?: PodContainerStatus[];
  conditions?: PodStatusCondition[];
}

/** The subset of `@kubernetes/client-node`'s `CoreV1Api` needed to GET a
 * single pod's status for failure classification — distinct from
 * `SandboxPodsApi` (list-based, ownerReference-scan fallback) and from
 * `provider.ts`'s `PodLivenessApi` (just a `uid`, no status detail). */
export interface SandboxPodStatusApi {
  /** Returns `null` when the pod does not exist (404) — never throws for
   * the "absent" case, since a Sandbox CR that hasn't reconciled a pod yet
   * is a normal (not-error) state. */
  getPodStatus(namespace: string, podName: string): Promise<PodStatusInfo | null>;
}

/** Wraps a real `k8s.CoreV1Api` instance. */
export function podStatusApiAdapter(api: k8s.CoreV1Api): SandboxPodStatusApi {
  return {
    async getPodStatus(namespace, podName) {
      let pod: k8s.V1Pod;
      try {
        pod = await api.readNamespacedPod({ name: podName, namespace });
      } catch (err) {
        if (isApiError(err) && err.code === 404) return null;
        throw err;
      }
      const images = new Map((pod.spec?.containers ?? []).map((c) => [c.name, c.image]));
      const containerStatuses: PodContainerStatus[] = (pod.status?.containerStatuses ?? []).map((cs) => ({
        name: cs.name,
        image: images.get(cs.name) ?? cs.image,
        waitingReason: cs.state?.waiting?.reason,
        waitingMessage: cs.state?.waiting?.message,
      }));
      const conditions: PodStatusCondition[] = (pod.status?.conditions ?? [])
        .filter(
          (c): c is k8s.V1PodCondition & { type: string; status: "True" | "False" | "Unknown" } =>
            typeof c.type === "string" && (c.status === "True" || c.status === "False" || c.status === "Unknown"),
        )
        .map((c) => ({ type: c.type, status: c.status, reason: c.reason, message: c.message }));
      return { phase: pod.status?.phase, containerStatuses, conditions };
    },
  };
}

/**
 * Pure classification of a backing pod's status (plus, for the `PodFailed`
 * case, the Sandbox CR's own `Ready` condition) into a terminal-startup-
 * failure reason string, or `null` when the pod isn't in a terminal-failure
 * state (still pulling, healthy, or genuinely absent/unresolved — all of
 * which should stay "provisioning", not "error"). Extracted as a pure
 * function (no I/O) so it's directly unit-testable with synthesized pod
 * objects — mirrors `mapConditionsToStatus`'s existing pattern.
 *
 * Checked in order:
 *   1. any container `waiting.reason` in `IMAGE_PULL_WAITING_REASONS` →
 *      "image pull failed (<reason>): <image>"
 *   2. any container `waiting.reason === "CrashLoopBackOff"` →
 *      "container crash-looping (CrashLoopBackOff)"
 *   3. `pod.phase === "Failed"`, or the CR's `Ready` condition has
 *      `reason === "PodFailed"` → "pod failed: <detail>"
 *   4. `pod.phase === "Pending"` with a `PodScheduled=False,
 *      reason=Unschedulable` condition → "unschedulable: <message>"
 *   5. otherwise `null` (defer to `mapConditionsToStatus`'s CR-Ready mapping)
 *
 * `pod === null` (CR has no backing pod yet, or the GET 404'd) always
 * returns `null` — a merely-still-provisioning CR must never be classified
 * as an error.
 */
export function classifyPodFailure(pod: PodStatusInfo | null, crReadyCondition?: SandboxCondition): string | null {
  if (pod === null) return null;

  for (const cs of pod.containerStatuses ?? []) {
    if (cs.waitingReason && IMAGE_PULL_WAITING_REASONS.has(cs.waitingReason)) {
      const target = cs.image ?? cs.waitingMessage ?? "unknown image";
      return `image pull failed (${cs.waitingReason}): ${target}`;
    }
  }

  for (const cs of pod.containerStatuses ?? []) {
    if (cs.waitingReason === "CrashLoopBackOff") {
      return "container crash-looping (CrashLoopBackOff)";
    }
  }

  if (pod.phase === "Failed" || crReadyCondition?.reason === "PodFailed") {
    const detail = crReadyCondition?.message ?? crReadyCondition?.reason ?? "pod entered phase Failed";
    return `pod failed: ${detail}`;
  }

  if (pod.phase === "Pending") {
    const scheduled = pod.conditions?.find((c) => c.type === "PodScheduled");
    if (scheduled?.status === "False" && scheduled.reason === "Unschedulable") {
      return `unschedulable: ${scheduled.message ?? "no message"}`;
    }
  }

  return null;
}

/**
 * Absent CR → "released" (per the brief); otherwise delegates to
 * `mapConditionsToStatus`, UNLESS `podsApi`/`podStatusApi` are supplied and
 * the backing pod is in a terminal-failure state (`classifyPodFailure`), in
 * which case that takes precedence and reports `state: "error"` immediately
 * — this is the fix for the "pod fails to start -> hangs for 60s on a
 * generic timeout" bug: the CR's own `Ready` condition only ever carries
 * `type: Ready` with the failure cause in `reason`/`message`, so without
 * reading the pod directly every startup failure looked identical to normal
 * in-progress provisioning.
 *
 * Best-effort and defensive: `podsApi`/`podStatusApi` are optional (existing
 * callers/tests that only care about the CR-Ready mapping keep working
 * unchanged), and any failure resolving the pod name or GETting the pod
 * (404, transient API error) is swallowed — falls through to the baseline
 * CR-Ready mapping rather than misreporting "error" for a pod that simply
 * isn't resolvable yet.
 */
export async function sandboxStatus(
  api: SandboxCustomObjectsApi,
  cfg: K8sProviderConfig,
  name: string,
  podsApi?: SandboxPodsApi,
  podStatusApi?: SandboxPodStatusApi,
): Promise<SandboxStatus> {
  const cr = await getSandbox(api, cfg, name);
  if (cr === null) {
    return { id: name, state: "released" };
  }
  if (cr.spec.operatingMode === "Suspended") {
    // Short-circuits before the pod-failure classification below: a
    // suspended CR's backing pod is deliberately gone, so resolving it and
    // checking for a terminal failure is both wasted work and would
    // misclassify "the pod I intentionally scaled to zero" as an error.
    return { id: name, state: "idle" };
  }
  const conditions = cr.status?.conditions ?? [];
  const baseline = mapConditionsToStatus(name, conditions, cr.spec.operatingMode);

  if (podsApi && podStatusApi) {
    const podName = await resolvePodName(api, podsApi, cfg, name).catch(() => null);
    if (podName) {
      const pod = await podStatusApi.getPodStatus(cfg.namespace, podName).catch(() => null);
      const readyCondition = conditions.find((c) => c.type === "Ready");
      const reason = classifyPodFailure(pod, readyCondition);
      if (reason) return { id: name, state: "error", error: reason };
    }
  }

  return baseline;
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
