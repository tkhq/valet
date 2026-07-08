/**
 * SessionLifecycle — pure HTTP interactions with the Modal backend
 * and timing/alarm logic extracted from SessionAgentDO.
 *
 * This class owns:
 * - Sandbox spawn / terminate / snapshot / restore (HTTP calls)
 * - Idle timeout detection
 * - Alarm scheduling (combining idle timeout with external deadlines)
 * - Running-time accumulation (markRunningStarted / flushActiveSeconds)
 * - Activity touch (lastUserActivityAt)
 */

import type { SessionState } from './session-state.js';

// ─── Retry Helpers (TKAI-176) ────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Exponential backoff: 2s, 4s, 8s… */
function backoffMs(attempt: number): number {
  return Math.min(2_000 * 2 ** (attempt - 1), 8_000);
}

// ─── Error Types ──────────────────────────────────────────────────────────────

/** Thrown when a sandbox operation receives a 409 — sandbox already exited. */
export class SandboxAlreadyExitedError extends Error {
  constructor(message?: string) {
    super(message ?? 'Sandbox has already exited');
    this.name = 'SandboxAlreadyExitedError';
  }
}

/** Thrown when the backend cannot create a snapshot image for hibernation. */
export class SandboxSnapshotFailedError extends Error {
  constructor(message?: string) {
    super(message ?? 'Snapshot failed');
    this.name = 'SandboxSnapshotFailedError';
  }
}

// ─── Result Types ─────────────────────────────────────────────────────────────

export interface SpawnResult {
  sandboxId: string;
  tunnelUrls: Record<string, string>;
  durationMs: number;
}

export interface SnapshotResult {
  snapshotImageId: string;
}

export interface RestoreResult {
  sandboxId: string;
  tunnelUrls: Record<string, string>;
  durationMs: number;
}

// ─── SessionLifecycle ─────────────────────────────────────────────────────────

export class SessionLifecycle {
  private readonly state: SessionState;
  private readonly ctx: DurableObjectState;

  constructor(state: SessionState, ctx: DurableObjectState) {
    this.state = state;
    this.ctx = ctx;
  }

  // ─── Sandbox Operations (pure HTTP) ─────────────────────────────────

  /**
   * Spawn a new sandbox via the Modal backend.
   *
   * TKAI-176: The Modal `create-session` endpoint can occasionally exceed
   * Cloudflare's ~100s edge cap and return `524 error code: 524`, or the
   * connection can drop mid-flight. In practice the sandbox usually still
   * comes up on Modal's side — we just gave up before it responded. To reduce
   * the surface-level failure rate we:
   *   1. Bound the outbound fetch with `AbortSignal.timeout(90_000)` so we
   *      surface a clean `AbortError` before CF's edge times us out.
   *   2. Retry once on transient failures (timeout, network error, 5xx
   *      including 524). Non-transient errors (4xx auth/config) fail fast.
   *
   * Note: this does NOT adopt an in-flight sandbox that came up after our
   * fetch timed out — that requires threading a clientRequestId all the way
   * through to Modal and a separate adoption endpoint (Approach B in
   * TKAI-176). Cheap retry only reduces how often we see the failure at all.
   */
  async spawnSandbox(
    backendUrl: string,
    spawnRequest: Record<string, unknown>,
  ): Promise<SpawnResult> {
    const start = Date.now();
    const maxAttempts = 2;
    let lastErr: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const response = await fetch(backendUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(spawnRequest),
          signal: AbortSignal.timeout(90_000),
        });

        if (!response.ok) {
          const err = await response.text();
          const status = response.status;
          // Retry on 5xx (includes CF 524 edge timeout, 503 Modal cold, 502
          // bad gateway). Fail fast on 4xx — auth/config errors won't fix
          // themselves.
          if (status >= 500 && attempt < maxAttempts) {
            lastErr = new Error(`Backend returned ${status}: ${err}`);
            console.warn(
              `[SessionLifecycle] spawnSandbox attempt ${attempt}/${maxAttempts} failed with ${status}, retrying: ${err.slice(0, 200)}`,
            );
            await sleep(backoffMs(attempt));
            continue;
          }
          throw new Error(`Backend returned ${status}: ${err}`);
        }

