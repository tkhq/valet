import { sql, type SQL } from "drizzle-orm";
import type { ResolvedUsagePeriod } from "./usage-period.js";
const HOUR = 3600000;
/** Complete UTC hours use summaries. The disjoint edges retain exact timestamps. */
export function usagePeriodRows(
  period: ResolvedUsagePeriod,
  includeTools = false,
  useDaily = true,
): SQL {
  const first = Math.ceil(period.startMs / HOUR) * HOUR;
  const last = Math.max(first, Math.floor(period.endMs / HOUR) * HOUR);
  const firstDay = Math.ceil(period.startMs / (24 * HOUR)) * (24 * HOUR);
  const lastDay = Math.max(
    firstDay,
    Math.floor(period.endMs / (24 * HOUR)) * (24 * HOUR),
  );
  const summarySource = useDaily
    ? sql`(
   SELECT * FROM usage_daily_entries WHERE created_at>=${firstDay} AND created_at<${lastDay}
   UNION ALL SELECT * FROM usage_hourly_entries
   WHERE created_at>=${first} AND created_at<${last} AND (created_at<${firstDay} OR created_at>=${lastDay})
 )`
    : sql`usage_hourly_entries`;
  const edge = sql`created_at >= ${period.startMs} AND created_at < ${period.endMs}
  AND (created_at < ${first} OR created_at >= ${last})`;
  const raw = includeTools
    ? sql`
 SELECT session_id,created_at,model,org_id,user_id,owner_type,owner_id,workflow_id,workflow_run_id,use_case,NULL::text AS provider,
 COALESCE((usage->>'input')::bigint,0) AS input_tokens,COALESCE((usage->>'output')::bigint,0) AS output_tokens,
 COALESCE((usage->>'cacheRead')::bigint,0) AS cache_read_tokens,COALESCE((usage->>'cacheWrite')::bigint,0) AS cache_write_tokens,
 COALESCE((usage->>'total')::bigint,0) AS total_tokens,
 CASE WHEN usage IS NOT NULL THEN COALESCE((cost->>'total')::float8,0) ELSE 0 END AS cost_total,
 (usage IS NOT NULL)::int::bigint AS turns,(usage IS NOT NULL AND cost->>'total' IS NULL)::int::bigint AS unpriced_turns,
 (COALESCE((usage->>'total')::bigint,0)>0)::int::bigint AS positive_turns,tool_calls,pull_requests,reviews
 FROM usage_entries WHERE ${edge}`
    : sql`
 SELECT session_id,created_at,model,org_id,user_id,owner_type,owner_id,workflow_id,workflow_run_id,use_case,provider,
 input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,total_tokens,cost_total,
 1::bigint AS turns,(NOT priced)::int::bigint AS unpriced_turns,(total_tokens>0)::int::bigint AS positive_turns,
 0::bigint AS tool_calls,0::bigint AS pull_requests,0::bigint AS reviews
 FROM cost_entries WHERE ${edge}`;
  return sql`(
 SELECT session_id,created_at,model,scope_org_id AS org_id,scope_user_id AS user_id,owner_type,owner_id,workflow_id,workflow_run_id,use_case,provider,
 input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,total_tokens,cost_total::float8 AS cost_total,
 turns,unpriced_turns,positive_turns,tool_calls,pull_requests,reviews
 FROM ${summarySource} summary WHERE created_at>=${first} AND created_at<${last}
 ${includeTools ? sql`AND source_kind='engine'` : sql`AND turns>0`}
 UNION ALL ${raw}
 )`;
}
export const HOURLY_BUCKET_COLS = sql`
 COALESCE(SUM(cost_total),0) AS cost_usd,COALESCE(SUM(total_tokens),0) AS total_tokens,
 COALESCE(SUM(input_tokens),0) AS input_tokens,COALESCE(SUM(output_tokens),0) AS output_tokens,
 COALESCE(SUM(cache_read_tokens),0) AS cache_read_tokens,COALESCE(SUM(cache_write_tokens),0) AS cache_write_tokens,
 COALESCE(SUM(turns),0) AS turns,COALESCE(SUM(unpriced_turns),0) AS unpriced_turns`;

/** Harness totals preserve proxy detail without grouping every monthly request. */
export function proxyPeriodRows(period: ResolvedUsagePeriod): SQL {
  const first = Math.ceil(period.startMs / HOUR) * HOUR;
  const last = Math.max(first, Math.floor(period.endMs / HOUR) * HOUR);
  const firstDay = Math.ceil(period.startMs / (24 * HOUR)) * (24 * HOUR);
  const lastDay = Math.max(
    firstDay,
    Math.floor(period.endMs / (24 * HOUR)) * (24 * HOUR),
  );
  const summarySource = sql`(
    SELECT * FROM usage_daily WHERE created_at>=${firstDay} AND created_at<${lastDay}
    UNION ALL SELECT * FROM usage_hourly
    WHERE created_at>=${first} AND created_at<${last} AND (created_at<${firstDay} OR created_at>=${lastDay})
  )`;
  return sql`(
    SELECT dimensions->>6 AS harness,org_id,user_id,team_id,created_at,
      total_tokens,cost_total::float8 AS cost_usd,turns
    FROM ${summarySource} summary WHERE source_kind='proxy' AND turns>0
      AND created_at>=${first} AND created_at<${last}
    UNION ALL
    SELECT harness,org_id,user_id,team_id,created_at,total_tokens,cost_usd,1::bigint AS turns
    FROM llm_proxy_requests WHERE total_tokens>0
      AND created_at>=${period.startMs} AND created_at<${period.endMs}
      AND (created_at<${first} OR created_at>=${last})
  )`;
}
