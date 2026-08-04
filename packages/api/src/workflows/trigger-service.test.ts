/**
 * `trigger-service.ts` unit tests. Scoped to authorization: this file
 * previously had zero coverage. `createWorkflowTrigger`'s
 * `validateSubscription` call needs a real event-key catalog to get past,
 * so tests supply a minimal fixture `ValetPlugin` — its `verify`/`toEvent`
 * are never invoked here, only `catalog`.
 */
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ValetPlugin } from "@valet/engine";
import { buildAppDb, buildAppQueryable, applyAppMigrations, type AppDb } from "../lib/drizzle.js";
import { workflowDefinitions } from "../schema/index.js";
import { createWorkflowTrigger } from "./trigger-service.js";

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

beforeAll(async () => {
  pglite = new PGlite();
  await applyAppMigrations(buildAppQueryable(pglite));
  db = buildAppDb(pglite);
});

afterAll(async () => {
  await pglite.close();
});

beforeEach(async () => {
  await buildAppQueryable(pglite).query(`TRUNCATE workflow_definitions, event_subscriptions RESTART IDENTITY CASCADE`);
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

    const result = await createWorkflowTrigger(db, FIXTURE_PLUGINS, { id: "other-org-member", orgId: "org-1" }, {
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

    const result = await createWorkflowTrigger(db, FIXTURE_PLUGINS, { id: "owner-user", orgId: "org-1" }, {
      workflowId: "wf_1",
      name: "trig",
      eventKeys: ["fixture.thing_happened"],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.trigger.workflowId).toBe("wf_1");
  });
});
