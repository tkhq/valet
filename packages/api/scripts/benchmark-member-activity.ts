/** Benchmark member session-days on a disposable local PostgreSQL database.
 * Set MEMBER_BENCH_URL to a fresh database named usage_rollup_bench_member.
 * This script does not read DATABASE_URL. */
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { pgDbFromPool } from '@valet/store-postgres';
import { applyAppMigrations } from '../src/lib/drizzle.js';
import { getMemberAgentDays } from '../src/services/usage-member-activity.js';
import * as schema from '../src/schema/index.js';
const uri = process.env.MEMBER_BENCH_URL;
if (!uri) throw new Error('Set MEMBER_BENCH_URL to an empty disposable local PostgreSQL database.');
const address = new URL(uri);
if (!['127.0.0.1', 'localhost'].includes(address.hostname) || address.pathname !== '/usage_rollup_bench_member') {
  throw new Error('Use a local database named usage_rollup_bench_member.');
}
const pool = new pg.Pool({ connectionString: uri, max: 12 });
const db = drizzle(pool, { schema, casing: 'snake_case' });
const emit = (event: Record<string, unknown>) => console.log(JSON.stringify(event));
const HOUR = 3600000;
const scope = { scope: 'team' as const, orgId: 'member-o', teamId: 'member-t', byMember: true };
const normalize = (rows: { actor_id: string | null; agent_days: unknown }[]) => rows.map(r => [r.actor_id, Number(r.agent_days)]).sort();
async function measure(rows: number) {
  await pool.query('ANALYZE engine_entries; ANALYZE usage_member_facts; ANALYZE usage_member_hourly; ANALYZE agent_sessions');
  for (const [label, startMs, endMs] of [['aligned', 0, HOUR * 48], ['partial', HOUR + 1, HOUR * 47 + 1]] as const) {
    const period = { startMs, endMs, kind: 'lookback' as const, label };
    let start = performance.now();
    const raw = await pool.query(`WITH active AS (
      SELECT floor(e.created_at::numeric/86400000) AS day,e.session_id,
        COALESCE(NULLIF(q.author::jsonb->>'id',''),s.user_id) AS actor_id
      FROM engine_entries e JOIN agent_sessions s ON s.id=e.session_id
      LEFT JOIN engine_queue_items q ON q.id=e.queue_item_id AND q.session_id=e.session_id
      WHERE e.created_at >= $1 AND e.created_at < $2 AND e.usage IS NOT NULL
        AND COALESCE((e.usage::jsonb->>'total')::bigint,0)>0
        AND s.org_id='member-o' AND s.owner_type='team' AND s.owner_id='member-t'
    ), daily AS (SELECT actor_id,day,COUNT(DISTINCT session_id) AS n FROM active GROUP BY 1,2)
    SELECT actor_id,SUM(n) AS agent_days FROM daily GROUP BY actor_id`, [startMs, endMs]);
    const rawMs = performance.now() - start;
    start = performance.now();
    const result = await getMemberAgentDays(db, scope, period);
    const summaryMs = performance.now() - start;
    if (JSON.stringify(normalize(result)) !== JSON.stringify(normalize(raw.rows))) throw new Error('Member activity differs from raw entries.');
    start = performance.now();
    await Promise.all(Array.from({ length: 10 }, () => getMemberAgentDays(db, scope, period)));
    emit({ event: 'member-query', rows, label, rawMs, summaryMs, concurrent10Ms: performance.now() - start, result: normalize(result) });
  }
}
try {
  await applyAppMigrations(pgDbFromPool(pool));
  await pool.query(`INSERT INTO agent_sessions(id,org_id,user_id,workspace,status,owner_type,owner_id,created_at,updated_at)
    SELECT 'member-s'||i,'member-o','owner','/w','active','team','member-t',0,0 FROM generate_series(0,99) i`);
  await pool.query(`INSERT INTO engine_queue_items(id,session_id,thread_id,status,content,author,attempt_count,max_attempts,timeout_at,created_at,updated_at)
    SELECT 'member-q'||i,'member-s'||(i%100),'th','pending','',json_build_object('id','actor'||(i/100))::text,0,1,0,0,0
    FROM generate_series(0,499) i`);
  for (const [from, to] of [[0, 100000], [100000, 1000000]]) {
    const start = performance.now();
    for (let first = from; first < to; first += 10000) {
      await pool.query(`INSERT INTO engine_entries(id,session_id,thread_id,entry_type,role,queue_item_id,usage,cost,created_at)
        SELECT 'member-e'||i,'member-s'||(i%100),'th','message','assistant','member-q'||(i%500),
          '{"total":1}','{"total":0.001}',((i/500)%48)*3600000::bigint
        FROM generate_series($1::int,$2::int) i`, [first, first + 9999]);
    }
    emit({ event: 'member-seed', rows: to, elapsedMs: performance.now() - start,
      summary: (await pool.query('SELECT count(*)::int AS rows,sum(positive_turns)::int AS turns FROM usage_member_hourly')).rows[0] });
    await measure(to);
  }
  const writer = await pool.connect();
  const follower = await pool.connect();
  try {
    await writer.query('BEGIN');
    await writer.query(`UPDATE engine_queue_items SET author='{"id":"corrected"}' WHERE id='member-q0'`);
    const insert = follower.query(`INSERT INTO engine_entries(id,session_id,thread_id,entry_type,queue_item_id,usage,created_at)
      VALUES ('concurrent','member-s0','th','message','member-q0','{"total":1}',0)`);
    await new Promise(resolve => setTimeout(resolve, 100));
    await writer.query('COMMIT');
    await insert;
    const result = await follower.query(`SELECT actor_id FROM usage_member_facts WHERE entry_id='concurrent'`);
    if (result.rows[0]?.actor_id !== 'corrected') throw new Error('Concurrent insert used a stale queue author.');
    await writer.query('BEGIN');
    await writer.query(`UPDATE engine_entries SET created_at=1 WHERE id='concurrent'`);
    const update = follower.query(`UPDATE engine_queue_items SET author='{"id":"final"}' WHERE id='member-q0'`);
    await new Promise(resolve => setTimeout(resolve, 100));
    await writer.query('COMMIT');
    await update;
    const final = await follower.query(`SELECT actor_id FROM usage_member_facts WHERE entry_id='concurrent'`);
    if (final.rows[0]?.actor_id !== 'final') throw new Error('Concurrent queue correction lost entry attribution.');
    emit({ event: 'member-concurrent-writes', passed: true });
  } finally { await writer.query('ROLLBACK'); writer.release(); follower.release(); }
} finally { await pool.end(); }
