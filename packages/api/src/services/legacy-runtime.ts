import { and, eq, isNull, sql } from "drizzle-orm";
import type { AppQueryable } from "../lib/drizzle.js";
import { legacyWorkflowRunRuntimes, workflowRuns, legacyWorkflowAdmissions, assistantExecutions, assistants, legacyAssistantRuntimes, legacyAssistantConversations, legacyWorkflowRuntimes, workflowDefinitions } from "../schema/index.js";

/** The durable upgrade snapshot never confers access across organizations or deletion. */
export async function isLegacyAssistantRuntime(db: AppQueryable, sessionId: string, orgId: string): Promise<boolean> {
  const rows = await db.select({ id: legacyAssistantRuntimes.sessionId }).from(legacyAssistantRuntimes)
    .innerJoin(assistants, eq(assistants.sessionId, legacyAssistantRuntimes.sessionId))
    .where(and(eq(legacyAssistantRuntimes.sessionId, sessionId), eq(legacyAssistantRuntimes.orgId, orgId),
      eq(assistants.orgId, orgId), sql`(${assistants.archivedAt} IS NULL OR (
        ${assistants.ownerId} = ${legacyAssistantRuntimes.ownerId} || ':retired:' || ${assistants.id}
        AND ((${legacyAssistantRuntimes.ownerType} = 'team' AND EXISTS (SELECT 1 FROM teams WHERE id = ${legacyAssistantRuntimes.ownerId} AND org_id = ${orgId}))
          OR (${legacyAssistantRuntimes.ownerType} = 'user' AND EXISTS (SELECT 1 FROM "user" WHERE id = ${legacyAssistantRuntimes.ownerId}))
          OR (${legacyAssistantRuntimes.ownerType} = 'org' AND ${legacyAssistantRuntimes.ownerId} = ${orgId}))))`,
      sql`NOT EXISTS (SELECT 1 FROM agent_sessions s WHERE s.id = ${sessionId} AND s.status = 'deleted')`)).limit(1);
  return rows.length > 0;
}

export async function isLegacyAssistantConversation(db: AppQueryable, sessionId: string, key: string, orgId: string): Promise<boolean> {
  if (!await isLegacyAssistantRuntime(db, sessionId, orgId)) return false;
  const rows = await db.select({ id: legacyAssistantConversations.threadId }).from(legacyAssistantConversations)
    .where(and(eq(legacyAssistantConversations.sessionId, sessionId), eq(legacyAssistantConversations.conversationKey, key),
      sql`EXISTS (SELECT 1 FROM engine_threads t WHERE t.session_id = ${sessionId}
        AND t.id = ${legacyAssistantConversations.threadId} AND t.key = ${key})`)).limit(1);
  return rows.length > 0;
}

/** A definition retains its original owner runtime across subsequent runs. */
export async function legacyWorkflowRuntime(db: AppQueryable, workflowId: string, orgId: string): Promise<string | undefined> {
  const [row] = await db.select({ id: legacyWorkflowRuntimes.sessionId }).from(legacyWorkflowRuntimes)
    .innerJoin(workflowDefinitions, eq(workflowDefinitions.id, legacyWorkflowRuntimes.workflowId))
    .leftJoin(assistantExecutions, eq(assistantExecutions.sessionId, legacyWorkflowRuntimes.sessionId))
    .innerJoin(assistants, sql`(${assistants.sessionId} = ${legacyWorkflowRuntimes.sessionId}
      OR ${assistants.id} = ${assistantExecutions.assistantId})`)
    .where(and(eq(legacyWorkflowRuntimes.workflowId, workflowId), eq(legacyWorkflowRuntimes.orgId, orgId),
      eq(workflowDefinitions.orgId, orgId), eq(workflowDefinitions.ownerType, assistants.ownerType),
      sql`(${workflowDefinitions.ownerId} = ${assistants.ownerId} OR EXISTS (
        SELECT 1 FROM legacy_assistant_runtimes l WHERE l.session_id = ${assistants.sessionId}
          AND l.owner_id = ${workflowDefinitions.ownerId} AND ${assistants.ownerId} = l.owner_id || ':retired:' || ${assistants.id}))`,
      eq(assistants.orgId, orgId),
      sql`NOT EXISTS (SELECT 1 FROM agent_sessions s WHERE s.id = ${legacyWorkflowRuntimes.sessionId} AND s.status = 'deleted')`)).limit(1);
  if (!row) return undefined;
  const [execution] = await db.select({ id: assistantExecutions.sessionId }).from(assistantExecutions)
    .innerJoin(assistants, eq(assistants.id, assistantExecutions.assistantId))
    .where(and(eq(assistantExecutions.sessionId, row.id), isNull(assistants.archivedAt))).limit(1);
  return execution || await isLegacyAssistantRuntime(db, row.id, orgId) ? row.id : undefined;
}

/** Only admissions present at upgrade may retain an older rendered workflow prompt. */
export async function legacyWorkflowAdmission(db: AppQueryable, dispatchId: string, orgId: string) {
  const [row] = await db.select().from(legacyWorkflowAdmissions)
    .where(and(eq(legacyWorkflowAdmissions.dispatchId, dispatchId), eq(legacyWorkflowAdmissions.orgId, orgId),
      sql`EXISTS (SELECT 1 FROM engine_queue_items q WHERE q.id = ${legacyWorkflowAdmissions.queueItemId}
        AND q.session_id = ${legacyWorkflowAdmissions.sessionId} AND q.thread_id = ${legacyWorkflowAdmissions.threadId}
        AND q.dispatch_id = ${dispatchId})`)).limit(1);
  return row;
}

/** In-flight run snapshots retain the assistant selected by that historical version. */
export async function legacyWorkflowRunRuntime(db: AppQueryable, runId: string, orgId: string): Promise<string | undefined> {
  const [row] = await db.select({ sessionId: legacyWorkflowRunRuntimes.sessionId }).from(legacyWorkflowRunRuntimes)
    .innerJoin(workflowRuns, eq(workflowRuns.id, legacyWorkflowRunRuntimes.runId))
    .innerJoin(workflowDefinitions, eq(workflowDefinitions.id, workflowRuns.workflowId))
    .innerJoin(legacyAssistantRuntimes, eq(legacyAssistantRuntimes.sessionId, legacyWorkflowRunRuntimes.sessionId))
    .where(and(eq(legacyWorkflowRunRuntimes.runId, runId), eq(legacyWorkflowRunRuntimes.orgId, orgId),
      eq(workflowDefinitions.orgId, orgId), eq(workflowDefinitions.ownerType, legacyAssistantRuntimes.ownerType),
      eq(workflowDefinitions.ownerId, legacyAssistantRuntimes.ownerId))).limit(1);
  return row && await isLegacyAssistantRuntime(db, row.sessionId, orgId) ? row.sessionId : undefined;
}
