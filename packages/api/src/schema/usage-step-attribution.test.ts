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
import { beforeEach, describe, expect, it } from "vitest";
import type { Usage } from "@earendil-works/pi-ai/compat";
import type { PgDb } from "@valet/store-postgres";
import type { AppDb } from "../lib/drizzle.js";
import { freshTestPgDb } from "../test-helpers/pg-test-db.js";
import { prepareUsageStepAttribution } from "../lib/usage-step-attribution.js";
import { recordLlmStepUsage, stepUsageEntry } from "../workflows/step-usage.js";

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
});

describe("stepUsageEntry", () => {
  it("follows the engine's rule: no tokens means no entry, no price means unpriced", () => {
    expect(stepUsageEntry(piUsage(0, 0))).toBeNull();
    expect(stepUsageEntry(piUsage(10, 0))).toEqual({ usage: { input: 10, output: 0, cacheRead: 0, cacheWrite: 0, total: 10 } });
    expect(stepUsageEntry(piUsage(10, 0.5))?.cost?.total).toBe(0.5);
  });
});
