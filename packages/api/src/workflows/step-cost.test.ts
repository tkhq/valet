/**
 * Model spend per step of a run (the run page's Steps list). Every model call
 * bills to `wf:{runId}:{nodeId}[:{iteration}]`; a `workflow` step adds the
 * spend of the runs it started.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { NodeCheckpoint } from "@valet/workflow";
import type { PgDb } from "@valet/store-postgres";
import type { AppDb } from "../lib/drizzle.js";
import { freshTestPgDb } from "../test-helpers/pg-test-db.js";
import { workflowRunStepCosts } from "./step-cost.js";

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

    const children: Record<string, NodeCheckpoint[]> = {
      "run-child": [checkpoint("run-child", "nested", { childRunId: "run-grandchild" })],
      "run-grandchild": [],
    };
    const store = { getCheckpoints: async (runId: string) => children[runId] ?? [] };
    const costs = await workflowRunStepCosts(appDb, store, "run-1", [
      checkpoint("run-1", "draft"), checkpoint("run-1", "call", { childRunId: "run-child" }),
    ]);

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
});
