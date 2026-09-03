/**
 * A workflow this deployment mirrors from a file is read-only in the product.
 * Editing the file is the edit, and deleting the file is the delete.
 *
 * Every product write path funnels through `updateWorkflowDefinition` or
 * `deleteWorkflowDefinition` — the REST route, the `workflows.update_workflow`
 * agent action, and `addAggregateNode` — so these cases cover all of them by
 * covering those two. `copyWorkflowDefinition` is the escape hatch, and the
 * last case is the one that says the copy is editable.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { RepoOwnedWorkflowError } from "@valet/shared";
import type { RunHost } from "@valet/workflow";
import { freshTestPgDb } from "../test-helpers/pg-test-db.js";
import type { AppDb } from "../lib/drizzle.js";
import { contentSources, workflowDefinitions, workflowVersions } from "../schema/index.js";
import {
  addAggregateNode,
  copyWorkflowDefinition,
  createWorkflowDefinition,
  deleteWorkflowDefinition,
  getWorkflowDefinition,
  listWorkflowDefinitions,
  updateWorkflowDefinition,
} from "./service.js";
import { PgWorkflowStore } from "./pg-store.js";
import type { WorkflowOwner, WorkflowServiceDeps } from "./service.js";

const stubRunHost: RunHost = {
  async start() {},
  async wake() {},
  async scheduleWake() {},
  async terminate() {},
  startHost() {},
  async stopHost() {},
};

const OWNER: WorkflowOwner = { userId: "user_1", orgId: "org_1" };
const SOURCE = "src_1";
const REPO = "tkhq/automation";
const PATH = ".valet/workflows/nightly.yaml";

const GRAPH = {
  version: "dag/v1",
  nodes: [
    { id: "trigger", type: "trigger" },
    { id: "stop", type: "stop" },
  ],
  edges: [{ from: "trigger", to: "stop" }],
};

let db: AppDb;
let cleanup: () => Promise<void>;
let deps: WorkflowServiceDeps;

beforeAll(async () => {
  const boot = await freshTestPgDb();
  db = boot.appDb;
  cleanup = boot.cleanup;
  deps = { db, workflowStore: new PgWorkflowStore(boot.pgdb), workflowRunHost: stubRunHost };

  const now = Date.now();
  await db.insert(contentSources).values({
    id: SOURCE,
    orgId: OWNER.orgId,
    ownerType: "user",
    ownerId: OWNER.userId,
    repoFullName: REPO,
    ref: "",
    subpath: "",
    kinds: ["workflows"],
    createdAt: now,
    updatedAt: now,
    nextAttemptAt: now,
  });
});

afterAll(async () => {
  await cleanup();
});

/** Two branches with no join, so `addAggregateNode` reaches its write
 * instead of refusing for want of branches to combine. */
const FAN_OUT = {
  version: "dag/v1",
  nodes: [
    { id: "trigger", type: "trigger" },
    { id: "left", type: "set", values: { a: "1" } },
    { id: "right", type: "set", values: { b: "2" } },
  ],
  edges: [
    { from: "trigger", to: "left" },
    { from: "trigger", to: "right" },
  ],
};

