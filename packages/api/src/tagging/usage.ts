import { and, eq, sql, type SQL } from "drizzle-orm";
import type { AppDb } from "../lib/drizzle.js";
import { externalCalls, tagDimensionState } from "../schema/index.js";
import type { ToolIntentUsage } from "../wire/types.js";
import { readRegistry, seedRegistry } from "./registry.js";
import { toolIntentDimension } from "./tool-intent.js";

export const intentLabelJoin = sql`tag_resolved_labels AS intent_label`;
export const intentLabelOn = sql`intent_label.org_id = ${externalCalls.orgId} AND intent_label.dimension = 'tool_intent'
  AND intent_label.subject_type = 'external_call' AND intent_label.subject_id = ${externalCalls.id}`;
export const intentKey = sql<string | null>`intent_label.key`;
export const intentKeyStatus = sql<string | null>`(SELECT status FROM tag_keys k WHERE k.org_id = ${externalCalls.orgId} AND k.dimension = 'tool_intent' AND k.key = intent_label.key)`;

export function intentKeyFilter(key?: string): SQL | undefined {
  return key === "__emerging" ? sql`${intentKeyStatus} = 'provisional'` : key ? sql`${intentKey} = ${key}` : undefined;
}

export async function toolIntentUsage(db: AppDb, orgId: string, where: SQL | undefined, canManage: boolean): Promise<ToolIntentUsage> {
  await seedRegistry(db, orgId, toolIntentDimension);
  const [registry, counts, state] = await Promise.all([
    readRegistry(db, orgId, "tool_intent"),
    db.select({ key: intentKey, calls: sql<number>`count(*)`.mapWith(Number), uniqueUsers: sql<number>`count(distinct ${externalCalls.userId})`.mapWith(Number),
      errorRate: sql<number>`count(*) filter (where ${externalCalls.outcome} = 'error')::float / count(*)`.mapWith(Number) }).from(externalCalls)
      .innerJoin(intentLabelJoin, intentLabelOn).where(where).groupBy(intentKey),
    db.select().from(tagDimensionState).where(and(eq(tagDimensionState.orgId, orgId), eq(tagDimensionState.dimension, "tool_intent"))),
  ]);
  return { canManage, consolidationDue: state[0]?.consolidationDue ?? false,
    keys: registry.map(key => ({ key: key.key, label: key.label, definition: key.definition, status: key.status, origin: key.origin,
      calls: counts.find(row => row.key === key.key)?.calls ?? 0, uniqueUsers: counts.find(row => row.key === key.key)?.uniqueUsers ?? 0,
      errorRate: counts.find(row => row.key === key.key)?.errorRate ?? 0 })) };
}
