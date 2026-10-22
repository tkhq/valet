import { and, eq, sql } from "drizzle-orm";
import type { AppDb, AppQueryable } from "../lib/drizzle.js";
import { tagDimensionState, tagKeys, tagLabels, tagSubjects } from "../schema/index.js";
import type { Dimension } from "./dimension.js";

export type RegistryKey = typeof tagKeys.$inferSelect & { assignments: number; users: number };
export function dimensionWhere(orgId: string, dimension: string) { return and(eq(tagKeys.orgId, orgId), eq(tagKeys.dimension, dimension)); }

export async function seedRegistry(db: AppQueryable, orgId: string, dimension: Dimension): Promise<void> {
  await db.insert(tagKeys).values(dimension.seeds.map(seed => ({ ...seed, orgId, dimension: dimension.id, origin: "seed" as const,
    status: "active" as const, examples: [], createdAt: Date.now(), updatedAt: Date.now() }))).onConflictDoNothing();
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
  throw new Error("Tag registry contains a merge cycle. Ask an organization admin to repair the registry.");
}

export async function readRegistry(db: AppQueryable, orgId: string, dimension: string): Promise<RegistryKey[]> {
  const keys = await db.select().from(tagKeys).where(dimensionWhere(orgId, dimension)).orderBy(tagKeys.key);
  const counts = await db.select({ key: tagLabels.key, assignments: sql<number>`count(*)`.mapWith(Number),
    users: sql<number>`count(distinct ${tagSubjects.userId})`.mapWith(Number) }).from(tagLabels)
    .leftJoin(tagSubjects, and(eq(tagSubjects.orgId, tagLabels.orgId), eq(tagSubjects.dimension, tagLabels.dimension),
      eq(tagSubjects.subjectType, tagLabels.subjectType), eq(tagSubjects.subjectId, tagLabels.subjectId)))
    .where(and(eq(tagLabels.orgId, orgId), eq(tagLabels.dimension, dimension))).groupBy(tagLabels.key);
  const total = new Map<string, { assignments: number; users: number }>();
  // Promotion counts use original assignments. Read aggregates resolve merges in SQL.
  for (const row of counts) total.set(row.key, row);
  return keys.map(key => ({ ...key, assignments: total.get(key.key)?.assignments ?? 0, users: total.get(key.key)?.users ?? 0 }));
}

export async function promoteKeys(db: AppQueryable, orgId: string, dimension: string): Promise<void> {
  for (const key of await readRegistry(db, orgId, dimension)) {
    if (key.status === "provisional" && (key.assignments >= 5 || key.users >= 2)) {
      await db.update(tagKeys).set({ status: "active", updatedAt: Date.now() }).where(and(dimensionWhere(orgId, dimension), eq(tagKeys.key, key.key), eq(tagKeys.status, "provisional")));
    }
  }
}

export class TagRegistry {
  constructor(private readonly db: AppDb, private readonly orgId: string) {}
  list(dimension: string) { return readRegistry(this.db, this.orgId, dimension); }

  async merge(dimension: string, from: string, to: string): Promise<void> {
    if (from === "other" || from === to) throw new Error("Invalid merge. Keep other as a terminal key and choose a different destination.");
    await this.db.insert(tagDimensionState).values({ orgId: this.orgId, dimension }).onConflictDoNothing();
    await this.db.transaction(async tx => {
      // Serialize edits and merges with classification, including cross-replica callers.
      const state = await tx.execute(sql`SELECT lease_until FROM tag_dimension_state WHERE org_id = ${this.orgId} AND dimension = ${dimension} FOR UPDATE`) as { rows: { lease_until: unknown }[] };
      if (Number(state.rows[0]?.lease_until ?? 0) > Date.now()) throw new Error("Tagger is busy. Retry this registry edit after the current batch.");
      const keys = await readRegistry(tx, this.orgId, dimension);
      if (!keys.some(key => key.key === from) || !keys.some(key => key.key === to)) throw new Error("Tag key not found. Reload the registry and choose an existing key.");
      const target = resolveKey(keys, to);
      if (target === from) throw new Error("This merge creates a cycle. Choose a different destination.");
      await tx.update(tagKeys).set({ status: "merged", mergedInto: target, updatedAt: Date.now() })
        .where(and(dimensionWhere(this.orgId, dimension), eq(tagKeys.key, from)));
      await tx.update(tagDimensionState).set({ consolidationDue: false }).where(and(eq(tagDimensionState.orgId, this.orgId), eq(tagDimensionState.dimension, dimension)));
    });
  }

  async edit(dimension: string, key: string, change: { label: string; definition: string }): Promise<void> {
    const label = change.label.trim(); const definition = change.definition.trim();
    if (!label || label.length > 100 || !definition || definition.length > 1000) throw new Error("Use a label of 1 to 100 characters and a definition of 1 to 1000 characters.");
    const rows = await this.db.update(tagKeys).set({ label, definition, updatedAt: Date.now() })
      .where(and(dimensionWhere(this.orgId, dimension), eq(tagKeys.key, key))).returning({ key: tagKeys.key });
    if (!rows.length) throw new Error("Tag key not found. Reload the registry and choose an existing key.");
  }
}
