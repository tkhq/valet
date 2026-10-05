import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { pgDbFromPglite } from '@valet/store-postgres';
import { applyAppMigrations, missingSchemaRepairs } from '../src/lib/drizzle.js';
// Only Git schema text and synthetic records enter this disposable database.
// DATABASE_URL, credentials, live integrations and application boot are never used.
const baseline = process.argv[2];
if (!baseline || !/^[0-9a-f]{7,40}$/.test(baseline)) throw new Error('Pass an existing baseline Git commit SHA.');
const root = fileURLToPath(new URL('../../../', import.meta.url));
const revision = execFileSync('git', ['rev-parse', '--verify', `${baseline}^{commit}`], { cwd: root, encoding: 'utf8' }).trim();
const pg = new PGlite();
const db = pgDbFromPglite(pg);
try {
 const target = revision;
 for (const path of ['packages/store-postgres/migrations/pg/0000_engine.sql', 'packages/api/migrations/pg/0000_app.sql']) {
  const source = execFileSync('git', ['show', `${revision}:${path}`], { cwd: root, encoding: 'utf8' });
  for (const sql of source.split(/-->\s*statement-breakpoint/).map(x => x.trim()).filter(Boolean)) await db.query(sql);
 }
 for (const kind of ['engine','app']) {
  await db.query(`CREATE TABLE __valet_${kind}_migrations(filename text primary key, applied_at bigint not null)`);
  await db.query(`INSERT INTO __valet_${kind}_migrations VALUES($1,1)`,[`0000_${kind}.sql`]);
 }
 await db.query(`INSERT INTO orgs(id,name,created_at) VALUES('rehearsal-org','Synthetic',1)`);
 await db.query(`INSERT INTO "user"(id,name,email) VALUES('rehearsal-user','Synthetic','rehearsal@example.invalid')`);
 await db.query(`INSERT INTO teams(id,org_id,name,created_at) VALUES('rehearsal-team','rehearsal-org','Synthetic',1)`);
 await db.query(`INSERT INTO assistants(id,org_id,owner_type,owner_id,session_id,created_at) VALUES('rehearsal-assistant','rehearsal-org','team','rehearsal-team','rehearsal-session',1)`);
 await db.query(`INSERT INTO agent_sessions(id,user_id,org_id,workspace,owner_type,owner_id,created_at,updated_at) VALUES('rehearsal-session','rehearsal-user','rehearsal-org','/synthetic','team','rehearsal-team',1,1)`);
 await db.query(`INSERT INTO engine_threads(id,session_id,key,status,queue_mode,created_at,updated_at) VALUES('rehearsal-thread','rehearsal-session','web:private','idle','followup',1,1)`);
 await db.query(`INSERT INTO engine_entries(id,session_id,thread_id,entry_type,role,content,created_at) VALUES('rehearsal-entry','rehearsal-session','rehearsal-thread','message','user','preserve transcript marker',1)`);
 const definition = JSON.stringify({version:'dag/v1',nodes:[],edges:[]});
 await db.query(`INSERT INTO workflow_definitions(id,org_id,owner_type,owner_id,name,definition,created_at,updated_at) VALUES('rehearsal-workflow','rehearsal-org','team','rehearsal-team','Synthetic',$1,1,1)`,[definition]);
 await db.query(`INSERT INTO workflow_versions(id,workflow_id,version,name,definition,created_at) VALUES('rehearsal-version','rehearsal-workflow',1,'Synthetic',$1,1)`,[definition]);
 await db.query(`INSERT INTO workflow_runs(id,workflow_id,definition_version_id,definition,params,status,created_at,updated_at) VALUES('rehearsal-run','rehearsal-workflow','rehearsal-version',$1,'{}','settled',1,1)`,[definition]);
 await db.query(`INSERT INTO memory_files(owner_type,owner_id,path,content,created_at,updated_at) VALUES('team','rehearsal-team','marker.md','preserve memory marker',1,1)`);
 const tables=['assistants','agent_sessions','engine_threads','engine_entries','workflow_definitions','workflow_versions','workflow_runs'];
 const before: Record<string, Record<string, unknown>[]> = Object.fromEntries(await Promise.all(tables.map(async table=>[table,(await db.query(`SELECT * FROM ${table} ORDER BY id`)).rows])));
 const backup = await pg.dumpDataDir();
 await applyAppMigrations(db);
 assert.deepEqual(await missingSchemaRepairs(db),[]);
 for (const table of tables) {
  const after=(await db.query(`SELECT * FROM ${table} ORDER BY id`)).rows;
  assert.deepEqual(after.map(x=>x.id),before[table].map(x=>x.id),`${target} ${table} IDs retained`);
  if(['workflow_definitions','workflow_versions','workflow_runs','engine_entries'].includes(table)) assert.deepEqual(after,before[table],`${target} ${table} content preserved`);
 }
 const memory=(await db.query(`SELECT namespace,content FROM memory_files WHERE owner_id='rehearsal-team'`)).rows;
 assert.deepEqual(memory,[{namespace:'legacy',content:'preserve memory marker'}]);
 const snapshot=async()=>Object.fromEntries(await Promise.all([...tables,'memory_files'].map(async table=>[table,(await db.query(`SELECT * FROM ${table}`)).rows])));
 const first=await snapshot(); await applyAppMigrations(db); assert.deepEqual(await snapshot(),first,'second boot idempotent');
 const restored = new PGlite({ loadDataDir: backup });
 try {
  for (const table of tables) assert.deepEqual((await restored.query(`SELECT * FROM ${table} ORDER BY id`)).rows, before[table], `${table} backup restored`);
  assert.equal((await restored.query<{ content: string }>(`SELECT content FROM memory_files WHERE owner_id='rehearsal-team'`)).rows[0]?.content, 'preserve memory marker');
 } finally { await restored.close(); }
 console.log(JSON.stringify({target,result:'PASS',baseline:'repository schema, SYNTHETIC DATA',retainedTables:tables,memory:'content retained in legacy namespace',secondBoot:'idempotent',backupRestore:'PASS'}));
} finally { await db.close(); }

