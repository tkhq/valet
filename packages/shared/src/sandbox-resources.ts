/**
 * Platform CPU ceiling for one sandbox.
 *
 * Kubernetes has no portable CPU maximum. Valet uses 64 cores because it fits
 * on common high-core nodes while rejecting values that cannot be scheduled by
 * ordinary clusters. Keep fractional CPU support: the valid range is (0, 64].
 */
export const MAX_SANDBOX_CPU = 64;

/** True when a CPU value is finite and inside Valet's sandbox CPU range. */
export function isValidSandboxCpu(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= MAX_SANDBOX_CPU;
}

/** Human-readable range generated from the shared ceiling. */
export function sandboxCpuRange(): string {
  return `greater than 0 and at most ${MAX_SANDBOX_CPU}`;
}
