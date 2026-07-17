/**
 * Narrow adapter over `@kubernetes/client-node`'s `BatchV1Api` (Jobs) and
 * `CoreV1Api` (Pods/ConfigMaps/Secrets/pod-logs) for the sandbox images v2
 * plan's Task 5 kubernetes BuildKit-Job image builder
 * (`packages/api/src/prebuilds/k8s-builder.ts`).
 *
 * Mirrors `./lifecycle.ts`'s narrow-adapter pattern (`SandboxCustomObjectsApi`
 * / `podsApiAdapter`): a hand-written interface naming exactly the methods
 * the builder calls, plus a production adapter wrapping the real
 * `client-node` classes. Unlike `CustomObjectsApi` (schemaless, `any` in/
 * out), `BatchV1Api`/`CoreV1Api` are properly typed generated clients, so
 * (like `podsApiAdapter`) no runtime validation boundary is needed here —
 * the adapter just projects the real typed response down to the minimal
 * shape callers need.
 *
 * This module does NOT touch the Sandbox CRD or session sandboxes at all —
 * it is purely the plumbing for BuildKit build Jobs run in the sandbox
 * namespace to produce prebuilt images. Named `buildkit-job.ts` (not
 * `jobs.ts`) to avoid colliding with the unrelated `./jobs.ts` (exec-job
 * protocol run *inside* a sandbox container via pods/exec).
 */
import type * as k8s from "@kubernetes/client-node";
import type { PodOwnerReference, PodSummary } from "./types.js";

// ── Params ──────────────────────────────────────────────────────────────

export interface CreateJobParams {
  namespace: string;
  body: k8s.V1Job;
}

export interface GetJobParams {
  namespace: string;
  name: string;
}

export interface DeleteJobParams {
  namespace: string;
  name: string;
}

export interface ListJobPodsParams {
  namespace: string;
  labelSelector: string;
}

export interface ReadPodLogParams {
  namespace: string;
  podName: string;
  container?: string;
  tailLines?: number;
}

export interface CreateConfigMapParams {
  namespace: string;
  name: string;
  data: Record<string, string>;
  labels?: Record<string, string>;
}

export interface DeleteConfigMapParams {
  namespace: string;
  name: string;
}

export interface CreateSecretParams {
  namespace: string;
  name: string;
  stringData: Record<string, string>;
  labels?: Record<string, string>;
}

export interface DeleteSecretParams {
  namespace: string;
  name: string;
}

// ── Result shapes ───────────────────────────────────────────────────────

/** Standard Kubernetes Job condition shape (`type`/`status`/`reason`/
 * `message`) — same fields as `SandboxCondition` in ./types.ts, kept
 * separate since it describes a batch/v1 Job, not the Sandbox CR. */
export interface JobConditionInfo {
  type: string;
  status: "True" | "False" | "Unknown";
  reason?: string;
  message?: string;
}

/** The subset of a `V1Job`'s `.status` the k8s image builder reads to
 * classify a build's state (active/succeeded/failed counts + conditions —
 * see `k8s-builder.ts`'s `mapJobStatus`). */
export interface JobStatusInfo {
  active?: number;
  succeeded?: number;
  failed?: number;
  conditions?: JobConditionInfo[];
}

// ── Adapter interface ───────────────────────────────────────────────────

/** The subset of `BatchV1Api`/`CoreV1Api` the k8s image builder drives:
 * Job create/get/delete + list-pods-for-job + pod-log tail (Jobs), plus
 * ConfigMap/Secret create/delete (the generated Dockerfile + git token the
 * build Job mounts). Real `client-node` classes are properly typed, so
 * (unlike `SandboxCustomObjectsApi`) callers here get concrete types
 * directly rather than validating an `unknown` payload. */
