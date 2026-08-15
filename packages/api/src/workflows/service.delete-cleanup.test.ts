/**
 * DB-backed tests for `deleteWorkflowDefinition` trigger cleanup and
 * `listRecentWorkflowRuns`. Uses the same PGlite harness as the other
 * workflow service tests.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import githubPlugin from "@valet/plugin-github/plugin";
import { freshTestPgDb } from "../test-helpers/pg-test-db.js";
import { eventSubscriptions, workflowSchedules } from "../schema/index.js";
import { eq } from "drizzle-orm";
import {
  createWorkflowDefinition,
  deleteWorkflowDefinition,
  listRecentWorkflowRuns,
} from "./service.js";
import { createWorkflowSchedule } from "./schedule-service.js";
import { createWorkflowTrigger } from "./trigger-service.js";
import { PgWorkflowStore } from "./pg-store.js";
import type { RunHost } from "@valet/workflow";
import type { AppDb } from "../lib/drizzle.js";
import type { WorkflowServiceDeps, WorkflowOwner } from "./service.js";

/** Minimal run-host stub: this test file never starts or cancels runs. */
const stubRunHost: RunHost = {
  async start() {},
  async wake() {},
  async scheduleWake() {},
  async terminate() {},
  startHost() {},
  async stopHost() {},
};

let db: AppDb;
let cleanup: () => Promise<void>;
let deps: WorkflowServiceDeps;

const OWNER: WorkflowOwner = { userId: "user_1", orgId: "org_1" };
// schedule-service and trigger-service use { id, orgId } for the user arg
const USER = { id: OWNER.userId, orgId: OWNER.orgId };
const NOW = Date.UTC(2026, 0, 15, 12, 30, 0);

beforeAll(async () => {
  const boot = await freshTestPgDb();
  db = boot.appDb;
  cleanup = boot.cleanup;

  const store = new PgWorkflowStore(boot.pgdb);
  deps = { db, workflowStore: store, workflowRunHost: stubRunHost };
});

afterAll(async () => {
  await cleanup();
});

describe("deleteWorkflowDefinition trigger cleanup", () => {
  it("deletes schedules and event-trigger subscriptions for the workflow", async () => {
    const def = await createWorkflowDefinition(deps, OWNER, {
      name: "trigger-cleanup-test",
      definition: { version: "dag/v1", nodes: [], edges: [] },
    });

    // Seed a schedule targeting this workflow
    const sched = await createWorkflowSchedule(
      db,
      USER,
      { workflowId: def.id, name: "daily", cron: "0 9 * * *" },
      NOW,
    );
    if (!sched.ok) throw new Error(sched.error);

    // Seed an event trigger targeting this workflow
    const trigger = await createWorkflowTrigger(db, [githubPlugin], USER, {
      workflowId: def.id,
      name: "on-pr",
      eventKeys: ["github.pull_request.opened"],
    });
    if (!trigger.ok) throw new Error(trigger.error);

    // Verify they exist before delete
    const schedBefore = await db
      .select()
      .from(workflowSchedules)
      .where(eq(workflowSchedules.workflowId, def.id));
    expect(schedBefore).toHaveLength(1);

    const subBefore = await db
      .select()
      .from(eventSubscriptions)
      .where(eq(eventSubscriptions.id, trigger.trigger.triggerId));
    expect(subBefore).toHaveLength(1);

    // Delete the workflow
    const result = await deleteWorkflowDefinition(deps, OWNER, def.id);
    expect(result).toBe("deleted");

    // Schedules must be gone
    const schedAfter = await db
      .select()
      .from(workflowSchedules)
      .where(eq(workflowSchedules.workflowId, def.id));
    expect(schedAfter).toHaveLength(0);

    // Event subscriptions must be gone
    const subAfter = await db
      .select()
      .from(eventSubscriptions)
      .where(eq(eventSubscriptions.id, trigger.trigger.triggerId));
    expect(subAfter).toHaveLength(0);
  });
});

describe("listRecentWorkflowRuns", () => {
  it("returns [] when there are no workflow definitions", async () => {
    // Use a fresh owner with no definitions
    const emptyOwner: WorkflowOwner = { userId: "user_empty", orgId: "org_empty" };
    const runs = await listRecentWorkflowRuns(deps, emptyOwner);
    expect(runs).toEqual([]);
  });
});
