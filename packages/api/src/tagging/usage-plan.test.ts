import { expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { freshTestPgDb } from "../test-helpers/pg-test-db.js";
import { externalCalls } from "../schema/index.js";
import { seedRegistry, readRegistry } from "./registry.js";
import { toolIntentDimension } from "./tool-intent.js";
import { intentJoins } from "./usage.js";

it("groups top tools across keys with a registry map on 100,000 seeded calls", async () => {
  const { appDb: db, pgdb } = await freshTestPgDb();
  await seedRegistry(db, "plan-org", toolIntentDimension);
  await pgdb.query(`INSERT INTO external_calls(id,org_id,user_id,surface,name,owner_type,owner_id,outcome,duration_ms,created_at)
    SELECT 'call-'||i,'plan-org','alice','mcp','call_tool','team','team','ok',1,i FROM generate_series(1,100000) i`);
  await pgdb.query(`INSERT INTO tag_labels(org_id,subject_type,subject_id,dimension,key,mode,confidence,model,input_hash,classified_at)
    SELECT 'plan-org','external_call','call-'||i,'tool_intent',CASE WHEN i % 2 = 0 THEN 'code_review' ELSE 'code_change' END,
      'single',1,'fixed','hash',i FROM generate_series(1,100000) i`);
  await pgdb.query("ANALYZE external_calls"); await pgdb.query("ANALYZE tag_labels");
  const join = intentJoins(await readRegistry(db, "plan-org", "tool_intent"), "plan-org", true);
  const query = db.select({ name: externalCalls.name, surface: externalCalls.surface, calls: sql<number>`count(*)`.mapWith(Number) })
    .from(externalCalls).leftJoin(join.join, join.on).where(sql`${externalCalls.orgId} = 'plan-org'`)
    .groupBy(externalCalls.name, externalCalls.surface);
  expect(await query).toEqual([{ name: "call_tool", surface: "mcp", calls: 100000 }]);
  const compiled = query.toSQL();
  const plan = await pgdb.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) ${compiled.sql}`, compiled.params);
  const text = plan.rows.map(row => row["QUERY PLAN"]).join("\n");
  console.log("TAGGING_100K_PLAN\n" + text);
  expect(text).not.toContain("Recursive");

}, 120000);
