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
  armableDefinitionRow,
  cancelWorkflowRun,
  copyWorkflowDefinition,
  createWorkflowDefinition,
  deleteWorkflowDefinition,
  getWorkflowDefinition,
  listWorkflowDefinitions,
  resolveWorkflowApproval,
  startWorkflowRun,
  updateWorkflowDefinition,
} from "./service.js";
import { PgWorkflowStore } from "./pg-store.js";
import type { WorkflowOwner, WorkflowServiceDeps } from "./service.js";

/** Records the owner every start is stamped with; this suite starts no real
 * run, and the owner is the thing under test. */
const started: Array<{ ownerType: string; ownerId: string; actorUserId?: string } | undefined> = [];

const stubRunHost: RunHost = {
  async start(_runId, _params, _definition, owner) {
    started.push(owner);
  },
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

  // An org source publishes to the whole org. Before this, `isAuthorizedForOwner`
  // answered false for every org-owned row, so an org source mirrored workflows
  // that no route could read, list, or run: write-only rows.
  it("lets an org member read a workflow an org source mirrored", async () => {
    const now = Date.now();
    await db.insert(workflowDefinitions).values({
      id: "wf_org",
      orgId: OWNER.orgId,
      ownerType: "org",
      ownerId: OWNER.orgId,
      name: "Org nightly",
      definition: GRAPH,
      origin: "repo",
      sourceId: SOURCE,
      upstreamPath: ".valet/workflows/org.yaml",
      contentSha: "blob-org",
      createdAt: now,
      updatedAt: now,
    });

    const summary = await getWorkflowDefinition(deps, OWNER, "wf_org");
    expect(summary?.ownerType).toBe("org");
    // The list and the single read must agree: a row one admits and the other
    // refuses is a workflow the list shows and every other route 404s.
    const listed = await listWorkflowDefinitions(deps, OWNER);
    expect(listed.map((w) => w.id)).toContain("wf_org");

    // Another org cannot reach it.
    const outsider = { userId: "user_2", orgId: "org_other" };
    expect(await getWorkflowDefinition(deps, outsider, "wf_org")).toBeNull();
    expect((await listWorkflowDefinitions(deps, outsider)).map((w) => w.id)).not.toContain("wf_org");

    // Readable is not writable: it still mirrors a file.
    await expect(updateWorkflowDefinition(deps, OWNER, "wf_org", { name: "x" })).rejects.toThrow(
      RepoOwnedWorkflowError,
    );
  });

  // The whole basis of the read/act split. A manual run is the caller's, so
  // it resolves the caller's own credentials. An armed trigger would run as
  // the workflow's owner, which for an org row means the org's stored
  // credentials, so arming is gated on `armableDefinitionRow` instead.
  it("lets a member RUN an org workflow as themselves, but not arm a trigger on it", async () => {
    const now = Date.now();
    await db.insert(workflowDefinitions).values({
      id: "wf_org_run",
      orgId: OWNER.orgId,
      ownerType: "org",
      ownerId: OWNER.orgId,
      name: "Org runnable",
      definition: GRAPH,
      origin: "repo",
      sourceId: SOURCE,
      upstreamPath: ".valet/workflows/runnable.yaml",
      contentSha: "blob-run",
      createdAt: now,
      updatedAt: now,
    });

    started.length = 0;
    const run = await startWorkflowRun(deps, OWNER, "wf_org_run");
    expect(run).not.toBeNull();
    expect(run).toHaveProperty("runId");

    // Not org-owned: the run bills the person who pressed it, so it resolves
    // their credentials and not the org's.
    expect(started).toHaveLength(1);
    expect(started[0]?.ownerType).toBe("user");
    expect(started[0]?.ownerId).toBe(OWNER.userId);
    expect(started[0]?.actorUserId).toBe(OWNER.userId);

    // And the act predicate refuses the same caller, who is not an org admin.
    expect(await armableDefinitionRow(db, OWNER, "wf_org_run")).toBeNull();
  });

  it("starts a team workflow as the team and records the clicker as actor", async () => {
    const { createTeam } = await import("../services/teams.js");
    const team = await createTeam(db, {
      orgId: OWNER.orgId,
      name: "Run actor team",
      creatorUserId: OWNER.userId,
    });
    const now = Date.now();
    await db.insert(workflowDefinitions).values({
      id: "wf_team_run",
      orgId: OWNER.orgId,
      ownerType: "team",
      ownerId: team.id,
      name: "Team runnable",
      definition: GRAPH,
      createdAt: now,
      updatedAt: now,
    });

    started.length = 0;
    const run = await startWorkflowRun(deps, OWNER, "wf_team_run");
    expect(run).not.toBeNull();
    expect(started).toHaveLength(1);
    expect(started[0]?.ownerType).toBe("team");
    expect(started[0]?.ownerId).toBe(team.id);
    expect(started[0]?.actorUserId).toBe(OWNER.userId);
  });

  // The read/act split has to reach the RUN paths too. A run started by a
  // schedule copies the definition's owner, so an org-owned mirrored workflow
  // produces org-owned runs, and resolving one's approval gate is what makes
  // the action run with the org's stored credentials.
  it("refuses a plain member resolving an approval on an org-owned run", async () => {
    const now = Date.now();
    await db.insert(workflowDefinitions).values({
      id: "wf_org_gate",
      orgId: OWNER.orgId,
      ownerType: "org",
      ownerId: OWNER.orgId,
      name: "Org gated",
      definition: GRAPH,
      origin: "repo",
      sourceId: SOURCE,
      upstreamPath: ".valet/workflows/gate.yaml",
      contentSha: "blob-gate",
      createdAt: now,
      updatedAt: now,
    });

    // The member reads it, which is the org-wide capability that is intended.
    expect(await getWorkflowDefinition(deps, OWNER, "wf_org_gate")).not.toBeNull();

    // And is refused every act on its runs. `ownedRun` answers not_found for
    // a non-admin, so both surface as the ordinary missing-run result.
    expect(await cancelWorkflowRun(deps, OWNER, "wfrun_org")).toBe("not_found");
    expect(
      await resolveWorkflowApproval(deps, OWNER, {
        runId: "wfrun_org",
        nodeId: "gate",
        approved: true,
        scope: "run",
        via: "web",
      }),
    ).toBe("not_found");
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
