/**
 * Session run state — what a session is DOING, derived from its queue.
 *
 * `SessionStatus` (the `agent_sessions.status` column) is the lifecycle of
 * the row: active, hibernated, archived, deleted. It cannot say "working",
 * "needs you", or "failed", so a list built from it alone is unreadable at a
 * glance. `SessionRunState` (see `wire/types.ts`) adds that reading, and this
 * module is the ONE place that computes it — the list route, the detail
 * routes, and the WebSocket `init` frame all call `deriveRunFields` so they
 * cannot disagree.
 *
 * The derivation is pure. Its caller supplies the session's unsettled
 * submissions; how the caller obtained them is the caller's problem. The list
 * route reads them for every session in ONE `listAllUnsettledSubmissions()`
 * call and groups by session id, exactly as the admin submissions route does;
 * a per-session route reads its own with `listUnsettledSubmissions(id)`.
 *
 * Where each signal comes from:
 *
 *   - `needs_you` — a submission with status `blocked_on_decision_gate`. The
 *     engine flips that status under a write fence for as long as a gate is
 *     pending (`Thread`'s `requestDecision` path calls `setSubmissionBlocked`
 *     on the way in and on every way out), so the blocked submission is the
 *     durable, cross-session record of a pending gate. The gate rows
 *     themselves are readable only one session at a time
 *     (`SessionStore.listDecisionGates(sessionId)`), which a list endpoint
 *     cannot use.
 *   - `working` — a submission with status `collecting`, `queued`, or
 *     `running`.
 *   - `failed` — an unsettled submission that already recorded a failed
 *     outcome, which is the `terminalizing` window between "the turn failed"
 *     and "the row is settled". A turn that settled failed EARLIER is not
 *     visible here: `SessionStore` exposes settled submissions one session at
 *     a time (`listSettledSubmissionsBefore`), and reading them per session
 *     would make the list cost one query per row. Such a session reads
 *     `sleeping` or `idle` until the store grows a cross-session read.
 *   - `sleeping` — the row status is `hibernated`.
 *   - `idle` — everything else.
 */
import type { QueueItem } from "@valet/engine";
import type { SessionRunState, SessionStatus } from "../wire/types.js";

/** The fields of a session row this derivation reads. */
export interface RunStateRow {
  status: SessionStatus;
  updatedAt: number;
}

/** The fields of a queue item this derivation reads. */
export type RunStateSubmission = Pick<QueueItem, "status" | "outcome" | "updatedAt">;

export interface SessionRunFields {
  runState: SessionRunState;
  lastActivityAt: number;
}

/**
 * `unsettled` holds the session's non-settled queue items, in any order. Pass
 * an empty array for a session with none.
 */
export function deriveRunState(row: RunStateRow, unsettled: readonly RunStateSubmission[]): SessionRunState {
  if (unsettled.some((item) => item.status === "blocked_on_decision_gate")) return "needs_you";
  if (
    unsettled.some(
      (item) => item.status === "collecting" || item.status === "queued" || item.status === "running",
    )
  ) {
    return "working";
  }
  if (unsettled.some((item) => item.outcome?.outcome === "failed")) return "failed";
  if (row.status === "hibernated") return "sleeping";
  return "idle";
}

/**
 * The later of the row's `updatedAt` and the newest unsettled submission's
 * `updatedAt`. A running turn touches its queue item on every claim, lease
 * renewal, and settlement, but it never touches the session row, so the row
 * alone reports a long turn as stale.
 */
export function deriveLastActivityAt(row: RunStateRow, unsettled: readonly RunStateSubmission[]): number {
  let latest = row.updatedAt;
  for (const item of unsettled) {
    if (item.updatedAt > latest) latest = item.updatedAt;
  }
  return latest;
}

/** Both derived fields at once — what every `SessionSummary` producer needs. */
export function deriveRunFields(
  row: RunStateRow,
  unsettled: readonly RunStateSubmission[],
): SessionRunFields {
  return {
    runState: deriveRunState(row, unsettled),
    lastActivityAt: deriveLastActivityAt(row, unsettled),
  };
}

/**
 * Groups cross-session submissions by session id. The list route calls
 * `listAllUnsettledSubmissions()` once and indexes the result through this,
 * so its query count does not grow with the number of sessions.
 */
export function groupSubmissionsBySession<T extends RunStateSubmission & { sessionId: string }>(
  submissions: readonly T[],
): Map<string, T[]> {
  const bySession = new Map<string, T[]>();
  for (const item of submissions) {
    const list = bySession.get(item.sessionId);
    if (list) list.push(item);
    else bySession.set(item.sessionId, [item]);
  }
  return bySession;
}
