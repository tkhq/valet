/**
 * Workflow step attribution in the usage projection. Every model call a
 * workflow makes bills to its step's id (`wf:{runId}:{nodeId}[:{iteration}]`):
 *
 * - A Thread step runs on the workspace assistant's session; its turns bill
 *   to the step through the queue item's dispatch id.
 * - An LLM step has no session; its call is recorded as a usage entry under
 *   the step's id.
 *
 * The hourly rollup and `cost_entries` then attribute both to the workflow,
 * and the repair moves Thread-step turns that predate the rule.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import type { Usage } from "@earendil-works/pi-ai/compat";
import { pgDbFromPglite, type PgDb } from "@valet/store-postgres";
import { applyAppMigrations, missingSchemaRepairs, type AppDb } from "../lib/drizzle.js";
import { freshTestPgDb } from "../test-helpers/pg-test-db.js";
import { prepareUsageStepAttribution } from "../lib/usage-step-attribution.js";
import { usageAnalyticsInstallSql } from "../lib/usage-analytics-migration.js";
import { recordLlmStepUsage, stepUsageEntry } from "../workflows/step-usage.js";
import { getDailyAgentActivity, getUsageBreakdown } from "../services/usage.js";
import { getMemberAgentDays } from "../services/usage-member-activity.js";

const NOW = 1_700_000_000_000;
const ASSISTANT = "orchestrator:u-alice";
const USAGE = JSON.stringify({ input: 100, output: 20, cacheRead: 0, cacheWrite: 0, total: 120 });
const COST = JSON.stringify({ input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 });

function piUsage(total: number, cost: number): Usage {
  return {
    input: total, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: total,
    cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
  };
}

async function queueItem(db: PgDb, id: string, dispatchId: string | null): Promise<void> {
  await db.query(`INSERT INTO engine_queue_items (id, session_id, thread_id, dispatch_id, status, content,
      attempt_count, max_attempts, timeout_at, created_at, updated_at)
    VALUES ($1, $2, 'th', $3, 'settled', 'prompt', 1, 3, $4, $4, $4)`, [id, ASSISTANT, dispatchId, NOW]);
}

async function assistantTurn(db: PgDb, id: string, queueItemId: string): Promise<void> {
  await db.query(`INSERT INTO engine_entries (id, session_id, thread_id, entry_type, role, model, queue_item_id, usage, cost, created_at)
    VALUES ($1, $2, 'th', 'message', 'assistant', 'claude', $3, $4, $5, $6)`, [id, ASSISTANT, queueItemId, USAGE, COST, NOW]);
}

async function factFor(db: PgDb, entryId: string) {
  return (await db.query("SELECT session_id, workflow_run_id FROM usage_entry_facts WHERE entry_id = $1", [entryId])).rows[0];
}

async function hourlyCost(db: PgDb, sessionId: string): Promise<number> {
  const rows = (await db.query("SELECT COALESCE(SUM(cost_total), 0)::float8 AS cost FROM usage_hourly WHERE session_id = $1", [sessionId])).rows;
  return Number(rows[0]?.cost ?? 0);
}

describe("usage workflow step attribution", () => {
  let db: PgDb;
  let appDb: AppDb;

  beforeEach(async () => {
    ({ pgdb: db, appDb } = await freshTestPgDb());
    await db.query("INSERT INTO orgs (id, name, created_at) VALUES ('org-a', 'Org A', $1)", [NOW]);
    await db.query(`INSERT INTO agent_sessions (id, user_id, org_id, workspace, status, owner_type, owner_id, created_at, updated_at)
      VALUES ($1, 'u-alice', 'org-a', '/tmp/o', 'active', 'user', 'u-alice', $2, $2)`, [ASSISTANT, NOW]);
    await db.query(`INSERT INTO workflow_definitions (id, org_id, owner_type, owner_id, name, definition, created_at, updated_at)
      VALUES ('wf-user', 'org-a', 'user', 'u-alice', 'Triage', '{}'::jsonb, $1, $1)`, [NOW]);
    await db.query(`INSERT INTO workflow_runs (id, workflow_id, definition_version_id, definition, params, owner_type, owner_id, created_at, updated_at)
      VALUES ('run-1', 'wf-user', 'v1', '{}'::jsonb, '{}'::jsonb, 'user', 'u-alice', $1, $1)`, [NOW]);
  });

  it("bills a Thread step's turns to the step, including its repair turn", async () => {
    await queueItem(db, "q-thread", "workflow:run-1:think");
    await queueItem(db, "q-repair", "workflow:run-1:think:2:repair");
    await queueItem(db, "q-chat", null);
    await assistantTurn(db, "e-thread", "q-thread");
    await assistantTurn(db, "e-repair", "q-repair");
    await assistantTurn(db, "e-chat", "q-chat");

    expect(await factFor(db, "e-thread")).toEqual({ session_id: "wf:run-1:think", workflow_run_id: "run-1" });
    expect(await factFor(db, "e-repair")).toEqual({ session_id: "wf:run-1:think:2", workflow_run_id: "run-1" });
    expect(await factFor(db, "e-chat")).toEqual({ session_id: ASSISTANT, workflow_run_id: null });

    const cost = (await db.query("SELECT use_case, workflow_id, workflow_run_id, owner_id FROM cost_entries WHERE entry_id = 'e-thread'")).rows[0];
    expect(cost).toEqual({ use_case: "workflow", workflow_id: "wf-user", workflow_run_id: "run-1", owner_id: "u-alice" });
    expect(await hourlyCost(db, "wf:run-1:think")).toBeCloseTo(0.003);
    expect(await hourlyCost(db, ASSISTANT)).toBeCloseTo(0.003);
  });

  it("moves Thread-step turns recorded before the rule, hours included", async () => {
    await queueItem(db, "q-thread", "workflow:run-1:think");
    await assistantTurn(db, "e-thread", "q-thread");
    // The fact as the earlier rule wrote it: billed to the assistant.
    await db.query("UPDATE usage_entry_facts SET session_id = $1, workflow_run_id = NULL WHERE entry_id = 'e-thread'", [ASSISTANT]);
    expect(await hourlyCost(db, ASSISTANT)).toBeCloseTo(0.003);

    await prepareUsageStepAttribution(db);

    expect(await factFor(db, "e-thread")).toEqual({ session_id: "wf:run-1:think", workflow_run_id: "run-1" });
    expect(await hourlyCost(db, ASSISTANT)).toBe(0);
    expect(await hourlyCost(db, "wf:run-1:think")).toBeCloseTo(0.003);
    // A second run finds nothing left to move.
    await prepareUsageStepAttribution(db);
    expect(await hourlyCost(db, "wf:run-1:think")).toBeCloseTo(0.003);
  });

  it("records an LLM step's call under the step, so the workflow's cost includes it", async () => {
    await recordLlmStepUsage(appDb, { runId: "run-1", nodeId: "summarize", iteration: 3, model: "claude", usage: piUsage(500, 0.01), now: NOW });

    const cost = (await db.query("SELECT session_id, use_case, workflow_run_id, cost_total, total_tokens::int AS total_tokens FROM cost_entries WHERE session_id LIKE 'wf:run-1:%'")).rows;
    expect(cost).toEqual([{ session_id: "wf:run-1:summarize:3", use_case: "workflow", workflow_run_id: "run-1", cost_total: 0.01, total_tokens: 500 }]);
    expect(await hourlyCost(db, "wf:run-1:summarize:3")).toBeCloseTo(0.01);
  });

  it("keeps a deleted workflow's step spend in the org's totals", async () => {
    await queueItem(db, "q-thread", "workflow:run-1:think");
    await assistantTurn(db, "e-thread", "q-thread");
    await recordLlmStepUsage(appDb, { runId: "run-1", nodeId: "summarize", iteration: 0, model: "claude", usage: piUsage(500, 0.01), now: NOW });
    const before = await orgTotals(db);
    expect(before.ledger).toBeCloseTo(0.013);

    // Deleting a workflow removes its definition and keeps its runs.
    await db.query("DELETE FROM workflow_definitions WHERE id = 'wf-user'");

    expect(await orgTotals(db)).toEqual(before);
    const owner = (await db.query("SELECT org_id, user_id, workflow_id FROM cost_entries WHERE entry_id = 'e-thread'")).rows[0];
    expect(owner).toEqual({ org_id: "org-a", user_id: "u-alice", workflow_id: "wf-user" });
  });

  it("leaves a turn on the assistant when its run resolves no org, so the repair keeps totals", async () => {
    await queueItem(db, "q-thread", "workflow:run-1:think");
    await assistantTurn(db, "e-thread", "q-thread");
    // A run whose workflow was deleted before the run kept its org.
    await db.query("UPDATE usage_entry_facts SET session_id = $1, workflow_run_id = NULL WHERE entry_id = 'e-thread'", [ASSISTANT]);
    await db.query("DELETE FROM workflow_definitions WHERE id = 'wf-user'");
    await db.query("UPDATE workflow_runs SET org_id = NULL WHERE id = 'run-1'");
    const before = await orgTotals(db);
    expect(before.ledger).toBeCloseTo(0.003);

    await prepareUsageStepAttribution(db);

    expect(await factFor(db, "e-thread")).toEqual({ session_id: ASSISTANT, workflow_run_id: null });
    expect(await orgTotals(db)).toEqual(before);
  });

  it("counts the assistant that ran a Thread step as an active agent, in every Usage panel", async () => {
    // The assistant's only usage is one Thread-step turn, which bills to the step.
    await queueItem(db, "q-thread", "workflow:run-1:think");
    await assistantTurn(db, "e-thread", "q-thread");
    const scope = { scope: "org", orgId: "org-a" } as const;
    const window = { windowMs: 86_400_000, now: NOW + 3_600_000, scope };
    const breakdown = await getUsageBreakdown(appDb, window);
    expect(breakdown.totalCostUsd).toBeCloseTo(0.003);
    expect(breakdown.activeAgents).toBe(1);
    const activity = await getDailyAgentActivity(appDb, window);
    expect(activity.days.map((d) => [d.dayMs, d.kind, d.activeAgents])).toEqual([[Math.floor(NOW / 86_400_000) * 86_400_000, "assistant", 1]]);
  });

  it("counts the sessions that made model calls as active agents, never billing-only step ids", async () => {
    // A session step runs in its own engine session.
    await db.query(`INSERT INTO engine_sessions (id, owner_type, owner_id, user_id, org_id, workspace, purpose, status, created_at, updated_at)
      VALUES ('wf:run-1:review', 'user', 'u-alice', 'u-alice', 'org-a', '/tmp/w', 'workflow', 'active', $1, $1)`, [NOW]);
    await db.query(`INSERT INTO engine_entries (id, session_id, thread_id, entry_type, role, model, usage, cost, created_at)
      VALUES ('e-review', 'wf:run-1:review', 'th', 'message', 'assistant', 'claude', $1, $2, $3)`, [USAGE, COST, NOW]);
    // Five LLM-step iterations and a Thread step: spend, but no engine session of their own.
    for (const iteration of [0, 1, 2, 3, 4]) {
      await recordLlmStepUsage(appDb, { runId: "run-1", nodeId: "summarize", iteration, model: "claude", usage: piUsage(10, 0.001), now: NOW });
    }
    await queueItem(db, "q-thread", "workflow:run-1:think");
    await assistantTurn(db, "e-thread", "q-thread");

    const scope = { scope: "org", orgId: "org-a" } as const;
    const window = { windowMs: 86_400_000, now: NOW + 3_600_000, scope };
    const activity = await getDailyAgentActivity(appDb, window);
    // The session step and the assistant that ran the Thread step; never the LLM step's ids.
    expect(activity.days.map((d) => [d.kind, d.activeAgents])).toEqual([["assistant", 1], ["workflow", 1]]);
    expect((await getUsageBreakdown(appDb, window)).activeAgents).toBe(2);
    const memberDays = await getMemberAgentDays(appDb, scope, { startMs: NOW - 3_600_000, endMs: NOW + 3_600_000, kind: "lookback", label: "test" });
    expect(memberDays.map((r) => [r.actor_id, Number(r.agent_days)])).toEqual([["u-alice", 1], [null, 1]]);
  });
});

/** The org's spend in every ledger Usage reads: per entry, per hour, per day. */
async function orgTotals(db: PgDb): Promise<{ ledger: number; hourly: number; daily: number }> {
  const sum = async (query: string) => Number((await db.query(query)).rows[0]?.cost ?? 0);
  return {
    ledger: await sum("SELECT COALESCE(SUM(cost_total), 0)::float8 AS cost FROM cost_entries WHERE org_id = 'org-a'"),
    hourly: await sum("SELECT COALESCE(SUM(cost_total), 0)::float8 AS cost FROM usage_hourly_entries WHERE scope_org_id = 'org-a'"),
    daily: await sum("SELECT COALESCE(SUM(cost_total), 0)::float8 AS cost FROM usage_daily_entries WHERE scope_org_id = 'org-a'"),
  };
}

