import { sql } from 'drizzle-orm';
import type { AppDb } from '../lib/drizzle.js';
import type { UsageScope } from './usage.js';
import type { ResolvedUsagePeriod } from './usage-period.js';
const HOUR = 3600000;
const DAY = HOUR * 24;

/** Count each actor's distinct sessions per UTC day, with current ownership. */
export async function getMemberAgentDays(db: AppDb, scope: UsageScope, period: ResolvedUsagePeriod): Promise<{ actor_id: string | null; agent_days: unknown }[]> {
  const first = Math.ceil(period.startMs / HOUR) * HOUR;
  const last = Math.max(first, Math.floor(period.endMs / HOUR) * HOUR);
  const scopeFilter = scope.scope === 'team'
    ? sql`AND owners.owner_type='team' AND owners.owner_id=${scope.teamId}`
    : scope.scope === 'me' ? sql`AND owners.user_id=${scope.userId}` : sql``;
  // Summary rows retain queue actors only. Child and session fallbacks stay live.
  // These selected columns have the same shape on PostgreSQL and PGlite.
  const result = await db.execute(sql`
    WITH activity AS NOT MATERIALIZED (
      SELECT session_id,actor_id,created_at FROM usage_member_hourly
      WHERE created_at>=${first} AND created_at<${last} AND positive_turns>0
      UNION ALL
      SELECT session_id,actor_id,created_at FROM usage_member_facts
      WHERE created_at>=${period.startMs} AND created_at<${period.endMs}
        AND (created_at<${first} OR created_at>=${last})
    ), owners AS (
      SELECT id AS session_id,org_id,user_id,owner_type,NULLIF(owner_id,'') AS owner_id
      FROM agent_sessions
      UNION ALL
      SELECT DISTINCT f.session_id,d.org_id,
        CASE WHEN r.owner_type='user' THEN NULLIF(r.owner_id,'') END,
        r.owner_type,NULLIF(r.owner_id,'')
      FROM (SELECT DISTINCT session_id FROM activity WHERE session_id LIKE 'wf:%') f
      JOIN workflow_runs r ON r.id=split_part(f.session_id,':',2)
      JOIN workflow_definitions d ON d.id=r.workflow_id
      WHERE NOT EXISTS (SELECT 1 FROM agent_sessions s WHERE s.id=f.session_id)
    ), active AS (
      SELECT activity.session_id,(floor(activity.created_at::numeric/${DAY})*${DAY})::bigint AS day_ms,
        COALESCE(NULLIF(activity.actor_id,''),NULLIF(cw.actor_user_id,''),
          CASE WHEN a.id IS NULL AND activity.session_id NOT LIKE 'orchestrator:%' THEN owners.user_id END) AS actor_id
      FROM activity JOIN owners ON owners.session_id=activity.session_id
      LEFT JOIN child_watches cw ON cw.child_session_id=activity.session_id AND cw.org_id=owners.org_id
      LEFT JOIN assistants a ON a.session_id=activity.session_id AND a.org_id=owners.org_id
      WHERE owners.org_id=${scope.orgId} ${scopeFilter}
    ), daily AS (
      SELECT actor_id,day_ms,COUNT(DISTINCT session_id) AS active_agents
      FROM active GROUP BY actor_id,day_ms
    ) SELECT actor_id,SUM(active_agents) AS agent_days FROM daily GROUP BY actor_id
  `) as { rows: { actor_id: string | null; agent_days: unknown }[] };
  return result.rows;
}
