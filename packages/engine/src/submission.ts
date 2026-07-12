import type {
  QueueItem,
  QueueMode,
  QueueState,
  QueueStatus,
  SessionEntry,
  SubmissionOutcome,
  SuspendedTurnState,
} from "./types.js";

/**
 * Pure derivation of the wire `QueueState` from the durable submission rows.
 *
 * `QueueState` is a derived view (plan decision 1): the only stored piece of
 * queue state is `ThreadData.paused`; everything else here is computed from the
 * thread's unsettled queue items.
 *
 * Status precedence: paused > blocked_on_decision_gate (any unsettled blocked
 * item) > running > queued (any queued) > idle.
 *
 * NOTE: the plan's interface sketch omits `threadId`, but a `QueueState`
 * requires it and it cannot be recovered when the item list is empty (idle
 * thread). We take it as an explicit first argument — a minimal deviation
 * documented in the task report.
 */
export function deriveQueueState(
  threadId: string,
  items: QueueItem[],
  mode: QueueMode,
  paused: boolean,
  blockedGateId?: string,
): QueueState {
  const threadItems = items
    .filter((i) => i.threadId === threadId && i.status !== "settled")
    .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const running = threadItems.find(
    (i) => i.status === "running" || i.status === "blocked_on_decision_gate",
  );
  const blocked = threadItems.some((i) => i.status === "blocked_on_decision_gate");
  const pending = threadItems.filter((i) => i.status === "queued" && !i.supersededByItemId);
  const collectBuffer = threadItems.filter((i) => i.status === "collecting");

  let status: QueueStatus;
  if (paused) status = "paused";
  else if (blocked) status = "blocked_on_decision_gate";
  else if (running) status = "running";
  else if (pending.length > 0) status = "queued";
  else status = "idle";

  return {
    threadId,
    mode,
    status,
    activeItemId: running?.id,
    pending,
    collectBuffer: collectBuffer.length > 0 ? collectBuffer : undefined,
    blockedGateId,
  };
}

/**
 * The action the reconciliation executor should take for one unsettled
 * submission after a crash / lease-expiry. Produced by `decideReconciliation`,
 * applied by the effectful executor in `Session`/`Thread`.
 */
export type ReconcileAction =
  | { kind: "settle"; outcome: SubmissionOutcome } // steps 1,2,3,5,6
  | { kind: "rearm_gate" } // step 4 (gate pending)
  | { kind: "replay_gate" } // step 4 (gate resolved while down)
  | { kind: "resume" } // step 7
  | { kind: "wait" }; // live lease / fresh marker — not ours to touch

/**
 * Everything `decideReconciliation` needs beyond the item itself, gathered by
 * the executor from the store. Kept as plain data so the decision function is
 * pure and unit-testable with literal inputs (no mocks, no store).
 */
export interface ReconcileContext {
  now: number;
  /** True when a persisted assistant entry carries item.id with stopReason 'end_turn'. */
  hasTerminalAssistantEntry: boolean;
  /** True when engine_attempt_markers has a row for (item.id, item.attemptId) AND the lease is unexpired. */
  attemptLive: boolean;
  suspended: SuspendedTurnState | null;
  gateStatus: "pending" | "resolved" | "expired" | "withdrawn" | null;
}

/**
 * The normative reconciliation decision tree (spec §Reconciliation, ~1168).
 * PURE — no store, no clock beyond `ctx.now`. Order matters and is asserted by
 * the table tests; do not reorder.
 *
 * Step 0 (guards, executor-adjacent):
 *   - `settled` → wait (already terminal; nothing to do)
 *   - `collecting` → wait (the sweep's collect-flush owns it)
 *   - `terminalizing` → wait (the executor re-runs finalization before ever
 *     consulting this function; a stray terminalizing item just waits)
 *   - `attemptLive` → wait (fresh marker + unexpired lease: may still be running)
 *
 * Steps 1-7 (spec order):
 *   1. terminal assistant entry → settle completed (beats abort/retry/timeout)
 *   2. abortRequestedAt → settle aborted
 *   3. supersededByItemId → settle superseded
 *   4. blocked_on_decision_gate + suspended: pending→rearm, resolved→replay;
 *      expired/withdrawn/missing fall THROUGH to 5-7. Gate-blocked items are
 *      EXEMPT from the step-6 timeout.
 *   5. attemptCount >= maxAttempts → settle failed (retry budget exhausted)
 *   6. now >= timeoutAt (and not gate-blocked) → settle failed (timed out)
 *   7. otherwise → resume
 */
