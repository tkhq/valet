/**
 * "Run without asking" for one thread. A person turns it on for a thread
 * they may answer approvals in. While it is on, the policy resolver allows
 * the approvals that this person could stop for good with "Always allow for
 * me" (or "for this team"), so the thread and the child agents it starts do
 * not stop for them. Critical actions, actions an admin rule names, another
 * member's shared account, and actions that need the author's own consent
 * still ask (`policies/service.ts`, `buildPolicyResolver`).
 */
import { and, eq } from "drizzle-orm";
import type { AppQueryable } from "../lib/drizzle.js";
import { childWatches, sessionThreads } from "../schema/index.js";

/** Parent threads read when a child agent looks for the setting. A chain
 * this deep is not a delegation tree a person set up. */
const MAX_PARENT_HOPS = 8;

export interface ThreadApprovalBypass {
  /** The person who turned it on. */
  enabledBy: string;
  /** The thread that carries the setting: this thread, or the thread that
   * started this child agent. */
  threadId: string;
}

/**
 * The setting that covers a thread: its own, else the setting of the thread
 * that started its session as a child agent, up the chain. Turning it off on
 * the parent therefore stops it for the children at once.
 */
export async function threadApprovalBypass(
  db: AppQueryable,
  at: { sessionId: string; threadId: string },
): Promise<ThreadApprovalBypass | undefined> {
  let current: { sessionId: string; threadId: string } | undefined = at;
  for (let hop = 0; current && hop <= MAX_PARENT_HOPS; hop++) {
    const [row] = await db.select({ enabledBy: sessionThreads.approvalBypassBy }).from(sessionThreads)
      .where(and(eq(sessionThreads.id, current.threadId), eq(sessionThreads.sessionId, current.sessionId))).limit(1);
    if (row?.enabledBy) return { enabledBy: row.enabledBy, threadId: current.threadId };
    const [parent] = await db.select({ sessionId: childWatches.parentSessionId, threadId: childWatches.parentThreadId })
      .from(childWatches).where(eq(childWatches.childSessionId, current.sessionId)).limit(1);
    current = parent;
  }
  return undefined;
}

/** Turns the setting on for `enabledBy`, or off with null. */
export async function setThreadApprovalBypass(
  db: AppQueryable,
  thread: { id: string; sessionId: string; createdAt: number },
  enabledBy: string | null,
  now: number = Date.now(),
): Promise<void> {
  const values = { approvalBypassBy: enabledBy, approvalBypassAt: enabledBy ? now : null };
  await db.insert(sessionThreads)
    .values({ id: thread.id, sessionId: thread.sessionId, createdAt: thread.createdAt, ...values })
    .onConflictDoUpdate({ target: sessionThreads.id, set: values });
}
