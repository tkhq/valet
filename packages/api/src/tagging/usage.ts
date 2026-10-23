import { and, eq, sql, type SQL } from "drizzle-orm";
import type { AppDb } from "../lib/drizzle.js";
import { externalCalls, tagDimensionState } from "../schema/index.js";
import type { ToolIntentUsage } from "../wire/types.js";
import { resolveKey, type RegistryKey } from "./registry.js";

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
      errorRate: sql<number>`count(*) filter (where ${externalCalls.outcome} = 'error')::float / count(*)`.mapWith(Number) }).from(externalCalls)
      .leftJoin(join.join, join.on).where(where).groupBy(intentKey),
    db.select().from(tagDimensionState).where(and(eq(tagDimensionState.orgId, orgId), eq(tagDimensionState.dimension, "tool_intent"))),
  ]);
  return { canManage, consolidationDue: state[0]?.consolidationDue ?? false,
    unlabeledCalls: counts.find(row => row.key === null)?.calls ?? 0,
    emergingCalls: counts.filter(row => row.key === "__emerging" || registry.some(key => key.key === row.key && key.status === "provisional"))
      .reduce((sum, row) => sum + row.calls, 0),
    keys: registry.filter(key => canManage || key.status !== "provisional").map(key => ({
      key: key.key, label: key.label, definition: key.definition, status: key.status, origin: key.origin,
      calls: counts.find(row => row.key === key.key)?.calls ?? 0, uniqueUsers: counts.find(row => row.key === key.key)?.uniqueUsers ?? 0,
      errorRate: counts.find(row => row.key === key.key)?.errorRate ?? 0 })) };
}
