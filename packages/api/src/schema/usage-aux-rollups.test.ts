import { PGlite } from '@electric-sql/pglite';
import { pgDbFromPglite, type PgDb, type PgQueryable } from '@valet/store-postgres';
import { drizzle } from 'drizzle-orm/pglite';
import { afterEach,expect,it } from 'vitest';
import { applyAppMigrations } from '../lib/drizzle.js';
import { AUX_USAGE_ROLLUP_SQL,backfillAuxUsageRollups } from '../lib/usage-aux-rollups.js';
import { getActionToolCalls,getActionOutcomes,getSkillBreakdown } from '../services/usage-aux-rollups.js';
import * as schema from './index.js';
let db: PgDb | undefined;
afterEach(async()=> { await db?.close(); });
const H=3_600_000;
async function setup() {
  const pg=new PGlite(); db=pgDbFromPglite(pg); await applyAppMigrations(db); await db.query(AUX_USAGE_ROLLUP_SQL);
  await db.query(`INSERT INTO orgs (id,name,created_at) VALUES ('o','O',0)`);
  await db.query(`INSERT INTO "user" (id,name,email) VALUES ('u','U','u@x')`);
  await db.query(`INSERT INTO agent_sessions (id,org_id,user_id,owner_type,owner_id,workspace,title,created_at,updated_at)
    VALUES ('s','o','u','user','u','w','S',0,0),('s2','o','u','user','u','w','S2',0,0)`);
  return {db,app:drizzle(pg,{schema})};
}
const period={startMs:0,endMs:4*H,label:'test',kind:'custom' as const};
const scope={scope:'org' as const,orgId:'o'};
async function invocation(db:PgQueryable,id:string,session='s',at=H) {
 await db.query(`INSERT INTO skill_invocations (id,created_at,org_id,session_id,thread_id,path,skill_key,skill_name,origin,content_sha,injected_characters,estimated_body_tokens,invoker_user_id)
 VALUES ($1,$2,'o',$3,'t','p','key','Skill','local','sha',10,5,'u')`,[id,at,session]);
}
async function context(db:PgQueryable,id:string,request:string,at:number,tokens=10) {
 await db.query(`INSERT INTO skill_context_attributions VALUES ($1,$2,'s','t',$3,$4)`,[id,request,at,tokens]);
}
it('counts exact skill requests across sessions, hours, and partial boundaries',async()=>{
 const {db,app}=await setup();
 await invocation(db,'i'); await invocation(db,'j','s2');
 await context(db,'i','same',H+10); await context(db,'j','same',2*H+10);
 await context(db,'i','other',3*H+10);
 expect(await getSkillBreakdown(app,period,scope)).toEqual([{skillKey:'key',name:'Skill',origin:'local',invocations:2,uniqueInvokers:1,unassignedInvocations:0,attributedContextTokens:30,carryingCalls:2}]);
 expect((await getSkillBreakdown(app,{...period,startMs:H+5,endMs:2*H+15},scope))[0]).toMatchObject({invocations:0,attributedContextTokens:20,carryingCalls:1});
 expect((await getSkillBreakdown(app,{...period,startMs:H+15,endMs:2*H+15},scope))[0]).toMatchObject({attributedContextTokens:10,carryingCalls:1});
 await db.query(`DELETE FROM skill_context_attributions WHERE skill_invocation_id='j'`);
 expect((await getSkillBreakdown(app,period,scope))[0]).toMatchObject({attributedContextTokens:20,carryingCalls:2});
 expect((await db.query(`SELECT * FROM usage_skill_requests WHERE memberships>1`)).rows).toEqual([]);
 await db.query(`UPDATE skill_invocations SET skill_name='Renamed' WHERE id='i'`);
 expect((await getSkillBreakdown(app,period,scope)).find(r=>r.name==='Renamed')).toMatchObject({attributedContextTokens:20,carryingCalls:2});
 await db.query(`DELETE FROM skill_invocations`);
 expect(await getSkillBreakdown(app,period,scope)).toEqual([]);
 expect((await db.query('SELECT * FROM usage_skill_request_memberships')).rows).toEqual([]);
});
it('counts settled actions and updates or removes outcomes transactionally',async()=>{
 const {db,app}=await setup();
 await db.query(`INSERT INTO action_invocations(invocation_id,created_at,org_id,session_id,service,action_id,status,duration_ms,result)
 VALUES ('a',$1,'o','s','github','github.create_pull_request','completed',5,'{"success":true}')`,[H+10]);
 expect(await getActionOutcomes(app,period,scope)).toEqual([{parent:'s:s',kind:'pull_request_created',count:'1'}]);
 expect(await getActionToolCalls(app,period,scope)).toBe(0);
 expect(await getActionOutcomes(app,{...period,startMs:H+11},scope)).toEqual([]);
 await db.query(`UPDATE action_invocations SET action_id='github.create_review',result='{"success":true,"data":{"state":"PENDING"}}'`);
 expect(await getActionOutcomes(app,period,scope)).toEqual([]);
 await db.query('DELETE FROM action_invocations');
 expect((await db.query('SELECT * FROM usage_action_hourly')).rows).toEqual([]);
});
it('backfills idempotently after source rows predate the triggers',async()=>{
 const {db,app}=await setup();
 await db.query('DROP TRIGGER skill_invocations_usage_fact ON skill_invocations');
 await db.query('DROP TRIGGER skill_context_usage_fact ON skill_context_attributions');
 await db.query('DROP TRIGGER action_invocations_usage_fact ON action_invocations');
 await invocation(db,'old'); await context(db,'old','request',H);
 await db.query(`INSERT INTO action_invocations(invocation_id,created_at,org_id,session_id,action_id,status,duration_ms,result)
 VALUES ('a',$1,'o','s','slack.dm_owner','completed',1,'{"success":true}')`,[H]);
 await db.query(AUX_USAGE_ROLLUP_SQL); await backfillAuxUsageRollups(db); await backfillAuxUsageRollups(db);
 expect((await getSkillBreakdown(app,period,scope))[0]).toMatchObject({invocations:1,attributedContextTokens:10,carryingCalls:1});
 expect(await getActionOutcomes(app,period,scope)).toEqual([{parent:'s:s',kind:'slack_dm_sent',count:'1'}]);
});
it('keeps same-hour request references exact and resolves current ownership',async()=>{
 const {db,app}=await setup();
 await invocation(db,'one','s',H); await invocation(db,'two','s',H+1);
 await context(db,'one','shared',H+10,7); await context(db,'two','shared',H+20,9);
 expect((await getSkillBreakdown(app,period,scope))[0]).toMatchObject({invocations:2,carryingCalls:1,attributedContextTokens:16});
 expect((await getSkillBreakdown(app,{...period,startMs:H+15,endMs:H+30},scope))[0]).toMatchObject({carryingCalls:1,attributedContextTokens:9});
 await db.query(`UPDATE skill_context_attributions SET created_at=$1,estimated_skill_tokens=11 WHERE skill_invocation_id='two'`,[2*H]);
 expect((await getSkillBreakdown(app,period,scope))[0]).toMatchObject({carryingCalls:1,attributedContextTokens:18});
 await db.query(`UPDATE agent_sessions SET owner_type='team',owner_id='team' WHERE id='s'`);
 const team={scope:'team' as const,orgId:'o',teamId:'team',byMember:true};
 expect((await getSkillBreakdown(app,period,team))[0]).toMatchObject({invocations:2,carryingCalls:1});
 expect(await getSkillBreakdown(app,period,{...team,teamId:'other'})).toEqual([]);
 await db.query(`UPDATE agent_sessions SET org_id='other' WHERE id='s'`);
 expect(await getSkillBreakdown(app,period,scope)).toEqual([]);
 expect((await getSkillBreakdown(app,period,{scope:'org',orgId:'other'}))[0]).toMatchObject({carryingCalls:1});
});
it('resumes a stopped backfill without losing corrected or deleted sources',async()=>{
 const {db}=await setup();
 await db.query('DROP TRIGGER action_invocations_usage_fact ON action_invocations');
 await db.query(`INSERT INTO action_invocations(invocation_id,created_at,org_id,session_id,action_id,status,duration_ms,result)
 SELECT 'a'||lpad(i::text,4,'0'),$1,'o','s','slack.dm_owner','completed',1,'{"success":true}'::jsonb FROM generate_series(1,1200)i`,[H]);
 await db.query(AUX_USAGE_ROLLUP_SQL);
 let batches=0;
 const interrupted:PgDb={...db,async query(text,params){
   if(text.startsWith('WITH batch') && ++batches===2) throw new Error('interrupted');
   return db.query(text,params);
 }};
 await expect(backfillAuxUsageRollups(interrupted)).rejects.toThrow('interrupted');
 await db.query(`UPDATE action_invocations SET status='error' WHERE invocation_id='a0001'`);
 await db.query(`DELETE FROM action_invocations WHERE invocation_id='a1100'`);
 await backfillAuxUsageRollups(db);
 expect((await db.query('SELECT SUM(outcomes)::int AS n FROM usage_action_hourly')).rows).toEqual([{n:1198}]);
 expect((await db.query('SELECT COUNT(*)::int AS n FROM usage_action_facts')).rows).toEqual([{n:1199}]);
});
it('aggregates bulk context and action writes once per hour without losing request counts',async()=>{
 const {db,app}=await setup(); await invocation(db,'bulk');
 await db.query(`INSERT INTO skill_context_attributions
 SELECT 'bulk','r'||i,'s','t',$1+i,3 FROM generate_series(1,10000)i`,[H]);
 await db.query(`INSERT INTO action_invocations(invocation_id,created_at,org_id,session_id,action_id,status,duration_ms,result)
 SELECT 'a'||i,$1+i,'o','s','slack.dm_owner','completed',1,'{"success":true}'::jsonb FROM generate_series(1,10000)i`,[H]);
 expect((await getSkillBreakdown(app,period,scope))[0]).toMatchObject({invocations:1,carryingCalls:10000,attributedContextTokens:30000});
 expect(await getActionOutcomes(app,period,scope)).toEqual([{parent:'s:s',kind:'slack_dm_sent',count:'10000'}]);
 await db.query(`UPDATE skill_context_attributions SET created_at=created_at+$1`,[H]);
 await db.query(`UPDATE action_invocations SET result='{"success":false}'`);
 expect((await getSkillBreakdown(app,period,scope))[0]).toMatchObject({carryingCalls:10000,attributedContextTokens:30000});
 expect(await getActionOutcomes(app,period,scope)).toEqual([]);
 await db.query('DELETE FROM skill_context_attributions');
 expect((await getSkillBreakdown(app,period,scope))[0]).toMatchObject({carryingCalls:0,attributedContextTokens:0});
 expect((await db.query('SELECT COUNT(*)::int n FROM usage_skill_requests')).rows).toEqual([{n:0}]);
},30000);
it('rejects stale transaction snapshots before related skill projections change',async()=>{
 const {db}=await setup();
 for(const isolation of ['REPEATABLE READ','SERIALIZABLE']) {
   await expect(db.transaction(async tx=>{
     await tx.query(`SET TRANSACTION ISOLATION LEVEL ${isolation}`);
     await invocation(tx,'isolated');
   })).rejects.toMatchObject({code:'40001',message:'Skill usage updates require READ COMMITTED isolation. Retry the transaction with READ COMMITTED isolation.'});
 }
 expect((await db.query('SELECT * FROM usage_skill_facts')).rows).toEqual([]);
 await invocation(db,'isolated');
 await expect(db.transaction(async tx=>{
   await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
   await context(tx,'isolated','r',H);
 })).rejects.toMatchObject({code:'40001'});
 await context(db,'isolated','r',H);
 expect((await db.query('SELECT SUM(tokens)::int AS tokens FROM usage_skill_hourly')).rows).toEqual([{tokens:10}]);
});
it('invalidates readiness if any auxiliary table is removed',async()=>{
 const {db}=await setup();
 for(const table of ['usage_action_facts','usage_action_hourly','usage_skill_facts','usage_skill_hourly','usage_skill_request_memberships','usage_skill_requests']) {
   const rollback=new Error('Rollback destructive fixture');
   await expect(db.transaction(async tx=>{
     await tx.query(`DROP TABLE ${table} CASCADE`);
     expect((await tx.query(`SELECT to_regclass('usage_aux_rollups_ready') AS ready`)).rows).toEqual([{ready:null}]);
     throw rollback;
   })).rejects.toBe(rollback);
 }
});
