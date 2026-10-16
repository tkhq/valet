/**
 * `WorkflowScheduler` — previously zero direct test coverage. Scoped here
 * to the run-ownership bug: a fired schedule must bill the WORKFLOW
 * definition's own owner, not whoever created the schedule.
 *
 * The fixture below seeds a `workflow_schedules` row directly (not through
 * `createWorkflowSchedule`, which — post-fix — refuses to create a row
 * shaped this way: see `schedule-service.test.ts`'s authorization suite).
 * The scenario still matters because the fix is forward-only: any schedule
 * created before it shipped, where the creator differs from the target
 * workflow's owner, persists in the database untouched. This test proves
 * the FIRE-time behavior is correct for such a row regardless of how it
 * got there — new rows can no longer be created this way, but the
 * scheduler must still bill correctly for the ones that already exist.
 */
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { InMemoryWorkflowStore, type RunHost, type RunParams } from "@valet/workflow";
import { buildAppDb, buildAppQueryable, applyAppMigrations, type AppDb } from "../lib/drizzle.js";
import { workflowDefinitions, workflowSchedules } from "../schema/index.js";
import { WorkflowScheduler } from "./scheduler.js";
import { PinUnavailableError, PIN_UNAVAILABLE_MESSAGE, type DeliveryDestination } from "../events/assistant-delivery.js";
import { eq } from "drizzle-orm";

/** The thread a recording delivery fake reports it landed in. */
const LANDED = { sessionId: "sess-landed", threadId: "thr-landed" };

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
  it.each(["user", "team", "org"] as const)("uses the workflow owner and a safe %s actor when the schedule creator differs", async (ownerType) => {
    await db.insert(workflowDefinitions).values({
      id: "wf_1",
      orgId: "org-1",
      ownerType,
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
      deliverToAssistant: async () => {
        throw new Error("not exercised by a workflow-target fire");
      },
      now: () => 1_000,
    });

    await scheduler.tick();

    expect(runHost.started).toHaveLength(1);
    // Shared automations cannot inherit the original creator's personal share.
    expect(runHost.started[0]!.owner).toEqual({ ownerType, ownerId: "workflow-owner", actorUserId: ownerType === "user" ? "schedule-creator" : `${ownerType}:workflow-owner` });
  });
});

 it("delivers a team prompt schedule without its creator's identity", async () => {
    await db.insert(workflowSchedules).values({
      id: "team-prompt", orgId: "org-1", ownerType: "team", ownerId: "team-1",
      targetKind: "orchestrator", prompt: "A teammate changed this prompt", name: "Team prompt",
      cron: "0 * * * *", timezone: "UTC", enabled: true, nextFireAt: 500,
      createdBy: "original-creator", createdAt: 100, updatedAt: 200,
    });
    const actors: string[] = [];
    const scheduler = new WorkflowScheduler({
      db, workflowStore: new InMemoryWorkflowStore(), workflowRunHost: new RecordingRunHost(),
      deliverToAssistant: async (args) => { actors.push(args.actorUserId); return LANDED; }, now: () => 1000,
    });
    await scheduler.tick();
    expect(actors).toEqual(["team:team-1"]);
  });

describe("WorkflowScheduler thread policy", () => {
  async function seedPromptSchedule(id: string, threadPolicy: unknown) {
    await db.insert(workflowSchedules).values({
      id, orgId: "org-1", ownerType: "user", ownerId: "user-1",
      targetKind: "orchestrator", prompt: "Summarize the night", name: "Morning summary",
      cron: "0 * * * *", timezone: "UTC", enabled: true, nextFireAt: 500,
      createdBy: "user-1", createdAt: 100, updatedAt: 100, threadPolicy,
    });
  }

  it("lands two firings of an own-policy schedule in schedule:<id> titled by its name", async () => {
    await seedPromptSchedule("sched-own", null);
    const destinations: DeliveryDestination[] = [];
    let clock = 1_000;
    const scheduler = new WorkflowScheduler({
      db, workflowStore: new InMemoryWorkflowStore(), workflowRunHost: new RecordingRunHost(),
      deliverToAssistant: async (args) => { destinations.push(args.destination); return LANDED; }, now: () => clock,
    });
    await scheduler.tick();
    // Move the clock past the next slot so the schedule fires again.
    clock = 10_000_000;
    await scheduler.tick();
    expect(destinations).toEqual([
      { kind: "key", key: "schedule:sched-own", title: "Morning summary", reason: "policy_own" },
      { kind: "key", key: "schedule:sched-own", title: "Morning summary", reason: "policy_own" },
    ]);
  });

  it("keys a new-policy firing on its slot", async () => {
    await seedPromptSchedule("sched-new", { mode: "new" });
    const destinations: DeliveryDestination[] = [];
    const scheduler = new WorkflowScheduler({
      db, workflowStore: new InMemoryWorkflowStore(), workflowRunHost: new RecordingRunHost(),
      deliverToAssistant: async (args) => { destinations.push(args.destination); return LANDED; }, now: () => 1_000,
    });
    await scheduler.tick();
    expect(destinations).toEqual([
      { kind: "key", key: "schedule:sched-new:500", title: "Morning summary · 1970-01-01", reason: "policy_new" },
    ]);
  });

  it("disables a schedule whose pinned thread cannot receive deliveries", async () => {
    await seedPromptSchedule("sched-pin", { mode: "existing", sessionId: "sess-1", threadId: "thr-1" });
    const destinations: DeliveryDestination[] = [];
    const scheduler = new WorkflowScheduler({
      db, workflowStore: new InMemoryWorkflowStore(), workflowRunHost: new RecordingRunHost(),
      deliverToAssistant: async (args) => { destinations.push(args.destination); throw new PinUnavailableError(); }, now: () => 1_000,
    });
    await scheduler.tick();
    expect(destinations).toEqual([{ kind: "target", sessionId: "sess-1", threadId: "thr-1", reason: "policy_existing" }]);
    const [row] = await db.select().from(workflowSchedules).where(eq(workflowSchedules.id, "sched-pin"));
    expect(row?.enabled).toBe(false);
    expect(PIN_UNAVAILABLE_MESSAGE).toBe("Pick another thread for this rule in Presence.");
  });
});
