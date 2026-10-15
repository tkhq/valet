/**
 * Model spend per step of a run (the run page's Steps list). Every model call
 * bills to `wf:{runId}:{nodeId}[:{iteration}]`; a `workflow` step adds the
 * spend of the runs it started.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import type { NodeCheckpoint } from "@valet/workflow";
import type { PgDb } from "@valet/store-postgres";
import type { AppDb } from "../lib/drizzle.js";
import { freshTestPgDb } from "../test-helpers/pg-test-db.js";
import { workflowRunStepCosts } from "./step-cost.js";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { seedWorkflowRun } from "../test-helpers/workflow-run.js";
import { getWorkflowRunDetail } from "./service.js";
import type { GetWorkflowRunResponse } from "../wire/types.js";

const NOW = 1_700_000_000_000;

function checkpoint(runId: string, nodeId: string, effects: Record<string, unknown> = {}): NodeCheckpoint {
  return { runId, nodeId, iteration: 0, status: "completed", effects, attempt: 1, createdAt: NOW };
}

async function turn(db: PgDb, id: string, sessionId: string, cost: number | null): Promise<void> {
  await db.query(`INSERT INTO engine_entries (id, session_id, thread_id, entry_type, role, model, usage, cost, created_at)
    VALUES ($1, $2, 'th', 'message', 'assistant', 'claude', $3, $4, $5)`, [
    id, sessionId, JSON.stringify({ input: 10, output: 0, cacheRead: 0, cacheWrite: 0, total: 10 }),
    cost === null ? null : JSON.stringify({ input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost }), NOW,
  ]);
}

describe("workflowRunStepCosts", () => {
  let db: PgDb;
  let appDb: AppDb;

  beforeEach(async () => {
    ({ pgdb: db, appDb } = await freshTestPgDb());
  });

  it("sums each step and iteration, counts unpriced calls, and rolls sub-runs into their step", async () => {
    await turn(db, "e-1", "wf:run-1:draft", 0.01);
    await turn(db, "e-2", "wf:run-1:draft", 0.02);
    await turn(db, "e-3", "wf:run-1:each:1", 0.005);
    await turn(db, "e-4", "wf:run-1:each:1", null);
    await turn(db, "e-5", "wf:run-child:inner", 0.04);
    await turn(db, "e-6", "wf:run-grandchild:deep", 0.001);
    await turn(db, "e-7", "wf:run-other:draft", 9);

    const checkpoints: Record<string, NodeCheckpoint[]> = {
      "run-1": [checkpoint("run-1", "draft"), checkpoint("run-1", "call", { childRunId: "run-child" })],
      "run-child": [checkpoint("run-child", "nested", { childRunId: "run-grandchild" })],
      "run-grandchild": [],
    };
    const store = { getCheckpoints: async (runId: string) => checkpoints[runId] ?? [] };
    const costs = await workflowRunStepCosts(appDb, store, "run-1");

    expect(costs.map(({ nodeId, iteration, turns, unpricedTurns }) => ({ nodeId, iteration, turns, unpricedTurns }))).toEqual([
      { nodeId: "call", iteration: 0, turns: 2, unpricedTurns: 0 },
      { nodeId: "draft", iteration: 0, turns: 2, unpricedTurns: 0 },
      { nodeId: "each", iteration: 1, turns: 2, unpricedTurns: 1 },
    ]);
    expect(costs[0].costUsd).toBeCloseTo(0.041);
    expect(costs[1].costUsd).toBeCloseTo(0.03);
    expect(costs[1].totalTokens).toBe(20);
    expect(costs[1].models).toEqual(["claude"]);
  });

  it("never fails on a session id whose fourth part is not an iteration", async () => {
    await turn(db, "e-odd", "wf:run-2:odd:name", 0.01);
    const store = { getCheckpoints: async () => [] };
    expect((await workflowRunStepCosts(appDb, store, "run-2")).map(({ nodeId, iteration }) => [nodeId, iteration]))
      .toEqual([["odd", 0]]);
  });
});

describe("run step costs on the run page", () => {
  let api: TestApi | undefined;
  afterEach(async () => { await api?.cleanup(); api = undefined; });

  it("returns step costs from the run route only, so other run reads never walk sub-runs", async () => {
    api = await bootTestApi();
    const p = api.providers;
    const owner = { type: "user", id: "local-user" } as const;
    await seedWorkflowRun(p.db, { runId: "run-parent", orgId: "local-org", owner });
    await seedWorkflowRun(p.db, { runId: "run-child", orgId: "local-org", owner });
    await p.db.execute(sql`INSERT INTO workflow_checkpoints (run_id, node_id, iteration, attempt, status, effects, created_at)
      VALUES ('run-parent', 'draft', 0, 1, 'completed', '{}'::jsonb, ${NOW}),
             ('run-parent', 'call', 0, 1, 'completed', ${JSON.stringify({ childRunId: "run-child" })}::jsonb, ${NOW})`);
    for (const [id, sessionId] of [["e-draft", "wf:run-parent:draft"], ["e-inner", "wf:run-child:inner"]]) {
      await p.db.execute(sql`INSERT INTO engine_entries (id, session_id, thread_id, entry_type, role, model, usage, cost, created_at)
        VALUES (${id}, ${sessionId}, 'th', 'message', 'assistant', 'claude', '{"total":10}', '{"total":0.01}', ${NOW})`);
    }

    const res = await fetch(`${api.baseUrl}/api/workflows/runs/run-parent`);
    expect(res.status).toBe(200);
    const body = await res.json() as GetWorkflowRunResponse;
    expect(body.stepCosts?.map(({ nodeId, turns }) => ({ nodeId, turns }))).toEqual([
      { nodeId: "call", turns: 1 }, { nodeId: "draft", turns: 1 },
    ]);

    const reads = vi.spyOn(p.workflowStore, "getCheckpoints");
    const deps = { db: p.db, workflowStore: p.workflowStore, workflowRunHost: p.workflowRunHost, credentials: p.engineCredentials, engineStore: p.engineStore };
    const detail = await getWorkflowRunDetail(deps, { userId: "local-user", orgId: "local-org" }, "run-parent");
    expect(detail?.stepCosts).toBeUndefined();
    expect(reads.mock.calls.map(([runId]) => runId)).toEqual(["run-parent"]);
  });
});
