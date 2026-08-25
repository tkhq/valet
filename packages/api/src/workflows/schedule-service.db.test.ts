/**
 * DB-backed tests for `updateWorkflowSchedule`. Pure-function tests live in
 * `schedule-service.test.ts`; this file owns anything that touches PGlite.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freshTestPgDb } from "../test-helpers/pg-test-db.js";
import { workflowDefinitions } from "../schema/index.js";
import {
  createWorkflowSchedule,
  updateWorkflowSchedule,
  nextFireAt,
} from "./schedule-service.js";
import type { AppDb } from "../lib/drizzle.js";

let db: AppDb;
let cleanup: () => Promise<void>;

const USER = { id: "user_1", orgId: "org_1" };
const OWNER = { userId: "user_1", orgId: "org_1" };
const NOW = Date.UTC(2026, 0, 15, 12, 30, 0);

beforeAll(async () => {
  const boot = await freshTestPgDb();
  db = boot.appDb;
  cleanup = boot.cleanup;
});

afterAll(async () => {
  await cleanup();
});

describe("updateWorkflowSchedule", () => {
  it("updates name and enabled without recomputing nextFireAt", async () => {
    const created = await createWorkflowSchedule(
      db,
      USER,
      { prompt: "daily digest", name: "digest", cron: "0 9 * * *" },
      NOW,
    );
    if (!created.ok) throw new Error(created.error);
    const before = created.schedule.nextFireAt;

    const updated = await updateWorkflowSchedule(
      db,
      OWNER,
      created.schedule.scheduleId,
      { name: "morning digest", enabled: false },
      NOW + 1000,
    );
    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    expect(updated.schedule.name).toBe("morning digest");
    expect(updated.schedule.enabled).toBe(false);
    expect(updated.schedule.nextFireAt).toBe(before);
  });

  it("recomputes nextFireAt when cron changes", async () => {
    const created = await createWorkflowSchedule(
      db,
      USER,
      { prompt: "p", name: "s", cron: "0 9 * * *" },
      NOW,
    );
    if (!created.ok) throw new Error(created.error);

    const updated = await updateWorkflowSchedule(
      db,
      OWNER,
      created.schedule.scheduleId,
      { cron: "0 18 * * *" },
      NOW,
    );
    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    const expected = nextFireAt("0 18 * * *", "UTC", NOW);
    if (!expected.ok) throw new Error(expected.error);
    expect(updated.schedule.nextFireAt).toBe(expected.at);
  });

  it("recomputes nextFireAt on re-enable so a stale slot does not fire immediately", async () => {
    const created = await createWorkflowSchedule(
      db,
      USER,
      { prompt: "p", name: "s", cron: "0 9 * * *" },
      NOW,
    );
    if (!created.ok) throw new Error(created.error);
    await updateWorkflowSchedule(
      db,
      OWNER,
      created.schedule.scheduleId,
      { enabled: false },
      NOW,
    );

    const later = NOW + 7 * 24 * 3600 * 1000;
    const updated = await updateWorkflowSchedule(
      db,
      OWNER,
      created.schedule.scheduleId,
      { enabled: true },
      later,
    );
    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    expect(updated.schedule.nextFireAt).toBeGreaterThan(later);
  });

  it("rejects an invalid cron with a corrective error and 400", async () => {
    const created = await createWorkflowSchedule(
      db,
      USER,
      { prompt: "p", name: "s", cron: "0 9 * * *" },
      NOW,
    );
    if (!created.ok) throw new Error(created.error);
    const updated = await updateWorkflowSchedule(
      db,
      OWNER,
      created.schedule.scheduleId,
      { cron: "not a cron" },
      NOW,
    );
    expect(updated.ok).toBe(false);
    if (updated.ok) return;
    expect(updated.status).toBe(400);
    expect(updated.error).toContain("5-field");
  });

  it("returns 404 for an unknown id or another org's schedule", async () => {
    const missing = await updateWorkflowSchedule(
      db,
      OWNER,
      "nope",
      { name: "x" },
      NOW,
    );
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.status).toBe(404);

    const created = await createWorkflowSchedule(
      db,
      USER,
      { prompt: "p", name: "s", cron: "0 9 * * *" },
      NOW,
    );
    if (!created.ok) throw new Error(created.error);
    const crossOrg = await updateWorkflowSchedule(
      db,
      { userId: USER.id, orgId: "org_other" },
      created.schedule.scheduleId,
      { name: "x" },
      NOW,
    );
    expect(crossOrg.ok).toBe(false);
    if (!crossOrg.ok) expect(crossOrg.status).toBe(404);
  });

  it("rejects prompt on a workflow-target schedule", async () => {
    const now = NOW;
    await db.insert(workflowDefinitions).values({
      id: "wf_1",
      orgId: USER.orgId,
      ownerType: "user",
      ownerId: USER.id,
      name: "test workflow",
      definition: { version: "dag/v1", nodes: [], edges: [] },
      createdAt: now,
      updatedAt: now,
    });

    const created = await createWorkflowSchedule(
      db,
      USER,
      { workflowId: "wf_1", name: "s", cron: "0 9 * * *" },
      NOW,
    );
    if (!created.ok) throw new Error(created.error);
    const updated = await updateWorkflowSchedule(
      db,
      OWNER,
      created.schedule.scheduleId,
      { prompt: "nope" },
      NOW,
    );
    expect(updated.ok).toBe(false);
    if (updated.ok) return;
    expect(updated.status).toBe(400);
    expect(updated.error).toContain("orchestrator");
  });
});
