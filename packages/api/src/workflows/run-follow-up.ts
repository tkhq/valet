import { and, eq } from "drizzle-orm";
import type { SessionStore } from "@valet/engine";
import type { AppDb } from "../lib/drizzle.js";
import { loadAssistantBySessionId } from "../assistants/service.js";
import { assistantExecutions } from "../schema/index.js";

/** Reads delivery evidence after the caller has passed the run's audience check. */
export async function readRunFollowUp(
  deps: { db: AppDb; engineStore: SessionStore },
  orgId: string,
  run: { runId: string; status: string; params: unknown },
) {
  const params = run.params && typeof run.params === "object" ? run.params : {};
  const origin = "origin" in params ? params.origin : undefined;
  if ("parentRunId" in params && typeof params.parentRunId === "string") return { registered: false, status: "parent_run", next: "Read the parent run for completion." };
  if (!origin) return { registered: false, status: "no_origin", next: "Call get_run to check completion. No automatic chat follow-up is registered." };
  if (typeof origin !== "object" || !("assistantSessionId" in origin) || typeof origin.assistantSessionId !== "string"
    || !("threadId" in origin) || typeof origin.threadId !== "string") {
    return { registered: false, status: "invalid_origin", next: "Call get_run to inspect the result. No valid completion target was recorded." };
  }
  const assistant = await loadAssistantBySessionId(deps.db, origin.assistantSessionId);
  if (!assistant || assistant.orgId !== orgId || assistant.archivedAt !== null) {
    return { registered: true, status: "origin_unavailable", next: "Call get_run to inspect the result. The originating assistant is unavailable." };
  }
  const thread = await deps.engineStore.getThread(origin.assistantSessionId, origin.threadId);
  if (!thread) return { registered: true, status: "origin_unavailable", next: "Call get_run to inspect the result. The originating thread is no longer stored." };
  const dispatchId = `workflow-settled:${run.runId}`;
  let sessionId = origin.assistantSessionId;
  let targetThreadId = origin.threadId;
  let item = await deps.engineStore.getQueueItemByDispatchId(sessionId, dispatchId);
  // Legacy team origins can report through their isolated conversation execution.
  if (!item && assistant.ownerType === "team") {
    const [execution] = await deps.db.select({ sessionId: assistantExecutions.sessionId }).from(assistantExecutions)
      .where(and(eq(assistantExecutions.assistantId, assistant.id), eq(assistantExecutions.conversationKey, thread.key))).limit(1);
    if (execution) {
      item = await deps.engineStore.getQueueItemByDispatchId(execution.sessionId, dispatchId);
      if (item) {
        sessionId = execution.sessionId;
        const target = await deps.engineStore.getThread(sessionId, item.threadId);
        if (target?.key !== thread.key) {
          return { registered: true, status: "target_mismatch", next: "Call get_run to inspect the result. The completion signal targets a different conversation." };
        }
        targetThreadId = item.threadId;
      }
    }
  }
  if (item && item.threadId !== targetThreadId) {
    return { registered: true, status: "target_mismatch", next: "Call get_run to inspect the result. The completion signal has an unexpected thread target." };
  }
  const status = item ? item.status : run.status === "settled" ? "not_recorded" : "awaiting_settlement";
  return {
    registered: true, status, signalType: "workflow.settled", dispatchId,
    sessionId, threadId: targetThreadId,
    ...(item ? { queueItemId: item.id, outcome: item.outcome, createdAt: item.createdAt, updatedAt: item.updatedAt } : {}),
    next: status === "not_recorded"
      ? "Call get_run and inspect node results now. No completion signal admission is recorded; delivery may have failed or history may have expired."
      : item?.status === "settled"
        ? "The follow-up turn settled. Inspect its outcome; this does not prove that an external message was delivered."
        : "End your turn and continue from workflow.settled. The completion follow-up is registered; do not poll.",
  };
}
