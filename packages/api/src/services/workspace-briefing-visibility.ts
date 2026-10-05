import { sql, type SQL } from "drizzle-orm";
import { governingThreadKeySql, sharedWithWholeTeamSql } from "./thread-access.js";

/** A team briefing cannot infer a shared audience from a broken origin link. */
export function sharedBriefingOrigin(orgId: string, teamId: string, sessionId: SQL, threadId: SQL): SQL {
  return sql`EXISTS (SELECT 1 FROM agent_sessions bs JOIN session_threads bt ON bt.session_id=bs.id
    WHERE bs.id=${sessionId} AND bt.id=${threadId} AND bs.org_id=${orgId}
      AND bs.owner_type='team' AND bs.owner_id=${teamId} AND bs.status<>'deleted' AND bt.archived_at IS NULL
      AND ${sharedWithWholeTeamSql(orgId, governingThreadKeySql(sessionId, threadId, "parent link"))})`;
}

/** Stored origins, not optional presentation links, decide run visibility. */
export function sharedBriefingRun(orgId: string, teamId: string, params: SQL): SQL {
  const data = sql`${params}->'input'->'data'`;
  const channel = sql`COALESCE(${data}->'refs'->>'channel',${data}->'payload'->'item'->>'channel',
    ${data}->'payload'->>'channel_id',${data}->'payload'->'channel'->>'id',${data}->'payload'->>'channel')`;
  return sql`((${params}->'origin' IS NULL OR ${params}->'origin'='null'::jsonb OR
    ${sharedBriefingOrigin(orgId, teamId, sql`${params}->'origin'->>'assistantSessionId'`, sql`${params}->'origin'->>'threadId'`)})
    AND (COALESCE(${data}->>'key','') NOT LIKE 'slack.%' OR
      (${channel} IS NOT NULL AND ${sharedWithWholeTeamSql(orgId, sql`('slack:' || ${channel} || ':')`)})))`;
}
