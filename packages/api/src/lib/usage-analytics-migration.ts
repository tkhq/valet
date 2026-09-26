import { readFileSync } from "node:fs";
import { isPgErrorCode, type PgDb } from "@valet/store-postgres";

// Fresh migration and deployed repair share exact function/view definitions.
const migration = readFileSync(new URL("../../migrations/pg/0000_app.sql", import.meta.url), "utf8");
function section(start: string, end: string): string {
  const content = migration.split(`-- usage analytics ${start}\n`)[1]?.split(end)[0];
  if (!content) throw new Error("Usage analytics migration missing. Restore 0000_app.sql from the release.");
  return content;
}
export const usageAnalyticsInstallSql = section("install", "-- usage analytics backfill");
const indexSql = section("indexes", "END $migration$");
export const projectedCostViewSql = 'CREATE OR REPLACE VIEW cost_entries AS' +
  section("publish", "-- usage analytics indexes").split('CREATE OR REPLACE VIEW cost_entries AS')[1];
export const usageAnalyticsPublishSql = `DO $publish$ BEGIN
  ${section("publish", "-- usage analytics indexes")}
  ANALYZE usage_entry_facts;
END $publish$`;

/** Install tracking first. Old readers retain their views until publication.
 * Each backfill batch releases its row locks before the next batch starts. */
export async function prepareUsageAnalytics(db: PgDb): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.query("SET LOCAL lock_timeout = '5s'");
    await tx.query(`DO $install$ BEGIN ${usageAnalyticsInstallSql} END $install$`);
  });
  // Build indexes on existing audit/skill tables without blocking writers.
  for (const statement of indexSql.split(';').map((s) => s.trim()).filter((s) => s.startsWith('CREATE INDEX'))) {
    const name = statement.match(/EXISTS (\w+)/)?.[1];
    if (!name) throw new Error("Usage index definition invalid. Restore 0000_app.sql from the release.");
    const deadline = Date.now() + 10 * 60_000;
    for (;;) {
      const state = await db.query(`SELECT i.indisvalid AS valid,
        EXISTS (SELECT 1 FROM pg_stat_progress_create_index progress WHERE progress.relid = i.indrelid) AS building
        FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = current_schema() AND c.relname = $1`, [name]);
      if (state.rows[0]?.valid === true) break;
      if (Date.now() > deadline) throw new Error(`Usage index ${name} is still building. Check pg_stat_progress_create_index, then restart the API.`);
      if (state.rows[0]?.building === true) {
        // Another API process owns a live build; invalid does not mean abandoned.
        await new Promise((resolve) => setTimeout(resolve, 250));
        continue;
      }
      try {
        // A stopped concurrent build leaves an invalid index. Names come only
        // from the bundled migration; no request value enters this statement.
        if (state.rows.length) await db.query(`DROP INDEX CONCURRENTLY IF EXISTS "${name}"`);
        await db.query(statement.replace('CREATE INDEX IF NOT EXISTS', 'CREATE INDEX CONCURRENTLY IF NOT EXISTS'));
      } catch (error) {
        // Simultaneous boots can both see no index before either creates it.
        // Re-read the catalog after that race; do not suppress other failures.
        if (!["42P07", "42710", "23505", "40P01"].some((code) => isPgErrorCode(error, code))) throw error;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
  }
  let cursor = "";
  for (;;) {
    const result = await db.query(`WITH batch AS MATERIALIZED (
      SELECT e.* FROM engine_entries e
      WHERE e.id > $1 AND NOT EXISTS (SELECT 1 FROM usage_entry_facts f WHERE f.entry_id = e.id)
      ORDER BY e.id LIMIT 500 FOR KEY SHARE OF e
    ), inserted AS (
      INSERT INTO usage_entry_facts SELECT f.* FROM batch e CROSS JOIN LATERAL valet_usage_fact(e) f
      ON CONFLICT (entry_id) DO NOTHING RETURNING entry_id
    ) SELECT MAX(id) AS cursor, COUNT(*)::int AS count FROM batch`, [cursor]);
    const next = result.rows[0]?.cursor;
    if (typeof next !== 'string') break;
    cursor = next;
  }
}
