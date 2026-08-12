import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildAppDb, buildAppQueryable, applyAppMigrations, type AppDb } from "../lib/drizzle.js";
import { teamMembers, teams, workflowDefinitions, workflowSchedules } from "../schema/index.js";
import { createWorkflowSchedule, deleteWorkflowSchedule, listWorkflowSchedules, nextFireAt } from "./schedule-service.js";
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
    await buildAppQueryable(pglite).query(
      `TRUNCATE workflow_definitions, workflow_schedules, teams, team_members RESTART IDENTITY CASCADE`,
    );
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

  it("allows the actual owner to schedule their own workflow, stamped with the OWNER's id, not necessarily the creator's", async () => {
    await seedWorkflow("wf_1", "owner-user", "org-1");

    const result = await createWorkflowSchedule(
      db,
      { id: "owner-user", orgId: "org-1" },
      { workflowId: "wf_1", name: "sched", cron: "0 * * * *" },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.schedule).toBeDefined();
    const rows = await db.select().from(workflowSchedules).where(eq(workflowSchedules.id, result.schedule.scheduleId));
    expect(rows[0]?.ownerType).toBe("user");
    expect(rows[0]?.ownerId).toBe("owner-user");
  });

  it("allows a team member (not just the workflow's creator) to schedule a team-owned workflow, and stamps the schedule ORG-owned — not the creating member", async () => {
    await db.insert(teams).values({ id: "team_1", orgId: "org-1", name: "Platform", createdAt: 1_000 });
    await db.insert(teamMembers).values({ teamId: "team_1", userId: "member-user", role: "member" });
    await db.insert(workflowDefinitions).values({
      id: "wf_1",
      orgId: "org-1",
      ownerType: "team",
      ownerId: "team_1",
      name: "target",
      definition: { version: "dag/v1", nodes: [], edges: [] },
      createdAt: 1_000,
      updatedAt: 1_000,
    });

    const result = await createWorkflowSchedule(
      db,
      { id: "member-user", orgId: "org-1" },
      { workflowId: "wf_1", name: "sched", cron: "0 * * * *" },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // `workflow_schedules.owner_type` has no `team` value (unlike
    // `workflow_definitions`) — org is the closest accurate mapping, not
    // the creating member. Doesn't affect run billing either way: a
    // workflow-target run always bills `def.ownerType`/`ownerId` directly
    // (`scheduler.ts`'s `fire()`), never this field.
    const rows = await db.select().from(workflowSchedules).where(eq(workflowSchedules.id, result.schedule.scheduleId));
    expect(rows[0]?.ownerType).toBe("org");
    expect(rows[0]?.ownerId).toBe("org-1");
  });

  it("rejects scheduling an org-owned workflow — org-owned definitions aren't authorized for anyone yet (matches services/skills.ts's identical, documented gap: nothing creates one)", async () => {
    await db.insert(workflowDefinitions).values({
      id: "wf_1",
      orgId: "org-1",
      ownerType: "org",
      ownerId: "org-1",
      name: "target",
      definition: { version: "dag/v1", nodes: [], edges: [] },
      createdAt: 1_000,
      updatedAt: 1_000,
    });

    const result = await createWorkflowSchedule(
      db,
      { id: "any-org-member", orgId: "org-1" },
      { workflowId: "wf_1", name: "sched", cron: "0 * * * *" },
    );

    expect(result.ok).toBe(false);
  });

  it("rejects scheduling a team-owned workflow for a non-member", async () => {
    await db.insert(teams).values({ id: "team_1", orgId: "org-1", name: "Platform", createdAt: 1_000 });
    await db.insert(workflowDefinitions).values({
      id: "wf_1",
      orgId: "org-1",
      ownerType: "team",
      ownerId: "team_1",
      name: "target",
      definition: { version: "dag/v1", nodes: [], edges: [] },
      createdAt: 1_000,
      updatedAt: 1_000,
    });

    const result = await createWorkflowSchedule(
      db,
      { id: "outsider-user", orgId: "org-1" },
      { workflowId: "wf_1", name: "sched", cron: "0 * * * *" },
    );

    expect(result.ok).toBe(false);
  });
});

describe("listWorkflowSchedules / deleteWorkflowSchedule scope (documented, deliberately unchanged by this fix)", () => {
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

  it("any org member can list and delete a schedule they didn't create — org-shared visibility, matching event_subscriptions' own documented model, NOT the creation-time ownership bug this file's other describe block fixes", async () => {
    await db.insert(workflowDefinitions).values({
      id: "wf_1",
      orgId: "org-1",
      ownerType: "user",
      ownerId: "owner-user",
      name: "target",
      definition: { version: "dag/v1", nodes: [], edges: [] },
      createdAt: 1_000,
      updatedAt: 1_000,
    });
    const created = await createWorkflowSchedule(
      db,
      { id: "owner-user", orgId: "org-1" },
      { workflowId: "wf_1", name: "sched", cron: "0 * * * *" },
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const listedByOther = await listWorkflowSchedules(db, "org-1");
    expect(listedByOther.map((s) => s.scheduleId)).toContain(created.schedule.scheduleId);

    const deletedByOther = await deleteWorkflowSchedule(db, "org-1", created.schedule.scheduleId);
    expect(deletedByOther).toBe("ok");
  });
});
