import { sql, type SQL } from 'drizzle-orm';
import type { AppDb } from '../lib/drizzle.js';
import type { UsageScope } from './usage.js';
import type { ResolvedUsagePeriod } from './usage-period.js';
import type { SkillUsageBreakdown } from '../wire/types.js';

const HOUR = 3_600_000;
function bounds(period: ResolvedUsagePeriod) {
  return { start: Math.ceil(period.startMs / HOUR) * HOUR, end: Math.floor(period.endMs / HOUR) * HOUR };
}
function owned(scope: UsageScope): SQL {
  const base = sql`COALESCE(s.org_id,d.org_id) = ${scope.orgId}`;
  if (scope.scope === 'team') return sql`${base} AND COALESCE(s.owner_type,r.owner_type) = 'team' AND COALESCE(s.owner_id,r.owner_id) = ${scope.teamId}`;
  if (scope.scope === 'me') return sql`${base} AND CASE WHEN s.id IS NOT NULL THEN s.user_id WHEN r.owner_type = 'user' THEN NULLIF(r.owner_id,'') END = ${scope.userId}`;
  return base;
}
function actionRows(period: ResolvedUsagePeriod, scope: UsageScope): SQL {
  const b = bounds(period);
  return sql`SELECT session_id,workflow_execution_id,tool_calls,outcome_kind,outcomes
    FROM usage_action_hourly WHERE org_id = ${scope.orgId} AND hour_ms >= ${b.start} AND hour_ms < ${b.end}
    UNION ALL SELECT session_id,workflow_execution_id,tool_calls,outcome_kind,
      CASE WHEN outcome_kind IS NOT NULL THEN 1 ELSE 0 END AS outcomes
    FROM usage_action_facts WHERE org_id = ${scope.orgId} AND created_at >= ${period.startMs} AND created_at < ${period.endMs}
      AND (created_at < ${b.start} OR created_at >= ${b.end})`;
}
export async function getActionToolCalls(db: AppDb, period: ResolvedUsagePeriod, scope: UsageScope): Promise<number> {
  const owner = scope.scope === 'team' ? sql`AND r.owner_type='team' AND r.owner_id=${scope.teamId}`
    : scope.scope === 'me' ? sql`AND r.owner_type='user' AND r.owner_id=${scope.userId}` : sql``;
  const result = await db.execute(sql`WITH facts AS (${actionRows(period,scope)})
    SELECT COALESCE(SUM(f.tool_calls),0) AS calls FROM facts f
    JOIN workflow_runs r ON r.id=f.workflow_execution_id
    JOIN workflow_definitions d ON d.id=r.workflow_id
    WHERE d.org_id=${scope.orgId} ${owner}`) as { rows: { calls: unknown }[] };
  return Number(result.rows[0]?.calls ?? 0);
}
export async function getActionOutcomes(db: AppDb, period: ResolvedUsagePeriod, scope: UsageScope) {
  const result = await db.execute(sql`WITH facts AS (${actionRows(period,scope)})
    SELECT CASE WHEN r.id IS NOT NULL THEN 'w:' || r.id ELSE 's:' || f.session_id END AS parent,
      f.outcome_kind AS kind,SUM(f.outcomes) AS count
    FROM facts f LEFT JOIN agent_sessions s ON s.id=f.session_id
    LEFT JOIN workflow_runs r ON r.id=COALESCE(f.workflow_execution_id,CASE WHEN f.session_id LIKE 'wf:%' THEN split_part(f.session_id,':',2) END)
    LEFT JOIN workflow_definitions d ON d.id=r.workflow_id
    WHERE ${owned(scope)} AND f.outcome_kind IS NOT NULL GROUP BY 1,2`) as { rows: { parent: string; kind: string; count: unknown }[] };
  return result.rows;
}

