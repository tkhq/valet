import type { QueueItem, QueueMode, QueueState, QueueStatus } from "./types.js";

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