export interface SandboxBatchJobsApi {
  /** Idempotent from the caller's perspective is NOT guaranteed here — a
   * 409 (name already in use) is thrown through, matching real `BatchV1Api`
   * behavior. `k8s-builder.ts` always mints a fresh, uniquely-suffixed Job
   * name per build, so a 409 in practice signals a real bug (id reuse), not
   * a benign race. */
  createNamespacedJob(params: CreateJobParams): Promise<void>;
  /** Returns `null` when the Job does not exist (404) — never throws for
   * the "absent" case (e.g. after `cancel`/cleanup already deleted it). */
  getNamespacedJob(params: GetJobParams): Promise<JobStatusInfo | null>;
  /** Deletes with `propagationPolicy: "Background"` so the Job's pod(s)
   * are cascade-deleted too. Idempotent — a 404 is treated as success. */
  deleteNamespacedJob(params: DeleteJobParams): Promise<void>;
  /** Lists pods matching `labelSelector` in `namespace` — used to resolve
   * the single pod backing a build Job (`backoffLimit: 0` means at most one
   * pod attempt) for log-tailing. */
  listPodsForJob(params: ListJobPodsParams): Promise<{ items: PodSummary[] }>;
  /** Best-effort: returns `""` (never throws) when the pod doesn't exist
   * yet, has no container started, or the log fetch otherwise fails —
   * `status()` callers treat an empty tail as "no logs yet", not an error. */
  readPodLog(params: ReadPodLogParams): Promise<string>;
  /** Idempotent create: a 409 (already exists) is swallowed — the builder's
   * cleanup-on-terminal-status path and a subsequent poll pass calling
   * `build()` again for a retried id could otherwise race a duplicate
   * create into an error. */
  createConfigMap(params: CreateConfigMapParams): Promise<void>;
  /** Idempotent delete — 404 is treated as success. */
  deleteConfigMap(params: DeleteConfigMapParams): Promise<void>;
  /** Idempotent create (see `createConfigMap`'s note). */
  createSecret(params: CreateSecretParams): Promise<void>;
  /** Idempotent delete — 404 is treated as success. */
  deleteSecret(params: DeleteSecretParams): Promise<void>;
}

function isApiError(err: unknown): err is { code: number } {
  return typeof err === "object" && err !== null && typeof (err as { code?: unknown }).code === "number";
}

function podOwnerReferencesFrom(refs: k8s.V1OwnerReference[] | undefined): PodOwnerReference[] | undefined {
  if (!refs) return undefined;
  return refs.map((ref) => ({ kind: ref.kind, name: ref.name, controller: ref.controller }));
}

function jobConditionsFrom(conditions: k8s.V1JobCondition[] | undefined): JobConditionInfo[] | undefined {
  if (!conditions) return undefined;
  return conditions
    .filter((c): c is k8s.V1JobCondition & { type: string; status: "True" | "False" | "Unknown" } =>
      typeof c.type === "string" && (c.status === "True" || c.status === "False" || c.status === "Unknown"),
    )
    .map((c) => ({ type: c.type, status: c.status, reason: c.reason, message: c.message }));
}

/** Wraps real `k8s.BatchV1Api` + `k8s.CoreV1Api` instances. No casts: both
 * classes return properly typed responses already. */
export function batchJobsApiAdapter(api: k8s.BatchV1Api, core: k8s.CoreV1Api): SandboxBatchJobsApi {
  return {
    async createNamespacedJob(params) {
      await api.createNamespacedJob({ namespace: params.namespace, body: params.body });
    },

    async getNamespacedJob(params) {
      let job: k8s.V1Job;
      try {
        job = await api.readNamespacedJob({ name: params.name, namespace: params.namespace });
      } catch (err) {
        if (isApiError(err) && err.code === 404) return null;
        throw err;
      }
      return {
        active: job.status?.active,
        succeeded: job.status?.succeeded,
        failed: job.status?.failed,
        conditions: jobConditionsFrom(job.status?.conditions),
      };
    },

    async deleteNamespacedJob(params) {
      try {
        await api.deleteNamespacedJob({
          name: params.name,
          namespace: params.namespace,
          propagationPolicy: "Background",
        });
      } catch (err) {
        if (isApiError(err) && err.code === 404) return;
        throw err;
      }
    },

    async listPodsForJob(params) {
      const result = await core.listNamespacedPod({
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

    async readPodLog(params) {
      try {
        const log = await core.readNamespacedPodLog({
          name: params.podName,
          namespace: params.namespace,
          container: params.container,
          tailLines: params.tailLines,
        });
        return typeof log === "string" ? log : "";
      } catch {
        return "";
      }
    },

    async createConfigMap(params) {
      try {
        await core.createNamespacedConfigMap({
          namespace: params.namespace,
          body: {
            metadata: { name: params.name, labels: params.labels },
            data: params.data,
          },
        });
      } catch (err) {
        if (isApiError(err) && err.code === 409) return;
        throw err;
      }
    },

    async deleteConfigMap(params) {
      try {
        await core.deleteNamespacedConfigMap({ name: params.name, namespace: params.namespace });
      } catch (err) {
        if (isApiError(err) && err.code === 404) return;
        throw err;
      }
    },

    async createSecret(params) {
      try {
        await core.createNamespacedSecret({
          namespace: params.namespace,
          body: {
            metadata: { name: params.name, labels: params.labels },
            stringData: params.stringData,
          },
        });
      } catch (err) {
        if (isApiError(err) && err.code === 409) return;
        throw err;
      }
    },

    async deleteSecret(params) {
      try {
        await core.deleteNamespacedSecret({ name: params.name, namespace: params.namespace });
      } catch (err) {
        if (isApiError(err) && err.code === 404) return;
        throw err;
      }
    },
  };
}
