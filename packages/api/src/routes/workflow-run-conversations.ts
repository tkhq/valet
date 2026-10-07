import { and, eq, sql } from "drizzle-orm";
import type { Context } from "hono";
import type { AppEnv } from "../env.js";
import { agentSessions, assistantExecutions, sessionThreads } from "../schema/index.js";
import type { WorkflowRunConversation } from "../wire/types.js";
import { loadOwnedSession } from "./messages.js";
import { threadsVisibleTo } from "./_thread-access.js";

/** Read durable threads, including live steps that have no completed checkpoint yet. */
export async function workflowRunConversations(c: Context<AppEnv>, runId: string): Promise<WorkflowRunConversation[]> {
  const key = sql<string>`COALESCE(${assistantExecutions.conversationKey}, t.key)`;
  const rows = await c.var.providers.db.select({
    sessionId: agentSessions.id, threadId: sql<string>`t.id`, key: sql<string>`t.key`, title: sessionThreads.title,
  }).from(agentSessions)
    .innerJoin(sql`engine_threads t`, sql`t.session_id = ${agentSessions.id}`)
    .leftJoin(assistantExecutions, eq(assistantExecutions.sessionId, agentSessions.id))
    .leftJoin(sessionThreads, and(eq(sessionThreads.sessionId, agentSessions.id), sql`${sessionThreads.id} = t.id`))
    .where(and(eq(agentSessions.orgId, c.var.user.orgId), sql`${agentSessions.status} <> 'deleted'`,
      sql`(${key} = ${`signal:workflow:${runId}`}
        OR (${key} ~ '^slack-events:[^:]+:workflow:' AND split_part(${key}, ':', 4) = ${runId})
        OR (split_part(${agentSessions.id}, ':', 1) = 'wf' AND split_part(${agentSessions.id}, ':', 2) = ${runId}))`,
      // Empty root anchors authorize execution sessions but contain no conversation.
      sql`(NOT EXISTS (SELECT 1 FROM assistant_executions a WHERE a.governing_thread_id = t.id)
        OR EXISTS (SELECT 1 FROM engine_entries e WHERE e.session_id = t.session_id AND e.thread_id = t.id))`))
    .orderBy(sql`t.created_at`, sql`t.id`);
  const conversations: WorkflowRunConversation[] = [];
  for (const row of rows) {
    const session = await loadOwnedSession(c, row.sessionId);
    if (!session || !await threadsVisibleTo(c, session)(row.key)) continue;
    conversations.push({ sessionId: row.sessionId, threadId: row.threadId,
      ...(row.title ? { title: row.title } : {}),
      ...(row.sessionId.startsWith(`wf:${runId}:`) ? { nodeId: row.sessionId.split(":")[2] } : {}),
    });
  }
  return conversations;
}
