/**
 * DB-backed tests for `updateWorkflowSchedule`. Pure-function tests live in
 * `schedule-service.test.ts`; this file owns anything that touches PGlite.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { InMemoryCredentialStore } from "@valet/engine";
import type { ValetPlugin } from "@valet/engine";
import { freshTestPgDb } from "../test-helpers/pg-test-db.js";
import { teams, teamMembers, workflowDefinitions, workflowSchedules } from "../schema/index.js";
import { eq } from "drizzle-orm";
import {
  createWorkflowSchedule,
  updateWorkflowSchedule,
  nextFireAt,
} from "./schedule-service.js";
import type { AppDb } from "../lib/drizzle.js";

/** Arm-gate deps for the create calls. Every workflow in this file is
 * user-owned, so the team readiness gate never runs. */
const armDeps = () => ({ db, credentials: new InMemoryCredentialStore(), plugins: [] });


let db: AppDb;
let cleanup: () => Promise<void>;

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
      armDeps(),
      OWNER,
      { prompt: "daily digest", name: "digest", cron: "0 9 * * *" },
      NOW,
    );
    if (!created.ok) throw new Error(created.error);
    const before = created.schedule.nextFireAt;

    const updated = await updateWorkflowSchedule(
      armDeps(),
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
      armDeps(),
      OWNER,
      { prompt: "p", name: "s", cron: "0 9 * * *" },
      NOW,
    );
    if (!created.ok) throw new Error(created.error);

    const updated = await updateWorkflowSchedule(
      armDeps(),
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
      armDeps(),
      OWNER,
      { prompt: "p", name: "s", cron: "0 9 * * *" },
      NOW,
    );
    if (!created.ok) throw new Error(created.error);
    await updateWorkflowSchedule(
      armDeps(),
      OWNER,
      created.schedule.scheduleId,
      { enabled: false },
      NOW,
    );

    const later = NOW + 7 * 24 * 3600 * 1000;
    const updated = await updateWorkflowSchedule(
      armDeps(),
      OWNER,
      created.schedule.scheduleId,
      { enabled: true },
      later,
    );
    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    expect(updated.schedule.nextFireAt).toBeGreaterThan(later);
  });

  // The scheduler stamps `disabled_reason` when it disables a schedule for a
  // dead pin (spec 2026-10-16: presence hub, Part D). The person's fix, a new
  // pin or a re-enable, clears it.
  describe("disabledReason", () => {
    const PIN_TEXT = "Pick another thread in Presence.";
    async function disabledByPin(): Promise<string> {
      const created = await createWorkflowSchedule(armDeps(), OWNER, { prompt: "p", name: "pin", cron: "0 9 * * *" }, NOW);
      if (!created.ok) throw new Error(created.error);
      await db.update(workflowSchedules).set({ enabled: false, disabledReason: PIN_TEXT })
        .where(eq(workflowSchedules.id, created.schedule.scheduleId));
      return created.schedule.scheduleId;
    }

    it("exposes the reason on a schedule the scheduler disabled", async () => {
      const id = await disabledByPin();
      const updated = await updateWorkflowSchedule(armDeps(), OWNER, id, { name: "renamed" }, NOW);
      if (!updated.ok) throw new Error(updated.error);
      expect(updated.schedule.disabledReason).toBe(PIN_TEXT);
      expect(updated.schedule.enabled).toBe(false);
    });

    it("clears the reason when the schedule is enabled", async () => {
      const id = await disabledByPin();
      const updated = await updateWorkflowSchedule(armDeps(), OWNER, id, { enabled: true }, NOW);
      if (!updated.ok) throw new Error(updated.error);
      expect(updated.schedule.disabledReason).toBeUndefined();
      const [row] = await db.select().from(workflowSchedules).where(eq(workflowSchedules.id, id));
      expect(row?.disabledReason).toBeNull();
    });

    it.each([
      "Its prompt is empty. Edit the routine and add a prompt.",
      "Its workflow was deleted. Edit the routine and pick another workflow.",
      "Its schedule does not parse. Edit the routine and fix the schedule.",
    ])("clears the scheduler reason %s when the schedule is enabled", async (reason) => {
      const id = await disabledByPin();
      await db.update(workflowSchedules).set({ disabledReason: reason }).where(eq(workflowSchedules.id, id));
      const updated = await updateWorkflowSchedule(armDeps(), OWNER, id, { enabled: true }, NOW);
      if (!updated.ok) throw new Error(updated.error);
      expect(updated.schedule.disabledReason).toBeUndefined();
      const [row] = await db.select().from(workflowSchedules).where(eq(workflowSchedules.id, id));
      expect(row?.disabledReason).toBeNull();
    });

    it("clears the reason when the pin changes", async () => {
      const id = await disabledByPin();
      const updated = await updateWorkflowSchedule(armDeps(), OWNER, id, { thread: { mode: "new" } }, NOW);
      if (!updated.ok) throw new Error(updated.error);
      expect(updated.schedule.disabledReason).toBeUndefined();
      const [row] = await db.select().from(workflowSchedules).where(eq(workflowSchedules.id, id));
      expect(row?.disabledReason).toBeNull();
    });
  });

  it("rejects an invalid cron with a corrective error and 400", async () => {
    const created = await createWorkflowSchedule(
      armDeps(),
      OWNER,
      { prompt: "p", name: "s", cron: "0 9 * * *" },
      NOW,
    );
    if (!created.ok) throw new Error(created.error);
    const updated = await updateWorkflowSchedule(
      armDeps(),
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
      armDeps(),
      OWNER,
      "nope",
      { name: "x" },
      NOW,
    );
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.status).toBe(404);

    const created = await createWorkflowSchedule(
      armDeps(),
      OWNER,
      { prompt: "p", name: "s", cron: "0 9 * * *" },
      NOW,
    );
    if (!created.ok) throw new Error(created.error);
    const crossOrg = await updateWorkflowSchedule(
      armDeps(),
      { userId: OWNER.userId, orgId: "org_other" },
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
      orgId: OWNER.orgId,
      ownerType: "user",
      ownerId: OWNER.userId,
      name: "test workflow",
      definition: { version: "dag/v1", nodes: [], edges: [] },
      createdAt: now,
      updatedAt: now,
    });

    const created = await createWorkflowSchedule(
      armDeps(),
      OWNER,
      { workflowId: "wf_1", name: "s", cron: "0 9 * * *" },
      NOW,
    );
    if (!created.ok) throw new Error(created.error);
    const updated = await updateWorkflowSchedule(
      armDeps(),
      OWNER,
      created.schedule.scheduleId,
      { prompt: "nope" },
      NOW,
    );
    expect(updated.ok).toBe(false);
    if (updated.ok) return;
    expect(updated.status).toBe(400);
    expect(updated.error).toContain("assistant-prompt");
  });
});

