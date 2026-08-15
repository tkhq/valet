/**
 * DB-backed tests for `WorkflowScheduler.fireNow`. Uses the same PGlite
 * harness as `schedule-service.db.test.ts` (`freshTestPgDb`).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { freshTestPgDb } from "../test-helpers/pg-test-db.js";
import { workflowDefinitions } from "../schema/index.js";
import {
  createWorkflowSchedule,
  listWorkflowSchedules,
  updateWorkflowSchedule,
} from "./schedule-service.js";
import { WorkflowScheduler, scheduledRunId } from "./scheduler.js";
import type { AppDb } from "../lib/drizzle.js";
import type { RunHost } from "@valet/workflow";
import type { OrchestratorDeliverFn } from "../events/dispatcher.js";
import { PgWorkflowStore } from "./pg-store.js";
import type { PgDb } from "@valet/store-postgres";

let db: AppDb;
let pgdb: PgDb;
let cleanup: () => Promise<void>;

const USER = { id: "user_1", orgId: "org_1" };
const FIXED_NOW = Date.UTC(2026, 0, 20, 10, 0, 0); // 2026-01-20T10:00:00Z

beforeAll(async () => {
  const boot = await freshTestPgDb();
  db = boot.appDb;
  pgdb = boot.pgdb;
  cleanup = boot.cleanup;
});

afterAll(async () => {
  await cleanup();
});

/** Full-shape RunHost stub — no casts. */
function makeRunHost(): { host: RunHost; start: ReturnType<typeof vi.fn> } {
  const start = vi.fn().mockResolvedValue(undefined);
  const host: RunHost = {
    start,
    wake: vi.fn().mockResolvedValue(undefined),
    scheduleWake: vi.fn().mockResolvedValue(undefined),
    terminate: vi.fn().mockResolvedValue(undefined),
    startHost: vi.fn(),
    stopHost: vi.fn().mockResolvedValue(undefined),
  };
  return { host, start };
}

/** Recording stub for `deliverToOrchestrator`. */
function makeDeliver(): { deliver: OrchestratorDeliverFn; calls: ReturnType<typeof vi.fn> } {
  const calls = vi.fn().mockResolvedValue(undefined);
  const deliver: OrchestratorDeliverFn = (args) => (calls(args) as Promise<void>);
  return { deliver, calls };
}

function buildScheduler(host: RunHost, deliver: OrchestratorDeliverFn): WorkflowScheduler {
  return new WorkflowScheduler({
    db,
    workflowStore: new PgWorkflowStore(pgdb),
    workflowRunHost: host,
    deliverToOrchestrator: deliver,
    now: () => FIXED_NOW,
  });
}

describe("WorkflowScheduler.fireNow", () => {
  it("fires an orchestrator schedule and does not advance nextFireAt", async () => {
    const created = await createWorkflowSchedule(
      db,
      USER,
      { prompt: "daily digest", name: "orch-sched-a", cron: "0 9 * * *" },
      FIXED_NOW - 1000,
    );
    if (!created.ok) throw new Error(created.error);
    const scheduleId = created.schedule.scheduleId;
    const before = created.schedule.nextFireAt;

    const { deliver, calls } = makeDeliver();
    const { host } = makeRunHost();
    const scheduler = buildScheduler(host, deliver);

    const result = await scheduler.fireNow("org_1", scheduleId);
    expect(result).toBe("ok");
    expect(calls).toHaveBeenCalledTimes(1);
    expect(calls.mock.calls[0][0].dispatchId).toBe(`schedule:${scheduleId}:${FIXED_NOW}`);

    const schedules = await listWorkflowSchedules(db, "org_1");
    const after = schedules.find((s) => s.scheduleId === scheduleId)!;
    expect(after.nextFireAt).toBe(before); // nextFireAt must not change
    expect(after.lastFiredAt).toBe(FIXED_NOW);
  });

  it("fires a workflow schedule through runHost.start with the derived runId", async () => {
    await db.insert(workflowDefinitions).values({
      id: "wf_fire_b",
      orgId: USER.orgId,
      ownerType: "user",
      ownerId: USER.id,
      name: "test workflow b",
      definition: { version: "dag/v1", nodes: [], edges: [] },
      createdAt: FIXED_NOW,
      updatedAt: FIXED_NOW,
    });

    const created = await createWorkflowSchedule(
      db,
      USER,
      { workflowId: "wf_fire_b", name: "wf-sched-b", cron: "0 9 * * *" },
      FIXED_NOW - 1000,
    );
    if (!created.ok) throw new Error(created.error);
    const scheduleId = created.schedule.scheduleId;

    const { deliver } = makeDeliver();
    const { host, start } = makeRunHost();
    const scheduler = buildScheduler(host, deliver);

    const result = await scheduler.fireNow("org_1", scheduleId);
    expect(result).toBe("ok");
    expect(start).toHaveBeenCalledTimes(1);
    expect(start.mock.calls[0][0]).toBe(scheduledRunId(scheduleId, FIXED_NOW));
  });

  it("returns not_found for cross-org and unknown ids", async () => {
    const created = await createWorkflowSchedule(
      db,
      USER,
      { prompt: "p", name: "cross-org-sched-c", cron: "0 9 * * *" },
      FIXED_NOW - 1000,
    );
    if (!created.ok) throw new Error(created.error);
    const scheduleId = created.schedule.scheduleId;

    const { deliver } = makeDeliver();
    const { host } = makeRunHost();
    const scheduler = buildScheduler(host, deliver);

    expect(await scheduler.fireNow("org_other", scheduleId)).toBe("not_found");
    expect(await scheduler.fireNow("org_1", "nope")).toBe("not_found");
  });

  it("fires a disabled schedule (manual fire is the test path)", async () => {
    const created = await createWorkflowSchedule(
      db,
      USER,
      { prompt: "p", name: "disabled-sched-d", cron: "0 9 * * *" },
      FIXED_NOW - 1000,
    );
    if (!created.ok) throw new Error(created.error);
    const scheduleId = created.schedule.scheduleId;

    await updateWorkflowSchedule(db, USER.orgId, scheduleId, { enabled: false }, FIXED_NOW - 500);

    const { deliver, calls } = makeDeliver();
    const { host } = makeRunHost();
    const scheduler = buildScheduler(host, deliver);

    const result = await scheduler.fireNow("org_1", scheduleId);
    expect(result).toBe("ok");
    expect(calls).toHaveBeenCalledTimes(1);

    const schedules = await listWorkflowSchedules(db, "org_1");
    const after = schedules.find((s) => s.scheduleId === scheduleId)!;
    // Still disabled — fireNow must not re-enable.
    expect(after.enabled).toBe(false);
    expect(after.lastFiredAt).toBe(FIXED_NOW);
  });
});