describe("stepUsageEntry", () => {
  it("follows the engine's rule: no tokens means no entry, no price means unpriced", () => {
    expect(stepUsageEntry(piUsage(0, 0))).toBeNull();
    expect(stepUsageEntry(piUsage(10, 0))).toEqual({ usage: { input: 10, output: 0, cacheRead: 0, cacheWrite: 0, total: 10 } });
    expect(stepUsageEntry(piUsage(10, 0.5))?.cost?.total).toBe(0.5);
  });
});

describe("a step attribution repair that fails", () => {
  let db: PgDb | undefined;
  afterEach(async () => { await db?.close(); db = undefined; });

  it("stays pending through other usage repairs and finishes on the next boot", async () => {
    db = pgDbFromPglite(new PGlite());
    const pg = db;
    await applyAppMigrations(pg);
    await pg.query("INSERT INTO orgs (id, name, created_at) VALUES ('org-a', 'Org A', $1)", [NOW]);
    await pg.query(`INSERT INTO workflow_definitions (id, org_id, owner_type, owner_id, name, definition, created_at, updated_at)
      VALUES ('wf-user', 'org-a', 'user', 'u-alice', 'Triage', '{}'::jsonb, $1, $1)`, [NOW]);
    await pg.query(`INSERT INTO workflow_runs (id, workflow_id, definition_version_id, definition, params, owner_type, owner_id, created_at, updated_at)
      VALUES ('run-1', 'wf-user', 'v1', '{}'::jsonb, '{}'::jsonb, 'user', 'u-alice', $1, $1)`, [NOW]);
    await queueItem(pg, "q-thread", "workflow:run-1:think");
    await assistantTurn(pg, "e-thread", "q-thread");
    // A deployed database before the rule: the turn bills to the assistant.
    await pg.query("UPDATE usage_entry_facts SET session_id = $1, workflow_run_id = NULL WHERE entry_id = 'e-thread'", [ASSISTANT]);
    await pg.query("DROP VIEW usage_step_attribution_ready");

    const interrupted: PgDb = {
      ...pg,
      async query(text, params) {
        if (text.startsWith("WITH items")) throw new Error("Interrupted upgrade");
        return pg.query(text, params);
      },
    };
    await expect(applyAppMigrations(interrupted)).rejects.toThrow("Interrupted upgrade");
    // Another usage repair installs the shared projection functions again.
    await pg.query(`DO $install$ BEGIN ${usageAnalyticsInstallSql} END $install$`);
    expect((await missingSchemaRepairs(pg)).map((r) => r.describe)).toEqual(["usage workflow step attribution"]);
    expect(await factFor(pg, "e-thread")).toEqual({ session_id: ASSISTANT, workflow_run_id: null });

    await applyAppMigrations(pg);

    expect(await missingSchemaRepairs(pg)).toEqual([]);
    expect(await factFor(pg, "e-thread")).toEqual({ session_id: "wf:run-1:think", workflow_run_id: "run-1" });
  });
});