/** A mirrored row, written the way the collector writes one. */
async function mirror(id: string, path = PATH, definition: unknown = GRAPH): Promise<string> {
  const now = Date.now();
  await db.insert(workflowDefinitions).values({
    id,
    orgId: OWNER.orgId,
    ownerType: "user",
    ownerId: OWNER.userId,
    name: "Nightly",
    definition,
    origin: "repo",
    sourceId: SOURCE,
    upstreamPath: path,
    contentSha: "blob-1",
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

describe("a mirrored workflow refuses every product write", () => {
  it("refuses an update, naming the file and the repository", async () => {
    const id = await mirror("wf_repo_update");
    await expect(
      updateWorkflowDefinition(deps, OWNER, id, { name: "renamed" }),
    ).rejects.toThrow(RepoOwnedWorkflowError);

    // The message is what a person with the editor open reads, so it has to
    // say where to go.
    const err = await updateWorkflowDefinition(deps, OWNER, id, { name: "renamed" }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(RepoOwnedWorkflowError);
    expect((err as RepoOwnedWorkflowError).message).toContain(PATH);
    expect((err as RepoOwnedWorkflowError).message).toContain(REPO);
    expect((err as RepoOwnedWorkflowError).statusCode).toBe(409);

    const [row] = await db.select().from(workflowDefinitions).where(eq(workflowDefinitions.id, id));
    expect(row.name).toBe("Nightly");
  });

  it("refuses the agent's own edit path through the same guard", async () => {
    const id = await mirror("wf_repo_aggregate", ".valet/workflows/agg.yaml", FAN_OUT);
    // `addAggregateNode` writes through `updateWorkflowDefinition`, so it
    // needs no guard of its own.
    await expect(addAggregateNode(deps, OWNER, id)).rejects.toThrow(RepoOwnedWorkflowError);
  });

  it("refuses a delete, because deleting the file is the delete", async () => {
    const id = await mirror("wf_repo_delete", ".valet/workflows/del.yaml");
    await expect(deleteWorkflowDefinition(deps, OWNER, id)).rejects.toThrow(
      RepoOwnedWorkflowError,
    );
    const rows = await db.select().from(workflowDefinitions).where(eq(workflowDefinitions.id, id));
    expect(rows).toHaveLength(1);
  });

  it("reports its origin and its file to the client", async () => {
    const id = await mirror("wf_repo_summary", ".valet/workflows/summary.yaml");
    const summary = await getWorkflowDefinition(deps, OWNER, id);
    expect(summary?.origin).toBe("repo");
    expect(summary?.upstream).toEqual({
      repoFullName: REPO,
      path: ".valet/workflows/summary.yaml",
    });

    const listed = await listWorkflowDefinitions(deps, OWNER);
    const found = listed.find((w) => w.id === id);
    expect(found?.upstream?.repoFullName).toBe(REPO);
    // A workflow the product owns carries neither field.
    const local = await createWorkflowDefinition(deps, OWNER, { name: "local", definition: GRAPH });
    expect(listed.concat(await listWorkflowDefinitions(deps, OWNER)).find((w) => w.id === local.id)?.origin).toBeUndefined();
  });

  it("copies into a local workflow that does save", async () => {
    const id = await mirror("wf_repo_copy", ".valet/workflows/copy.yaml");
    const copy = await copyWorkflowDefinition(deps, OWNER, id);
    expect(copy).not.toBeNull();
    if (copy === null) throw new Error("unreachable");

    expect(copy.name).toBe("Nightly (copy)");
    expect(copy.definition).toEqual(GRAPH);
    expect(copy.origin).toBeUndefined();
    expect(copy.ownerType).toBe("user");

    // The copy has a version 1, like any workflow the product created.
    const versions = await db
      .select()
      .from(workflowVersions)
      .where(eq(workflowVersions.workflowId, copy.id));
    expect(versions.map((v) => v.version)).toEqual([1]);

    // And it saves, which is the whole point of it.
    const saved = await updateWorkflowDefinition(deps, OWNER, copy.id, { name: "mine" });
    expect(saved?.name).toBe("mine");

    // The original is untouched and still mirroring.
    const [original] = await db
      .select()
      .from(workflowDefinitions)
      .where(eq(workflowDefinitions.id, id));
    expect(original.origin).toBe("repo");
    expect(original.name).toBe("Nightly");
  });

  it("still refuses when the source row is gone, without naming a repository it cannot read", async () => {
    const id = await mirror("wf_repo_orphan", ".valet/workflows/orphan.yaml");
    await db
      .update(workflowDefinitions)
      .set({ sourceId: "src_deleted" })
      .where(eq(workflowDefinitions.id, id));

    const err = await updateWorkflowDefinition(deps, OWNER, id, { name: "x" }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(RepoOwnedWorkflowError);
    expect((err as RepoOwnedWorkflowError).message).toContain(".valet/workflows/orphan.yaml");
  });
});
