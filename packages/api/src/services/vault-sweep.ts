/**
 * Hourly credential-vault TTL sweep (Part 10 §Operations). Deletes rows
 * whose `expires_at` is in the past. Mirrors `startRotateSweep`:
 *   - `startSweepTimer` shell (unref'd, error-logged, overlap-guarded).
 *   - Default interval 1h; overridable via `intervalMs`.
 *   - Per-pass errors are isolated to one call — the timer keeps ticking.
 *
 * A pass is a single `EngagementVault.sweepExpired()` call: one indexed
 * DELETE with a returning clause. No per-row work.
 */
import { startSweepTimer } from "../lib/sweep-timer.js";
import type { EngagementVault } from "./security-vault.js";

const DEFAULT_INTERVAL_MS = 60 * 60 * 1000; // 1 h

export interface VaultSweepDeps {
  vault: EngagementVault;
  /** How often to run the sweep. Default 1 h. */
  intervalMs?: number;
}

export interface VaultSweepHandle {
  stop(): void;
}

export function startVaultSweep(deps: VaultSweepDeps): VaultSweepHandle {
  const { vault, intervalMs = DEFAULT_INTERVAL_MS } = deps;
  return startSweepTimer("VaultTTLSweep", intervalMs, () => runVaultSweep(vault));
}

/** One sweep pass; exported for testability. Returns the count of rows
 * crypto-shredded so a caller can assert against a known fixture. */
export async function runVaultSweep(vault: EngagementVault): Promise<number> {
  return vault.sweepExpired();
}
