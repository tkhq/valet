/**
 * Engine-level errors. Provider/adapter implementations throw these so
 * callers can branch on `instanceof` checks without sniffing message text.
 */
import type { Model } from "@mariozechner/pi-ai";

export class NotFoundError extends Error {
  constructor(
    public readonly resource: string,
    public readonly key: string | Record<string, string>,
  ) {
    super(`${resource} not found: ${formatKey(key)}`);
    this.name = "NotFoundError";
  }
}

function formatKey(key: string | Record<string, string>): string {
  if (typeof key === "string") return key;
  return Object.entries(key)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
}

/**
 * Thrown when a fenced write (appendEntries, updateEntry, saveSuspendedTurn,
 * clearSuspendedTurn, reserveSettlement, finalizeSettlement,
 * setSubmissionBlocked) carries a WriteFence whose attemptId no longer
 * matches the submission's current attempt — i.e. a superseded/zombie
 * attempt is trying to land a write after it lost ownership.
 */
export class StaleAttemptError extends Error {
  constructor(
    public readonly itemId: string,
    public readonly staleAttemptId: string,
    public readonly currentAttemptId: string | undefined,
  ) {
    super(
      `stale attempt for queue item ${itemId}: attempt ${staleAttemptId} is no longer current (current: ${currentAttemptId ?? "none"})`,
    );
    this.name = "StaleAttemptError";
  }
}

/**
 * Thrown by a host `resolveModel` implementation when a spec resolves to a
 * REAL model but no API key is available anywhere (org key absent AND env
 * fallback absent). The engine checks for it at turn start, BEFORE any
 * side-effecting work (user-entry append, LLM call), and releases the claim
 * back to `queued` for a bounded number of attempts rather than burning the
 * submission `failed`. `model` carries the successfully resolved model so
 * spec-validation callers (`Session.setModel` / `Thread.setModel`) can still
 * accept the spec — a user must be able to select a model before configuring
 * its key.
 */
export class NoCredentialsError extends Error {
  constructor(
    message: string,
    public readonly model?: Model<any>,
  ) {
    super(message);
    this.name = "NoCredentialsError";
  }
}

/**
 * Thrown when a durable write conflicts with existing state — e.g. admitting
 * a submission with a dispatchId that's already bound to different content,
 * or settling a submission with a different terminal outcome than the one
 * already reserved.
 */
export class ConflictError extends Error {
  constructor(
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ConflictError";
  }
}

/**
 * Thrown when caller-supplied input fails a basic shape/format check before
 * it ever reaches storage — e.g. an `EventStream.read` `fromOffset` that
 * isn't a safe-integer decimal string.
 */
export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

/**
 * Thrown at admission when a thread already holds `cap` unsettled,
 * non-superseded submissions. Steer admissions are exempt (they supersede
 * the thread's pending items in the same atomic step, so they never grow
 * the count) — see `Thread.submitPrompt`.
 */
export class PendingCapError extends Error {
  readonly code = "pending_cap_exceeded";

  constructor(
    public readonly threadId: string,
    public readonly cap: number,
  ) {
    super(`thread ${threadId} has reached its pending submission cap (${cap})`);
    this.name = "PendingCapError";
  }
}

/**
 * Thrown by `Thread.awaitResult` when `opts.timeoutMs` elapses before the
 * submission (or, for a merged constituent, the item it delegates to)
 * settles. The wait is purely observational — this error never disturbs the
 * submission itself, which keeps running/settling on its own.
 */
export class TimeoutError extends Error {
  constructor(
    public readonly queueItemId: string,
    public readonly timeoutMs: number,
  ) {
    super(`awaitResult timed out after ${timeoutMs}ms waiting for submission ${queueItemId}`);
    this.name = "TimeoutError";
  }
}

/**
 * Thrown by `PolicySandbox` when a tool op's wait for `SandboxAttachment`
 * readiness exceeds `sandboxReadyTimeoutMs`. Not degradation — the
 * attachment keeps trying to provision in the background; this error just
 * means the caller's op gave up waiting.
 */
export class WorkspaceProvisioningError extends Error {
  readonly code = "workspace_provisioning";

  constructor(public readonly timeoutMs: number) {
    super(
      `[workspace_provisioning] sandbox did not become ready within ${timeoutMs}ms; the workspace is still provisioning in the background — retry shortly.`,
    );
    this.name = "WorkspaceProvisioningError";
  }
}

/**
 * Thrown by `PolicySandbox` when an op's underlying raw call resolved
 * successfully, but its epoch was superseded by a re-provision before the
 * result could be returned. The result is discarded — never returned to
 * the caller.
 */
export class SandboxSupersededError extends Error {
  readonly code = "sandbox_superseded";

  constructor(public readonly epoch?: number) {
    super(
      `[sandbox_superseded] the operation completed against a sandbox epoch that has since been replaced; its result was discarded. Retry the operation.`,
    );
    this.name = "SandboxSupersededError";
  }
}

/**
 * Thrown by a `SandboxProvider.create` implementation when a sandbox
 * definitively FAILED to start (a terminal condition — image pull failure,
 * crash-loop, unschedulable pod, pod failed) as opposed to merely being slow
 * to provision. Unlike `WorkspaceProvisioningError` (a timeout — "still
 * working, retry shortly"), this is NOT retry-shaped: the underlying cause
 * will not resolve itself on its own. `SandboxAttachment.doProvision`
 * rejects any pending `ensureReady` waiters with this error (instead of the
 * usual "swallow and let each waiter hit its own timeout" behavior) so the
 * real cause reaches the caller fast instead of after a generic timeout.
 */
export class SandboxStartupError extends Error {
  readonly code = "sandbox_startup_failed";

  constructor(
    public readonly sandboxId: string,
    public readonly reason: string,
  ) {
    super(`sandbox failed to start: ${reason}`);
    this.name = "SandboxStartupError";
  }
}

/**
 * Thrown by `SandboxAttachment.doProvision` when the host's optional
 * `prepareSandbox` hook rejects. Prep runs after a freshly-created sandbox
 * reports ready but BEFORE any `ensureReady` waiter is resolved, so a prep
 * failure is terminal for that provision: like `SandboxStartupError`, pending
 * waiters are rejected with this error immediately (no waiter ever receives an
 * unprepped sandbox) and the attachment lands in `error`. The next
 * `ensureReady` re-provisions and re-runs prep. `cause` carries the hook's
 * original rejection.
 */
export class SandboxPreparationError extends Error {
  readonly code = "sandbox_preparation_failed";

  constructor(public readonly cause?: unknown) {
    super(`sandbox preparation failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "SandboxPreparationError";
  }
}

/**
 * Thrown by `PolicySandbox` when a raw op rejects with a transport-level
 * failure (container death, connection loss) — as opposed to a normal
 * command-level or filesystem error, which rethrows untouched. The
 * attachment degrades and re-provisions in the background; `cause` carries
 * the original rejection.
 */
export class SandboxUnavailableError extends Error {
  readonly code = "sandbox_unavailable";

  constructor(public readonly cause?: unknown) {
    super(
      `[sandbox_unavailable] sandbox connection lost mid-operation; the command may or may not have run. The workspace is re-provisioning in the background — retry shortly.`,
    );
    this.name = "SandboxUnavailableError";
  }
}
