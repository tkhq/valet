/**
 * DB-backed tests for `updateWorkflowTrigger`. Uses the same PGlite harness
 * as Task 1 (`schedule-service.db.test.ts`), with the real github plugin for
 * `validateSubscription`.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import githubPlugin from "@valet/plugin-github/plugin";
import { freshTestPgDb } from "../test-helpers/pg-test-db.js";
import { eventSubscriptions, workflowDefinitions } from "../schema/index.js";
import {
  createWorkflowTrigger,
  updateWorkflowTrigger,
} from "./trigger-service.js";
import type { AppDb } from "../lib/drizzle.js";

let db: AppDb;
let cleanup: () => Promise<void>;

const USER = { id: "user_1", orgId: "org_1" };

beforeAll(async () => {
  const boot = await freshTestPgDb();
  db = boot.appDb;
  cleanup = boot.cleanup;

  const now = Date.now();
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
});

afterAll(async () => {
  await cleanup();
});

describe("updateWorkflowTrigger", () => {
  it("updates name/eventKeys/enabled and returns the summary", async () => {
    const created = await createWorkflowTrigger(db, [githubPlugin], USER, {
      workflowId: "wf_1",
      name: "original",
      eventKeys: ["github.pull_request.opened"],
    });
    if (!created.ok) throw new Error(created.error);
    const triggerId = created.trigger.triggerId;

    const updated = await updateWorkflowTrigger(db, [githubPlugin], "org_1", triggerId, {
      name: "renamed",
      enabled: false,
    });
    expect(updated.ok).toBe(true);
    if (updated.ok) {
      expect(updated.trigger.name).toBe("renamed");
      expect(updated.trigger.enabled).toBe(false);
    }
  });

  it("re-validates merged eventKeys/filters and 400s with the validator message", async () => {
    const created = await createWorkflowTrigger(db, [githubPlugin], USER, {
      workflowId: "wf_1",
      name: "to-invalidate",
      eventKeys: ["github.pull_request.opened"],
    });
    if (!created.ok) throw new Error(created.error);
    const triggerId = created.trigger.triggerId;

    const updated = await updateWorkflowTrigger(db, [githubPlugin], "org_1", triggerId, {
      eventKeys: ["github.no_such_event"],
    });
    expect(updated.ok).toBe(false);
    if (!updated.ok) expect(updated.status).toBe(400);
  });

  it("404s for unknown ids, cross-org rows, and non-workflow subscriptions", async () => {
    // Unknown id
    const missing = await updateWorkflowTrigger(db, [githubPlugin], "org_1", "nope", {
      name: "x",
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.status).toBe(404);

    // Cross-org: trigger exists under a different org
    const created = await createWorkflowTrigger(db, [githubPlugin], USER, {
      workflowId: "wf_1",
      name: "cross-org trigger",
      eventKeys: ["github.pull_request.opened"],
    });
    if (!created.ok) throw new Error(created.error);
    const crossOrg = await updateWorkflowTrigger(
      db,
      [githubPlugin],
      "org_other",
      created.trigger.triggerId,
      { name: "x" },
    );
    expect(crossOrg.ok).toBe(false);
    if (!crossOrg.ok) expect(crossOrg.status).toBe(404);

    // Non-workflow subscription (orchestrator target) — must 404 through this seam
    const now = Date.now();
    const orchId = randomUUID();
    await db.insert(eventSubscriptions).values({
      id: orchId,
      orgId: USER.orgId,
      ownerType: "user",
      ownerId: USER.id,
      name: "orch sub",
      eventKeys: ["github.pull_request.opened"],
      filters: [],
      target: { kind: "orchestrator" },
      enabled: true,
      createdBy: USER.id,
      createdAt: now,
      updatedAt: now,
    });
    const orchUpdate = await updateWorkflowTrigger(db, [githubPlugin], "org_1", orchId, {
      name: "should-fail",
    });
    expect(orchUpdate.ok).toBe(false);
    if (!orchUpdate.ok) expect(orchUpdate.status).toBe(404);
  });
});
