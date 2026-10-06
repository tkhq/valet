import { and, eq, isNull, sql } from "drizzle-orm";
import { NotFoundError } from "@valet/shared";
import type { AppDb } from "../lib/drizzle.js";
import { agentSessions, assistantExecutions, assistants, workflowDefinitions, workflowRuns } from "../schema/index.js";
import { runEventChannel } from "./thread-access.js";

/** Shared web conversations retain the team's established corpus. Private and
 * external conversations keep their execution storage, regardless of who wakes them. */
export async function assistantMemoryNamespace(db: AppDb, sessionId: string, teamId: string, orgId: string, depth = 0): Promise<string> {
  if (depth > 8) throw new NotFoundError("memory origin ancestry");
  const [execution] = await db.select({ key: assistantExecutions.conversationKey })
    .from(assistantExecutions).innerJoin(assistants, eq(assistants.id, assistantExecutions.assistantId))
    .where(and(eq(assistantExecutions.sessionId, sessionId), eq(assistants.ownerType, "team"),
      eq(assistants.ownerId, teamId), eq(assistants.orgId, orgId), isNull(assistants.archivedAt),
      sql`EXISTS (SELECT 1 FROM engine_threads t
        WHERE t.session_id = ${assistants.sessionId} AND t.id = ${assistantExecutions.governingThreadId}
          AND t.key = ${assistantExecutions.conversationKey})`,
      sql`NOT EXISTS (SELECT 1 FROM engine_sessions s WHERE s.id = ${sessionId}
        AND (s.parent_session_id IS DISTINCT FROM ${assistants.sessionId}
          OR s.parent_thread_id IS DISTINCT FROM ${assistantExecutions.governingThreadId}))`)).limit(1);
  const run = /^(?:signal:workflow:|slack-events:[^:]+:workflow:)([A-Za-z0-9_-]+)$/.exec(execution?.key ?? "");
  if (run) return workflowMemoryNamespace(db, run[1], teamId, orgId, depth + 1);
  return execution?.key.startsWith("web:") ? "" : sessionId;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** Resolve a stored run only within its organization and execution owner.
 * Ordinary team workflows retain shared persistent memory. Narrower audiences
 * use a stable origin/channel scope, never a fresh namespace for each run. */
export async function workflowMemoryNamespace(db: AppDb, runId: string, teamId: string, orgId: string, depth = 0): Promise<string> {
  if (depth > 8) throw new NotFoundError("memory origin ancestry");
  const [run] = await db.select({ params: workflowRuns.params, workflowId: workflowRuns.workflowId })
    .from(workflowRuns).innerJoin(workflowDefinitions, eq(workflowDefinitions.id, workflowRuns.workflowId))
    .where(and(eq(workflowRuns.id, runId), eq(workflowDefinitions.orgId, orgId),
      sql`((${workflowRuns.ownerType} = 'team' AND ${workflowRuns.ownerId} = ${teamId})
        OR (${workflowRuns.ownerType} = 'user' AND ${workflowRuns.ownerId} = ${`team:${teamId}`}))`)).limit(1);
  const params = record(run?.params);
  if (!run || !params) throw new NotFoundError("workflow memory");
  const input = record(params.input);
  const data = record(input?.data);
  let channel: string | undefined;
  if (input?.type === "event" && typeof data?.key === "string" && data.key.startsWith("slack.")) {
    channel = runEventChannel(params);
    // Missing channel provenance must not widen the audience to the team.
    if (!channel) throw new NotFoundError("workflow memory audience");
  }
  // A run can carry both a channel audience and a narrower conversation origin.
  const scoped = (namespace: string) => channel
    ? `workflow-channel:${JSON.stringify([run.workflowId, channel, namespace])}` : namespace;
  if (params.origin == null) return scoped("");
  const origin = record(params.origin);
  if (!origin || typeof origin.assistantSessionId !== "string" || typeof origin.threadId !== "string") {
    throw new NotFoundError("workflow memory origin");
  }
  const [source] = await db.select({ ownerType: agentSessions.ownerType, ownerId: agentSessions.ownerId,
    key: sql<string>`t.key` }).from(agentSessions)
    .innerJoin(sql`engine_threads t`, sql`t.session_id = ${agentSessions.id} AND t.id = ${origin.threadId}`)
    .where(and(eq(agentSessions.id, origin.assistantSessionId), eq(agentSessions.orgId, orgId),
      sql`${agentSessions.status} <> 'deleted'`)).limit(1);
  if (!source) throw new NotFoundError("workflow memory origin");
  if (source.ownerType === "team" && source.ownerId === teamId) {
    const [root] = await db.select({ id: assistants.id }).from(assistants)
      .where(and(eq(assistants.sessionId, origin.assistantSessionId), eq(assistants.orgId, orgId))).limit(1);
    if (!root) return scoped(await assistantMemoryNamespace(db, origin.assistantSessionId, teamId, orgId, depth + 1));
    // Old assistant roots held many audiences; never use the root ID as a private scope.
    if (source.key.startsWith("web:")) return scoped("");
    const [execution] = await db.select({ id: assistantExecutions.sessionId }).from(assistantExecutions)
      .where(and(eq(assistantExecutions.assistantId, root.id), eq(assistantExecutions.governingThreadId, origin.threadId))).limit(1);
    if (execution) return scoped(execution.id);
    throw new NotFoundError("workflow origin execution");
  }
  return scoped(`workflow-origin:${JSON.stringify([origin.assistantSessionId, origin.threadId])}`);
}
