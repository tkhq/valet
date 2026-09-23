/** Shared model discovery contract for every Valet host. */
export const MODEL_DISCOVERY_STATES = ["pending", "approved", "rejected"] as const;

export type ModelDiscoveryState = (typeof MODEL_DISCOVERY_STATES)[number];

export interface ModelDiscoveryCandidate<T> {
  providerId: string;
  modelId: string;
  metadata: T;
}

export interface ModelDiscoveryRecord<T> extends ModelDiscoveryCandidate<T> {
  discoveredAt: number;
}

export function modelDiscoveryKey(providerId: string, modelId: string): string {
  return `${providerId}\u0000${modelId}`;
}

/**
 * Return upstream models that are absent from both the bundled catalog and
 * the persisted discovery set. This function does not mutate model choices.
 */
export function detectNewModels<T>(
  upstream: readonly ModelDiscoveryCandidate<T>[],
  bundledKeys: ReadonlySet<string>,
  discoveredKeys: ReadonlySet<string>,
  discoveredAt: number,
): ModelDiscoveryRecord<T>[] {
  const found: ModelDiscoveryRecord<T>[] = [];
  for (const candidate of upstream) {
    const key = modelDiscoveryKey(candidate.providerId, candidate.modelId);
    if (bundledKeys.has(key) || discoveredKeys.has(key)) continue;
    found.push({ ...candidate, discoveredAt });
  }
  return found;
}
