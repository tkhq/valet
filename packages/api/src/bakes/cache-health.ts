import { and, eq, inArray, isNotNull, isNull, notExists } from "drizzle-orm";
import type { AppDb } from "../lib/drizzle.js";
import { agentSessions, bakes, childWatches, imageSources } from "../schema/index.js";

/**
 * One protection rule for both retention paths and the health API. Each
 * source's newest pushed bake is protected, and so is every bake that a
 * session with a sandbox still booted from. A session whose sandbox was
 * reclaimed (a hibernated session past the reaper, or a settled child past
 * its retention sweep) protects nothing: its next start resolves the newest
 * bake again (`resolvePrebuildImage`). Child sessions stay `active` after
 * they finish, so without this rule their bakes stayed protected forever and
 * filled a deployment's disk (2026-11-09).
 */
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
    .where(and(
      eq(agentSessions.orgId, orgId),
      inArray(agentSessions.status, ["active", "hibernated"]),
      isNull(agentSessions.sandboxReclaimedAt),
      notExists(db.select({ id: childWatches.childSessionId }).from(childWatches)
        .where(and(eq(childWatches.childSessionId, agentSessions.id), isNotNull(childWatches.sandboxReclaimedAt)))),
    ));
  for (const session of live) if (session.bakeId) protectedIds.add(session.bakeId);
  return { rows, protectedIds };
}
