/** Disposable PostgreSQL read/backfill benchmark. This script never reads DATABASE_URL.
 * Set BENCH_DATABASE_URL to a new local database named usage_rollup_bench_<suffix>.
 * Run: pnpm --filter @valet/api exec node --import tsx scripts/benchmark-usage-scale.ts
 * BENCH_ROWS defaults to 10 million; BENCH_EXPLAIN=1 records measured query plans.
 * BENCH_PHASE=seed prepares the baseline; BENCH_PHASE=verify resumes its upgrade.
 * Source transcripts are omitted: this measures fact reads and summary backfill, not ingestion.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { applyEngineMigrations, pgDbFromPool, type PgDb } from '@valet/store-postgres';
import { applyAppMigrations } from '../src/lib/drizzle.js';
import * as schema from '../src/schema/index.js';
import * as current from '../src/services/usage.js';

const baselineCommit = '77f356e26029ca6bea35f9916eb61cd73d966fe3';
const uri = process.env.BENCH_DATABASE_URL;
if (!uri) throw new Error('Set BENCH_DATABASE_URL to an empty disposable local PostgreSQL database.');
const address = new URL(uri);
if (!['127.0.0.1', 'localhost', '[::1]'].includes(address.hostname) || address.search !== '' ||
    !/^\/usage_rollup_bench_[a-z0-9_]+$/.test(address.pathname)) {
  throw new Error('Use a loopback PostgreSQL database named usage_rollup_bench_<suffix>.');
}
const phase = process.env.BENCH_PHASE ?? 'all';
if (!['all', 'seed', 'verify'].includes(phase)) throw new Error('Set BENCH_PHASE to all, seed, or verify.');
const shape = process.env.BENCH_SHAPE ?? 'sessions';
if (!['sessions', 'dispersed'].includes(shape)) throw new Error('Set BENCH_SHAPE to sessions or dispersed.');
const rows = Number(process.env.BENCH_ROWS ?? 10_000_000);
if (!Number.isSafeInteger(rows) || rows < 1000) throw new Error('Set BENCH_ROWS to an integer of at least 1000.');
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const pool = new pg.Pool({ connectionString: uri, max: 16, statement_timeout: 300_000, options: process.env.BENCH_PG_OPTIONS });
const raw = pgDbFromPool(pool);
type CapturedStatement = { query: string; params: unknown[] };
const queries: (CapturedStatement & { settings: CapturedStatement[] })[] = [];
let localSettings: CapturedStatement[] = [];
let capture = false;
const db = drizzle(pool, { schema, casing: 'snake_case', logger: {
  logQuery(query, params) {
    if (!capture) return;
    if (/^BEGIN\b/i.test(query.trim())) localSettings = [];
    if (/^SET LOCAL\b/i.test(query.trim())) localSettings.push({ query, params });
    if (/^(SELECT|WITH)\b/i.test(query.trim())) queries.push({ query, params, settings: [...localSettings] });
  },
} });
const emit = (event: Record<string, unknown>) => console.log(JSON.stringify(event));
const baselineSql = execFileSync('git', ['show', `${baselineCommit}:packages/api/migrations/pg/0000_app.sql`], { cwd: root, encoding: 'utf8' });
const baselineSource = execFileSync('git', ['show', `${baselineCommit}:packages/api/src/services/usage.ts`], { cwd: root, encoding: 'utf8' });
// Keep package resolution in this checkout. Rewrite relative imports from the original service.
const temp = mkdtempSync(resolve(here, '.usage-scale-'));
const baselinePath = resolve(temp, 'baseline.ts');
writeFileSync(baselinePath, baselineSource.replace(/from "(\.[^"]+)"/g, (_match, specifier: string) =>
  `from ${JSON.stringify(pathToFileURL(resolve(here, '../src/services', specifier)).href)}`));
const baseline: typeof current = await import(pathToFileURL(baselinePath).href);
const endpointNames = ['breakdown', 'tool-efficiency', 'outcomes', 'activity'] as const;
const endpoints = (service: typeof current, now: number, scope: current.UsageScope) => ({
  breakdown: () => service.getUsageBreakdown(db, { windowMs: 30 * 86400000, now, scope }),
  'tool-efficiency': () => service.getUsageToolEfficiency(db, { windowMs: 30 * 86400000, now, scope }),
  outcomes: () => service.getUsageOutcomes(db, { windowMs: 30 * 86400000, now, scope }),
  activity: () => service.getDailyAgentActivity(db, { windowMs: 30 * 86400000, now, scope }),
});
function assertEqual(actual: unknown, expected: unknown, path = '$'): void {
  if (typeof actual === 'number' && typeof expected === 'number') {
    if (Number.isInteger(actual) && Number.isInteger(expected)) {
      if (actual === expected) return;
    } else if (Math.abs(actual - expected) <= Math.max(1e-7, Math.abs(expected) * 1e-9)) return;
  } else if (actual === expected) return;
  else if (Array.isArray(actual) && Array.isArray(expected) && actual.length === expected.length) {
    const key = (value: unknown) => typeof value === 'object' && value !== null
      ? JSON.stringify(Object.entries(value).filter(([, v]) => typeof v === 'string').sort()) : JSON.stringify(value);
    const a = [...actual].sort((a, b) => key(a).localeCompare(key(b)));
    const e = [...expected].sort((a, b) => key(a).localeCompare(key(b)));
    a.forEach((value, i) => assertEqual(value, e[i], `${path}[${i}]`)); return;
  } else if (typeof actual === 'object' && actual !== null && typeof expected === 'object' && expected !== null) {
    const a = Object.entries(actual).filter(([, value]) => value !== undefined).sort();
    const e = Object.entries(expected).filter(([, value]) => value !== undefined).sort();
    if (JSON.stringify(a.map(([key]) => key)) === JSON.stringify(e.map(([key]) => key))) {
      a.forEach(([key, value], i) => assertEqual(value, e[i][1], `${path}.${key}`)); return;
    }
  }
  throw new Error(`Response differs at ${path}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);
}
async function time(label: string, run: () => Promise<unknown>): Promise<unknown> {
  const start = performance.now(); const result = await run();
  emit({ event: 'timing', label, ms: Math.round(performance.now() - start) }); return result;
}
try {
  const settings = await pool.query("SELECT version() AS version,current_setting('shared_buffers') AS shared_buffers,current_setting('work_mem') AS work_mem,current_setting('max_parallel_workers_per_gather') AS parallel_workers,current_setting('jit') AS jit");
  emit({ event: 'database', settings: settings.rows[0], poolSize: 16 });
  if (phase !== 'verify') {
    const existing = await pool.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public'");
    if (existing.rowCount) throw new Error('The benchmark database is not empty. Create a new disposable database.');
    const now = Date.UTC(2026, 8, 26, 12, 17, 41);
    const sessions = Math.min(10000, Math.floor(rows / 10));
    await time('baseline-schema', async () => {
      await applyEngineMigrations(raw);
      for (const sql of baselineSql.split(/-->\s*statement-breakpoint/).map(s => s.trim()).filter(Boolean)) await pool.query(sql);
      await pool.query('CREATE TABLE __valet_app_migrations (filename text PRIMARY KEY, applied_at bigint NOT NULL)');
      await pool.query("INSERT INTO __valet_app_migrations VALUES ('0000_app.sql', $1)", [now]);
      await pool.query('CREATE TABLE usage_benchmark_metadata (now_ms bigint, fact_rows bigint, sessions integer)');
      await pool.query('INSERT INTO usage_benchmark_metadata VALUES ($1,$2,$3)', [now, rows, sessions]);
      await pool.query('CREATE TABLE usage_benchmark_expected (scope text, endpoint text, response jsonb, PRIMARY KEY(scope,endpoint))');
      // Fact-only scale fixture. The production schema retains this foreign key.
      await pool.query('ALTER TABLE usage_entry_facts DROP CONSTRAINT usage_entry_facts_entry_id_fkey');
    });
    await time('seed-sessions', () => pool.query(`INSERT INTO agent_sessions
      (id,org_id,user_id,workspace,status,owner_type,owner_id,created_at,updated_at)
      SELECT CASE WHEN i%100=1 THEN 'orchestrator:bench-'||i ELSE 'bench-'||i END,CASE WHEN i%10=0 THEN 'foreign-org' ELSE 'bench-org' END,'user-'||(i%97),
      '/w','active','user','user-'||(i%97),$1,$1 FROM generate_series(1,$2::int) i`, [now, sessions]));
    await time('seed-facts', async () => {
      for (let start = 1; start <= rows; start += 100000) {
        await pool.query(`INSERT INTO usage_entry_facts
          SELECT 'entry-'||i,CASE WHEN (1+(i-1)%$4::int)%100=1 THEN 'orchestrator:bench-' ELSE 'bench-' END||(1+(i-1)%$4::int),NULL,
            $1::bigint - CASE WHEN $5::boolean OR (1+(i-1)%$4::int)%100=1
              THEN (i::bigint*2654435761 % 3024000000)
              ELSE ((1+(i-1)%$4::int)%35)::bigint*86400000 + (((i-1)/$4::int)%1080)::bigint*20000 END,
            CASE WHEN i%37=0 THEN NULL ELSE 'model-'||((i/$4::int)%5) END,
            jsonb_build_object('input',100+i%31,'output',20+i%13,'total',120+i%31+i%13,'cacheRead',i%7),
            CASE WHEN i%101=0 THEN NULL ELSE jsonb_build_object('total',0.003+(i%11)*0.0001) END,
            (i%4)::int,CASE WHEN i%1009=0 THEN 1 ELSE 0 END,CASE WHEN i%2017=0 THEN 1 ELSE 0 END
          FROM generate_series($2::int,$3::int) i`, [now, start, Math.min(rows, start + 99999), sessions, shape === 'dispersed']);
        if (start === 1 || (start + 99999) % 1000000 === 0) emit({ event: 'seed-progress', rows: Math.min(rows, start + 99999) });
      }
    });
    const aux = Math.max(1000, Math.floor(rows / 100));
    await time('seed-proxy-actions-skills', async () => {
      await pool.query(`INSERT INTO llm_proxy_requests (id,created_at,org_id,user_id,api_key_id,provider_kind,model,harness,
        endpoint,stream,status_code,request_body,input_tokens,output_tokens,total_tokens,cost_usd)
        SELECT 'proxy-'||i,$1::bigint-(i%35)::bigint*86400000-(i%3600)::bigint*1000,
        CASE WHEN i%10=0 THEN 'foreign-org' ELSE 'bench-org' END,'user-'||(i%97),'key','openai',
        'model-'||(i%5),'codex','/responses',true,200,'{}',100,20,120,0.002
        FROM generate_series(1,$2::int) i`, [now, aux]);
      await pool.query(`INSERT INTO skill_invocations
        (id,created_at,org_id,session_id,thread_id,path,skill_key,skill_name,origin,content_sha,injected_characters,estimated_body_tokens)
        SELECT 'skill-'||i,$1::bigint-(i%60)::bigint*86400000,
        CASE WHEN (1+(i-1)%$3::int)%10=0 THEN 'foreign-org' ELSE 'bench-org' END,
        CASE WHEN (1+(i-1)%$3::int)%100=1 THEN 'orchestrator:bench-' ELSE 'bench-' END||(1+(i-1)%$3::int),'th','model_tool','skill-'||(i%20),'Skill '||(i%20),'plugin','sha',100,25
        FROM generate_series(1,$2::int) i`, [now, Math.max(1000, Math.floor(aux / 10)), sessions]);
      await pool.query(`INSERT INTO skill_context_attributions
        (skill_invocation_id,llm_request_id,session_id,thread_id,created_at,estimated_skill_tokens)
        SELECT 'skill-'||(1+(i-1)%$3::int),'request-'||i,CASE WHEN (1+(i-1)%$4::int)%100=1 THEN 'orchestrator:bench-' ELSE 'bench-' END||(1+(i-1)%$4::int),'th',
        $1::bigint-(i%35)::bigint*86400000-(i%3600)::bigint*1000,25+i%7
        FROM generate_series(1,$2::int) i`, [now, aux * 2, Math.max(1000, Math.floor(aux / 10)), sessions]);
      await pool.query(`INSERT INTO action_invocations
        (invocation_id,created_at,started_at,org_id,session_id,service,action_id,status,duration_ms,result)
        SELECT 'action-'||i,$1::bigint-(i%35)::bigint*86400000-(i%3600)::bigint*1000,NULL,
        CASE WHEN (1+(i-1)%$3::int)%10=0 THEN 'foreign-org' ELSE 'bench-org' END,
        CASE WHEN (1+(i-1)%$3::int)%100=1 THEN 'orchestrator:bench-' ELSE 'bench-' END||(1+(i-1)%$3::int),'slack',CASE WHEN i%7=0 THEN 'slack.history' ELSE 'slack.send_message' END,
        CASE WHEN i%11=0 THEN 'error' ELSE 'completed' END,10,
        jsonb_build_object('success',i%11<>0,'data',jsonb_build_object('channel',CASE WHEN i%13=0 THEN 'D1' ELSE 'C1' END))
        FROM generate_series(1,$2::int) i`, [now, aux, sessions]);
    });
    await pool.query('ANALYZE');
    emit({ event: 'fixture', shape, rows, sessions, proxyRequests: aux, actions: aux, skillInvocations: Math.max(1000, Math.floor(aux / 10)), skillContext: aux * 2,
      dates: '35 days; sessions shape: short sessions + 1% long orchestrators; dispersed shape: every session spans period; 5 models plus null; 90% primary org; 97 users', transcriptBodies: false });
    for (const scope of [{ scope: 'org', orgId: 'bench-org' }, { scope: 'me', orgId: 'bench-org', userId: 'user-1' }] satisfies current.UsageScope[]) {
      const calls = endpoints(baseline, now, scope);
      for (const endpoint of endpointNames) {
        const result = await time(`baseline/${scope.scope}/${endpoint}`, calls[endpoint]);
        await pool.query('INSERT INTO usage_benchmark_expected VALUES ($1,$2,$3)', [scope.scope, endpoint, JSON.stringify(result)]);
      }
    }
  }
  if (phase !== 'seed') {
    const metadata = await pool.query<{ now_ms: string; fact_rows: string; sessions: number }>('SELECT * FROM usage_benchmark_metadata');
    if (metadata.rows.length !== 1) throw new Error('Prepare the fixture with BENCH_PHASE=seed first.');
    const now = Number(metadata.rows[0].now_ms);
    const checkedSources = new Set<string>();
    const checkedRaw: PgDb = { ...raw, async query(query, params) {
      const source = params?.[0];
      if (query.startsWith('WITH progress AS MATERIALIZED') && typeof source === 'string' && !checkedSources.has(source)) {
        const result = await raw.query(`EXPLAIN (FORMAT JSON) ${query}`, params);
        const id = source === 'engine' ? 'entry_id' : 'id';
        const hasCursorIndex = (value: unknown): boolean => {
          if (typeof value !== 'object' || value === null) return false;
          if ('Index Cond' in value && typeof value['Index Cond'] === 'string' && value['Index Cond'].includes(`${id} >`)) return true;
          return Object.values(value).some(hasCursorIndex);
        };
        if (!hasCursorIndex(result.rows)) throw new Error('Backfill lost its cursor index. Restore the scalar watermark subquery before running the benchmark.');
        emit({ event: 'backfill-cursor-plan', source, passed: true, plan: result.rows });
        checkedSources.add(source);
      }
      return raw.query(query, params);
    } };
    await time('rollup-upgrade', () => applyAppMigrations(checkedRaw));
    await pool.query('ANALYZE');
    const sizes = await pool.query(`SELECT relname,n_live_tup,pg_total_relation_size(relid)::text AS bytes
      FROM pg_stat_user_tables WHERE relname LIKE 'usage_%' OR relname IN ('llm_proxy_requests','action_invocations','skill_context_attributions') ORDER BY relname`);
    emit({ event: 'cardinality', tables: sizes.rows, fixture: metadata.rows[0] });
    for (const scope of [{ scope: 'org', orgId: 'bench-org' }, { scope: 'me', orgId: 'bench-org', userId: 'user-1' }] satisfies current.UsageScope[]) {
      const calls = endpoints(current, now, scope);
      for (const endpoint of endpointNames) {
        capture = true;
        const result = await time(`first-read/${scope.scope}/${endpoint}`, calls[endpoint]);
        capture = false;
        const expected = await pool.query<{ response: unknown }>('SELECT response FROM usage_benchmark_expected WHERE scope=$1 AND endpoint=$2', [scope.scope, endpoint]);
        assertEqual(result, expected.rows[0]?.response);
        emit({ event: 'equality', scope: scope.scope, endpoint, passed: true });
        await time(`warm/${scope.scope}/${endpoint}`, calls[endpoint]);
      }
    }
    const proxyOptions = { windowMs: 30 * 86400000, now, scope: { scope: 'org' as const, orgId: 'bench-org' }, useCase: 'proxy' as const };
    const rawProxy = await time('baseline/org/proxy-drill', () => baseline.getUsageDrillItems(db, proxyOptions));
    const rolledProxy = await time('warm/org/proxy-drill', () => current.getUsageDrillItems(db, proxyOptions));
    assertEqual(rolledProxy, rawProxy);
    emit({ event: 'equality', scope: 'org', endpoint: 'proxy-drill', passed: true });
    const calls = endpoints(current, now, { scope: 'org', orgId: 'bench-org' });
    await time('four-concurrent-dashboards', () => Promise.all(Array.from({ length: 4 }, (_, dashboard) =>
      time(`dashboard-${dashboard + 1}`, () => Promise.all(endpointNames.map(endpoint =>
        time(`concurrent-${dashboard + 1}/${endpoint}`, calls[endpoint])))))));
    if (process.env.BENCH_EXPLAIN === '1') {
      for (const { query, params, settings } of queries) {
        const connection = await pool.connect();
        try {
          await connection.query('BEGIN READ ONLY');
          for (const setting of settings) await connection.query(setting.query, setting.params);
          const plan = await connection.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query}`, params);
          emit({ event: 'plan', query, params, settings, plan: plan.rows });
        } finally {
          await connection.query('ROLLBACK');
          connection.release();
        }
      }
    }
    emit({ event: 'complete', note: 'First reads follow backfill and ANALYZE; they are not cold-cache measurements. No production data was used.' });
  }
} finally { await pool.end(); rmSync(temp, { recursive: true, force: true }); }
