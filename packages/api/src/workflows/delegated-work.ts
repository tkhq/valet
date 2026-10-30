/**
 * Work an agent step hands to a child session.
 *
 * A step's turn can spawn a child with the `task` tool and end. The child
 * reports back on the step's thread as a `child.settled` signal, and the
 * turn that signal starts finishes the step's work (for example, it posts
 * the review the step was asked for). The step's own queue item settles
 * when the first turn ends, so these reads tell the step wait
 * (`engine-deps.ts`) and the run's thread archive (`run-attention.ts`) that
 * the step still owes that work.
 */
import { and, eq, gte } from "drizzle-orm";
import type { QueueItem, SessionStore } from "@valet/engine";
import type { AppDb } from "../lib/drizzle.js";
import { childWatches } from "../schema/index.js";

/** A turn that a child's report started on the parent thread. */
function isChildReportTurn(item: QueueItem): boolean {
  const content = item.content;
  return typeof content !== "string" && "kind" in content && content.kind === "signal" && content.signalType.startsWith("child.");
}

/**
 * True when a child spawned on this thread has not reported back yet.
 * The watcher marks the watch settled only after it admits the report to
 * the parent thread, or after it drops the report.
 */
export async function hasUnreportedChild(db: AppDb, sessionId: string, threadId: string, since?: number): Promise<boolean> {
  const [row] = await db.select({ id: childWatches.childSessionId }).from(childWatches)
    .where(and(eq(childWatches.parentSessionId, sessionId), eq(childWatches.parentThreadId, threadId),
      eq(childWatches.settled, false), ...(since !== undefined ? [gte(childWatches.createdAt, since)] : [])))
    .limit(1);
  return row !== undefined;
}

/** The first unsettled turn a child's report started on this thread since `since`. */
export async function unsettledChildReportTurn(
  store: SessionStore, sessionId: string, threadId: string, since: number,
): Promise<QueueItem | undefined> {
  return (await store.listUnsettledSubmissions(sessionId))
    .find((item) => item.threadId === threadId && item.createdAt >= since && isChildReportTurn(item));
}

/** True when the step that `item` started still owes delegated work. */
export async function delegatedWorkOpen(db: AppDb, store: SessionStore, sessionId: string, item: QueueItem): Promise<boolean> {
  return await unsettledChildReportTurn(store, sessionId, item.threadId, item.createdAt) !== undefined
    || await hasUnreportedChild(db, sessionId, item.threadId, item.createdAt);
}

/**
 * The step's last turn: the latest child-report turn on the thread since
 * the step started, or the step's own queue item when there is none.
 * Reads only the thread's tail, so a long thread costs one bounded read.
 */
export async function lastStepTurn(store: SessionStore, sessionId: string, item: QueueItem): Promise<string> {
  const entries = await store.getEntries(sessionId, item.threadId, { limit: 50 });
  const seen = new Set<string>();
  for (let i = entries.length - 1; i >= 0; i--) {
    const id = entries[i]?.queueItemId;
    if (id === undefined || seen.has(id)) continue;
    if (id === item.id) return id;
    seen.add(id);
    const turn = await store.getQueueItem(sessionId, id);
    if (turn && turn.createdAt >= item.createdAt && isChildReportTurn(turn)) return id;
  }
  return item.id;
}
