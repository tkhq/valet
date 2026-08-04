import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildAppDb, buildAppQueryable, applyAppMigrations, type AppDb } from "../lib/drizzle.js";
import { workflowDefinitions } from "../schema/index.js";
import { createWorkflowSchedule, nextFireAt } from "./schedule-service.js";
import { scheduledRunId } from "./scheduler.js";

describe("nextFireAt", () => {
  const base = Date.UTC(2026, 0, 15, 12, 30, 0); // 2026-01-15T12:30:00Z (Thursday)

  it("computes the next occurrence strictly after `from`", () => {
    const result = nextFireAt("0 * * * *", "UTC", base);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(new Date(result.at).toISOString()).toBe("2026-01-15T13:00:00.000Z");
    }
  });

  it("respects the timezone", () => {
    // 09:00 in Denver (UTC-7 in January) = 16:00 UTC.
    const result = nextFireAt("0 9 * * *", "America/Denver", base);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(new Date(result.at).toISOString()).toBe("2026-01-15T16:00:00.000Z");
    }
  });

  it("rejects non-5-field expressions", () => {
    const result = nextFireAt("0 * * *", "UTC", base);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("5-field");
  });

  it("rejects unparseable field values", () => {
    const result = nextFireAt("99 * * * *", "UTC", base);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("invalid cron");
  });

  it("rejects unknown timezones with an IANA hint", () => {
    const result = nextFireAt("0 * * * *", "Mars/Olympus_Mons", base);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("IANA");
  });
});

describe("scheduledRunId", () => {
  it("is deterministic per (schedule, slot) and distinct across slots", () => {
    const a = scheduledRunId("0a1b2c3d-4e5f-6789-abcd-ef0123456789", 1000);
    expect(a).toBe(scheduledRunId("0a1b2c3d-4e5f-6789-abcd-ef0123456789", 1000));
    expect(a).not.toBe(scheduledRunId("0a1b2c3d-4e5f-6789-abcd-ef0123456789", 2000));
    expect(a).toMatch(/^wfrun_sch_[a-z0-9]{8}_1000$/);
  });
});

describe("createWorkflowSchedule authorization", () => {
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
    await buildAppQueryable(pglite).query(`TRUNCATE workflow_definitions, workflow_schedules RESTART IDENTITY CASCADE`);
  });

  async function seedWorkflow(id: string, ownerId: string, orgId = "org-1"): Promise<void> {
    await db.insert(workflowDefinitions).values({
      id,
      orgId,
      ownerType: "user",
      ownerId,
      name: "target",
      definition: { version: "dag/v1", nodes: [], edges: [] },
      createdAt: 1_000,
      updatedAt: 1_000,
    });
  }

  it("rejects scheduling a workflow owned by a different user in the SAME org", async () => {
    await seedWorkflow("wf_1", "owner-user", "org-1");

    const result = await createWorkflowSchedule(
      db,
      { id: "other-org-member", orgId: "org-1" },
      { workflowId: "wf_1", name: "sched", cron: "0 * * * *" },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("wf_1");
  });

  it("allows the actual owner to schedule their own workflow", async () => {
    await seedWorkflow("wf_1", "owner-user", "org-1");

    const result = await createWorkflowSchedule(
      db,
      { id: "owner-user", orgId: "org-1" },
      { workflowId: "wf_1", name: "sched", cron: "0 * * * *" },
    );

    expect(result.ok).toBe(true);
  });
});
