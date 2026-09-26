import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { pgDbFromPglite } from '@valet/store-postgres';
import { afterEach, expect, it } from 'vitest';
import { applyAppMigrations } from '../lib/drizzle.js';
import * as schema from './index.js';
let pg: PGlite;
afterEach(async () => { await pg?.close(); });
async function setup() {
  pg = new PGlite(); await applyAppMigrations(pgDbFromPglite(pg));
  await pg.query(`INSERT INTO agent_sessions(id,org_id,user_id,workspace,status,owner_type,owner_id,created_at,updated_at)
    VALUES ('s','o','owner','/w','active','team','t',0,0)`);
  return drizzle(pg, { schema, casing: 'snake_case' });
}
async function queue(id: string, author: string) {
  await pg.query(`INSERT INTO engine_queue_items(id,session_id,thread_id,status,content,author,attempt_count,max_attempts,timeout_at,created_at,updated_at)
    VALUES ($1,'s','th','pending','', $2,0,1,0,0,0)`, [id, JSON.stringify({ id: author })]);
}
it('compresses actors and preserves counts across queue, entry and time corrections', async () => {
  await setup();
  expect((await pg.query(`SELECT to_regclass('usage_member_hourly') IS NOT NULL AS installed`)).rows).toEqual([{ installed: true }]);
  await queue('q', 'alice');
  await pg.query(`INSERT INTO engine_entries(id,session_id,thread_id,entry_type,queue_item_id,usage,created_at)
    SELECT 'e'||i,'s','th','message','q','{"total":1}',3600001 FROM generate_series(1,100) i`);
  const counts = () => pg.query(`SELECT actor_id,created_at::float8 AS time,positive_turns::int AS n FROM usage_member_hourly ORDER BY actor_id,created_at`);
  expect((await counts()).rows).toEqual([{ actor_id: 'alice', time: 3600000, n: 100 }]);
  await pg.query(`UPDATE engine_queue_items SET author='{"id":"bob"}' WHERE id='q'`);
  expect((await counts()).rows).toEqual([{ actor_id: 'bob', time: 3600000, n: 100 }]);
  await pg.query(`UPDATE engine_entries SET created_at=7200000,queue_item_id=NULL WHERE id='e1'`);
  expect((await counts()).rows).toEqual([{ actor_id: '', time: 7200000, n: 1 }, { actor_id: 'bob', time: 3600000, n: 99 }]);
  await pg.query(`UPDATE engine_entries SET usage='{"total":0}' WHERE id='e1'`);
  await pg.query(`DELETE FROM engine_entries WHERE id='e2'`);
  await pg.query(`DELETE FROM engine_queue_items WHERE id='q'`);
  expect((await counts()).rows).toEqual([{ actor_id: '', time: 3600000, n: 98 }]);
  await queue('q', 'carol');
  expect((await counts()).rows).toEqual([{ actor_id: 'carol', time: 3600000, n: 98 }]);
});

it('counts exact session-days with current owners and assistant and child fallbacks', async () => {
  const db = await setup();
  const { getMemberAgentDays } = await import('../services/usage-member-activity.js');
  const period = { startMs: 3600001, endMs: 10800001, kind: 'lookback' as const, label: 'test' };
  const scope = { scope: 'team' as const, orgId: 'o', teamId: 't', byMember: true };
  await queue('q', 'alice');
  for (const [id, time, q] of [['before', 3600000, 'q'], ['first', 3600001, 'q'], ['middle', 7200000, null], ['last', 10800000, 'q'], ['after', 10800001, 'q']] as const) {
    await pg.query(`INSERT INTO engine_entries(id,session_id,thread_id,entry_type,queue_item_id,usage,created_at)
      VALUES ($1,'s','th','message',$2,'{"total":1}',$3)`, [id, q, time]);
  }
  const rows = async () => (await getMemberAgentDays(db, scope, period)).map(r => ({ actor: r.actor_id, days: Number(r.agent_days) })).sort((a,b)=>String(a.actor).localeCompare(String(b.actor)));
  expect(await rows()).toEqual([{ actor: 'alice', days: 1 }, { actor: 'owner', days: 1 }]);
  await pg.query(`UPDATE agent_sessions SET owner_id='other' WHERE id='s'`);
  expect(await rows()).toEqual([]);
  await pg.query(`UPDATE agent_sessions SET owner_id='t',user_id='changed' WHERE id='s'`);
  expect(await rows()).toEqual([{ actor: 'alice', days: 1 }, { actor: 'changed', days: 1 }]);
  await pg.query(`INSERT INTO assistants(id,org_id,owner_type,owner_id,session_id,created_at) VALUES ('a','o','team','t','s',0)`);
  expect(await rows()).toEqual([{ actor: 'alice', days: 1 }, { actor: null, days: 1 }]);
  await pg.query(`INSERT INTO child_watches(child_session_id,queue_item_id,parent_session_id,parent_thread_id,actor_user_id,org_id,created_at)
    VALUES ('s','q','parent','th','child-actor','o',0)`);
  expect(await rows()).toEqual([{ actor: 'alice', days: 1 }, { actor: 'child-actor', days: 1 }]);
  await pg.query(`UPDATE child_watches SET actor_user_id='new-child' WHERE child_session_id='s'`);
  expect(await rows()).toEqual([{ actor: 'alice', days: 1 }, { actor: 'new-child', days: 1 }]);
});

