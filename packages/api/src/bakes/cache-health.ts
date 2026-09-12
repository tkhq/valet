import { and, eq, inArray } from "drizzle-orm";
import type { AppDb } from "../lib/drizzle.js";
import { agentSessions, bakes, imageSources } from "../schema/index.js";

/** One protection rule for both retention paths and the health API. */
export async function readCacheState(db: AppDb, orgId: string) {
  const rows = await db.select({
    id: bakes.id, sourceId: bakes.sourceId, imageRef: bakes.imageRef,
    sizeBytes: bakes.sizeBytes, createdAt: bakes.createdAt,
  }).from(bakes).innerJoin(imageSources, eq(bakes.sourceId, imageSources.id))
    .where(and(eq(imageSources.orgId, orgId), eq(bakes.status, "pushed")))
    .orderBy(bakes.createdAt, bakes.id);
  const newest = new Map<string, string>();
  for (const row of rows) newest.set(row.sourceId, row.id);
  const protectedIds = new Set(newest.values());
  const live = await db.select({ bakeId: agentSessions.bakeId }).from(agentSessions)
    .where(and(eq(agentSessions.orgId, orgId), inArray(agentSessions.status, ["active", "hibernated"])));
  for (const session of live) if (session.bakeId) protectedIds.add(session.bakeId);
  return { rows, protectedIds };
}
