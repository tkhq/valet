import type { Principal, Session, Thread } from "@valet/engine";
import { and, eq, sql } from "drizzle-orm";
import { isLegacyAssistantRuntime } from "../services/legacy-runtime.js";
import { ensureAssistantExecution, ensureAssistantRuntime, loadAssistantBySessionId } from "../assistants/service.js";
import type { EngineHost } from "../engine/host.js";
import type { AppDb } from "../lib/drizzle.js";
import { assistantExecutions, assistants } from "../schema/index.js";

/** Existing admissions and execution mappings take precedence over upgrade compatibility. */
export async function resolveWorkflowReportTarget(
  deps: { db: AppDb; engineHost: EngineHost },
  owner: Principal,
  meta: { actorUserId: string; orgId: string },
  session: Session,
  thread: Thread,
  dispatchId: string,
): Promise<{ session: Session; thread: Thread; priorQueueItemId?: string }> {
  if (owner.type !== "team") return { session, thread };
  const prior = await deps.db.execute(sql`SELECT id, thread_id FROM engine_queue_items
    WHERE session_id = ${session.id} AND dispatch_id = ${dispatchId} LIMIT 1`) as { rows: Array<{ id: string; thread_id: string }> };
  const existing = prior.rows[0];
  if (existing) {
    if (existing.thread_id !== thread.id) throw new Error("The workflow dispatch belongs to another thread. Start a new workflow run.");
    return { session, thread, priorQueueItemId: existing.id };
  }
  const [mapping] = await deps.db.select({ id: assistantExecutions.sessionId }).from(assistantExecutions)
    .innerJoin(assistants, eq(assistants.id, assistantExecutions.assistantId))
    .where(and(eq(assistants.sessionId, session.id), eq(assistants.orgId, meta.orgId),
      eq(assistantExecutions.conversationKey, thread.key))).limit(1);
  if (mapping) {
    const assistant = await loadAssistantBySessionId(deps.db, mapping.id);
    if (!assistant) throw new Error("The workflow's original execution is unavailable. Restore its runtime before retrying.");
    const { session: execution } = await ensureAssistantRuntime(deps, assistant, meta);
    return { session: execution, thread: execution.thread(thread.key) };
  }
  if (!session.options.readOnlyReason || await isLegacyAssistantRuntime(deps.db, session.id, meta.orgId)) return { session, thread };
  const { session: execution } = await ensureAssistantExecution(deps, owner, meta, thread.key);
  return { session: execution, thread: execution.thread(thread.key) };
}
