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
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { InMemoryWorkflowStore, type RunHost, type RunParams } from "@valet/workflow";
import { buildAppDb, buildAppQueryable, applyAppMigrations, type AppDb } from "../lib/drizzle.js";
import { workflowDefinitions, workflowSchedules } from "../schema/index.js";
import { WorkflowScheduler } from "./scheduler.js";
import { PinUnavailableError, PIN_UNAVAILABLE_MESSAGE, type DeliveryDestination } from "../events/assistant-delivery.js";
import { eq } from "drizzle-orm";
import type { DestinationRecorder } from "../observability/delivery-metrics.js";

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
      targetKind: "assistant", prompt: "A teammate changed this prompt", name: "Team prompt",
      cron: "0 * * * *", timezone: "UTC", enabled: true, nextFireAt: 500,
      createdBy: "original-creator", createdAt: 100, updatedAt: 200,
    });
    const actors: string[] = [];
    const unattended: Array<boolean | undefined> = [];
    const scheduler = new WorkflowScheduler({
      db, workflowStore: new InMemoryWorkflowStore(), workflowRunHost: new RecordingRunHost(),
      deliverToAssistant: async (args) => { actors.push(args.actorUserId); unattended.push(args.unattended); return LANDED; },
      now: () => 1000,
    });
    await scheduler.tick();
    expect(actors).toEqual(["team:team-1"]);
    // No person waits on a scheduled prompt, so it must not park on a question.
    expect(unattended).toEqual([true]);
  });

