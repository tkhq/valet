import { readFileSync } from "node:fs";
import type { PgDb } from "@valet/store-postgres";
import { usageAnalyticsPublishSql } from "./usage-analytics-migration.js";
import { usageHourlyPublishSql } from "./usage-hourly-migration.js";

/**
 * Deployed databases receive the Thread-step billing rule
 * (`valet_usage_fact` in 0000_app.sql) through this repair. A
 * fresh database installs it with the usage projection and creates the
 * ready view at the end of the migration, so this repair never runs on one.
 * On a deployed database only this repair's publish step creates the view,
 * after the backfill finishes.
 *
 * The backfill moves existing Thread-step facts from the assistant session
 * to their step. Each fact update fires the hourly trigger, which subtracts
 * the turn from the assistant's bucket and adds it to the step's, so the
 * hourly and daily totals move with it and nothing is counted twice.
 */
const migration = readFileSync(new URL("../../migrations/pg/0000_app.sql", import.meta.url), "utf8");
function between(start: string, end: string): string {
  const content = migration.split(start)[1]?.split(end)[0];
  if (!content) throw new Error("Usage step attribution migration missing. Restore 0000_app.sql from the release.");
  return content;
}
const functionsSql = between("-- usage step attribution begin\n", "-- usage step attribution end");

/**
 * `workflow_runs.org_id` and the trigger that copies it from the workflow
 * when a run starts. The backfill gives each existing run its workflow's
 * org. A run whose workflow is already gone keeps no org: its spend was
 * already out of the org's totals, and its Thread-step turns stay on the
 * assistant (see `valet_usage_fact`).
 */
export const WORKFLOW_RUN_ORG_SQL =
  `DO $run_org$ BEGIN ${between("-- workflow run org begin\n", "-- workflow run org end")} END $run_org$`;
export const WORKFLOW_RUN_ORG_BACKFILL = `UPDATE workflow_runs r SET org_id = d.org_id
  FROM workflow_definitions d WHERE d.id = r.workflow_id AND r.org_id IS NULL RETURNING r.id`;

// The usage views read the org from the run; a deployed database gets them here.
const dailyEntriesViewSql = "CREATE OR REPLACE VIEW usage_daily_entries AS"
  + between("CREATE OR REPLACE VIEW usage_daily_entries AS", "CREATE OR REPLACE VIEW usage_daily_ready");

export const USAGE_STEP_ATTRIBUTION_PUBLISH_SQL = `DO $publish$ BEGIN
  ${dailyEntriesViewSql}
  CREATE OR REPLACE VIEW usage_step_attribution_ready AS SELECT 1 AS version WHERE false;
END $publish$`;

export async function prepareUsageStepAttribution(db: PgDb): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.query("SET LOCAL lock_timeout = '5s'");
    // Serializes concurrent boots, as the usage analytics install does: two
    // transactions replacing one function fail with "tuple concurrently
    // updated". Writers pause only for this short transaction.
    await tx.query("LOCK TABLE engine_entries IN SHARE ROW EXCLUSIVE MODE");
    await tx.query(`DO $install$ BEGIN ${functionsSql} END $install$`);
    await tx.query(usageAnalyticsPublishSql);
    await tx.query(usageHourlyPublishSql);
  });
  // Page by Thread-step queue item. Each batch commits on its own, so a
  // restart resumes; the moved facts no longer match and are skipped.
  let cursor = "";
  for (;;) {
    const result = await db.query(`WITH items AS MATERIALIZED (
      SELECT id, session_id FROM engine_queue_items
      WHERE id > $1 AND dispatch_id LIKE 'workflow:%' AND session_id NOT LIKE 'wf:%'
      ORDER BY id LIMIT 200
    ), targets AS (
      SELECT id, session_id FROM items
      UNION ALL
      -- A prompt that send-now promoted runs as a new item naming its source.
      -- Read without a jsonb cast, as valet_usage_step_session does, so one
      -- unparsable metadata row cannot abort the repair and the boot.
      SELECT p.id, p.session_id FROM items i JOIN engine_queue_items p ON p.session_id = i.session_id
        AND p.dispatch_id IS NULL
        AND substring(p.metadata FROM '"promotedFromItemId":"([^"\\\\]+)"') = i.id
    ), moved AS (
      UPDATE usage_entry_facts f SET session_id = n.session_id, workflow_run_id = n.workflow_run_id
      FROM targets i JOIN engine_entries e ON e.queue_item_id = i.id AND e.session_id = i.session_id
      CROSS JOIN LATERAL valet_usage_fact(e) n
      WHERE f.entry_id = e.id AND f.session_id IS DISTINCT FROM n.session_id
    ) SELECT MAX(id) AS cursor FROM items`, [cursor]);
    const next = result.rows[0]?.cursor;
    if (typeof next !== "string") break;
    cursor = next;
  }
}
