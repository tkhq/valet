/** Tiny write/backfill races. Set ROLLUP_CHECK_URL to a disposable loopback database. */
import assert from 'node:assert/strict';
import pg from 'pg';
import { pgDbFromPool, type PgDb } from '@valet/store-postgres';
import { applyAppMigrations } from '../src/lib/drizzle.js';
import { prepareUsageHourly } from '../src/lib/usage-hourly-migration.js';
const uri = process.env.ROLLUP_CHECK_URL;
if (!uri) throw new Error('Set ROLLUP_CHECK_URL to the disposable local race-test database.');
const url = new URL(uri);
if (!['127.0.0.1', 'localhost'].includes(url.hostname) || url.pathname !== '/usage_rollup_bench_member_races') throw new Error('Use local database usage_rollup_bench_member_races.');
const pool = new pg.Pool({ connectionString: uri, max: 5 });
const raw = pgDbFromPool(pool);
const a = await pool.connect(); const b = await pool.connect();
const wait = () => new Promise(resolve => setTimeout(resolve, 100));
const serialization = (error: unknown) => error instanceof pg.DatabaseError && error.code === '40001';
async function seedUnaccounted() {
  await pool.query(`DELETE FROM engine_entries; UPDATE usage_hourly_progress SET watermark='';`);
  await pool.query(`INSERT INTO engine_entries(id,session_id,thread_id,entry_type,usage,cost,created_at)
    VALUES ('e','s','th','message','{"total":10}','{"total":1}',0)`);
  await pool.query(`ALTER TABLE usage_entry_facts DISABLE TRIGGER USER;
    UPDATE usage_entry_facts SET hourly_accounted=false; TRUNCATE usage_hourly;
    ALTER TABLE usage_entry_facts ENABLE TRIGGER USER;`);
}
async function tokens() { return Number((await pool.query(`SELECT COALESCE(SUM(total_tokens),0) AS n FROM usage_hourly`)).rows[0].n); }
// Schema is already installed. Skip only DDL so a held snapshot does not block ALTER TABLE.
// Every backfill statement below is the production query, through real PostgreSQL clients.
function backfillDb(client?: pg.PoolClient): PgDb {
  return {
    query: client ? async (query, values) => {
      const result = await client.query(query, values);
      return { rows: result.rows, rowCount: result.rowCount ?? 0 };
    } : raw.query,
    transaction: async operation => operation({ query: async () => ({ rows: [], rowCount: 0 }) }),
    close: async () => {},
  };
}

try {
  await applyAppMigrations(raw);
  await pool.query(`INSERT INTO agent_sessions(id,org_id,user_id,workspace,status,owner_type,owner_id,created_at,updated_at)
    VALUES ('s','o','owner','/w','active','team','t',0,0)`);
  await seedUnaccounted();
  await a.query('BEGIN');
  await prepareUsageHourly(backfillDb(a));
  const updateAfter = b.query(`UPDATE engine_entries SET usage='{"total":20}' WHERE id='e'`);
  await wait(); await a.query('COMMIT'); await updateAfter;
  assert.equal(await tokens(), 20);
  console.log('PASS: RC update waiting for backfill subtracts committed contribution');
  await seedUnaccounted();
  await a.query('BEGIN');
  await a.query(`UPDATE engine_entries SET usage='{"total":30}' WHERE id='e'`);
  const backfillAfter = prepareUsageHourly(backfillDb());
  await wait(); await a.query('COMMIT'); await backfillAfter;
  assert.equal(await tokens(), 30);
  console.log('PASS: backfill after live correction skips accounted row');
  await seedUnaccounted();
  await a.query('BEGIN');
  await prepareUsageHourly(backfillDb(a));
  const deleteAfter = b.query(`DELETE FROM engine_entries WHERE id='e'`);
  await wait(); await a.query('COMMIT'); await deleteAfter;
  assert.equal(await tokens(), 0);
  console.log('PASS: RC delete waiting for backfill removes committed contribution');
  for (const command of [`UPDATE engine_entries SET usage='{"total":99}' WHERE id='e'`, `DELETE FROM engine_entries WHERE id='e'`]) {
    await seedUnaccounted(); await a.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    await a.query('SELECT count(*) FROM usage_entry_facts');
    await b.query('BEGIN'); await prepareUsageHourly(backfillDb(b)); await b.query('COMMIT');
    await assert.rejects(a.query(command), serialization); await a.query('ROLLBACK');
    assert.equal(await tokens(), 10);
  }
  console.log('PASS: RR update/delete reject stale-watermark snapshots with 40001');
  await pool.query(`INSERT INTO engine_queue_items(id,session_id,thread_id,status,content,author,attempt_count,max_attempts,timeout_at,created_at,updated_at)
    VALUES ('q','s','th','pending','','{"id":"alice"}',0,1,0,0,0)`);
  await a.query('BEGIN'); await a.query(`UPDATE engine_queue_items SET author='{"id":"bob"}' WHERE id='q'`);
  const memberInsert = b.query(`INSERT INTO engine_entries(id,session_id,thread_id,entry_type,queue_item_id,usage,created_at)
    VALUES ('member','s','th','message','q','{"total":1}',0)`);
  await wait(); await a.query('COMMIT'); await memberInsert;
  assert.equal((await pool.query(`SELECT actor_id FROM usage_member_facts WHERE entry_id='member'`)).rows[0].actor_id, 'bob');
  await a.query('BEGIN'); await a.query(`UPDATE engine_entries SET created_at=1 WHERE id='member'`);
  const memberCorrection = b.query(`UPDATE engine_queue_items SET author='{"id":"carol"}' WHERE id='q'`);
  await wait(); await a.query('COMMIT'); await memberCorrection;
  assert.equal((await pool.query(`SELECT actor_id FROM usage_member_facts WHERE entry_id='member'`)).rows[0].actor_id, 'carol');
  await a.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
  await assert.rejects(a.query(`UPDATE engine_entries SET created_at=2 WHERE id='member'`), serialization);
  await a.query('ROLLBACK');
  console.log('PASS: member attribution serializes both orders and rejects RR');
} finally { await a.query('ROLLBACK'); await b.query('ROLLBACK'); a.release(); b.release(); await pool.end(); }
