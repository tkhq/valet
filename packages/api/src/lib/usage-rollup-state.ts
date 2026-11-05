import type { PgDb } from '@valet/store-postgres';
/** A partial projection is data loss, not an interrupted transactional install. */
export async function assertCompleteUsageProjection(db: PgDb, tables: readonly string[]): Promise<void> {
  const present = await db.query(`SELECT name FROM jsonb_array_elements_text($1::jsonb) AS names(name)
    WHERE to_regclass(name) IS NOT NULL`, [JSON.stringify(tables)]);
  if (present.rows.length === 0 || present.rows.length === tables.length) return;
  const found = new Set(present.rows.map(row => row.name));
  const missing = tables.filter(name => !found.has(name));
  throw new Error(`Usage projection tables are missing: ${missing.join(', ')}. Restore these tables from backup before restarting the API.`);
}
