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
  DELETE FROM usage_hourly_progress WHERE source_kind = 'step-attribution';
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
  await backfillStepAttribution(db);
}

/** The backfill's progress row in `usage_hourly_progress`, the table the
 * hourly backfill keeps its own watermarks in. */
const PROGRESS = "step-attribution";
const PAGE_ITEMS = 2000;

/**
 * Moves Thread-step facts recorded before the rule to their step. It makes
 * one pass over `engine_queue_items` in primary-key order, a fixed number of
 * items per page, so its cost is bounded by the table's size. A page touches
 * only the entries of its workflow-dispatched items and of items that
 * send-now promoted, through `engine_entries_queue_item`;
 * `valet_usage_fact` decides each entry's billing, so a promoted item whose
 * source is not a workflow step keeps its fact. Each page commits with the
 * watermark it reached, so a restart resumes there, and the progress row's
 * lock serializes concurrent boots.
 */
export async function backfillStepAttribution(db: PgDb): Promise<void> {
  await db.query("INSERT INTO usage_hourly_progress (source_kind, watermark) VALUES ($1, '') ON CONFLICT DO NOTHING", [PROGRESS]);
  for (;;) {
    const result = await db.query(`WITH progress AS MATERIALIZED (
      SELECT watermark FROM usage_hourly_progress WHERE source_kind = $1 FOR UPDATE
    ), page AS MATERIALIZED (
      SELECT q.id, q.session_id, q.dispatch_id, q.metadata FROM engine_queue_items q
      WHERE q.id > (SELECT watermark FROM progress) ORDER BY q.id LIMIT ${PAGE_ITEMS}
    ), targets AS (
      -- A text match, never a jsonb cast: metadata copies prompt arguments.
      SELECT id, session_id FROM page WHERE session_id NOT LIKE 'wf:%'
        AND (dispatch_id LIKE 'workflow:%' OR (dispatch_id IS NULL AND metadata LIKE '%"promotedFromItemId"%'))
    ), moved AS (
      UPDATE usage_entry_facts f SET session_id = n.session_id, workflow_run_id = n.workflow_run_id
      FROM targets t JOIN engine_entries e ON e.queue_item_id = t.id AND e.session_id = t.session_id
      CROSS JOIN LATERAL valet_usage_fact(e) n
      WHERE f.entry_id = e.id AND f.session_id IS DISTINCT FROM n.session_id
    ), advanced AS (
      UPDATE usage_hourly_progress SET watermark = (SELECT MAX(id) FROM page)
      WHERE source_kind = $1 AND EXISTS (SELECT 1 FROM page) RETURNING watermark
    ) SELECT watermark FROM advanced`, [PROGRESS]);
    if (typeof result.rows[0]?.watermark !== "string") break;
  }
}
