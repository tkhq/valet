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
import { and, asc, eq, gte } from "drizzle-orm";
import type { QueueItem, SessionStore } from "@valet/engine";
import type { AppDb } from "../lib/drizzle.js";
import { childWatches } from "../schema/index.js";

/** The child whose report started this turn, if a child's report started it. */
function reportedChild(item: QueueItem): string | undefined {
  const content = item.content;
  if (typeof content === "string" || !("kind" in content) || content.kind !== "signal" || !content.signalType.startsWith("child.")) return undefined;
  return content.attributes?.child_session_id;
}

/**
 * True when a child spawned on this thread has not reported back yet.
 * The watcher marks the watch settled only after it admits the report to
 * the parent thread, or after it drops the report.
 */
export async function hasUnreportedChild(db: AppDb, sessionId: string, threadId: string): Promise<boolean> {
  const [row] = await db.select({ id: childWatches.childSessionId }).from(childWatches)
    .where(and(eq(childWatches.parentSessionId, sessionId), eq(childWatches.parentThreadId, threadId), eq(childWatches.settled, false)))
    .limit(1);
  return row !== undefined;
}

/**
 * The children that the step's own turns spawned, mapped to whether each has
 * reported back. The step's turns are its queue item and the report turns of
 * its children. Two steps can share a thread, so a child spawned on the thread
 * by another step's turn is not this step's work.
 */
async function stepChildren(db: AppDb, store: SessionStore, sessionId: string, item: QueueItem): Promise<Map<string, boolean>> {
  const rows = await db.select({ child: childWatches.childSessionId, parent: childWatches.parentQueueItemId, settled: childWatches.settled })
    .from(childWatches)
    .where(and(eq(childWatches.parentSessionId, sessionId), eq(childWatches.parentThreadId, item.threadId),
      gte(childWatches.createdAt, item.createdAt)))
    .orderBy(asc(childWatches.createdAt));
  const turns = new Set([item.id]);
  const children = new Map<string, boolean>();
  // A child's watch row exists before its report turn, and a report turn
  // exists before any child it spawns, so one pass in creation order sees
  // each parent before its children.
  for (const row of rows) {
    if (row.parent === null) continue;
    if (!turns.has(row.parent)) {
      const turn = await store.getQueueItem(sessionId, row.parent);
      const reported = turn && reportedChild(turn);
      if (!reported || !children.has(reported)) continue;
      turns.add(row.parent);
    }
    children.set(row.child, row.settled);
  }
  return children;
}

/** What the step that `item` started still owes: a report turn to finish, or a child that has not reported. */
export interface StepWork {
  reportTurn?: QueueItem;
  childPending: boolean;
}

export async function openStepWork(db: AppDb, store: SessionStore, sessionId: string, item: QueueItem): Promise<StepWork> {
  const children = await stepChildren(db, store, sessionId, item);
  const reportTurn = children.size === 0 ? undefined : (await store.listUnsettledSubmissions(sessionId)).find((turn) => {
    const reported = turn.threadId === item.threadId && turn.createdAt >= item.createdAt ? reportedChild(turn) : undefined;
    return reported !== undefined && children.has(reported);
  });
  return { ...(reportTurn ? { reportTurn } : {}), childPending: [...children.values()].some((settled) => !settled) };
}

/** True when the step that `item` started still owes delegated work. */
export async function delegatedWorkOpen(db: AppDb, store: SessionStore, sessionId: string, item: QueueItem): Promise<boolean> {
  const work = await openStepWork(db, store, sessionId, item);
  return work.reportTurn !== undefined || work.childPending;
}

/**
 * The step's last turn: the latest report turn of the step's own children,
 * or the step's own queue item when there is none.
 * Reads only the thread's tail, so a long thread costs one bounded read.
 */
export async function lastStepTurn(db: AppDb, store: SessionStore, sessionId: string, item: QueueItem): Promise<string> {
  const children = await stepChildren(db, store, sessionId, item);
  if (children.size === 0) return item.id;
  const entries = await store.getEntries(sessionId, item.threadId, { limit: 50 });
  const seen = new Set<string>();
  for (let i = entries.length - 1; i >= 0; i--) {
    const id = entries[i]?.queueItemId;
    if (id === undefined || seen.has(id)) continue;
    if (id === item.id) return id;
    seen.add(id);
    const turn = await store.getQueueItem(sessionId, id);
    const reported = turn && turn.createdAt >= item.createdAt ? reportedChild(turn) : undefined;
    if (reported !== undefined && children.has(reported)) return id;
  }
  return item.id;
}
