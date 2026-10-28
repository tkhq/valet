import { stripNul } from "@valet/engine";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { AppDb, AppQueryable } from "../lib/drizzle.js";
import { tagDimensionState, tagKeys, tagLabels, tagSubjects } from "../schema/index.js";
import type { Dimension } from "./dimension.js";

export class RegistryConflict extends Error {}

export type RegistryKey = typeof tagKeys.$inferSelect & { assignments: number; users: number; owners: number };
export function dimensionWhere(orgId: string, dimension: string) { return and(eq(tagKeys.orgId, orgId), eq(tagKeys.dimension, dimension)); }

export async function seedRegistry(db: AppQueryable, orgId: string, dimension: Dimension): Promise<void> {
  await db.insert(tagKeys).values(dimension.seeds.map(seed => ({ ...seed, orgId, dimension: dimension.id, origin: "seed" as const,
    status: "active" as const, examples: [], createdAt: Date.now(), updatedAt: Date.now() }))).onConflictDoUpdate({ target: [tagKeys.orgId, tagKeys.dimension, tagKeys.key],
    set: { label: sql`excluded.label`, definition: sql`excluded.definition` },
    setWhere: and(eq(tagKeys.origin, "seed"), sql`${tagKeys.editedAt} IS NULL`) });
}

export function resolveKey(keys: readonly Pick<RegistryKey, "key" | "status" | "mergedInto">[], key: string): string {
  const byKey = new Map(keys.map(row => [row.key, row]));
  const visited = new Set<string>();
  let current = key;
  while (!visited.has(current)) {
    visited.add(current);
    const row = byKey.get(current);
    if (!row) return "other";
    if (row.status !== "merged") return current;
    current = row.mergedInto ?? "other";
  }
  throw new RegistryConflict("Tag registry contains a merge cycle. Ask an organization admin to repair the registry.");
}

export async function readRegistry(db: AppQueryable, orgId: string, dimension: string): Promise<RegistryKey[]> {
  const keys = await db.select().from(tagKeys).where(dimensionWhere(orgId, dimension)).orderBy(tagKeys.key);
  const provisional = keys.filter(key => key.status === "provisional").map(key => key.key);
  const counts = provisional.length ? await db.select({ key: tagLabels.key, assignments: sql<number>`count(*)`.mapWith(Number),
    users: sql<number>`count(distinct ${tagSubjects.userId})`.mapWith(Number),
    owners: sql<number>`count(distinct jsonb_build_array(${tagSubjects.ownerType}, ${tagSubjects.ownerId}))
      filter (where ${tagSubjects.ownerType} IS NOT NULL AND ${tagSubjects.ownerId} IS NOT NULL)`.mapWith(Number) }).from(tagLabels)
    .leftJoin(tagSubjects, and(eq(tagSubjects.orgId, tagLabels.orgId), eq(tagSubjects.dimension, tagLabels.dimension),
      eq(tagSubjects.subjectType, tagLabels.subjectType), eq(tagSubjects.subjectId, tagLabels.subjectId)))
    .where(and(eq(tagLabels.orgId, orgId), eq(tagLabels.dimension, dimension), inArray(tagLabels.key, provisional))).groupBy(tagLabels.key) : [];
  const total = new Map<string, { assignments: number; users: number; owners: number }>();
  // Only provisional keys need promotion counts. Active keys use scoped usage aggregates.
  for (const row of counts) total.set(row.key, row);
  return keys.map(key => ({ ...key, assignments: total.get(key.key)?.assignments ?? 0, users: total.get(key.key)?.users ?? 0, owners: total.get(key.key)?.owners ?? 0 }));
}

export async function promoteKeys(db: AppQueryable, orgId: string, dimension: string): Promise<void> {
  for (const key of await readRegistry(db, orgId, dimension)) {
    if (key.status === "provisional" && key.assignments >= 10 && key.owners >= 2) {
      await db.update(tagKeys).set({ status: "active", updatedAt: Date.now() }).where(and(dimensionWhere(orgId, dimension), eq(tagKeys.key, key.key), eq(tagKeys.status, "provisional")));
    }
  }
}

export class TagRegistry {
  constructor(private readonly db: AppDb, private readonly orgId: string) {}
  list(dimension: string) { return readRegistry(this.db, this.orgId, dimension); }

  async merge(dimension: string, from: string, to: string): Promise<void> {
    if (from === "other" || from === to) throw new RegistryConflict("Invalid merge. Keep other as a terminal key and choose a different destination.");
    await this.db.insert(tagDimensionState).values({ orgId: this.orgId, dimension }).onConflictDoNothing();
    await this.db.transaction(async tx => {
      // Serialize edits and merges with classification, including cross-replica callers.
      await tx.execute(sql`SELECT lease_until FROM tag_dimension_state WHERE org_id = ${this.orgId} AND dimension = ${dimension} FOR UPDATE`);
      const keys = await readRegistry(tx, this.orgId, dimension);
      if (!keys.some(key => key.key === from) || !keys.some(key => key.key === to)) throw new RegistryConflict("Tag key not found. Reload the registry and choose an existing key.");
      const target = resolveKey(keys, to);
      if (target === from) throw new RegistryConflict("This merge creates a cycle. Choose a different destination.");
      await tx.update(tagKeys).set({ status: "merged", mergedInto: target, updatedAt: Date.now() })
        .where(and(dimensionWhere(this.orgId, dimension), eq(tagKeys.key, from)));
      await tx.update(tagDimensionState).set({ consolidationDue: sql`${tagDimensionState.consolidationDue} AND ${keys.filter(key => key.status !== "merged").length - (keys.find(key => key.key === from)?.status === "merged" ? 0 : 1)} >= ${sql`key_limit`}` }).where(and(eq(tagDimensionState.orgId, this.orgId), eq(tagDimensionState.dimension, dimension)));
    });
  }

  async edit(dimension: string, key: string, change: { label: string; definition: string }): Promise<void> {
    const label = stripNul(change.label).trim(); const definition = stripNul(change.definition).trim();
    if (!label || label.length > 60 || !definition || definition.length > 200) throw new RegistryConflict("Use a label of 1 to 60 characters and a definition of 1 to 200 characters.");
    const rows = await this.db.update(tagKeys).set({ label, definition, updatedAt: Date.now(), editedAt: Date.now() })
      .where(and(dimensionWhere(this.orgId, dimension), eq(tagKeys.key, key))).returning({ key: tagKeys.key });
    if (!rows.length) throw new RegistryConflict("Tag key not found. Reload the registry and choose an existing key.");
  }
}
