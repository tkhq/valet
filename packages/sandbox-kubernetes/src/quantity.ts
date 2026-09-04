/**
 * Storage-quantity math shared by the manifest builder (create-time
 * workspace sizing, TKAI-385) and the workspace-PVC growth path
 * (`workspace-pvc.ts`). Lives in its own module so `manifest.ts` can import
 * it without a cycle (`workspace-pvc.ts` imports `WORKSPACE_VOLUME_NAME`
 * from `manifest.ts`).
 */

/** Fallback cap for workspace sizing and growth when
 * `K8sProviderConfig.workspaceStorageMax` is unset. */
export const DEFAULT_WORKSPACE_STORAGE_MAX = "20Gi";

const BINARY_SUFFIXES: Record<string, number> = {
  Ki: 2 ** 10,
  Mi: 2 ** 20,
  Gi: 2 ** 30,
  Ti: 2 ** 40,
};

const DECIMAL_SUFFIXES: Record<string, number> = {
  k: 1e3,
  M: 1e6,
  G: 1e9,
  T: 1e12,
};

/**
 * Parses a Kubernetes storage quantity ("1Gi", "500Mi", "2G", "1073741824")
 * to bytes, or null when unparseable. Covers the suffixes storage values
 * realistically use (binary Ki/Mi/Gi/Ti, decimal k/M/G/T, plain bytes) —
 * not the full quantity grammar (no milli/exponent forms, which are
 * nonsensical for a PVC size).
 */
export function parseStorageQuantity(quantity: string): number | null {
  const match = /^([0-9]+(?:\.[0-9]+)?)(Ki|Mi|Gi|Ti|k|M|G|T)?$/.exec(quantity.trim());
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return null;
  const suffix = match[2];
  const unit = suffix ? (BINARY_SUFFIXES[suffix] ?? DECIMAL_SUFFIXES[suffix]) : 1;
  return Math.floor(value * unit);
}

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