// ── Team readiness at arm time (TKAI-444) ─────────────────────────────────
//
// A scheduled team run bills the team, so it resolves the TEAM's
// credentials. Armed over a service the team cannot act as, it fails on
// every fire. The install gate already refuses that; this path must give
// the same answer with the same predicate.

const LINEAR_PLUGIN: ValetPlugin = {
  name: "linear",
  version: "0.0.0",
  credentials: [{ type: "api_key", service: "linear", configKeys: [] }],
};

describe("createWorkflowSchedule team readiness", () => {
  const TEAM = "team-sched";
  const MEMBER = { userId: "member-sched", orgId: "org_1" };

  async function seedTeamWorkflow(id: string): Promise<void> {
    await db.insert(teams).values({ id: TEAM, orgId: MEMBER.orgId, name: "Schedule team", createdAt: NOW }).onConflictDoNothing();
    await db.insert(teamMembers).values({ teamId: TEAM, userId: MEMBER.userId, role: "member" }).onConflictDoNothing();
    await db.insert(workflowDefinitions).values({
      id,
      orgId: MEMBER.orgId,
      ownerType: "team",
      ownerId: TEAM,
      name: "target",
      definition: {
        version: "dag/v1",
        nodes: [
          { id: "start", type: "trigger" },
          { id: "step", type: "tool", service: "linear", action: "do", params: {} },
        ],
        edges: [{ from: "start", to: "step" }],
      },
      createdAt: 1_000,
      updatedAt: 1_000,
    });
  }

  function teamArmDeps(credentials: InMemoryCredentialStore) {
    return { db, credentials, plugins: [LINEAR_PLUGIN], env: {} as NodeJS.ProcessEnv };
  }

  it("refuses a schedule the team cannot run, and names the fix", async () => {
    await seedTeamWorkflow("wf_team_sched_blocked");

    const result = await createWorkflowSchedule(
      teamArmDeps(new InMemoryCredentialStore()),
      MEMBER,
      { workflowId: "wf_team_sched_blocked", name: "nightly", cron: "0 9 * * *" },
      NOW,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("Connect linear for this team, then create the schedule.");
  });

  it("arms once the team holds the credential", async () => {
    await seedTeamWorkflow("wf_team_sched_ready");
    const credentials = new InMemoryCredentialStore();
    await credentials.save({ type: "team", id: TEAM }, "linear", { type: "api_key", apiKey: "k" });

    const result = await createWorkflowSchedule(
      teamArmDeps(credentials),
      MEMBER,
      { workflowId: "wf_team_sched_ready", name: "nightly", cron: "0 9 * * *" },
      NOW,
    );

    expect(result.ok).toBe(true);
  });
});
