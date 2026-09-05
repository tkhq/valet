/**
 * Storage-quantity math shared by the manifest builder (create-time
 * workspace sizing, TKAI-385) and the workspace-PVC growth path
 * (`workspace-pvc.ts`). Lives in its own module so `manifest.ts` can import
 * it without a cycle (`workspace-pvc.ts` imports `WORKSPACE_VOLUME_NAME`
 * from `manifest.ts`).
 */

import { parseResourceQuantity } from "@valet/engine";

/** Fallback cap for workspace sizing and growth when
 * `K8sProviderConfig.workspaceStorageMax` is unset. */
export const DEFAULT_WORKSPACE_STORAGE_MAX = "20Gi";

/** Compatibility name for Kubernetes workspace-storage consumers. */
export const parseStorageQuantity = parseResourceQuantity;

/** Formats bytes as the largest binary suffix that divides evenly (else
 * plain bytes) — the doubles of any whole-Mi quantity stay whole. */
export function formatStorageQuantity(bytes: number): string {
  for (const [suffix, unit] of [
    ["Gi", 2 ** 30],
    ["Mi", 2 ** 20],
    ["Ki", 2 ** 10],
  ] as const) {
    if (bytes % unit === 0) return `${bytes / unit}${suffix}`;
  }
  return `${bytes}`;
}

/**
 * Clamps a requested storage quantity to a cap: the request (trimmed) when it
 * fits, the cap (trimmed) when it exceeds it (`clamped: true`), or null when
 * either quantity is unparseable — the caller falls back to its default
 * rather than provisioning an unknown size (a typo'd cap must never grant an
 * unbounded request).
 *
 * Trimmed, never verbatim: `parseStorageQuantity` trims before matching, so a
 * whitespace-padded value (`"8Gi "` survives YAML quoting) parses here — but
 * emitted verbatim it fails the CRD's quantity pattern and the CR is rejected
 * at admission, which kills the sandbox outright instead of falling back.
 */
export function clampStorageRequest(
  requested: string,
  max: string,
): { storage: string; clamped: boolean } | null {
  const requestedBytes = parseStorageQuantity(requested);
  if (requestedBytes === null || requestedBytes <= 0) return null;
  const maxBytes = parseStorageQuantity(max);
  if (maxBytes === null || maxBytes <= 0) return null;
  if (requestedBytes > maxBytes) return { storage: max.trim(), clamped: true };
  return { storage: requested.trim(), clamped: false };
}