it('backfills retained entries in batches and resumes without counting writes twice', async () => {
  await setup();
  const { MEMBER_ACTIVITY_INSTALL_SQL, prepareMemberActivity } = await import('../lib/usage-member-activity.js');
  await pg.query('DROP TRIGGER engine_entries_member_insert ON engine_entries');
  await queue('q', 'alice');
  await pg.query(`INSERT INTO engine_entries(id,session_id,thread_id,entry_type,queue_item_id,usage,created_at)
    SELECT 'old'||i,'s','th','message','q','{"total":1}',3600000 FROM generate_series(1,1001) i`);
  await pg.exec(MEMBER_ACTIVITY_INSTALL_SQL);
  await pg.query(`SELECT valet_member_sync_entry(e) FROM engine_entries e WHERE id='old1'`);
  await pg.query(`UPDATE engine_entries SET usage='{"total":2}',created_at=7200000 WHERE id='old2'`);
  await pg.query(`DELETE FROM engine_entries WHERE id='old3'`);
  await pg.query(`UPDATE engine_queue_items SET author='{"id":"bob"}' WHERE id='q'`);
  await prepareMemberActivity(pgDbFromPglite(pg));
  const counts = () => pg.query(`SELECT actor_id,sum(positive_turns)::int AS n FROM usage_member_hourly GROUP BY actor_id`);
  expect((await counts()).rows).toEqual([{ actor_id: 'bob', n: 1000 }]);
  await prepareMemberActivity(pgDbFromPglite(pg));
  expect((await counts()).rows).toEqual([{ actor_id: 'bob', n: 1000 }]);
  expect((await pg.query(`SELECT count(*)::int AS n FROM usage_member_facts WHERE created_at=7200000`)).rows).toEqual([{ n: 1 }]);
});

it('keeps workflow ownership, queue session matching, and UTC session-day counts exact', async () => {
  const db = await setup();
  const { getMemberAgentDays } = await import('../services/usage-member-activity.js');
  await pg.query(`INSERT INTO workflow_definitions(id,org_id,owner_type,owner_id,name,definition,created_at,updated_at)
    VALUES ('w','o','team','t','Test','{}',0,0)`);
  await pg.query(`INSERT INTO workflow_runs(id,workflow_id,definition_version_id,definition,params,owner_type,owner_id,created_at,updated_at)
    VALUES ('r','w','v','{}','{}','team','t',0,0)`);
  await queue('q', 'alice');
  await pg.query(`INSERT INTO engine_entries(id,session_id,thread_id,entry_type,queue_item_id,usage,created_at)
    VALUES ('one','wf:r:step','th','message','q','{"total":1}',3600000),
      ('two','wf:r:step','th','message','q','{"total":1}',86400000)`);
  const rows = async () => (await getMemberAgentDays(db,
    { scope: 'team', orgId: 'o', teamId: 't', byMember: true },
    { startMs: 0, endMs: 86400001, kind: 'lookback', label: 'test' }))
    .map(r => ({ actor: r.actor_id, days: Number(r.agent_days) })).sort((a,b)=>String(a.actor).localeCompare(String(b.actor)));
  expect(await rows()).toEqual([{ actor: null, days: 2 }]);
  await pg.query(`UPDATE engine_queue_items SET session_id='wf:r:step' WHERE id='q'`);
  expect(await rows()).toEqual([{ actor: 'alice', days: 2 }]);
  await pg.query(`UPDATE engine_entries SET session_id='s' WHERE id='one'`);
  expect(await rows()).toEqual([{ actor: 'alice', days: 1 }, { actor: 'owner', days: 1 }]);
  await pg.query(`UPDATE workflow_runs SET owner_id='other' WHERE id='r'`);
  expect(await rows()).toEqual([{ actor: 'owner', days: 1 }]);
});

it('rejects snapshot-isolated queue attribution instead of retaining stale actors', async () => {
  await setup();
  await queue('q', 'alice');
  await pg.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
  try {
    await expect(pg.query(`INSERT INTO engine_entries(id,session_id,thread_id,entry_type,queue_item_id,usage,created_at)
      VALUES ('rr','s','th','message','q','{"total":1}',0)`)).rejects.toThrow('Retry member activity writes at READ COMMITTED isolation.');
  } finally { await pg.query('ROLLBACK'); }
  expect((await pg.query(`SELECT count(*)::int AS n FROM usage_member_facts WHERE entry_id='rr'`)).rows).toEqual([{ n: 0 }]);
});
