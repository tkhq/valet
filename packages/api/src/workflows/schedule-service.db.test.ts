/**
 * DB-backed tests for `updateWorkflowSchedule`. Pure-function tests live in
 * `schedule-service.test.ts`; this file owns anything that touches PGlite.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { InMemoryCredentialStore } from "@valet/engine";
import type { ValetPlugin } from "@valet/engine";
import { freshTestPgDb } from "../test-helpers/pg-test-db.js";
import { teamMembers, workflowDefinitions } from "../schema/index.js";
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
      armDeps(),
      OWNER,
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
      armDeps(),
      OWNER,
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
      armDeps(),
      OWNER,
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
      armDeps(),
      OWNER,
      { prompt: "p", name: "s", cron: "0 9 * * *" },
      NOW,
    );
    if (!created.ok) throw new Error(created.error);
    const crossOrg = await updateWorkflowSchedule(
      db,
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
