import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { pgDbFromPglite } from "@valet/store-postgres";
import { afterEach, expect, it } from "vitest";
import { applyAppMigrations } from "../lib/drizzle.js";
import * as schema from "./index.js";
import {
  getUsageBreakdown,
  getUsageToolEfficiency,
  getUsageOutcomes,
} from "../services/usage.js";
let pg: PGlite;
afterEach(async () => {
  await pg?.close();
});
const HOUR = 3600000;
async function setup() {
  pg = new PGlite();
  const raw = pgDbFromPglite(pg);
  await applyAppMigrations(raw);
  await pg.query(`INSERT INTO agent_sessions (id,org_id,user_id,workspace,status,owner_type,owner_id,created_at,updated_at)
 VALUES ('s','o','u','/w','active','user','u',0,0)`);
  return drizzle(pg, { schema, casing: "snake_case" });
}
it("compresses entries and maintains totals through corrections, moves, and deletes", async () => {
  await setup();
  await pg.query(`INSERT INTO engine_entries(id,session_id,thread_id,entry_type,role,usage,cost,created_at)
 SELECT 'e'||i,'s','th','message','assistant','{"total":12}','{"total":0.5}',3600000 FROM generate_series(1,100) i`);
  expect(
    (
      await pg.query(
        "SELECT count(*)::int AS n,sum(turns)::int AS turns,sum(total_tokens)::int AS tokens FROM usage_hourly",
      )
    ).rows,
  ).toEqual([{ n: 1, turns: 100, tokens: 1200 }]);
  await pg.query(
    `UPDATE engine_entries SET usage='{"total":20}',cost='{"total":1}',created_at=7200000 WHERE id='e1'`,
  );
  expect(
    (
      await pg.query(
        "SELECT sum(turns)::int AS turns,sum(total_tokens)::int AS tokens,sum(cost_total)::float8 AS cost FROM usage_hourly",
      )
    ).rows,
  ).toEqual([{ turns: 100, tokens: 1208, cost: 50.5 }]);
  await pg.query(`DELETE FROM engine_entries WHERE id='e1'`);
  expect(
    (
      await pg.query(
        "SELECT sum(turns)::int AS turns,sum(total_tokens)::int AS tokens FROM usage_hourly",
      )
    ).rows,
  ).toEqual([{ turns: 99, tokens: 1188 }]);
});
it("reads exact partial hours and current owners without double-counting", async () => {
  const db = await setup();
  const parts = JSON.stringify([
    {
      type: "tool_call",
      toolName: "bash",
      status: "completed",
      result: { details: { outcome: { kind: "pull_request_created" } } },
    },
  ]);
  for (const [id, time] of [
    ["before", HOUR - 1],
    ["first", HOUR],
    ["middle", HOUR * 2],
    ["last", HOUR * 3],
    ["after", HOUR * 3 + 1],
  ] as const)
    await pg.query(
      `INSERT INTO engine_entries(id,session_id,thread_id,entry_type,role,usage,cost,parts,created_at) VALUES($1,'s','th','message','assistant','{"total":12}','{"total":0.5}',$2,$3)`,
      [id, parts, time],
    );
  const opts = {
    period: {
      startMs: HOUR,
      endMs: HOUR * 3 + 1,
      kind: "lookback" as const,
      label: "test",
    },
    scope: { scope: "org" as const, orgId: "o" },
  };
  const result = await getUsageBreakdown(db, opts);
  expect(result.totalTurns).toBe(3);
  expect(result.totalCostUsd).toBe(1.5);
  expect(
    (await getUsageToolEfficiency(db, opts)).byUseCase.find(
      (x) => x.useCase === "session",
    )?.modelDirectedCalls,
  ).toBe(3);
  expect((await getUsageOutcomes(db, opts)).byOutcome[0].count).toBe(3);
  await pg.query(
    `UPDATE agent_sessions SET org_id='other',user_id='v',owner_type='team',owner_id='team' WHERE id='s'`,
  );
  expect((await getUsageBreakdown(db, opts)).totalTurns).toBe(0);
  expect(
    (
      await getUsageBreakdown(db, {
        ...opts,
        scope: {
          scope: "team",
          orgId: "other",
          teamId: "team",
          byMember: false,
        },
      })
    ).totalTurns,
  ).toBe(3);
  const tiny = {
    ...opts,
    period: { ...opts.period, startMs: HOUR * 3, endMs: HOUR * 3 + 1 },
    scope: { scope: "org" as const, orgId: "other" },
  };
  expect((await getUsageBreakdown(db, tiny)).totalTurns).toBe(1);
});

