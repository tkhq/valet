import type * as k8s from "@kubernetes/client-node";

export interface PodEvictionEvent {
  podName?: string;
  uid?: string;
  reason?: string;
  message?: string;
  timestamp?: number;
}

export interface SandboxEvictionApi {
  getPod(namespace: string, podName: string): Promise<{ uid?: string; reason?: string; message?: string } | null>;
  listEvents(namespace: string, podName: string): Promise<PodEvictionEvent[]>;
}

/** Read status before dispatch. After deletion, retain only recent evidence for this pod identity. */
export async function findPodEviction(
  api: SandboxEvictionApi,
  namespace: string,
  podName: string,
  dispatchUid: string | null,
  now = Date.now(),
): Promise<string | null> {
  const pod = await api.getPod(namespace, podName);
  if (pod && (dispatchUid === null || pod.uid === dispatchUid)) {
    return pod.reason === "Evicted" ? pod.message ?? "Kubernetes evicted the sandbox pod" : null;
  }
  const events = await api.listEvents(namespace, podName);
  const eviction = events
    .filter((event) => event.podName === podName && event.reason === "Evicted"
      && (dispatchUid === null || event.uid === dispatchUid)
      && event.timestamp !== undefined && event.timestamp <= now && event.timestamp >= now - 10 * 60_000)
    .sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0))[0];
  return eviction ? eviction.message ?? "Kubernetes evicted the sandbox pod" : null;
}

export function sandboxEvictionApiAdapter(api: Pick<k8s.CoreV1Api, "readNamespacedPod" | "listNamespacedEvent">): SandboxEvictionApi {
  return {
    async getPod(namespace, podName) {
      try {
        const pod = await api.readNamespacedPod({ namespace, name: podName });
        return { uid: pod.metadata?.uid, reason: pod.status?.reason, message: pod.status?.message };
      } catch (error) {
        if (typeof error === "object" && error !== null && "code" in error && error.code === 404) return null;
        throw error;
      }
    },
    async listEvents(namespace, podName) {
      const result = await api.listNamespacedEvent({ namespace, fieldSelector: `involvedObject.kind=Pod,involvedObject.name=${podName},reason=Evicted` });
      return result.items.map((event) => ({
        podName: event.involvedObject.name,
        uid: event.involvedObject.uid,
        reason: event.reason,
        message: event.message,
        timestamp: (event.series?.lastObservedTime ?? event.lastTimestamp ?? event.eventTime ?? event.metadata?.creationTimestamp)?.getTime(),
      }));
    },
  };
}
