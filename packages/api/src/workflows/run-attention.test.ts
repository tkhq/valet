import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { NodeCheckpoint, RunSettledInfo } from "@valet/workflow";
import { applyAppMigrations, buildAppDb, buildAppQueryable, type AppDb } from "../lib/drizzle.js";
import { notifications, workflowDefinitions } from "../schema/index.js";
import { buildRunSettledAttention, failedNodeSummary } from "./run-attention.js";

function checkpoint(overrides: Partial<NodeCheckpoint> & { nodeId: string }): NodeCheckpoint {
  return {
    runId: "run-1",
    iteration: 0,
    status: "completed",
    attempt: 1,
    createdAt: 1_000,
    ...overrides,
  };
}

function settled(overrides: Partial<RunSettledInfo> = {}): RunSettledInfo {
  return {
    runId: "run-1",
    workflowId: "wf-1",
    outcome: "failed",
    owner: { ownerType: "user", ownerId: "u-1" },
    settledAt: 5_000,
    ...overrides,
  };
}

describe("failedNodeSummary", () => {
  it("names the failed nodes and their errors", () => {
    const summary = failedNodeSummary([
      checkpoint({ nodeId: "fetch", status: "completed" }),
      checkpoint({ nodeId: "call-api", status: "failed", error: "HTTP 500" }),
    ]);
    expect(summary).toBe("call-api: HTTP 500. Open the run to see the full error.");
  });

  it("labels a foreach body row with its iteration and counts the rest", () => {
    const summary = failedNodeSummary([
      checkpoint({ nodeId: "body", iteration: 1, status: "failed", error: "a" }),
      checkpoint({ nodeId: "body", iteration: 2, status: "failed", error: "b" }),
      checkpoint({ nodeId: "body", iteration: 3, status: "failed", error: "c" }),
    ]);
    expect(summary).toBe("body[1]: a; body[2]: b (+1 more). Open the run to see the full error.");
  });

  it("still directs the reader to the run when no checkpoint failed", () => {
    const summary = failedNodeSummary([checkpoint({ nodeId: "t" })]);
    expect(summary).toBe("Open the run to see why it stopped.");
  });

  it("truncates a long error rather than pasting a whole response body", () => {
    const summary = failedNodeSummary([checkpoint({ nodeId: "n", status: "failed", error: "x".repeat(500) })]);
    expect(summary).toContain("…");
    expect(summary.length).toBeLessThan(300);
  });
});

describe("buildRunSettledAttention", () => {
  let db: AppDb;
  let pglite: PGlite;

  const store = {
    getCheckpoints: async (): Promise<NodeCheckpoint[]> => [
      checkpoint({ nodeId: "call-api", status: "failed", error: "HTTP 500" }),
    ],
  };

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
      `TRUNCATE workflow_definitions, notifications RESTART IDENTITY CASCADE`,
    );
    await db.insert(workflowDefinitions).values({
      id: "wf-1",
      orgId: "org-1",
      ownerType: "user",
      ownerId: "u-1",
      name: "Customer artifacts",
      definition: { version: "dag/v1", nodes: [], edges: [] },
      createdAt: 1_000,
      updatedAt: 1_000,
    });
  });

  it("notifies the owner of a failed top-level run, naming the workflow and the failed node", async () => {
    await buildRunSettledAttention({ db, store })(settled());

    const rows = await db.select().from(notifications);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      userId: "u-1",
      kind: "notification",
      urgency: "high",
      title: "Workflow run failed: Customer artifacts",
      body: "call-api: HTTP 500. Open the run to see the full error.",
      href: "/workflows/runs/run-1",
    });
  });

  it("inserts once when the settle is reported twice", async () => {
    const notify = buildRunSettledAttention({ db, store });
    await notify(settled());
    await notify(settled());

    expect(await db.select().from(notifications)).toHaveLength(1);
  });

  it("stays silent for a child run, so a batch fan-out cannot flood the table", async () => {
    await buildRunSettledAttention({ db, store })(
      settled({ runId: "child-1", parentRunId: "run-1", parentNodeId: "call", parentIteration: 0 }),
    );

    expect(await db.select().from(notifications)).toHaveLength(0);
  });

  it("stays silent for a completed or cancelled run", async () => {
    const notify = buildRunSettledAttention({ db, store });
    await notify(settled({ outcome: "completed" }));
    await notify(settled({ outcome: "cancelled" }));

    expect(await db.select().from(notifications)).toHaveLength(0);
  });

  it("stays silent when the run recorded no owner", async () => {
    await buildRunSettledAttention({ db, store })(settled({ owner: undefined }));

    expect(await db.select().from(notifications)).toHaveLength(0);
  });

  it("falls back to the workflow id when the definition has been deleted", async () => {
    await buildRunSettledAttention({ db, store })(settled({ workflowId: "wf-gone" }));

    const rows = await db.select().from(notifications);
    expect(rows[0]?.title).toBe("Workflow run failed: wf-gone");
  });

  it("swallows a store fault, because a throw here would abandon the drive", async () => {
    const brokenStore = {
      getCheckpoints: async (): Promise<NodeCheckpoint[]> => {
        throw new Error("store unreachable");
      },
    };

    await expect(buildRunSettledAttention({ db, store: brokenStore })(settled())).resolves.toBeUndefined();
    expect(await db.select().from(notifications)).toHaveLength(0);
  });
});
