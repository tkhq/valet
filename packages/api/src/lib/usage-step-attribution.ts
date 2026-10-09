import { readFileSync } from "node:fs";
import type { PgDb } from "@valet/store-postgres";

/**
 * Deployed databases receive the Thread-step billing rule
 * (`valet_usage_billing_session` in 0000_app.sql) through this repair. A
 * fresh database installs it with the usage projection and creates the
 * ready view there, so this repair never runs on one.
 *
 * The backfill moves existing Thread-step facts from the assistant session
 * to their step. Each fact update fires the hourly trigger, which subtracts
 * the turn from the assistant's bucket and adds it to the step's, so the
 * hourly and daily totals move with it and nothing is counted twice.
 */
const migration = readFileSync(new URL("../../migrations/pg/0000_app.sql", import.meta.url), "utf8");
const functionsSql = migration.split("-- usage step attribution begin\n")[1]?.split("-- usage step attribution end")[0];
if (!functionsSql) throw new Error("Usage step attribution migration missing. Restore 0000_app.sql from the release.");

export const USAGE_STEP_ATTRIBUTION_PUBLISH_SQL =
  "CREATE OR REPLACE VIEW usage_step_attribution_ready AS SELECT 1 AS version WHERE false";

export async function prepareUsageStepAttribution(db: PgDb): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.query("SET LOCAL lock_timeout = '5s'");
    await tx.query(`DO $install$ BEGIN ${functionsSql} END $install$`);
  });
  // Page by Thread-step queue item. Each batch commits on its own, so a
  // restart resumes; the moved facts no longer match and are skipped.
  let cursor = "";
  for (;;) {
    const result = await db.query(`WITH items AS MATERIALIZED (
      SELECT id, session_id FROM engine_queue_items
      WHERE id > $1 AND dispatch_id LIKE 'workflow:%' AND session_id NOT LIKE 'wf:%'
      ORDER BY id LIMIT 200
    ), moved AS (
      UPDATE usage_entry_facts f SET session_id = n.session_id, workflow_run_id = n.workflow_run_id
      FROM items i JOIN engine_entries e ON e.queue_item_id = i.id AND e.session_id = i.session_id
      CROSS JOIN LATERAL valet_usage_fact(e) n
      WHERE f.entry_id = e.id AND f.session_id IS DISTINCT FROM n.session_id
      RETURNING f.entry_id
    ) SELECT MAX(id) AS cursor, (SELECT COUNT(*)::int FROM moved) AS moved FROM items`, [cursor]);
    const next = result.rows[0]?.cursor;
    if (typeof next !== "string") break;
    cursor = next;
  }
}
