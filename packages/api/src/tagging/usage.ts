import { and, eq, sql, type SQL } from "drizzle-orm";
import type { AppDb } from "../lib/drizzle.js";
import { externalCalls, tagDimensionState } from "../schema/index.js";
import type { ToolIntentUsage, SessionOutcomeUsage } from "../wire/types.js";
import type { UsageScope } from "../services/usage.js";
import type { ResolvedUsagePeriod } from "../services/usage-period.js";
import { readRegistry, resolveKey, type RegistryKey } from "./registry.js";

/** Resolve the small organization registry once, not the label table recursively in every query. */
export function intentJoins(keys: readonly RegistryKey[], orgId: string, canManage: boolean) {
  const map = keys.map(row => {
    const resolved = resolveKey(keys, row.key);
    const status = keys.find(key => key.key === resolved)?.status;
    return { original: row.key, key: !canManage && status === "provisional" ? "__emerging" : resolved, status };
  });
  return {
    join: sql`(SELECT l.subject_id, m.key, m.status FROM tag_labels l
      JOIN jsonb_to_recordset(${JSON.stringify(map)}::jsonb) AS m(original text, key text, status text) ON m.original = l.key
      WHERE l.org_id = ${orgId} AND l.dimension = 'tool_intent' AND l.subject_type = 'external_call') AS intent_label`,
    on: sql`intent_label.subject_id = ${externalCalls.id}`,
  };
}
export const intentKey = sql<string | null>`intent_label.key`;
export function intentKeyFilter(key?: string): SQL | undefined {
  return key === "__emerging" ? sql`intent_label.status = 'provisional'`
    : key === "__unlabeled" ? sql`${intentKey} IS NULL` : key ? sql`${intentKey} = ${key}` : undefined;
}

export async function toolIntentUsage(db: AppDb, orgId: string, where: SQL | undefined, canManage: boolean,
  registry: RegistryKey[]): Promise<ToolIntentUsage> {
  const join = intentJoins(registry, orgId, canManage);
  const [counts, state] = await Promise.all([
    db.select({ key: intentKey, calls: sql<number>`count(*)`.mapWith(Number),
      uniqueUsers: sql<number>`count(distinct ${externalCalls.userId})`.mapWith(Number),
      errorRate: sql<number>`coalesce(count(*) filter (where ${externalCalls.outcome} = 'error')::float / nullif(count(*) filter (where ${externalCalls.outcome} in ('ok', 'error')), 0), 0)`.mapWith(Number) }).from(externalCalls)
      .leftJoin(join.join, join.on).where(where).groupBy(intentKey),
    db.select().from(tagDimensionState).where(and(eq(tagDimensionState.orgId, orgId), eq(tagDimensionState.dimension, "tool_intent"))),
  ]);
  return { canManage, consolidationDue: state[0]?.consolidationDue ?? false,
    unlabeledCalls: counts.find(row => row.key === null)?.calls ?? 0,
    emergingCalls: counts.filter(row => row.key === "__emerging" || registry.some(key => key.key === row.key && key.status === "provisional"))
      .reduce((sum, row) => sum + row.calls, 0),
    keys: registry.filter(key => canManage || (key.status === "active" && counts.some(row => row.key === key.key && row.calls > 0))).map(key => ({
      key: key.key, label: key.label, definition: key.definition, status: key.status, origin: key.origin,
      calls: counts.find(row => row.key === key.key)?.calls ?? 0, uniqueUsers: counts.find(row => row.key === key.key)?.uniqueUsers ?? 0,
      errorRate: counts.find(row => row.key === key.key)?.errorRate ?? 0 })) };
}

/** Counts thread subjects, including child-session threads. No transcript leaves this endpoint. */
export async function sessionOutcomeUsage(db: AppDb, scope: UsageScope, period: ResolvedUsagePeriod): Promise<SessionOutcomeUsage> {
  const result = await db.execute(sql`SELECT l.key, count(*)::int AS sessions FROM tag_labels l
    JOIN engine_threads t ON l.subject_id = t.session_id || ':' || t.id
    JOIN agent_sessions s ON s.id = t.session_id AND s.org_id = l.org_id
    WHERE l.org_id = ${scope.orgId} AND l.dimension = 'session_outcome' AND l.subject_type = 'session_thread'
      AND s.status <> 'deleted' AND s.id NOT LIKE 'tagger:%' AND s.id NOT LIKE 'wf:%'
      AND l.classified_at >= ${period.startMs} AND l.classified_at < ${period.endMs}
      ${scope.scope === "me" ? sql`AND s.user_id = ${scope.userId}` : sql``}
      ${scope.scope === "team" ? sql`AND s.owner_type = 'team' AND s.owner_id = ${scope.teamId}` : sql``}
    GROUP BY l.key`) as { rows: { key: string; sessions: unknown }[] };
  const registry = await readRegistry(db, scope.orgId, "session_outcome");
  return { outcomes: registry.filter(key => key.status !== "merged" && (key.key !== "other" || result.rows.some(row => row.key === "other")))
    .map(key => ({ key: key.key, label: key.label, definition: key.definition, sessions: Number(result.rows.find(row => row.key === key.key)?.sessions ?? 0) })) };
}