it("repairs an interrupted backfill while live corrections and deletes continue", async () => {
  await setup();
  const raw = pgDbFromPglite(pg);
  for (const suffix of ["mark", "insert", "update", "delete"])
    await pg.query(
      `DROP TRIGGER usage_entry_facts_hourly_${suffix} ON usage_entry_facts`,
    );
  await pg.query(`INSERT INTO engine_entries(id,session_id,thread_id,entry_type,role,usage,cost,created_at)
 SELECT 'batch-'||lpad(i::text,5,'0'),'s','th','message','assistant','{"total":12}','{"total":0.5}',3600000 FROM generate_series(1,12000) i`);
  let batches = 0;
  const interrupted = {
    ...raw,
    async query(text: string, params?: unknown[]) {
      if (text.startsWith("WITH progress") && ++batches === 2)
        throw new Error("interrupted");
      return raw.query(text, params);
    },
  };
  const { prepareUsageHourly } =
    await import("../lib/usage-hourly-migration.js");
  await expect(prepareUsageHourly(interrupted)).rejects.toThrow("interrupted");
  expect(
    (await pg.query("SELECT sum(turns)::int AS n FROM usage_hourly")).rows,
  ).toEqual([{ n: 10000 }]);
  await pg.query(
    `UPDATE engine_entries SET usage='{"total":20}' WHERE id='batch-12000'`,
  );
  await pg.query(`DELETE FROM engine_entries WHERE id='batch-00001'`);
  await prepareUsageHourly(raw);
  expect(
    (
      await pg.query(
        "SELECT sum(turns)::int AS n,sum(total_tokens)::int AS tokens FROM usage_hourly",
      )
    ).rows,
  ).toEqual([{ n: 11999, tokens: 11999 * 12 + 8 }]);
  await prepareUsageHourly(raw);
  expect(
    (await pg.query("SELECT sum(turns)::int AS n FROM usage_hourly")).rows,
  ).toEqual([{ n: 11999 }]);
});

it("maintains proxy pricing, cache corrections, scope changes, and conflict updates exactly once", async () => {
  const db = await setup();
  await pg.query(`INSERT INTO llm_proxy_requests(id,org_id,user_id,api_key_id,provider_kind,endpoint,stream,status_code,request_body,total_tokens,input_tokens,created_at)
 VALUES('p','o','u','key','openai','responses',false,200,'{}',100,100,3600000)`);
  await pg.query(
    `UPDATE llm_proxy_requests SET cost_usd=0.5,input_tokens=10,cache_read_tokens=90 WHERE id='p'`,
  );
  expect(
    (
      await pg.query(
        "SELECT turns,input_tokens,cache_read_tokens,unpriced_turns FROM usage_hourly",
      )
    ).rows,
  ).toEqual([
    { turns: 1, input_tokens: 10, cache_read_tokens: 90, unpriced_turns: 0 },
  ]);
  await pg.query(`INSERT INTO llm_proxy_requests(id,org_id,user_id,api_key_id,provider_kind,endpoint,stream,status_code,request_body,total_tokens,input_tokens,cost_usd,created_at)
 VALUES('p','o','u','key','openai','responses',false,200,'{}',200,200,1,3600000)
 ON CONFLICT(id) DO UPDATE SET total_tokens=EXCLUDED.total_tokens,input_tokens=EXCLUDED.input_tokens,cost_usd=EXCLUDED.cost_usd`);
  const opts = {
    period: {
      startMs: 0,
      endMs: HOUR * 2,
      kind: "lookback" as const,
      label: "test",
    },
    scope: { scope: "org" as const, orgId: "o" },
  };
  expect((await getUsageBreakdown(db, opts)).totalTurns).toBe(1);
  await pg.query(
    `UPDATE llm_proxy_requests SET org_id='elsewhere',team_id='team' WHERE id='p'`,
  );
  expect((await getUsageBreakdown(db, opts)).totalTurns).toBe(0);
  await pg.query(`DELETE FROM llm_proxy_requests WHERE id='p'`);
  expect((await pg.query("SELECT * FROM usage_hourly")).rows).toEqual([]);
});

it("maintains daily summaries across hour corrections without losing hourly detail", async () => {
  await setup();
  await pg.query(`INSERT INTO engine_entries(id,session_id,thread_id,entry_type,role,usage,cost,created_at)
 VALUES ('d1','s','th','message','assistant','{"total":10}','{"total":1}',3600000),
 ('d2','s','th','message','assistant','{"total":20}','{"total":2}',7200000)`);
  expect(
    (
      await pg.query(
        "SELECT count(*)::int AS n,sum(turns)::int AS turns FROM usage_daily",
      )
    ).rows,
  ).toEqual([{ n: 1, turns: 2 }]);
  expect(
    (await pg.query("SELECT count(*)::int AS n FROM usage_hourly")).rows,
  ).toEqual([{ n: 2 }]);
  await pg.query(`UPDATE engine_entries SET created_at=90000000 WHERE id='d1'`);
  expect(
    (
      await pg.query(
        "SELECT created_at::float8 AS day,total_tokens FROM usage_daily ORDER BY created_at",
      )
    ).rows,
  ).toEqual([
    { day: 0, total_tokens: 20 },
    { day: 86400000, total_tokens: 10 },
  ]);
  await pg.query(`DELETE FROM engine_entries WHERE id='d2'`);
  expect(
    (
      await pg.query(
        "SELECT count(*)::int AS n,sum(turns)::int AS turns FROM usage_daily",
      )
    ).rows,
  ).toEqual([{ n: 1, turns: 1 }]);
});

