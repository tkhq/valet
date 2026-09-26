import { assertCompleteUsageProjection } from "./usage-rollup-state.js";
import { readFileSync } from 'node:fs';
import type { PgDb } from '@valet/store-postgres';
const migration = readFileSync(new URL('../../migrations/pg/0000_app.sql', import.meta.url), 'utf8');
const install = migration.split('-- usage member install\n')[1]?.split('-- usage member install end')[0];
if (!install) throw new Error('Member activity migration missing. Restore 0000_app.sql from the release.');
export const MEMBER_ACTIVITY_INSTALL_SQL = `DO $member_install$ BEGIN ${install} END $member_install$;`;
export const MEMBER_ACTIVITY_PUBLISH_SQL = `DO $publish$ BEGIN CREATE OR REPLACE VIEW usage_member_activity_ready AS SELECT 1 AS version FROM usage_member_facts,usage_member_hourly WHERE false; ANALYZE usage_member_facts; ANALYZE usage_member_hourly; END $publish$`;

/** Install triggers while writers pause, then account retained entries in batches. */
export async function prepareMemberActivity(db: PgDb): Promise<void> {
  await assertCompleteUsageProjection(db, ["usage_member_facts", "usage_member_hourly"]);
  await db.transaction(async tx => {
    await tx.query("SET LOCAL lock_timeout='5s'");
    await tx.query('LOCK TABLE engine_entries,engine_queue_items IN SHARE ROW EXCLUSIVE MODE');
    await tx.query(MEMBER_ACTIVITY_INSTALL_SQL);
  });
  await backfillMemberActivity(db);
}

export async function backfillMemberActivity(db: PgDb): Promise<void> {
  let cursor = '';
  for (;;) {
    // Row locks keep entry corrections and deletes ordered against backfill.
    const result = await db.query('SELECT valet_member_backfill_batch($1,500) AS id', [cursor]);
    if (result.rows[0]?.id == null) break;
    const next = result.rows[result.rows.length - 1].id;
    if (typeof next !== 'string') throw new Error('Member activity cursor is invalid. Restart the API to retry.');
    cursor = next;
  }
}