/** Additive hours cover common requests; only cross-bucket requests need deduplication. */
export async function getSkillBreakdown(db: AppDb, period: ResolvedUsagePeriod, scope: UsageScope): Promise<SkillUsageBreakdown[]> {
  const b = bounds(period);
  const result = await db.execute(sql`
    WITH full_hours AS MATERIALIZED (
      SELECT h.* FROM usage_skill_hourly h
      LEFT JOIN agent_sessions s ON s.id=h.session_id
      LEFT JOIN workflow_runs r ON h.session_id LIKE 'wf:%' AND r.id=split_part(h.session_id,':',2)
      LEFT JOIN workflow_definitions d ON d.id=r.workflow_id
      WHERE h.hour_ms >= ${b.start} AND h.hour_ms < ${b.end} AND ${owned(scope)}
    ), edges AS MATERIALIZED (
      SELECT f.*,
        jsonb_build_array(f.session_id,f.skill_key,f.skill_name,f.origin,f.plugin_name,f.invoker_user_id)::text AS dimension_key,
        floor(f.created_at::numeric / ${HOUR})::bigint * ${HOUR} AS hour_ms,
        jsonb_build_array(f.skill_key,f.skill_name,f.origin,f.plugin_name,f.request_id)::text AS request_key
      FROM usage_skill_facts f
      LEFT JOIN agent_sessions s ON s.id=f.session_id
      LEFT JOIN workflow_runs r ON f.session_id LIKE 'wf:%' AND r.id=split_part(f.session_id,':',2)
      LEFT JOIN workflow_definitions d ON d.id=r.workflow_id
      WHERE f.created_at >= ${period.startMs} AND f.created_at < ${period.endMs}
        AND (f.created_at < ${b.start} OR f.created_at >= ${b.end}) AND ${owned(scope)}
    ), buckets AS (
      SELECT skill_key,skill_name,origin,plugin_name,invoker_user_id,tokens,invocations,carrying_calls FROM full_hours
      UNION ALL
      SELECT skill_key,skill_name,origin,plugin_name,invoker_user_id,SUM(tokens),SUM(invoked),COUNT(DISTINCT request_id)
      FROM edges GROUP BY dimension_key,hour_ms,skill_key,skill_name,origin,plugin_name,invoker_user_id
    ), duplicate_memberships AS (
      SELECT m.request_key,h.skill_key,h.skill_name,h.origin,h.plugin_name
      FROM usage_skill_requests r JOIN usage_skill_request_memberships m ON m.request_key=r.request_key
      JOIN full_hours h ON h.dimension_key=m.dimension_key AND h.hour_ms=m.hour_ms
      WHERE r.memberships > 1
      UNION ALL
      SELECT e.request_key,e.skill_key,e.skill_name,e.origin,e.plugin_name
      FROM edges e JOIN usage_skill_requests r ON r.request_key=e.request_key AND r.memberships > 1
      WHERE e.request_id IS NOT NULL
      GROUP BY e.request_key,e.dimension_key,e.hour_ms,e.skill_key,e.skill_name,e.origin,e.plugin_name
    ), corrections AS (
      SELECT skill_key,skill_name,origin,plugin_name,COUNT(*) - COUNT(DISTINCT request_key) AS duplicates
      FROM duplicate_memberships GROUP BY skill_key,skill_name,origin,plugin_name
    )
    SELECT b.skill_key,b.skill_name,b.origin,b.plugin_name,SUM(b.invocations) AS invocations,
      COUNT(DISTINCT b.invoker_user_id) FILTER (WHERE b.invocations > 0) AS unique_invokers,
      COALESCE(SUM(b.invocations) FILTER (WHERE b.invoker_user_id IS NULL),0) AS unassigned_invocations,
      SUM(b.tokens) AS attributed_context_tokens,SUM(b.carrying_calls)-COALESCE(MAX(c.duplicates),0) AS carrying_calls
    FROM buckets b LEFT JOIN corrections c ON c.skill_key=b.skill_key AND c.skill_name=b.skill_name AND c.origin=b.origin
      AND c.plugin_name IS NOT DISTINCT FROM b.plugin_name
    GROUP BY b.skill_key,b.skill_name,b.origin,b.plugin_name ORDER BY invocations DESC,b.skill_name ASC
  `) as { rows: { skill_key: string; skill_name: string; origin: 'plugin' | 'local' | 'repo'; plugin_name: string | null;
    invocations: unknown; unique_invokers: unknown; unassigned_invocations: unknown; attributed_context_tokens: unknown; carrying_calls: unknown }[] };
  return result.rows.map(r => ({ skillKey:r.skill_key,name:r.skill_name,origin:r.origin,
    ...(r.plugin_name ? {pluginName:r.plugin_name} : {}),invocations:Number(r.invocations),uniqueInvokers:Number(r.unique_invokers),
    unassignedInvocations:Number(r.unassigned_invocations),attributedContextTokens:Number(r.attributed_context_tokens),carryingCalls:Number(r.carrying_calls) }));
}
