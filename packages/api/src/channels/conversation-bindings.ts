import { and, eq, sql } from "drizzle-orm";
import type { AppDb } from "../lib/drizzle.js";
import { agentSessions, channelConversationBindings } from "../schema/index.js";
import { HOME_THREAD_KEY } from "../home/context.js";

export interface ConversationScope {
  orgId: string;
  userId: string;
  sessionId: string;
  channelType: string;
  conversationKey: string;
}

function ownedSession(scope: ConversationScope) {
  return and(
    eq(agentSessions.id, scope.sessionId),
    eq(agentSessions.orgId, scope.orgId),
    eq(agentSessions.ownerType, "user"),
    // Personal rows created before owner_id use user_id as their owner.
    sql`COALESCE(NULLIF(${agentSessions.ownerId}, ''), ${agentSessions.userId}) = ${scope.userId}`,
  );
}

function ownedThread(scope: ConversationScope, threadId: string) {
  return and(ownedSession(scope), sql`EXISTS (
    SELECT 1 FROM engine_threads t WHERE t.id = ${threadId} AND t.session_id = ${agentSessions.id}
  )`);
}

/** Retain missing thread IDs so the caller can report a conflict without rerouting. */
export async function findConversationBinding(db: AppDb, scope: ConversationScope): Promise<string | undefined> {
  const bindings = channelConversationBindings;
  const [binding] = await db.select({ threadId: bindings.threadId }).from(bindings)
    .innerJoin(agentSessions, eq(agentSessions.id, bindings.sessionId))
    .where(and(
      ownedSession(scope),
      eq(bindings.orgId, scope.orgId),
      eq(bindings.userId, scope.userId),
      eq(bindings.sessionId, scope.sessionId),
      eq(bindings.channelType, scope.channelType),
      eq(bindings.conversationKey, scope.conversationKey),
    )).limit(1);
  return binding?.threadId;
}

/** The primary key chooses the first writer; later writers reread that choice. */
export async function bindConversation(db: AppDb, scope: ConversationScope, threadId: string): Promise<string> {
  const validTarget = ownedThread(scope, threadId);
  const [target] = await db.select({ id: agentSessions.id }).from(agentSessions).where(validTarget).limit(1);
  if (!target) throw new Error("Conversation target does not belong to this user and session. Select an owned thread.");

  // Check ownership in the insert too, in case it changed after validation.
  await db.insert(channelConversationBindings).select(db.select({
    orgId: agentSessions.orgId,
    userId: sql<string>`${scope.userId}`.as("user_id"),
    sessionId: agentSessions.id,
    channelType: sql<string>`${scope.channelType}`.as("channel_type"),
    conversationKey: sql<string>`${scope.conversationKey}`.as("conversation_key"),
    threadId: sql<string>`${threadId}`.as("thread_id"),
    createdAt: sql<number>`${Date.now()}`.as("created_at"),
  }).from(agentSessions).where(validTarget).limit(1)).onConflictDoNothing();

  const winner = await findConversationBinding(db, scope);
  if (winner === undefined) throw new Error("Conversation binding has no valid owner. Reload the session before retrying.");
  return winner;
}

/** Read persisted destinations because another host can have created them after cache load. */
export async function findPriorConversationThread(db: AppDb, scope: ConversationScope, threadKey: string): Promise<string | undefined> {
  const rows = await db.select({ id: sql<string>`t.id`, key: sql<string>`t.key` }).from(agentSessions)
    .innerJoin(sql`engine_threads t`, sql`t.session_id = ${agentSessions.id}`)
    .where(and(ownedSession(scope), sql`t.key IN (${threadKey}, ${HOME_THREAD_KEY})`)).limit(2);
  const native = rows.find(row => row.key === threadKey);
  if (native) return native.id;
  const home = rows.find(row => row.key === HOME_THREAD_KEY);
  return home && await hasLegacyHomeConversation(db, scope, home.id, threadKey) ? home.id : undefined;
}

/** Any prior channel submission proves continuity, even without a queue row or message timestamp. */
export async function hasLegacyHomeConversation(db: AppDb, scope: ConversationScope, homeThreadId: string, threadKey: string): Promise<boolean> {
  // Replace escaped NUL before extraction, as workspace-outcomes does for engine JSON text.
  const [match] = await db.select({ id: agentSessions.id }).from(agentSessions).where(and(
    ownedThread(scope, homeThreadId),
    sql`(
      EXISTS (SELECT 1 FROM engine_queue_items q
        WHERE q.session_id = ${scope.sessionId} AND q.thread_id = ${homeThreadId}
          AND replace(q.channel, chr(92)||'u0000', chr(92)||'uFFFD')::json ->> 'channelType' = ${scope.channelType}
          AND replace(q.channel, chr(92)||'u0000', chr(92)||'uFFFD')::json ->> 'channelId' = ${scope.conversationKey})
      OR EXISTS (SELECT 1 FROM engine_queue_items q
        WHERE q.session_id = ${scope.sessionId} AND q.thread_id = ${homeThreadId}
          AND replace(q.content, chr(92)||'u0000', chr(92)||'uFFFD')::json ->> 'kind' = 'signal'
          AND replace(q.content, chr(92)||'u0000', chr(92)||'uFFFD')::json -> 'origin' ->> 'channelType' = ${scope.channelType}
          AND replace(q.content, chr(92)||'u0000', chr(92)||'uFFFD')::json -> 'origin' ->> 'threadKey' = ${threadKey})
      OR EXISTS (SELECT 1 FROM engine_entries e
        WHERE e.session_id = ${scope.sessionId} AND e.thread_id = ${homeThreadId}
          AND replace(e.channel, chr(92)||'u0000', chr(92)||'uFFFD')::json ->> 'channelType' = ${scope.channelType}
          AND replace(e.channel, chr(92)||'u0000', chr(92)||'uFFFD')::json ->> 'channelId' = ${scope.conversationKey})
      OR EXISTS (SELECT 1 FROM engine_entries e
        WHERE e.session_id = ${scope.sessionId} AND e.thread_id = ${homeThreadId}
          AND replace(e.signal, chr(92)||'u0000', chr(92)||'uFFFD')::json -> 'origin' ->> 'channelType' = ${scope.channelType}
          AND replace(e.signal, chr(92)||'u0000', chr(92)||'uFFFD')::json -> 'origin' ->> 'threadKey' = ${threadKey})
    )`,
  )).limit(1);
  return match !== undefined;
}
