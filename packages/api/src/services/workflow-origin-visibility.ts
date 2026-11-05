import { sql, type SQL } from "drizzle-orm";
import { governingThreadKeySql, sharedWithWholeTeamSql, threadSlackChannelsSql } from "./thread-access.js";

/** A shared outcome cannot infer a team audience from a broken origin link. */
export function sharedWorkflowOriginSql(orgId: string, teamId: string, sessionId: SQL, threadId: SQL): SQL {
  return sql`EXISTS (SELECT 1 FROM agent_sessions bs JOIN session_threads bt ON bt.session_id=bs.id
    WHERE bs.id=${sessionId} AND bt.id=${threadId} AND bs.org_id=${orgId}
      AND bs.owner_type='team' AND bs.owner_id=${teamId} AND bs.status<>'deleted' AND bt.archived_at IS NULL
      AND ${sharedWithWholeTeamSql(orgId, governingThreadKeySql(sessionId, threadId, "parent link"), threadSlackChannelsSql(sessionId, threadId))})`;
}

/** Stored origins, not optional presentation links, decide run visibility. */
export function sharedWorkflowRunSql(orgId: string, teamId: string, params: SQL): SQL {
  const data = sql`${params}->'input'->'data'`;
  const channel = sql`COALESCE(${data}->'refs'->>'channel',${data}->'payload'->'item'->>'channel',
    ${data}->'payload'->>'channel_id',${data}->'payload'->'channel'->>'id',${data}->'payload'->>'channel')`;
  return sql`((${params}->'origin' IS NULL OR ${params}->'origin'='null'::jsonb OR
    ${sharedWorkflowOriginSql(orgId, teamId, sql`${params}->'origin'->>'assistantSessionId'`, sql`${params}->'origin'->>'threadId'`)})
    AND (COALESCE(${data}->>'key','') NOT LIKE 'slack.%' OR
      (${channel} IS NOT NULL AND ${sharedWithWholeTeamSql(orgId, sql`('slack:' || ${channel} || ':')`)})))`;
}
