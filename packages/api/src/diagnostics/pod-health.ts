/**
 * Pod restarts and OOM kills on the kubernetes backend, read for
 * `diagnostics.list_pod_restarts`. Read-only: list pods and list Warning
 * events, nothing else.
 *
 * RBAC today (`deploy/chart/valet/templates/rbac.yaml`): the API service
 * account may list pods and events in the sandbox namespace only. The
 * chart keeps it out of its own namespace on purpose, so reads of the API
 * and Postgres pods return 403 until an operator grants
 * `API_NAMESPACE_RBAC`. This module reports that grant; it does not work
 * around it.
 */
import { readFileSync } from "node:fs";
import * as k8s from "@kubernetes/client-node";
import { resolveKubeConfig } from "../providers/sandbox-backend.js";

/** Pods read per namespace. */
const MAX_PODS = 500;
/** API-namespace pods returned in full. */
const MAX_API_PODS = 50;
const MAX_WARNINGS = 20;
const MESSAGE_CHARS = 200;
const WARNING_WINDOW_MS = 60 * 60_000;

/** The Role an operator adds so the API can read its own namespace. */
export function apiNamespaceRbac(namespace: string, serviceAccount = "valet-api"): string {
  return `Role in namespace ${namespace} with rules: apiGroups [""], resources ["pods"], verbs ["get", "list"]; ` +
    `apiGroups [""], resources ["events"], verbs ["list"]. RoleBinding to ServiceAccount ${serviceAccount} in ${namespace}.`;
}

export interface ContainerHealth {
  name: string;
  ready: boolean;
  restarts: number;
  /** running, waiting:<reason>, or terminated:<reason>. */
  state: string;
  lastTermination?: { reason?: string; exitCode?: number; finishedAt?: number };
}

export interface PodRead {
  name: string;
  phase?: string;
  node?: string;
  startedAt?: number;
  containers: ContainerHealth[];
}

export interface PodWarning {
  pod?: string;
  reason?: string;
  message?: string;
  count: number;
  lastAt?: number;
}

export interface PodHealthApi {
  listPods(namespace: string): Promise<PodRead[]>;
  listPodWarnings(namespace: string): Promise<PodWarning[]>;
}

function containerState(status: k8s.V1ContainerStatus): string {
  if (status.state?.running) return "running";
  if (status.state?.waiting) return `waiting:${status.state.waiting.reason ?? "unknown"}`;
  if (status.state?.terminated) return `terminated:${status.state.terminated.reason ?? "unknown"}`;
  return "unknown";
}

export function podRead(pod: k8s.V1Pod): PodRead {
  const statuses = [...(pod.status?.initContainerStatuses ?? []), ...(pod.status?.containerStatuses ?? [])];
  return {
    name: pod.metadata?.name ?? "(unnamed)",
    ...(pod.status?.phase ? { phase: pod.status.phase } : {}),
    ...(pod.spec?.nodeName ? { node: pod.spec.nodeName } : {}),
    ...(pod.status?.startTime ? { startedAt: pod.status.startTime.getTime() } : {}),
    containers: statuses.map((status) => {
      const last = status.lastState?.terminated;
      return {
        name: status.name,
        ready: status.ready,
        restarts: status.restartCount,
        state: containerState(status),
        ...(last ? { lastTermination: {
          ...(last.reason ? { reason: last.reason } : {}),
          exitCode: last.exitCode,
          ...(last.finishedAt ? { finishedAt: last.finishedAt.getTime() } : {}),
        } } : {}),
      };
    }),
  };
}

/** The two `CoreV1Api` list calls this module makes. A real `CoreV1Api` fits it. */
export interface PodListApi {
  listNamespacedPod(request: { namespace: string; limit?: number }): Promise<{ items: k8s.V1Pod[] }>;
  listNamespacedEvent(request: { namespace: string; fieldSelector?: string; limit?: number }): Promise<{ items: k8s.CoreV1Event[] }>;
}

export function podHealthApiAdapter(api: PodListApi): PodHealthApi {
  return {
    async listPods(namespace) {
      const list = await api.listNamespacedPod({ namespace, limit: MAX_PODS });
      return list.items.map(podRead);
    },
    async listPodWarnings(namespace) {
      const list = await api.listNamespacedEvent({ namespace, fieldSelector: "type=Warning,involvedObject.kind=Pod", limit: MAX_PODS });
      return list.items.map((event) => ({
        ...(event.involvedObject.name ? { pod: event.involvedObject.name } : {}),
        ...(event.reason ? { reason: event.reason } : {}),
        ...(event.message ? { message: event.message.replace(/\s+/g, " ").slice(0, MESSAGE_CHARS) } : {}),
        count: event.series?.count ?? event.count ?? 1,
        lastAt: (event.series?.lastObservedTime ?? event.lastTimestamp ?? event.eventTime ?? event.metadata?.creationTimestamp)?.getTime(),
      }));
    },
  };
}

/** A read that failed because RBAC refused it. */
export function isForbidden(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === 403;
}

function lastTerminationAt(pod: PodRead): number {
  return Math.max(0, ...pod.containers.map((container) => container.lastTermination?.finishedAt ?? 0));
}

function recentWarnings(warnings: PodWarning[], now: number): PodWarning[] {
  return warnings.filter((warning) => warning.lastAt === undefined || warning.lastAt >= now - WARNING_WINDOW_MS);
}

/** Every API-namespace pod by name, restarted ones first, with the Warning
 * events of the last hour (probe failures, back-offs, kills). */