export function decideReconciliation(item: QueueItem, ctx: ReconcileContext): ReconcileAction {
  // Step 0 — guards.
  if (item.status === "settled") return { kind: "wait" };
  if (item.status === "collecting") return { kind: "wait" };
  if (item.status === "terminalizing") return { kind: "wait" };
  if (ctx.attemptLive) return { kind: "wait" };

  // Step 1 — finished work settles first, unconditionally.
  if (ctx.hasTerminalAssistantEntry) return { kind: "settle", outcome: { outcome: "completed" } };

  // Step 2 — abort wins next.
  if (item.abortRequestedAt !== undefined) return { kind: "settle", outcome: { outcome: "aborted" } };

  // Step 3 — supersession.
  if (item.supersededByItemId !== undefined) {
    return { kind: "settle", outcome: { outcome: "superseded" } };
  }

  const gateBlocked = item.status === "blocked_on_decision_gate";

  // Step 4 — blocked on a gate with a checkpoint.
  if (gateBlocked && ctx.suspended !== null) {
    if (ctx.gateStatus === "pending") return { kind: "rearm_gate" };
    if (ctx.gateStatus === "resolved") return { kind: "replay_gate" };
    // expired / withdrawn / missing gate: fall through to 5-7 (the turn resumes
    // and the model sees the gate's terminal state).
  }

  // Step 5 — retry budget exhausted.
  if (item.attemptCount >= item.maxAttempts) {
    return { kind: "settle", outcome: { outcome: "failed", error: "retry budget exhausted" } };
  }

  // Step 6 — timeout. Gate-blocked items are exempt (their bound is the gate's
  // own expiry, not the execution timeout).
  if (!gateBlocked && ctx.now >= item.timeoutAt) {
    return { kind: "settle", outcome: { outcome: "failed", error: "timed out" } };
  }

  // Step 7 — resume.
  return { kind: "resume" };
}

/**
 * PURE — walks a thread's persisted entries and returns the content of the
 * LAST assistant `MessageEntry` carrying `queueItemId` with
 * `stopReason === "end_turn"` (spec ~422, `SubmissionResult.text`). Returns
 * `undefined` when the submission's turn never reached a terminal
 * end-of-turn entry (e.g. it was superseded mid-stream — use
 * `resolvePartialSubmissionText` for that case).
 */
export function resolveSubmissionText(entries: SessionEntry[], queueItemId: string): string | undefined {
  let text: string | undefined;
  for (const e of entries) {
    if (e.type === "message" && e.role === "assistant" && e.queueItemId === queueItemId && e.stopReason === "end_turn") {
      text = e.content;
    }
  }
  return text;
}

/**
 * PURE — same walk as `resolveSubmissionText` but without the `stopReason`
 * requirement: returns the content of the LAST assistant entry carrying
 * `queueItemId`, regardless of how the turn ended. Used for the `superseded`
 * outcome, whose interrupted turn's final assistant entry is persisted with
 * `stopReason: "abort"` (spec ~422: "whatever partial assistant output
 * persisted under the submission's queueItemId").
 */
export function resolvePartialSubmissionText(entries: SessionEntry[], queueItemId: string): string | undefined {
  let text: string | undefined;
  for (const e of entries) {
    if (e.type === "message" && e.role === "assistant" && e.queueItemId === queueItemId) {
      text = e.content;
    }
  }
  return text;
}
