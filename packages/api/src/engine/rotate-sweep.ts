/**
 * Hourly sandbox-token rotation sweep (sandbox-reconciliation plan, Task 12).
 *
 * Tokens minted at session provision time live up to 24 h, but a long-running
 * sandbox can outlast that window. `startRotateSweep` starts a background
 * interval that re-mints and pushes a fresh token into every eligible sandbox
 * via `SandboxProvider.updateCreds` — no pod restart required.
 *
 * Eligibility: the session is in the host's cache, its attachment is `ready`
 * or `suspended`, the provider reports `credsMount: true`, and the last token
 * mint is older than `maxAgeMs` (default 12 h).
 *
 * The rotation is additive (verify-don't-revoke): minting an ADDITIONAL token
 * never invalidates the previous one, so a token push that races an in-flight
 * API call from the sandbox is always safe.
 *
 * NOTE: The env var (`VALET_SANDBOX_TOKEN`) baked into the running pod's
 * environment at provision time is NOT updated here — that is impossible
 * without a pod restart. The env var is a fallback for sandboxes and providers
 * that predate `credsMount`; the live-mount at `/etc/valet/creds/token` is the
 * authoritative path for `credsMount`-capable providers.
 */

import type { SandboxProvider } from "@valet/engine";
import type { AppDb } from "../lib/drizzle.js";
import { mintSandboxToken } from "../auth/sandbox-tokens.js";

const DEFAULT_MAX_AGE_MS = 12 * 60 * 60 * 1000; // 12 h
const DEFAULT_INTERVAL_MS = 60 * 60 * 1000; // 1 h

/** Narrow interface the sweep needs from `EngineHost`. */
export interface RotateHost {
  listRotatableSessions(): Array<{
    sessionId: string;
    sandboxId: string | undefined;
    state: "ready" | "suspended";
    mintedAt: number;
    userId: string;
    orgId: string;
  }>;
  recordTokenMintedAt(sessionId: string, mintedAt: number): void;
}

export interface RotateSweepDeps {
  host: RotateHost;
  provider: SandboxProvider;
  db: AppDb;
  /** How often to run the sweep. Default: 1 h. */
  intervalMs?: number;
  /** Rotate tokens older than this. Default: 12 h. */
  maxAgeMs?: number;
}

export interface RotateSweepHandle {
  stop(): void;
}

/**
 * Starts the hourly token-rotation sweep. Call next to `prebuildService.start()`
 * in the api boot; call `handle.stop()` in the shutdown handler alongside
 * `prebuildService.stop()`.
 *
 * Returns a handle whose `stop()` clears the interval. The interval is
 * `.unref()`'d so it never prevents the process from exiting on its own.
 */
export function startRotateSweep(deps: RotateSweepDeps): RotateSweepHandle {
  const { host, provider, db, intervalMs = DEFAULT_INTERVAL_MS, maxAgeMs = DEFAULT_MAX_AGE_MS } = deps;

  const handle = setInterval(() => {
    runRotateSweep({ host, provider, db, maxAgeMs }).catch((err) =>
      console.error("RotateSweep: sweep tick failed:", err),
    );
  }, intervalMs);
  // Do not prevent the process from exiting if this is the only active handle.
  handle.unref?.();

  return {
    stop() {
      clearInterval(handle);
    },
  };
}

/** One sweep pass — exported for testability. */
export async function runRotateSweep(deps: {
  host: RotateHost;
  provider: SandboxProvider;
  db: AppDb;
  maxAgeMs?: number;
}): Promise<void> {
  const { host, provider, db, maxAgeMs = DEFAULT_MAX_AGE_MS } = deps;

  if (!provider.capabilities().credsMount) return;
  if (!provider.updateCreds) return;

  const now = Date.now();
  const sessions = host.listRotatableSessions();

  for (const entry of sessions) {
    if (now - entry.mintedAt < maxAgeMs) continue;
    if (!entry.sandboxId) continue;

    try {
      const { token } = await mintSandboxToken(db, {
        sessionId: entry.sessionId,
        userId: entry.userId,
        orgId: entry.orgId,
      });

      // provider.updateCreds existence was checked above.
      await provider.updateCreds!(entry.sandboxId, { token });

      host.recordTokenMintedAt(entry.sessionId, Date.now());
    } catch (err) {
      // Per-session errors are isolated — the sweep continues for other sessions.
      console.error(
        `RotateSweep: failed to rotate token for session ${entry.sessionId}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
}