describe("upgrading a database that has runs of deleted workflows", () => {
  let db: PgDb | undefined;
  afterEach(async () => { await db?.close(); db = undefined; });

  it("gives runs their org and moves Thread-step turns without changing any total", async () => {
    db = pgDbFromPglite(new PGlite());
    await applyAppMigrations(db);
    await db.query("INSERT INTO orgs (id, name, created_at) VALUES ('org-a', 'Org A', $1)", [NOW]);
    await db.query(`INSERT INTO agent_sessions (id, user_id, org_id, workspace, status, owner_type, owner_id, created_at, updated_at)
      VALUES ($1, 'u-alice', 'org-a', '/tmp/o', 'active', 'user', 'u-alice', $2, $2)`, [ASSISTANT, NOW]);
    await db.query(`INSERT INTO workflow_definitions (id, org_id, owner_type, owner_id, name, definition, created_at, updated_at)
      VALUES ('wf-kept', 'org-a', 'user', 'u-alice', 'Kept', '{}'::jsonb, $1, $1), ('wf-gone', 'org-a', 'user', 'u-alice', 'Gone', '{}'::jsonb, $1, $1)`, [NOW]);
    await db.query(`INSERT INTO workflow_runs (id, workflow_id, definition_version_id, definition, params, owner_type, owner_id, created_at, updated_at)
      VALUES ('run-kept', 'wf-kept', 'v1', '{}'::jsonb, '{}'::jsonb, 'user', 'u-alice', $1, $1),
             ('run-gone', 'wf-gone', 'v1', '{}'::jsonb, '{}'::jsonb, 'user', 'u-alice', $1, $1)`, [NOW]);
    for (const run of ["kept", "gone"]) {
      await queueItem(db, `q-${run}`, `workflow:run-${run}:think`);
      await assistantTurn(db, `e-${run}`, `q-${run}`);
    }
    await db.query(`INSERT INTO engine_entries (id, session_id, thread_id, entry_type, role, model, usage, cost, created_at)
      VALUES ('e-session-step', 'wf:run-kept:draft', 'th', 'message', 'assistant', 'claude', $1, $2, $3)`, [USAGE, COST, NOW]);

    // The database as the previous release left it: Thread-step turns on the
    // assistant, runs without an org, and one workflow already deleted.
    await db.query("UPDATE usage_entry_facts SET session_id = $1, workflow_run_id = NULL WHERE entry_id IN ('e-kept', 'e-gone')", [ASSISTANT]);
    await db.query("DELETE FROM workflow_definitions WHERE id = 'wf-gone'");
    await db.query("DROP TRIGGER workflow_runs_org ON workflow_runs");
    await db.query("DROP FUNCTION valet_workflow_run_org()");
    await db.query("ALTER TABLE workflow_runs DROP COLUMN org_id CASCADE");
    await db.query("DROP VIEW usage_step_attribution_ready");
    // Both assistant turns and the kept run's session step counted. The
    // deleted workflow's session step never had a definition to count under.
    const before = 3 * 0.003;

    await applyAppMigrations(db);

    expect(await missingSchemaRepairs(db)).toEqual([]);
    expect((await db.query("SELECT id, org_id FROM workflow_runs ORDER BY id")).rows).toEqual([
      { id: "run-gone", org_id: null }, { id: "run-kept", org_id: "org-a" },
    ]);
    expect(await factFor(db, "e-kept")).toEqual({ session_id: "wf:run-kept:think", workflow_run_id: "run-kept" });
    expect(await factFor(db, "e-gone")).toEqual({ session_id: ASSISTANT, workflow_run_id: null });
    const after = await orgTotals(db);
    expect(after.ledger).toBeCloseTo(before);
    expect(after.hourly).toBeCloseTo(before);
    expect(after.daily).toBeCloseTo(before);

    await db.query("DELETE FROM workflow_definitions WHERE id = 'wf-kept'");
    expect(await orgTotals(db)).toEqual(after);
  });
});
