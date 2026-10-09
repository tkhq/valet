// Helpers the wakeups seam and the WakeWatcher share (spec 2026-10-08,
// fix wave 2): which errors mean the sandbox is gone, and the detached job
// log cap.

import {
  SandboxEvictedError,
  SandboxGoneError,
  SandboxSupersededError,
  SandboxUnavailableError,
} from "@valet/engine";
import { parseResourceQuantity } from "@valet/shared";

/**
 * Error texts that mean the sandbox is gone: the kubernetes provider's
 * pod-gone error (`podUnavailableError`) and its `restore()` miss for a
 * deleted CR. Docker restore errors arrive as `SandboxGoneError`.
 */
const SANDBOX_GONE = /No such container|backing pod was recreated or removed|Sandbox CR "[^"]*" not found/;

/**
 * True when `err` means the wakeup's sandbox no longer exists or no longer
 * runs, so its process is gone with it (fix wave 2, M2). An evicted pod
 * counts: the eviction killed every process in it.
 */
export function isSandboxGone(err: unknown): boolean {
  if (
    err instanceof SandboxUnavailableError ||
    err instanceof SandboxSupersededError ||
    err instanceof SandboxEvictedError ||
    err instanceof SandboxGoneError
  ) {
    return true;
  }
  return err instanceof Error && SANDBOX_GONE.test(err.message);
}

/** Default cap on one detached job's log: 2 GiB (fix wave 2, M6). */
export const DEFAULT_JOB_LOG_MAX_BYTES = 2 * 1024 ** 3;

/**
 * The detached job log cap from `VALET_JOB_LOG_MAX_BYTES`: a plain byte
 * count or a quantity such as `2Gi`. Unset means the default. A value that
 * does not parse to a positive whole number of bytes stops the boot.
 */
export function resolveJobLogMaxBytes(env: Record<string, string | undefined>): number {
  const raw = env.VALET_JOB_LOG_MAX_BYTES?.trim();
  if (raw === undefined || raw === "") return DEFAULT_JOB_LOG_MAX_BYTES;
  const bytes = /^\d+$/.test(raw) ? Number(raw) : parseResourceQuantity(raw);
  if (bytes === null || !Number.isSafeInteger(bytes) || bytes < 1) {
    throw new Error(
      `VALET_JOB_LOG_MAX_BYTES="${raw}" is not a byte size. Set a whole number of bytes or a quantity such as 2Gi.`,
    );
  }
  return bytes;
}
