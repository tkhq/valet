/**
 * `trigger-service.ts` unit tests. Scoped to authorization: this file
 * previously had zero coverage. `createWorkflowTrigger`'s
 * `validateSubscription` call needs a real event-key catalog to get past,
 * so tests supply a minimal fixture `ValetPlugin` — its `verify`/`toEvent`
 * are never invoked here, only `catalog`.
 */
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { InMemoryCredentialStore } from "@valet/engine";
import type { ValetPlugin } from "@valet/engine";
import { buildAppDb, buildAppQueryable, applyAppMigrations, type AppDb } from "../lib/drizzle.js";
import { teamMembers, workflowDefinitions } from "../schema/index.js";
import { createWorkflowTrigger, deleteWorkflowTrigger, listWorkflowTriggers } from "./trigger-service.js";

const FIXTURE_PLUGINS: ValetPlugin[] = [
  {
    name: "fixture",
    version: "0.0.0",
    triggers: [
      {
        id: "fixture.thing_happened",
        service: "fixture",
        description: "test fixture event",
        verify: () => null,
        toEvent: () => {
          throw new Error("not exercised by these tests");
        },
        catalog: [{ key: "fixture.thing_happened", description: "a thing happened", filters: [] }],
      },
    ],
  },
];

let db: AppDb;
let pglite: PGlite;

/** Arm-gate deps for a create call. The authorization tests all target
 * user-owned workflows, so the team readiness gate never runs. */
const armDeps = () => ({ db, credentials: new InMemoryCredentialStore(), plugins: FIXTURE_PLUGINS });

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
    `TRUNCATE workflow_definitions, event_subscriptions, team_members RESTART IDENTITY CASCADE`,
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

describe("createWorkflowTrigger authorization", () => {
  it("rejects wiring a trigger onto a workflow owned by a different user in the SAME org", async () => {
    await seedWorkflow("wf_1", "owner-user", "org-1");

    const result = await createWorkflowTrigger(armDeps(), { userId: "other-org-member", orgId: "org-1" }, {
      workflowId: "wf_1",
      name: "trig",
      eventKeys: ["fixture.thing_happened"],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("wf_1");
  });

  it("allows the actual owner to wire a trigger onto their own workflow", async () => {
    await seedWorkflow("wf_1", "owner-user", "org-1");

    const result = await createWorkflowTrigger(armDeps(), { userId: "owner-user", orgId: "org-1" }, {
      workflowId: "wf_1",
      name: "trig",
      eventKeys: ["fixture.thing_happened"],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.trigger.workflowId).toBe("wf_1");
  });
});

describe("listWorkflowTriggers / deleteWorkflowTrigger owner scoping (TKAI-227)", () => {
  it("another org member cannot list or delete a trigger on a workflow they cannot reach; the owner can do both", async () => {
    await seedWorkflow("wf_1", "owner-user", "org-1");
    const created = await createWorkflowTrigger(armDeps(), { userId: "owner-user", orgId: "org-1" }, {
      workflowId: "wf_1",
      name: "trig",
      eventKeys: ["fixture.thing_happened"],
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const other = { userId: "other-org-member", orgId: "org-1" };
    const listedByOther = await listWorkflowTriggers(db, other);
    expect(listedByOther.map((t) => t.triggerId)).not.toContain(created.trigger.triggerId);
    const deletedByOther = await deleteWorkflowTrigger(db, other, created.trigger.triggerId);
    expect(deletedByOther).toBe("not_found");

    const owner = { userId: "owner-user", orgId: "org-1" };
    const listedByOwner = await listWorkflowTriggers(db, owner);
    expect(listedByOwner.map((t) => t.triggerId)).toContain(created.trigger.triggerId);
    const deletedByOwner = await deleteWorkflowTrigger(db, owner, created.trigger.triggerId);
    expect(deletedByOwner).toBe("ok");
  });
});

// ── Team readiness at arm time (TKAI-444) ─────────────────────────────────
//
// A team trigger bills the team, so an event-fired run resolves the TEAM's
// credentials. Armed over a service the team cannot act as, it fails on
// every event. The install gate already refuses that; this path must give
// the same answer with the same predicate.

const LINEAR_PLUGIN: ValetPlugin = {
  name: "linear",
  version: "0.0.0",
  credentials: [{ type: "api_key", service: "linear", configKeys: [] }],
};

describe("createWorkflowTrigger team readiness", () => {
  const TEAM = "team-1";
  const MEMBER = { userId: "member-1", orgId: "org-1" };

  async function seedTeamWorkflow(id: string): Promise<void> {
    await db.insert(teamMembers).values({ teamId: TEAM, userId: MEMBER.userId, role: "member" });
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
    return {
      db,
      credentials,
      plugins: [...FIXTURE_PLUGINS, LINEAR_PLUGIN],
      env: {} as NodeJS.ProcessEnv,
    };
  }

  it("refuses a trigger the team cannot run, and names the fix", async () => {
    await seedTeamWorkflow("wf_team");

    const result = await createWorkflowTrigger(teamArmDeps(new InMemoryCredentialStore()), MEMBER, {
      workflowId: "wf_team",
      name: "trig",
      eventKeys: ["fixture.thing_happened"],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("Connect linear for this team, then create the trigger.");
  });

  it("arms once the team holds the credential", async () => {
    await seedTeamWorkflow("wf_team");
    const credentials = new InMemoryCredentialStore();
    await credentials.save({ type: "team", id: TEAM }, "linear", { type: "api_key", apiKey: "k" });

    const result = await createWorkflowTrigger(teamArmDeps(credentials), MEMBER, {
      workflowId: "wf_team",
      name: "trig",
      eventKeys: ["fixture.thing_happened"],
    });

    expect(result.ok).toBe(true);
  });
});