export function summarizeApiNamespace(pods: PodRead[], warnings: PodWarning[], now: number) {
  const restarts = (pod: PodRead) => pod.containers.reduce((sum, container) => sum + container.restarts, 0);
  return {
    pods: [...pods].sort((a, b) => restarts(b) - restarts(a) || lastTerminationAt(b) - lastTerminationAt(a)).slice(0, MAX_API_PODS),
    warnings: recentWarnings(warnings, now).sort((a, b) => (b.lastAt ?? 0) - (a.lastAt ?? 0)).slice(0, MAX_WARNINGS),
  };
}

/** Sandbox pods as counts only: no pod or session names, because sandboxes
 * belong to every organization on the deployment. */
export function summarizeSandboxNamespace(pods: PodRead[], warnings: PodWarning[], now: number) {
  const byNode = new Map<string, { node: string; pods: number; restarts: number; oomKilled: number }>();
  const lastTerminations: Record<string, number> = {};
  let restartedPods = 0;
  let restarts = 0;
  let oomKilledPods = 0;
  for (const pod of pods) {
    const podRestarts = pod.containers.reduce((sum, container) => sum + container.restarts, 0);
    const oom = pod.containers.some((container) => container.lastTermination?.reason === "OOMKilled" || container.state === "terminated:OOMKilled");
    restarts += podRestarts;
    if (podRestarts > 0) restartedPods += 1;
    if (oom) oomKilledPods += 1;
    for (const container of pod.containers) {
      const reason = container.lastTermination?.reason;
      if (reason) lastTerminations[reason] = (lastTerminations[reason] ?? 0) + 1;
    }
    const node = pod.node ?? "(unscheduled)";
    const entry = byNode.get(node) ?? { node, pods: 0, restarts: 0, oomKilled: 0 };
    entry.pods += 1;
    entry.restarts += podRestarts;
    if (oom) entry.oomKilled += 1;
    byNode.set(node, entry);
  }
  const warningReasons: Record<string, number> = {};
  for (const warning of recentWarnings(warnings, now)) {
    const reason = warning.reason ?? "unknown";
    warningReasons[reason] = (warningReasons[reason] ?? 0) + warning.count;
  }
  return {
    pods: pods.length,
    restartedPods,
    restarts,
    oomKilledPods,
    lastTerminations,
    byNode: [...byNode.values()].sort((a, b) => b.oomKilled - a.oomKilled || b.restarts - a.restarts).slice(0, 10),
    warningReasons,
  };
}

type NamespaceRead<T> = ({ namespace: string } & T) | { namespace: string; error: "forbidden"; requiredRbac: string } | { namespace: string; error: "unavailable"; detail: string };

async function readNamespace<T>(namespace: string, read: () => Promise<T>, rbac: string): Promise<NamespaceRead<T>> {
  try {
    return { namespace, ...(await read()) };
  } catch (err) {
    if (isForbidden(err)) return { namespace, error: "forbidden", requiredRbac: rbac };
    return { namespace, error: "unavailable", detail: (err instanceof Error ? err.message : String(err)).slice(0, MESSAGE_CHARS) };
  }
}

export interface PodHealthTarget {
  api: PodHealthApi;
  /** The API's own namespace; undefined when the API runs out of cluster. */
  apiNamespace?: string;
  sandboxNamespace: string;
}

/** Pod health for the API namespace, and for the sandbox namespace unless
 * `omitSandboxes` gives the reason the caller may not read numbers that
 * cover every organization. */
export async function readPodHealth(target: PodHealthTarget, opts: { omitSandboxes?: string; now?: number }) {
  const now = opts.now ?? Date.now();
  const sandbox = opts.omitSandboxes !== undefined ? { namespace: target.sandboxNamespace, omitted: opts.omitSandboxes } : await readNamespace(target.sandboxNamespace, async () => {
    const [pods, warnings] = await Promise.all([target.api.listPods(target.sandboxNamespace), target.api.listPodWarnings(target.sandboxNamespace)]);
    return summarizeSandboxNamespace(pods, warnings, now);
  }, `Role in namespace ${target.sandboxNamespace} with pods ["get", "list"] and events ["list"] (deploy/chart/valet/templates/rbac.yaml grants these).`);
  const apiNamespace = target.apiNamespace;
  const api = apiNamespace === undefined
    ? { error: "out_of_cluster" as const, detail: "The API does not run in a pod, so it has no pod to read." }
    : await readNamespace(apiNamespace, async () => {
      const [pods, warnings] = await Promise.all([target.api.listPods(apiNamespace), target.api.listPodWarnings(apiNamespace)]);
      return summarizeApiNamespace(pods, warnings, now);
    }, apiNamespaceRbac(apiNamespace));
  return { api, sandboxes: sandbox };
}

/** Where kubelet mounts the pod's own namespace. */
const SERVICE_ACCOUNT_NAMESPACE_FILE = "/var/run/secrets/kubernetes.io/serviceaccount/namespace";

/** The pod reader for this deployment, built on first call and reused. The
 * API namespace is the pod's own; out of cluster there is none. */
export function podHealthTargetFromEnv(env: NodeJS.ProcessEnv): () => PodHealthTarget {
  let target: PodHealthTarget | undefined;
  return () => {
    if (target) return target;
    const kc = resolveKubeConfig(env);
    let apiNamespace: string | undefined;
    if (env.KUBERNETES_SERVICE_HOST) {
      try {
        apiNamespace = readFileSync(SERVICE_ACCOUNT_NAMESPACE_FILE, "utf8").trim() || undefined;
      } catch {
        apiNamespace = undefined;
      }
    }
    target = {
      api: podHealthApiAdapter(kc.makeApiClient(k8s.CoreV1Api)),
      ...(apiNamespace ? { apiNamespace } : {}),
      sandboxNamespace: env.VALET_SANDBOX_NAMESPACE ?? "valet-sandboxes",
    };
    return target;
  };
}
