/**
 * Engine-level errors. Provider/adapter implementations throw these so
 * callers can branch on `instanceof` checks without sniffing message text.
 */

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
