import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { pgDbFromPglite, type PgDb } from "@valet/store-postgres";
import { afterEach, expect, it } from "vitest";
import { prepareUsageAnalytics } from "../lib/usage-analytics-migration.js";
import { applyAppMigrations, missingSchemaRepairs } from "../lib/drizzle.js";

let db: PgDb | undefined;
afterEach(async () => { await db?.close(); });
async function setup() {
  db = pgDbFromPglite(new PGlite());
  await applyAppMigrations(db);
  return db;
}
const parts = JSON.stringify([
  { type: "text", text: "large output\u0000" },
  { type: "tool_call", toolName: "bash", status: "completed", result: { details: { outcome: { kind: "pull_request_created" } } } },
  { type: "tool_call", toolName: "call_tool", status: "error" },
  { type: "tool_call", toolName: "bash", status: "running" },
]);
async function insert(db: PgDb) {
  await db.query(`INSERT INTO engine_entries (id,session_id,thread_id,entry_type,role,parts,usage,cost,created_at)
    VALUES ('fact-entry','session','th','message','assistant',$1,'{"total":12}','{"total":0.5}',100)`, [parts]);
}
it("updates compact facts in the source transaction and cascades deletes", async () => {
  const db = await setup();
  await insert(db);
  const fact = () => db.query('SELECT * FROM usage_entry_facts');
  expect((await fact()).rows[0]).toMatchObject({ tool_calls: 2, pull_requests: 1, reviews: 0, usage: { total: 12 }, cost: { total: 0.5 } });
  await db.query(`UPDATE engine_entries SET parts='[]', usage=NULL, cost=NULL WHERE id='fact-entry'`);
  expect((await fact()).rows[0]).toMatchObject({ tool_calls: 0, pull_requests: 0, usage: null, cost: null });
  await db.query(`DELETE FROM engine_entries WHERE id='fact-entry'`);
  expect((await fact()).rows).toEqual([]);
});
it("backfills an existing database once and installs time indexes", async () => {
  const db = await setup();
  await db.query('DROP TRIGGER engine_entries_usage_fact ON engine_entries');
  await db.query('DROP TABLE usage_entry_facts CASCADE');
  const legacyView = readFileSync(new URL('../../migrations/pg/0000_app.sql', import.meta.url), 'utf8')
    .split(/-->\s*statement-breakpoint/).find((s) => s.includes('CREATE VIEW "cost_entries" AS'));
  if (!legacyView) throw new Error('Missing legacy view fixture');
  await db.query(legacyView);
  await insert(db);
  await applyAppMigrations(db);
  expect((await db.query('SELECT tool_calls FROM usage_entry_facts')).rows).toEqual([{ tool_calls: 2 }]);
  expect(await missingSchemaRepairs(db)).toEqual([]);
  const indexes = await db.query(`SELECT indexname FROM pg_indexes WHERE indexname IN
    ('action_invocations_usage_time','skill_context_attributions_window','usage_entry_facts_window')`);
  expect(indexes.rows).toHaveLength(3);
  await applyAppMigrations(db);
  expect((await db.query('SELECT COUNT(*)::int AS n FROM usage_entry_facts')).rows).toEqual([{ n: 1 }]);
});

it("resumes interrupted batches while source updates continue through the trigger", async () => {
  const db = await setup();
  await db.query('DROP TRIGGER engine_entries_usage_fact ON engine_entries');
  await db.query('DROP TABLE usage_entry_facts CASCADE');
  await db.query(`INSERT INTO engine_entries (id,session_id,thread_id,entry_type,role,parts,created_at)
    SELECT 'batch-' || lpad(i::text,4,'0'),'session','th','message','assistant','[]',100
    FROM generate_series(1,1200) i`);
  let batches = 0;
  const interrupted: PgDb = {
    ...db,
    async query(text, params) {
      if (text.startsWith('WITH batch') && ++batches === 2) throw new Error('Interrupted upgrade');
      return db.query(text, params);
    },
  };
  await expect(prepareUsageAnalytics(interrupted)).rejects.toThrow('Interrupted upgrade');
  expect((await db.query('SELECT COUNT(*)::int AS n FROM usage_entry_facts')).rows).toEqual([{ n: 500 }]);
  await db.query(`UPDATE engine_entries SET parts=$1 WHERE id='batch-1100'`, [parts]);
  await db.query(`DELETE FROM engine_entries WHERE id='batch-0001'`);
  await applyAppMigrations(db);
  expect((await db.query('SELECT COUNT(*)::int AS n FROM usage_entry_facts')).rows).toEqual([{ n: 1199 }]);
  expect((await db.query("SELECT tool_calls FROM usage_entry_facts WHERE entry_id='batch-1100'")).rows).toEqual([{ tool_calls: 2 }]);
  const plan = await db.query(`EXPLAIN (FORMAT JSON) SELECT entry_id FROM usage_entry_facts
    WHERE created_at >= 0 AND created_at < 200 AND (pull_requests > 0 OR reviews > 0)`);
  expect(JSON.stringify(plan.rows)).toContain('usage_entry_facts_outcomes_window');
});
it("resolves ownership changes and workflow fallback without rebuilding facts", async () => {
  const db = await setup();
  await db.query(`INSERT INTO agent_sessions (id,org_id,user_id,workspace,status,owner_type,owner_id,created_at,updated_at)
    VALUES ('session','org-a','user-a','/w','active','user','user-a',100,100)`);
  await insert(db);
  const owner = () => db.query("SELECT org_id,user_id,owner_type,owner_id FROM cost_entries WHERE entry_id='fact-entry'");
  expect((await owner()).rows).toEqual([{ org_id: 'org-a', user_id: 'user-a', owner_type: 'user', owner_id: 'user-a' }]);
  await db.query(`UPDATE agent_sessions SET org_id='org-b',user_id='user-b',owner_type='team',owner_id='team-b' WHERE id='session'`);
  expect((await owner()).rows).toEqual([{ org_id: 'org-b', user_id: 'user-b', owner_type: 'team', owner_id: 'team-b' }]);
  await db.query(`INSERT INTO workflow_definitions (id,org_id,owner_type,owner_id,name,definition,created_at,updated_at)
    VALUES ('def','org-c','user','user-c','Workflow','{}',100,100)`);
  await db.query(`INSERT INTO workflow_runs (id,workflow_id,definition_version_id,definition,params,owner_type,owner_id,created_at,updated_at)
    VALUES ('run','def','v1','{}','{}','user','user-c',100,100)`);
  await db.query(`UPDATE engine_entries SET session_id='wf:run:node' WHERE id='fact-entry'`);
  expect((await owner()).rows).toEqual([{ org_id: 'org-c', user_id: 'user-c', owner_type: 'user', owner_id: 'user-c' }]);
  await db.query(`INSERT INTO agent_sessions (id,org_id,user_id,workspace,status,owner_type,owner_id,created_at,updated_at)
    VALUES ('wf:run:node','org-a','user-a','/w','active','user','user-a',100,100)`);
  expect((await owner()).rows[0].org_id).toBe('org-a');
  await db.query(`DELETE FROM agent_sessions WHERE id='wf:run:node'`);
  expect((await owner()).rows[0].org_id).toBe('org-c');
  await db.query(`DELETE FROM workflow_runs WHERE id='run'`);
  expect((await owner()).rows).toEqual([]);
});
