/** Synthetic, disposable PGlite benchmark. Never connects to a deployed database. */
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "../src/schema/index.js";
import { PGlite } from "@electric-sql/pglite";
import { pgDbFromPglite } from "@valet/store-postgres";
import { applyAppMigrations } from "../src/lib/drizzle.js";
import { getUsageBreakdown, getUsageToolEfficiency, getUsageOutcomes } from "../src/services/usage.js";

const pg = new PGlite();
const raw = pgDbFromPglite(pg);
const queries: { query: string; params: unknown[] }[] = [];
const db = drizzle(pg, { schema, casing: "snake_case", logger: {
  logQuery(query, params) { queries.push({ query, params }); },
} });
const count = Number(process.env.BENCH_ROWS ?? 20000);
if (!Number.isInteger(count) || count < 1) throw new Error("Set BENCH_ROWS to a positive integer.");
const now = Date.now();
try {
  await applyAppMigrations(raw);
  await raw.query(`INSERT INTO agent_sessions (id,org_id,user_id,workspace,status,owner_type,owner_id,created_at,updated_at)
    SELECT 'bench-' || i, 'bench-org', 'bench-user', '/w', 'active', 'user', 'bench-user', $1, $1 FROM generate_series(1,100) i`, [now]);
  await raw.query(`INSERT INTO engine_entries (id,session_id,thread_id,entry_type,role,parts,usage,cost,created_at)
    SELECT 'entry-' || i, 'bench-' || (1 + i % 100), 'th', 'message','assistant',
      jsonb_build_array(jsonb_build_object('type','text','text',repeat(md5(i::text),256)),
        jsonb_build_object('type','tool_call','toolName','bash','status','completed','result',
          jsonb_build_object('details',jsonb_build_object('outcome',jsonb_build_object('kind','pull_request_created')))))::text,
      '{"input":100,"output":20,"total":120}', '{"total":0.003}', $1::bigint - (i % 30)::bigint * 86400000
    FROM generate_series(1,$2::int) i`, [now, count]);
  await raw.query(`INSERT INTO skill_invocations
    (id,created_at,org_id,session_id,thread_id,path,skill_key,skill_name,origin,content_sha,injected_characters,estimated_body_tokens)
    SELECT 'skill-' || i, $1::bigint - (i % 60)::bigint * 86400000, 'bench-org', 'bench-' || (1+i%100),
      'th','model_tool','skill-' || (i%10),'Skill ' || (i%10),'plugin','sha',100,25
    FROM generate_series(1,1000) i`, [now]);
  await raw.query(`INSERT INTO skill_context_attributions
    (skill_invocation_id,llm_request_id,session_id,thread_id,created_at,estimated_skill_tokens)
    SELECT 'skill-' || (1+i%1000), 'request-' || i, 'bench-' || (1+i%100), 'th',
      $1::bigint - (i%180)::bigint*86400000,25 FROM generate_series(1,$2::int) i`, [now,count*2]);
  await raw.query(`INSERT INTO action_invocations
    (invocation_id,created_at,started_at,org_id,session_id,service,action_id,status,duration_ms,result)
    SELECT 'action-' || i, $1::bigint - (i%180)::bigint*86400000, NULL, 'bench-org',
      'bench-' || (1+i%100), 'slack', CASE WHEN i%20=0 THEN 'slack.send_message' ELSE 'slack.history' END,
      'completed',10,'{"success":true,"data":{"channel":"C1"}}'
    FROM generate_series(1,$2::int) i`, [now,count]);
  await raw.query('ANALYZE');
  const opts = { windowMs: 30 * 86400000, now, scope: { scope: "org" as const, orgId: "bench-org" } };
  for (const [name, run] of [
    ['breakdown', () => getUsageBreakdown(db, opts)],
    ['tool-efficiency', () => getUsageToolEfficiency(db, opts)],
    ['outcomes', () => getUsageOutcomes(db, opts)],
  ] as const) {
    const start = performance.now();
    const result = await run();
    console.log(JSON.stringify({ name, rows: count, ms: Math.round(performance.now() - start), result }));
  }
  if (process.env.BENCH_EXPLAIN === "1") {
    for (const { query, params } of queries) {
      const plan = await raw.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query}`, params);
      console.log(JSON.stringify({ plan: plan.rows }));
    }
  }
} finally { await pg.close(); }
