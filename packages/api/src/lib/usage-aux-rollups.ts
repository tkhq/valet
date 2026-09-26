import { assertCompleteUsageProjection } from "./usage-rollup-state.js";
import { readFileSync } from 'node:fs';
import type { PgDb } from '@valet/store-postgres';

const migration = readFileSync(new URL('../../migrations/pg/0000_app.sql', import.meta.url), 'utf8');
const install = migration.split('-- usage auxiliary install\n')[1]?.split('-- usage auxiliary end')[0];
if (!install) throw new Error('Usage rollup migration missing. Restore 0000_app.sql from the release.');
export const AUX_USAGE_ROLLUP_SQL = `DO $aux_install$ BEGIN ${install} END $aux_install$;`;
export const AUX_USAGE_PUBLISH_SQL = `DO $publish$ BEGIN CREATE OR REPLACE VIEW usage_aux_rollups_ready AS SELECT 1 AS version
  FROM usage_action_facts, usage_action_hourly, usage_skill_facts, usage_skill_hourly,
    usage_skill_request_memberships, usage_skill_requests WHERE false; ANALYZE usage_action_facts; ANALYZE usage_action_hourly; ANALYZE usage_skill_facts; ANALYZE usage_skill_hourly; ANALYZE usage_skill_request_memberships; ANALYZE usage_skill_requests; END $publish$`;

export async function prepareAuxUsageRollups(db: PgDb): Promise<void> {
  await assertCompleteUsageProjection(db, ["usage_action_facts", "usage_action_hourly", "usage_skill_facts", "usage_skill_hourly", "usage_skill_request_memberships", "usage_skill_requests"]);
  await db.transaction(async tx => {
    await tx.query("SET LOCAL lock_timeout = '5s'");
    await tx.query('LOCK TABLE action_invocations, skill_invocations, skill_context_attributions IN SHARE ROW EXCLUSIVE MODE');
    await tx.query(AUX_USAGE_ROLLUP_SQL);
  });
  await backfillAuxUsageRollups(db);
}


/** Install within the short schema-lock transaction, then backfill outside it. */
export async function backfillAuxUsageRollups(db: PgDb): Promise<void> {
  let after = '';
  for (;;) {
    const result = await db.query(`WITH batch AS MATERIALIZED (
      SELECT a FROM action_invocations a WHERE invocation_id > $1
        AND NOT EXISTS (SELECT 1 FROM usage_action_facts f WHERE f.invocation_id=a.invocation_id)
      ORDER BY invocation_id LIMIT 500 FOR KEY SHARE
    ), inserted AS (INSERT INTO usage_action_facts SELECT f.* FROM batch CROSS JOIN LATERAL valet_action_fact(a) f
      ON CONFLICT DO NOTHING)
    SELECT (a).invocation_id AS id FROM batch ORDER BY (a).invocation_id DESC LIMIT 1`,[after]);
    if (!result.rows[0]) break;
    const next = result.rows[0].id;
    if (typeof next !== 'string') throw new Error('Usage backfill cursor is invalid. Restart the API to retry.');
    after = next;
  }
  after = '';
  for (;;) {
    const result = await db.query(`WITH batch AS MATERIALIZED (
      SELECT i FROM skill_invocations i WHERE id > $1
        AND NOT EXISTS (SELECT 1 FROM usage_skill_facts f WHERE f.fact_key=jsonb_build_array(i.id)::text)
      ORDER BY id LIMIT 500 FOR KEY SHARE
    ), inserted AS (INSERT INTO usage_skill_facts SELECT f.* FROM batch CROSS JOIN LATERAL valet_skill_invocation_fact(i) f
      ON CONFLICT DO NOTHING)
    SELECT (i).id FROM batch ORDER BY (i).id DESC LIMIT 1`,[after]);
    if (!result.rows[0]) break;
    const next = result.rows[0].id;
    if (typeof next !== 'string') throw new Error('Usage backfill cursor is invalid. Restart the API to retry.');
    after = next;
  }
  let requestAfter = '';
  after = '';
  for (;;) {
    const result = await db.query(`WITH batch AS MATERIALIZED (
      SELECT c,i FROM skill_context_attributions c JOIN skill_invocations i ON i.id=c.skill_invocation_id
      WHERE (c.skill_invocation_id,c.llm_request_id) > ($1,$2)
        AND NOT EXISTS (SELECT 1 FROM usage_skill_facts f WHERE f.fact_key=jsonb_build_array(c.skill_invocation_id,c.llm_request_id)::text)
      ORDER BY c.skill_invocation_id,c.llm_request_id LIMIT 500 FOR KEY SHARE
    ), inserted AS (INSERT INTO usage_skill_facts
      SELECT f.* FROM batch CROSS JOIN LATERAL valet_skill_context_fact(c,i) f
      ON CONFLICT DO NOTHING)
    SELECT (c).skill_invocation_id AS id,(c).llm_request_id AS request FROM batch
      ORDER BY (c).skill_invocation_id DESC,(c).llm_request_id DESC LIMIT 1`,[after,requestAfter]);
    if (!result.rows[0]) break;
    const next = result.rows[0].id;
    if (typeof next !== 'string') throw new Error('Usage backfill cursor is invalid. Restart the API to retry.');
    after = next;
    const request = result.rows[0].request;
    if (typeof request !== 'string') throw new Error('Usage backfill request cursor is invalid. Restart the API to retry.');
    requestAfter = request;
  }
}
