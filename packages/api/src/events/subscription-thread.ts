/** Conversation destinations share one access gate at write and delivery time. */
import type { Principal } from "@valet/engine";
import { sql, type SQL } from "drizzle-orm";
import type { AppDb } from "../lib/drizzle.js";
import { governingThreadKeySql, sharedWithWholeTeamSql } from "../services/thread-access.js";
import type { ThreadSummary } from "../wire/types.js";

export interface SubscriptionThreadScope {
  orgId: string;
  owner: Principal;
  userId: string;
}

export const SUBSCRIPTION_THREAD_UNAVAILABLE = "This conversation is unavailable to the subscription workspace. Choose an active conversation shared with its owner.";

/** A destination cannot retain access after its creator leaves the workspace. */
export async function subscriptionWorkspaceAuthorized(db: AppDb, scope: SubscriptionThreadScope): Promise<boolean> {
  const { orgId, owner, userId } = scope;
  if (owner.type === "org" || (owner.type === "user" && owner.id !== userId)) return false;
  const result = await db.execute(sql`SELECT 1 FROM org_members om
    WHERE om.org_id = ${orgId} AND om.user_id = ${userId}
      AND (${owner.type} = 'user' OR EXISTS (
        SELECT 1 FROM teams tm JOIN team_members m ON m.team_id = tm.id
        WHERE tm.id = ${owner.id} AND tm.org_id = ${orgId} AND m.user_id = ${userId}))
    LIMIT 1`) as { rows: unknown[] };
  return result.rows.length > 0;
}

/** Only live assistant runtimes and their verified execution sessions qualify. */
function eligibleThreads(scope: SubscriptionThreadScope): SQL {
  const { orgId, owner } = scope;
  const key = governingThreadKeySql(sql`s.id`, sql`t.id`);
  return sql`FROM agent_sessions s
    JOIN engine_sessions es ON es.id = s.id AND es.org_id = s.org_id
      AND es.owner_type = s.owner_type AND es.owner_id = s.owner_id
    JOIN engine_threads t ON t.session_id = s.id
    LEFT JOIN session_threads m ON m.session_id = s.id AND m.id = t.id
    LEFT JOIN assistant_executions x ON x.session_id = s.id
    JOIN assistants a ON (a.session_id = s.id OR a.id = x.assistant_id)
    JOIN agent_sessions root ON root.id = a.session_id AND root.org_id = s.org_id
    LEFT JOIN engine_threads g ON g.session_id = a.session_id AND g.id = x.governing_thread_id
    LEFT JOIN session_threads gm ON gm.session_id = g.session_id AND gm.id = g.id
    WHERE s.org_id = ${orgId} AND s.owner_type = ${owner.type} AND s.owner_id = ${owner.id}
      AND s.status IN ('active', 'hibernated') AND es.status <> 'terminated' AND root.status IN ('active', 'hibernated')
      AND a.org_id = ${orgId} AND a.owner_type = ${owner.type} AND a.owner_id = ${owner.id}
      AND a.archived_at IS NULL AND m.archived_at IS NULL AND t.status <> 'archived'
      AND (${owner.type} <> 'team' OR x.session_id IS NOT NULL OR EXISTS (
        SELECT 1 FROM legacy_assistant_runtimes legacy WHERE legacy.session_id = s.id AND legacy.org_id = ${orgId}))
      AND COALESCE(x.conversation_key, t.key) !~ '^(signal:workflow:|slack-events:[^:]+:workflow:)[A-Za-z0-9_-]+$'
      AND (s.id <> a.session_id OR NOT EXISTS (SELECT 1 FROM assistant_executions anchor
        WHERE anchor.assistant_id = a.id AND anchor.governing_thread_id = t.id)
        OR EXISTS (SELECT 1 FROM engine_entries entry WHERE entry.session_id = s.id AND entry.thread_id = t.id))
      AND (x.session_id IS NULL OR (g.id IS NOT NULL AND gm.archived_at IS NULL AND g.status <> 'archived'
        AND es.parent_session_id = a.session_id AND es.parent_thread_id = g.id))
      AND (${owner.type} <> 'team' OR ${sharedWithWholeTeamSql(orgId, key)})`;
}

export async function subscriptionThreadAvailable(
  db: AppDb, scope: SubscriptionThreadScope, target: { sessionId: string; threadId: string },
): Promise<boolean> {
  if (!await subscriptionWorkspaceAuthorized(db, scope)) return false;
  const result = await db.execute(sql`SELECT t.id ${eligibleThreads(scope)}
    AND s.id = ${target.sessionId} AND t.id = ${target.threadId} LIMIT 1`) as { rows: unknown[] };
  return result.rows.length > 0;
}

/** Read persisted metadata only. Selecting a destination never starts a runtime. */
export async function listSubscriptionThreads(
  db: AppDb, scope: SubscriptionThreadScope,
  options: { limit: number; query: string; after?: { createdAt: number; id: string } },
): Promise<ThreadSummary[]> {
  const { after, query } = options;
  const result = await db.execute(sql`SELECT t.id, s.id AS session_id, t.key, t.created_at,
      m.title, COALESCE(m.last_user_activity_at, t.created_at) AS last_user_activity_at
    ${eligibleThreads(scope)}
      AND (${query} = '' OR strpos(lower(COALESCE(m.title, '')), ${query}) > 0)
      ${after ? sql`AND (t.created_at < ${after.createdAt} OR (t.created_at = ${after.createdAt} AND t.id > ${after.id}))` : sql``}
    ORDER BY t.created_at DESC, t.id ASC LIMIT ${options.limit}`) as {
      rows: Array<{ id: string; session_id: string; key: string; created_at: number | string; title: string | null; last_user_activity_at: number | string }>;
    };
  return result.rows.map(row => ({ id: row.id, sessionId: row.session_id, key: row.key,
    createdAt: Number(row.created_at), lastUserActivityAt: Number(row.last_user_activity_at),
    ...(row.title ? { title: row.title } : {}) }));
}
