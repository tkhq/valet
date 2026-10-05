import type { Principal, Session, Thread } from "@valet/engine";
import { sql } from "drizzle-orm";
import { ensureAssistantExecution } from "../assistants/service.js";
import type { EngineHost } from "../engine/host.js";
import type { AppDb } from "../lib/drizzle.js";

/** Preserve a verified origin's audience when its legacy runtime is read-only.
 * Existing admissions retain their terminal receipts and never execute again. */
export async function resolveWorkflowReportTarget(
  deps: { db: AppDb; engineHost: EngineHost },
  owner: Principal,
  meta: { actorUserId: string; orgId: string },
  session: Session,
  thread: Thread,
  dispatchId: string,
): Promise<{ session: Session; thread: Thread; priorQueueItemId?: string }> {
  if (!session.options.readOnlyReason || owner.type !== "team") return { session, thread };
  const prior = await deps.db.execute(sql`SELECT id, thread_id FROM engine_queue_items
    WHERE session_id = ${session.id} AND dispatch_id = ${dispatchId} LIMIT 1`) as { rows: Array<{ id: string; thread_id: string }> };
  const existing = prior.rows[0];
  if (existing) {
    if (existing.thread_id !== thread.id) throw new Error("The workflow dispatch belongs to another thread. Start a new workflow run.");
    return { session, thread, priorQueueItemId: existing.id };
  }
  const { session: execution } = await ensureAssistantExecution(deps, owner, meta, thread.key);
  return { session: execution, thread: execution.thread(thread.key) };
}