it("rejects lost hourly tables when daily totals survive instead of counting them again", async () => {
  await setup();
  const raw = pgDbFromPglite(pg);
  await pg.query(`INSERT INTO engine_entries(id,session_id,thread_id,entry_type,role,usage,created_at)
 VALUES('retained','s','th','message','assistant','{"total":10}',3600000)`);
  // Retained rows from deployed backfill use the watermark instead of this flag.
  await pg.query(
    "DROP TRIGGER usage_entry_facts_hourly_mark ON usage_entry_facts",
  );
  await pg.query("UPDATE usage_entry_facts SET hourly_accounted=false");
  await pg.query("DROP TABLE usage_hourly,usage_hourly_progress CASCADE");
  const { prepareUsageHourly } =
    await import("../lib/usage-hourly-migration.js");
  await expect(prepareUsageHourly(raw)).rejects.toThrow(
    "Usage projection tables are missing: usage_hourly, usage_hourly_progress. Restore these tables from backup before restarting the API.",
  );
  expect(
    (await pg.query("SELECT sum(turns)::int AS turns FROM usage_daily")).rows,
  ).toEqual([{ turns: 1 }]);
  expect(
    (await pg.query("SELECT to_regclass('usage_hourly') AS hourly")).rows,
  ).toEqual([{ hourly: null }]);
});

it("allows the daily layer to be added to complete hourly tables", async () => {
  await setup();
  const raw = pgDbFromPglite(pg);
  await pg.query(`INSERT INTO engine_entries(id,session_id,thread_id,entry_type,role,usage,created_at)
 VALUES('retained','s','th','message','assistant','{"total":10}',3600000)`);
  await pg.query("DROP TABLE usage_daily CASCADE");
  const { prepareUsageHourly } =
    await import("../lib/usage-hourly-migration.js");
  await prepareUsageHourly(raw);
  expect(
    (await pg.query("SELECT sum(turns)::int AS turns FROM usage_daily")).rows,
  ).toEqual([{ turns: 1 }]);
});

it("combines full days, edge hours, and exact partial hours without overlap", async () => {
  const db = await setup();
  const DAY = 24 * HOUR;
  const start = HOUR + 123;
  const end = 3 * DAY + 2 * HOUR + 456;
  const timestamps = [
    start - 1,
    start,
    2 * HOUR,
    DAY - 1,
    DAY,
    DAY + HOUR,
    2 * DAY,
    3 * DAY - 1,
    3 * DAY,
    3 * DAY + HOUR,
    3 * DAY + 2 * HOUR,
    end - 1,
    end,
  ];
  for (const [index, time] of timestamps.entries()) {
    await pg.query(
      `INSERT INTO engine_entries(id,session_id,thread_id,entry_type,role,usage,cost,created_at)
     VALUES($1,'s','th','message','assistant',$2,$3,$4)`,
      [
        "edge-" + index,
        JSON.stringify({ total: index + 1, input: index + 1 }),
        JSON.stringify({ total: (index + 1) / 10 }),
        time,
      ],
    );
  }
  const raw = await pg.query<{ turns: number; tokens: number; cost: number }>(
    `SELECT COUNT(*)::int AS turns,
   SUM((usage::jsonb->>'total')::int)::int AS tokens,SUM((cost::jsonb->>'total')::numeric)::float8 AS cost
   FROM engine_entries WHERE created_at >= $1 AND created_at < $2`,
    [start, end],
  );
  const result = await getUsageBreakdown(db, {
    period: {
      startMs: start,
      endMs: end,
      kind: "custom",
      label: "exact edges",
    },
    scope: { scope: "org", orgId: "o" },
  });
  expect(result.totalTurns).toBe(raw.rows[0].turns);
  expect(result.totalTokens).toBe(raw.rows[0].tokens);
  expect(result.totalCostUsd).toBeCloseTo(raw.rows[0].cost, 10);
  expect(result.activeAgents).toBe(1);
  expect(result.byDay.map((day) => day.dayMs)).toEqual([
    0,
    DAY,
    2 * DAY,
    3 * DAY,
  ]);
});