        const result = await response.json() as {
          sandboxId: string;
          tunnelUrls: Record<string, string>;
        };

        if (attempt > 1) {
          console.log(`[SessionLifecycle] spawnSandbox succeeded on attempt ${attempt}/${maxAttempts}`);
        }

        return {
          sandboxId: result.sandboxId,
          tunnelUrls: result.tunnelUrls,
          durationMs: Date.now() - start,
        };
      } catch (err) {
        // AbortError (our 90s timeout) or network error — retry once.
        const isAbort = err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');
        const isNetwork = err instanceof TypeError; // undici surfaces network errors as TypeError
        if ((isAbort || isNetwork) && attempt < maxAttempts) {
          lastErr = err;
          console.warn(
            `[SessionLifecycle] spawnSandbox attempt ${attempt}/${maxAttempts} threw ${err instanceof Error ? err.name : 'error'}, retrying: ${err instanceof Error ? err.message : String(err)}`,
          );
          await sleep(backoffMs(attempt));
          continue;
        }
        throw err;
      }
    }

    // Should be unreachable — loop either returns or throws — but satisfy TS.
    throw lastErr ?? new Error('spawnSandbox: exhausted retries with no error captured');
  }

  /** Terminate the current sandbox via the backend. Best-effort, never throws. */
  async terminateSandbox(): Promise<void> {
    const sandboxId = this.state.sandboxId;
    const terminateUrl = this.state.terminateUrl;
    if (!sandboxId || !terminateUrl) return;

    try {
      await fetch(terminateUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sandboxId }),
      });
    } catch (err) {
      console.error('Failed to terminate sandbox:', err);
    }
  }

  /**
   * Snapshot the current sandbox filesystem for hibernation.
   * Throws SandboxAlreadyExitedError on 409 so the caller can route
   * through proper termination instead.
   */
  async snapshotSandbox(): Promise<SnapshotResult> {
    const sandboxId = this.state.sandboxId;
    const hibernateUrl = this.state.hibernateUrl;

    if (!sandboxId || !hibernateUrl) {
      throw new Error('Cannot snapshot: missing sandboxId or hibernateUrl');
    }

    const response = await fetch(hibernateUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sandboxId }),
    });

    if (response.status === 409) {
      throw new SandboxAlreadyExitedError();
    }

    if (response.status === 503) {
      let message = 'Snapshot failed';
      try {
        const body = await response.json() as { error?: string; message?: string };
        if (body.error === 'snapshot_failed') {
          message = body.message ? `Snapshot failed: ${body.message}` : message;
        }
      } catch {
        // Ignore parse failure and fall back to generic error below.
      }
      throw new SandboxSnapshotFailedError(message);
    }

    if (response.status === 500) {
      const err = await response.text();
      const snapshotMessage = this.extractSnapshotFailureMessage(err);
      if (snapshotMessage) {
        throw new SandboxSnapshotFailedError(`Snapshot failed: ${snapshotMessage}`);
      }
      throw new Error(`Backend returned ${response.status}: ${err}`);
    }

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Backend returned ${response.status}: ${err}`);
    }

    const result = await response.json() as { snapshotImageId: string };
    return { snapshotImageId: result.snapshotImageId };
  }

  private extractSnapshotFailureMessage(errorText: string): string | null {
    const normalized = errorText.toLowerCase();
    if (normalized.includes('timed out waiting for image to be created')) {
      return 'Timed out waiting for image to be created';
    }
    if (normalized.includes('failed to create image')) {
      return 'Failed to create image';
    }
    return null;
  }

  /** Restore a sandbox from a snapshot. */
  async restoreSandbox(): Promise<RestoreResult> {
    const snapshotImageId = this.state.snapshotImageId;
    const restoreUrl = this.state.restoreUrl;
    const spawnRequest = this.state.spawnRequest;

    if (!snapshotImageId || !restoreUrl || !spawnRequest) {
      throw new Error('Cannot restore: missing snapshotImageId, restoreUrl, or spawnRequest');
    }

    const start = Date.now();
    console.log(`[SessionLifecycle] restoreSandbox: fetching ${restoreUrl} (snapshotId=${snapshotImageId})`);
    const response = await fetch(restoreUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...spawnRequest,
        snapshotImageId,
      }),
      signal: AbortSignal.timeout(60_000),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Backend returned ${response.status}: ${err}`);
    }

    const result = await response.json() as {
      sandboxId: string;
      tunnelUrls: Record<string, string>;
    };

    return {
      sandboxId: result.sandboxId,
      tunnelUrls: result.tunnelUrls,
      durationMs: Date.now() - start,
    };
  }

  // ─── Idle Timeout ───────────────────────────────────────────────────

  /** Returns true if the session has been idle long enough to hibernate. */
  checkIdleTimeout(): boolean {
    const status = this.state.status;
    const idleTimeoutMs = this.state.idleTimeoutMs;
    const lastActivity = this.state.lastUserActivityAt;

    if (status !== 'running' || !idleTimeoutMs || !lastActivity) {
      return false;
    }

    return Date.now() - lastActivity >= idleTimeoutMs;
  }

  /** Update last activity timestamp. */
  touchActivity(): void {
    this.state.lastUserActivityAt = Date.now();
  }

  // ─── Running-Time Tracking ─────────────────────────────────────────

  /** Record that the sandbox entered the 'running' state. */
  markRunningStarted(): void {
    this.state.runningStartedAt = Date.now();
  }

  /**
   * Compute elapsed active seconds since markRunningStarted() and reset
   * the marker. Returns 0 if no marker was set. The caller is responsible
   * for persisting the returned value to D1.
   */
  flushActiveSeconds(): number {
    const startMs = this.state.runningStartedAt;
    if (!startMs) return 0;

    const elapsed = Math.floor((Date.now() - startMs) / 1000);
    // Reset to now so we don't double-count on next flush
    this.state.runningStartedAt = Date.now();
    return elapsed;
  }

  /** Clear the running start marker (leaving running state permanently). */
  clearRunningStarted(): void {
    this.state.runningStartedAt = 0;
    this.state.sandboxWakeStartedAt = 0;
  }

  // ─── Alarm Scheduling ──────────────────────────────────────────────

  /**
   * Schedule the next alarm from a set of candidate deadlines.
   * Automatically includes the idle timeout deadline if configured.
   * Pass additional deadlines from subsystems (prompt expiry, followups, etc.).
   */
  /**
   * Minimum re-check interval when a deadline is already past.
   * Prevents tight alarm loops from expired-but-unactionable deadlines
   * (e.g., watchdog deadline expired while runner is still connected).
   */
  private static readonly MIN_PAST_DEADLINE_DELAY_MS = 30_000;

  scheduleAlarm(externalDeadlines: (number | null)[]): void {
    let earliest = Infinity;

    // Idle timeout deadline
    const idleTimeoutMs = this.state.idleTimeoutMs;
    const lastActivity = this.state.lastUserActivityAt;
    if (idleTimeoutMs > 0 && lastActivity > 0) {
      const idleDeadline = lastActivity + idleTimeoutMs;
      if (idleDeadline < earliest) earliest = idleDeadline;
    }

    // External deadlines from caller
    for (const deadline of externalDeadlines) {
      if (deadline != null && deadline > 0 && deadline < earliest) {
        earliest = deadline;
      }
    }

    if (earliest < Infinity) {
      // If the earliest deadline is already past, clamp to a minimum delay.
      // This prevents tight alarm loops when a deadline has expired but its
      // handler's preconditions aren't met (e.g., stuck-processing watchdog
      // fires after 5 min but runner is still connected — nothing to do).
      const now = Date.now();
      if (earliest <= now) {
        earliest = now + SessionLifecycle.MIN_PAST_DEADLINE_DELAY_MS;
      }
      this.ctx.storage.setAlarm(earliest);
    }
  }
}
