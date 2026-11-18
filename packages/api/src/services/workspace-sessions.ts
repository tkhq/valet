import { and, desc, eq, sql } from "drizzle-orm";
import type { AppDb } from "../lib/drizzle.js";
import { agentSessions, assistantExecutions, assistants } from "../schema/index.js";

/**
 * The other sessions of the workspace `sessionId` belongs to: the
 * assistant's root session and every conversation session
 * (`execution:<uuid>`) of the same assistant. A team workspace runs each
 * conversation in its own session, so `thread_read` and `list_threads` need
 * these to reach a sibling thread, such as an earlier subscription run.
 * Empty for a session that belongs to no assistant (a child). Reads the
 * WORKSPACE_SESSIONS_MAX most recently active conversations: a team on a
 * schedule adds one per run.
 */
/** The most conversation sessions one read returns. */
export const WORKSPACE_SESSIONS_MAX = 50;

export async function workspaceSiblingSessions(db: AppDb, sessionId: string): Promise<string[]> {
  const [own] = await db.select({ assistantId: assistantExecutions.assistantId }).from(assistantExecutions)
    .where(eq(assistantExecutions.sessionId, sessionId)).limit(1);
  const [assistant] = own
    ? await db.select({ id: assistants.id, sessionId: assistants.sessionId }).from(assistants).where(eq(assistants.id, own.assistantId)).limit(1)
    : await db.select({ id: assistants.id, sessionId: assistants.sessionId }).from(assistants).where(eq(assistants.sessionId, sessionId)).limit(1);
  if (!assistant) return [];
  const executions = await db.select({ sessionId: assistantExecutions.sessionId }).from(assistantExecutions)
    .innerJoin(agentSessions, eq(agentSessions.id, assistantExecutions.sessionId))
    .where(and(eq(assistantExecutions.assistantId, assistant.id), sql`${agentSessions.status} <> 'deleted'`))
    .orderBy(desc(agentSessions.updatedAt)).limit(WORKSPACE_SESSIONS_MAX);
  return [...new Set([assistant.sessionId, ...executions.map((e) => e.sessionId)])].filter((id) => id !== sessionId);
}
