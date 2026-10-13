/**
 * Model changes between runs: a step that called different models than in
 * the previous run with the same steps is flagged. An edit or a first run
 * has nothing to compare against.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { PgDb } from "@valet/store-postgres";
import type { AppDb } from "../lib/drizzle.js";
import { workflowRuns } from "../schema/index.js";
import { freshTestPgDb } from "../test-helpers/pg-test-db.js";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { seedWorkflowRun } from "../test-helpers/workflow-run.js";
import type { GetWorkflowRunResponse } from "../wire/types.js";
import { workflowRunStepCosts } from "./step-cost.js";
import { workflowRunModelChanges } from "./model-drift.js";

const NOW = 1_700_000_000_000;
const STEPS = {
  version: "dag/v1",
  nodes: [{ id: "draft", type: "session", prompt: "Draft", model: "l" }, { id: "review", type: "llm", prompt: "Review", model: "s" }],
  edges: [{ from: "draft", to: "review" }],
};
const noCheckpoints = { getCheckpoints: async () => [] };

async function run(db: AppDb, id: string, createdAt: number, definition: unknown): Promise<void> {
  await db.insert(workflowRuns).values({
    id, workflowId: "wf-1", definitionVersionId: id, definition, params: { workflowId: "wf-1", definitionVersionId: id },
    ownerType: "user", ownerId: "u-1", createdAt, updatedAt: createdAt,
  });
}

async function call(db: PgDb, id: string, sessionId: string, model: string): Promise<void> {
  await db.query(`INSERT INTO engine_entries (id, session_id, thread_id, entry_type, role, model, usage, cost, created_at)
    VALUES ($1, $2, 'th', 'message', 'assistant', $3, '{"total":10}', '{"total":0.01}', $4)`, [id, sessionId, model, NOW]);
}

async function changes(appDb: AppDb, runId: string, createdAt: number, definition: unknown) {
  const stepCosts = await workflowRunStepCosts(appDb, noCheckpoints, runId);
  return workflowRunModelChanges(appDb, noCheckpoints, { runId, workflowId: "wf-1", createdAt, definition }, stepCosts);
}

describe("workflowRunModelChanges", () => {
  let db: PgDb;
  let appDb: AppDb;

  beforeEach(async () => {
    ({ pgdb: db, appDb } = await freshTestPgDb());
  });

  it("flags a step whose model the platform remapped while the steps stayed the same", async () => {
    await run(appDb, "run-1", NOW, STEPS);
    await call(db, "e-1", "wf:run-1:draft", "sol-5.6");
    await call(db, "e-2", "wf:run-1:review", "claude-haiku-4-5");
    // Moving a node on the map is not an edit to the steps.
    const moved = { ...STEPS, ui: { nodes: { draft: { position: { x: 40, y: 80 } } } } };
    await run(appDb, "run-2", NOW + 1000, moved);
    await call(db, "e-3", "wf:run-2:draft", "sol-6.1");
    await call(db, "e-4", "wf:run-2:review", "claude-haiku-4-5");

    expect(await changes(appDb, "run-2", NOW + 1000, moved)).toEqual([
      { nodeId: "draft", previous: ["sol-5.6"], current: ["sol-6.1"] },
    ]);
  });

  it("does not flag a model change that follows an edit to the steps", async () => {
    await run(appDb, "run-1", NOW, STEPS);
    await call(db, "e-1", "wf:run-1:draft", "sol-5.6");
    const edited = { ...STEPS, nodes: [{ ...STEPS.nodes[0], model: "xl" }, STEPS.nodes[1]] };
    await run(appDb, "run-2", NOW + 1000, edited);
    await call(db, "e-2", "wf:run-2:draft", "sol-6.1");

    expect(await changes(appDb, "run-2", NOW + 1000, edited)).toEqual([]);
  });

  it("does not flag the first run of a workflow", async () => {
    await run(appDb, "run-1", NOW, STEPS);
    await call(db, "e-1", "wf:run-1:draft", "sol-6.1");
    // A later run is not a previous run.
    await run(appDb, "run-2", NOW + 1000, STEPS);
    await call(db, "e-2", "wf:run-2:draft", "sol-5.6");

    expect(await changes(appDb, "run-1", NOW, STEPS)).toEqual([]);
  });
});

describe("model changes on the run page", () => {
  let api: TestApi | undefined;
  afterEach(async () => { await api?.cleanup(); api = undefined; });

  it("returns the run's model changes from the run route", async () => {
    api = await bootTestApi();
    const p = api.providers;
    await seedWorkflowRun(p.db, { runId: "run-1", orgId: "local-org", owner: { type: "user", id: "local-user" } });
    // The seeded run has no steps. The next run of the same workflow has the same ones.
    const [first] = await p.db.select().from(workflowRuns);
    await p.db.insert(workflowRuns).values({ ...first, id: "run-2", createdAt: first.createdAt + 1000, updatedAt: first.createdAt + 1000 });
    for (const [id, sessionId, model] of [["e-1", "wf:run-1:draft", "sol-5.6"], ["e-2", "wf:run-2:draft", "sol-6.1"]]) {
      await p.db.execute(sql`INSERT INTO engine_entries (id, session_id, thread_id, entry_type, role, model, usage, cost, created_at)
        VALUES (${id}, ${sessionId}, 'th', 'message', 'assistant', ${model}, '{"total":10}', '{"total":0.01}', ${NOW})`);
    }

    const res = await fetch(`${api.baseUrl}/api/workflows/runs/run-2`);
    expect(res.status).toBe(200);
    const body = await res.json() as GetWorkflowRunResponse;
    expect(body.modelChanges).toEqual([{ nodeId: "draft", previous: ["sol-5.6"], current: ["sol-6.1"] }]);
  });
});