describe("WorkflowScheduler thread policy", () => {
  async function seedPromptSchedule(id: string, threadPolicy: unknown) {
    await db.insert(workflowSchedules).values({
      id, orgId: "org-1", ownerType: "user", ownerId: "user-1",
      targetKind: "assistant", prompt: "Summarize the night", name: "Morning summary",
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

  it("records the thread each assistant firing landed on", async () => {
    await seedPromptSchedule("sched-landed", null);
    let landed = LANDED;
    let clock = 1_000;
    const scheduler = new WorkflowScheduler({
      db, workflowStore: new InMemoryWorkflowStore(), workflowRunHost: new RecordingRunHost(),
      deliverToAssistant: async () => landed, now: () => clock,
    });
    const stored = async () => {
      const [row] = await db.select().from(workflowSchedules).where(eq(workflowSchedules.id, "sched-landed"));
      return { sessionId: row?.lastFiredSessionId, threadId: row?.lastFiredThreadId };
    };
    await scheduler.tick();
    expect(await stored()).toEqual(LANDED);
    // A later firing on another thread replaces the record, by the poll loop and by Fire.
    landed = { sessionId: "sess-2", threadId: "thr-2" };
    clock = 10_000_000;
    await scheduler.tick();
    expect(await stored()).toEqual({ sessionId: "sess-2", threadId: "thr-2" });
    landed = { sessionId: "sess-3", threadId: "thr-3" };
    expect(await scheduler.fireNow({ userId: "user-1", orgId: "org-1" }, "sched-landed")).toBe("ok");
    expect(await stored()).toEqual({ sessionId: "sess-3", threadId: "thr-3" });
  });

  // Review of PR #999: a policy edit during the firing clears the landing;
  // the firing, chosen under the old policy, must not write it back.
  it("does not record a landing when the thread policy changed during the firing", async () => {
    await seedPromptSchedule("sched-raced", { mode: "new" });
    const scheduler = new WorkflowScheduler({
      db, workflowStore: new InMemoryWorkflowStore(), workflowRunHost: new RecordingRunHost(),
      deliverToAssistant: async () => {
        await db.update(workflowSchedules).set({ threadPolicy: { mode: "own" } }).where(eq(workflowSchedules.id, "sched-raced"));
        return LANDED;
      },
      now: () => 1_000,
    });
    await scheduler.tick();
    const [row] = await db.select().from(workflowSchedules).where(eq(workflowSchedules.id, "sched-raced"));
    expect(row?.lastFiredAt).toBe(1_000);
    expect(row?.lastFiredSessionId).toBeNull();
    expect(row?.lastFiredThreadId).toBeNull();
  });

  it("records no thread for a workflow firing", async () => {
    await db.insert(workflowDefinitions).values({
      id: "wf-landed", orgId: "org-1", ownerType: "user", ownerId: "user-1", name: "Nightly",
      definition: { version: "dag/v1", nodes: [], edges: [] }, createdAt: 100, updatedAt: 100,
    });
    await db.insert(workflowSchedules).values({
      id: "sched-wf-landed", orgId: "org-1", ownerType: "user", ownerId: "user-1", targetKind: "workflow",
      workflowId: "wf-landed", name: "Nightly", cron: "0 * * * *", timezone: "UTC", enabled: true,
      nextFireAt: 500, createdBy: "user-1", createdAt: 100, updatedAt: 100,
    });
    const host = new RecordingRunHost();
    const scheduler = new WorkflowScheduler({
      db, workflowStore: new InMemoryWorkflowStore(), workflowRunHost: host,
      deliverToAssistant: async () => LANDED, now: () => 1_000,
    });
    await scheduler.tick();
    expect(host.started).toHaveLength(1);
    const [row] = await db.select().from(workflowSchedules).where(eq(workflowSchedules.id, "sched-wf-landed"));
    expect(row?.lastFiredAt).toBe(1_000);
    expect([row?.lastFiredSessionId, row?.lastFiredThreadId]).toEqual([null, null]);
  });

  it("starts a workflow run with its schedule's input at the top of trigger.data and under input", async () => {
    await db.insert(workflowDefinitions).values({
      id: "wf-scan", orgId: "org-1", ownerType: "user", ownerId: "user-1", name: "Error scan",
      definition: { version: "dag/v1", nodes: [{ id: "scan", type: "tool", service: "grafana", action: "query", params: { since: "now-{{trigger.data.lookback}}" } }], edges: [] },
      createdAt: 100, updatedAt: 100,
    });
    await db.insert(workflowSchedules).values({
      id: "sched-scan", orgId: "org-1", ownerType: "user", ownerId: "user-1", targetKind: "workflow",
      workflowId: "wf-scan", name: "Morning scan", cron: "0 * * * *", timezone: "UTC", enabled: true,
      input: { lookback: "17h" }, nextFireAt: 500, createdBy: "user-1", createdAt: 100, updatedAt: 100,
    });
    const host = new RecordingRunHost();
    const scheduler = new WorkflowScheduler({
      db, workflowStore: new InMemoryWorkflowStore(), workflowRunHost: host,
      deliverToAssistant: async () => LANDED, now: () => 1_000,
    });
    await scheduler.tick();
    expect(host.started[0]?.params.input).toMatchObject({
      type: "schedule",
      data: { lookback: "17h", scheduleName: "Morning scan", cron: "0 * * * *", input: { lookback: "17h" } },
    });
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
    expect(row?.disabledReason).toBe(PIN_UNAVAILABLE_MESSAGE);
    expect(PIN_UNAVAILABLE_MESSAGE).toBe("Pick another thread in Presence.");
  });

  it("counts a dead pin once, when it disables the schedule", async () => {
    await seedPromptSchedule("sched-pin-count", { mode: "existing", sessionId: "sess-1", threadId: "thr-1" });
    const recordDestination = vi.fn<DestinationRecorder>();
    // Two replicas fire the same slot: each delivery waits until both started.
    let started = 0;
    let bothStarted = () => {};
    const barrier = new Promise<void>((resolve) => { bothStarted = resolve; });
    const deliverToAssistant = async () => {
      if (++started === 2) bothStarted();
      await barrier;
      throw new PinUnavailableError();
    };
    const replica = () => new WorkflowScheduler({
      db, workflowStore: new InMemoryWorkflowStore(), workflowRunHost: new RecordingRunHost(), deliverToAssistant, now: () => 1_000, recordDestination,
    });
    const scheduler = replica();
    await Promise.all([scheduler.tick(), replica().tick()]);
    expect(started).toBe(2);
    expect(recordDestination.mock.calls).toEqual([["pin_unavailable"]]);

    // A manual fire of the disabled schedule answers with the fix text and
    // does not page again.
    expect(await scheduler.fireNow({ userId: "user-1", orgId: "org-1" }, "sched-pin-count")).toEqual({ error: PIN_UNAVAILABLE_MESSAGE });
    expect(recordDestination.mock.calls).toEqual([["pin_unavailable"]]);
  });
});

describe("WorkflowScheduler disable reasons", () => {
  const scheduler = () => new WorkflowScheduler({
    db, workflowStore: new InMemoryWorkflowStore(), workflowRunHost: new RecordingRunHost(),
    deliverToAssistant: async () => LANDED, now: () => 1_000,
  });
  const base = {
    orgId: "org-1", ownerType: "user", ownerId: "user-1", name: "Broken routine",
    timezone: "UTC", enabled: true, nextFireAt: 500, createdBy: "user-1", createdAt: 100, updatedAt: 100,
  } as const;
  async function reasonFor(id: string): Promise<{ enabled: boolean | undefined; disabledReason: string | null | undefined }> {
    await scheduler().tick();
    const [row] = await db.select().from(workflowSchedules).where(eq(workflowSchedules.id, id));
    return { enabled: row?.enabled, disabledReason: row?.disabledReason };
  }

  it("names the fix when a prompt routine has no prompt", async () => {
    await db.insert(workflowSchedules).values({ ...base, id: "no-prompt", targetKind: "assistant", prompt: "  ", cron: "0 * * * *" });
    expect(await reasonFor("no-prompt")).toEqual({ enabled: false, disabledReason: "Its prompt is empty. Edit the routine and add a prompt." });
  });

  it("names the fix when a routine's workflow was deleted", async () => {
    await db.insert(workflowSchedules).values({ ...base, id: "wf-gone", targetKind: "workflow", workflowId: "wf_deleted", cron: "0 * * * *" });
    expect(await reasonFor("wf-gone")).toEqual({ enabled: false, disabledReason: "Its workflow was deleted. Delete this routine and make a new one with another workflow." });
  });

  it("names the fix when a workflow routine has no workflow", async () => {
    await db.insert(workflowSchedules).values({ ...base, id: "wf-null", targetKind: "workflow", workflowId: null, cron: "0 * * * *" });
    expect(await reasonFor("wf-null")).toEqual({ enabled: false, disabledReason: "Its workflow was deleted. Delete this routine and make a new one with another workflow." });
  });

  it("names the fix when a routine's schedule does not parse", async () => {
    await db.insert(workflowSchedules).values({ ...base, id: "bad-cron", targetKind: "assistant", prompt: "p", cron: "not a cron" });
    expect(await reasonFor("bad-cron")).toEqual({ enabled: false, disabledReason: "Its schedule does not parse. Edit the routine and fix the schedule." });
  });
});
