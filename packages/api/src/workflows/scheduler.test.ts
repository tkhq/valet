/**
 * `WorkflowScheduler` — previously zero direct test coverage. Scoped here
 * to the run-ownership bug: a fired schedule must bill the WORKFLOW
 * definition's own owner, not whoever created the schedule (which can be
 * a different org member than the workflow's owner since schedule
 * creation is org-scoped, not owner-scoped — see
 * `schedule-service.test.ts`'s authorization suite for the creation-time
 * half of this fix).
 */
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { InMemoryWorkflowStore, type RunHost, type RunParams } from "@valet/workflow";
import { buildAppDb, buildAppQueryable, applyAppMigrations, type AppDb } from "../lib/drizzle.js";
import { workflowDefinitions, workflowSchedules } from "../schema/index.js";
import { WorkflowScheduler } from "./scheduler.js";

class RecordingRunHost implements RunHost {
  started: Array<{ runId: string; params: RunParams; owner?: { ownerType: string; ownerId: string } }> = [];
  async start(
    runId: string,
    params: RunParams,
    _definition: unknown,
    owner?: { ownerType: string; ownerId: string },
  ): Promise<void> {
    this.started.push({ runId, params, owner });
  }
  async wake(): Promise<void> {}
  async scheduleWake(): Promise<void> {}
  async terminate(): Promise<void> {}
  startHost(): void {}
  async stopHost(): Promise<void> {}
}

let db: AppDb;
let pglite: PGlite;

beforeAll(async () => {
  pglite = new PGlite();
  await applyAppMigrations(buildAppQueryable(pglite));
  db = buildAppDb(pglite);
});

afterAll(async () => {
  await pglite.close();
});

beforeEach(async () => {
  await buildAppQueryable(pglite).query(
    `TRUNCATE workflow_definitions, workflow_schedules, workflow_runs RESTART IDENTITY CASCADE`,
  );
});

describe("WorkflowScheduler fire ownership", () => {
  it("bills the WORKFLOW's own owner, not the schedule creator, when they differ", async () => {
    await db.insert(workflowDefinitions).values({
      id: "wf_1",
      orgId: "org-1",
      ownerType: "user",
      ownerId: "workflow-owner",
      name: "target",
      definition: { version: "dag/v1", nodes: [], edges: [] },
      createdAt: 1_000,
      updatedAt: 1_000,
    });
    // Simulates a schedule created by a different org member than the
    // workflow's owner (the pre-fix authz gap in schedule-service.ts let
    // this row exist at all; this test only proves the fire-time fix).
    await db.insert(workflowSchedules).values({
      id: "sch_1",
      orgId: "org-1",
      ownerType: "user",
      ownerId: "schedule-creator",
      targetKind: "workflow",
      workflowId: "wf_1",
      name: "every hour",
      cron: "0 * * * *",
      timezone: "UTC",
      enabled: true,
      nextFireAt: 500,
      createdBy: "schedule-creator",
      createdAt: 100,
      updatedAt: 100,
    });

    const runHost = new RecordingRunHost();
    const scheduler = new WorkflowScheduler({
      db,
      workflowStore: new InMemoryWorkflowStore(),
      workflowRunHost: runHost,
      deliverToOrchestrator: async () => {
        throw new Error("not exercised by a workflow-target fire");
      },
      now: () => 1_000,
    });

    await scheduler.tick();

    expect(runHost.started).toHaveLength(1);
    expect(runHost.started[0]!.owner).toEqual({ ownerType: "user", ownerId: "workflow-owner" });
  });
});
