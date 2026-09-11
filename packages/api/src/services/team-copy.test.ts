import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { InMemoryCredentialStore } from "@valet/engine";
import { InMemoryWorkflowStore, type RunHost } from "@valet/workflow";
import { freshTestPgDb } from "../test-helpers/pg-test-db.js";
import type { AppDb } from "../lib/drizzle.js";
import { memoryFiles, teams, teamMembers, orgMembers, workflowDefinitions, workflowSchedules, workflowWebhooks, eventSubscriptions, workflowVersions } from "../schema/index.js";
import { copyArtifactToTeam, publishArtifact, getArtifactById } from "./artifacts.js";
import { copyFileToTeam, copyFileFromTeam, readOwnFile, writeFile } from "./memory.js";
import { copyWorkflowDefinition, createWorkflowDefinition, type WorkflowServiceDeps } from "../workflows/service.js";

const runHost: RunHost = {
  async start() {}, async wake() {}, async scheduleWake() {}, async terminate() {}, startHost() {}, async stopHost() {},
};
const owner = { userId: "u1", orgId: "org1" };
const scope = { owner: { type: "user", id: "u1" } as const, actorUserId: "u1" };
const graph = { version: "dag/v1", nodes: [{ id: "start", type: "trigger" },
  { id: "child", type: "call", workflowId: "personal-child" }], edges: [{ from: "start", to: "child" }],
  ui: { positions: { start: { x: 10, y: 20 } } } };
let db: AppDb;
let cleanup: () => Promise<void>;
let deps: WorkflowServiceDeps;
beforeEach(async () => {
  const boot = await freshTestPgDb();
  db = boot.appDb; cleanup = boot.cleanup;
  deps = { db, workflowStore: new InMemoryWorkflowStore(), workflowRunHost: runHost, credentials: new InMemoryCredentialStore() };
  await db.insert(orgMembers).values({ orgId: "org1", userId: "u1", role: "member" });
  await db.insert(teams).values({ id: "team1", orgId: "org1", name: "Team", createdAt: 1 });
  await db.insert(teamMembers).values({ teamId: "team1", userId: "u1", role: "admin" });
});
afterEach(async () => { await cleanup(); });

describe("personal memory copy to team", () => {
  const input = { from: "notes/source.md", to: "notes/copy.md", teamId: "team1" };
  it("preserves exact content and metadata, starts a new version and never overwrites", async () => {
    await writeFile(db, scope, { path: input.from, content: "# Original\n\n[Link](notes/private.md)\n", tags: ["a"], description: "Context", pinned: true });
    const before = await readOwnFile(db, scope, input.from);
    const copy = await copyFileToTeam(db, scope, input);
    expect(copy).toMatchObject({ ownerType: "team", ownerId: "team1", path: input.to, version: 1,
      content: before?.content, tags: before?.tags, description: "Context", pinned: true, sourceId: null, sourceSessionId: "" });
    await expect(copyFileToTeam(db, scope, input)).rejects.toThrow(/already exists/);
    expect(await readOwnFile(db, scope, input.from)).toEqual(before);
    expect(await db.select().from(memoryFiles)).toHaveLength(2);
  });
  it("allows only one copy when two requests target the same destination", async () => {
    await writeFile(db, scope, { path: input.from, content: "exact source" });
    const results = await Promise.allSettled([
      copyFileToTeam(db, scope, input), copyFileToTeam(db, scope, input),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(await db.select().from(memoryFiles)).toHaveLength(2);
  });
  it("requires both membership and memory write authority", async () => {
    await writeFile(db, scope, { path: input.from, content: "private" });
    await db.update(teamMembers).set({ role: "member" });
    await expect(copyFileToTeam(db, scope, input)).rejects.toThrow(/team admin/);
    await db.delete(teamMembers);
    await expect(copyFileToTeam(db, scope, input)).rejects.toThrow(/not found/);
    expect(await db.select().from(memoryFiles)).toHaveLength(1);
  });
  it("rejects missing/foreign sources, nonpersonal scopes and reserved destinations", async () => {
    await writeFile(db, { owner: { type: "user", id: "u2" }, actorUserId: "u2" }, { path: input.from, content: "private" });
    await expect(copyFileToTeam(db, scope, input)).rejects.toThrow(/not found/);
    await expect(copyFileToTeam(db, { owner: { type: "user", id: "u2" }, actorUserId: "u1" }, input)).rejects.toThrow(/personal/);
    await expect(copyFileToTeam(db, { owner: { type: "team", id: "team1" }, actorUserId: "u1" }, input)).rejects.toThrow(/personal/);
    await writeFile(db, scope, { path: input.from, content: "own" });
    await expect(copyFileToTeam(db, scope, { ...input, to: "lib/copy.md" })).rejects.toThrow(/reserved/);
  });
});

describe("memory transfer organization authority", () => {
  it("preserves membership-based cross-organization memory access", async () => {
    await db.insert(teams).values({ id: "team2", orgId: "org2", name: "Second org", createdAt: 1 });
    await db.insert(teamMembers).values({ teamId: "team2", userId: "u1", role: "admin" });
    await writeFile(db, scope, { path: "notes/personal.md", content: "Personal knowledge" });
    const pushed = await copyFileToTeam(db, scope, { from: "notes/personal.md", to: "notes/team.md", teamId: "team2" });
    expect(pushed).toMatchObject({ ownerId: "team2", orgId: "org2" });
    const pulled = await copyFileFromTeam(db, scope, { from: "notes/team.md", to: "notes/pulled.md", teamId: "team2" });
    expect(pulled).toMatchObject({ ownerId: "u1", orgId: "", content: "Personal knowledge" });
  });

  it("uses only the target org's admin grant and rejects demotion or removed team membership", async () => {
    await db.update(teamMembers).set({ role: "member" });
    await db.insert(orgMembers).values({ orgId: "org2", userId: "u1", role: "admin" });
    await writeFile(db, scope, { path: "notes/source.md", content: "Personal knowledge" });
    const input = { from: "notes/source.md", to: "notes/team.md", teamId: "team1" };
    await expect(copyFileToTeam(db, scope, input)).rejects.toThrow(/team admin/);
    await db.update(orgMembers).set({ role: "admin" }).where(eq(orgMembers.orgId, "org1"));
    expect(await copyFileToTeam(db, scope, input)).toMatchObject({ ownerId: "team1" });
    await db.update(orgMembers).set({ role: "member" }).where(eq(orgMembers.orgId, "org1"));
    await expect(copyFileToTeam(db, scope, { ...input, to: "notes/denied.md" })).rejects.toThrow(/team admin/);
    await db.update(orgMembers).set({ role: "admin" }).where(eq(orgMembers.orgId, "org1"));
    await db.delete(teamMembers);
    await expect(copyFileToTeam(db, scope, { ...input, to: "notes/denied.md" })).rejects.toThrow(/not found/);
  });
});

describe("team memory pull into personal memory", () => {
  const teamScope = { owner: { type: "team", id: "team1" } as const, actorUserId: "u1" };
  const input = { from: "knowledge/source.md", to: "notes/pulled.md", teamId: "team1" };

  it("allows a member to pull exact knowledge and metadata without changing the original", async () => {
    await writeFile(db, teamScope, { path: input.from, content: "# Knowledge\n\n[Link](other.md)\n",
      tags: ["knowledge"], description: "Team context", pinned: true, sensitivity: "shareable", origin: "user-stated" });
    await writeFile(db, teamScope, { path: input.from, content: "# Updated\n\n[Link](other.md)\n" });
    const before = await readOwnFile(db, teamScope, input.from);
    await db.update(teamMembers).set({ role: "member" });
    const copy = await copyFileFromTeam(db, scope, input);
    expect(copy).toMatchObject({ ownerType: "user", ownerId: "u1", orgId: "", path: input.to, version: 1,
      content: before?.content, tags: before?.tags, description: "Team context", pinned: true,
      sensitivity: "shareable", origin: "user-stated", sourceSessionId: "", sourceId: null,
      upstreamPath: null, contentSha: null });
    expect(await readOwnFile(db, teamScope, input.from)).toEqual(before);
    await writeFile(db, scope, { path: input.to, content: "Independent personal edit" });
    expect(await readOwnFile(db, teamScope, input.from)).toEqual(before);
    await expect(copyFileToTeam(db, scope, { from: input.to, to: "notes/push.md", teamId: "team1" })).rejects.toThrow(/team admin/);
  });

  it("never overwrites an existing destination and serializes concurrent pulls", async () => {
    await writeFile(db, teamScope, { path: input.from, content: "Team source" });
    await writeFile(db, scope, { path: input.to, content: "Keep personal content" });
    const before = await readOwnFile(db, scope, input.to);
    await expect(copyFileFromTeam(db, scope, input)).rejects.toThrow(/Choose another path/);
    expect(await readOwnFile(db, scope, input.to)).toEqual(before);
    const fresh = { ...input, to: "notes/fresh.md" };
    const results = await Promise.allSettled([copyFileFromTeam(db, scope, fresh), copyFileFromTeam(db, scope, fresh)]);
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(await db.select().from(memoryFiles)).toHaveLength(3);
  });

  it("rejects revoked membership, foreign scopes and other teams before copying", async () => {
    await writeFile(db, teamScope, { path: input.from, content: "Team secret" });
    await expect(copyFileFromTeam(db, teamScope, input)).rejects.toThrow(/personal/);
    await expect(copyFileFromTeam(db, { owner: { type: "user", id: "u2" }, actorUserId: "u1" }, input)).rejects.toThrow(/personal/);
    await expect(copyFileFromTeam(db, scope, { ...input, teamId: "other-team" })).rejects.toThrow(/not found/);
    await db.delete(teamMembers);
    await expect(copyFileFromTeam(db, scope, input)).rejects.toThrow(/not found/);
    expect(await db.select().from(memoryFiles)).toHaveLength(1);
  });

  it("requires an exact team source and a writable personal destination", async () => {
    await writeFile(db, scope, { path: input.from, content: "Personal file is not a team source" });
    await expect(copyFileFromTeam(db, scope, input)).rejects.toThrow(/not found/);
    await writeFile(db, teamScope, { path: input.from, content: "Team source" });
    await expect(copyFileFromTeam(db, scope, { ...input, from: "knowledge/" })).rejects.toThrow(/not found/);
    for (const to of ["lib/reserved.md", "team:other/copy.md", "../escape.md"]) {
      await expect(copyFileFromTeam(db, scope, { ...input, to })).rejects.toThrow();
    }
    await expect(copyFileFromTeam(db, scope, { ...input, from: "team:team1/knowledge/source.md" })).rejects.toThrow();
    expect(await db.select().from(memoryFiles)).toHaveLength(2);
  });
});

describe("personal workflow copy to team", () => {
  it("copies the JSON verbatim and version history starts fresh, while all original triggers stay unchanged", async () => {
    const source = await createWorkflowDefinition(deps, owner, { name: "Original", definition: graph });
    const before = await db.select().from(workflowDefinitions);
    await db.insert(workflowSchedules).values({ id: "schedule", orgId: "org1", ownerId: "u1", workflowId: source.id,
      name: "daily", cron: "0 0 * * *", nextFireAt: 9999999999999, createdBy: "u1", createdAt: 1, updatedAt: 1 });
    await db.insert(workflowWebhooks).values({ id: "secret", workflowId: source.id, orgId: "org1", createdAt: 1, updatedAt: 1 });
    await db.insert(eventSubscriptions).values({ id: "event", orgId: "org1", ownerType: "user", ownerId: "u1",
      name: "event", eventKeys: ["test.event"], target: { kind: "workflow", workflowId: source.id }, createdBy: "u1", createdAt: 1, updatedAt: 1 });
    const schedules = await db.select().from(workflowSchedules);
    const webhooks = await db.select().from(workflowWebhooks);
    const events = await db.select().from(eventSubscriptions);
    const copy = await copyWorkflowDefinition(deps, owner, source.id, { teamId: "team1", name: " Team copy " });
    expect(copy).toMatchObject({ name: "Team copy", ownerType: "team", ownerId: "team1", definition: graph });
    expect(copy?.id).not.toBe(source.id);
    expect(await db.select().from(workflowDefinitions).where(eq(workflowDefinitions.id, source.id))).toEqual(before);
    expect(await db.select().from(workflowSchedules)).toEqual(schedules);
    expect(await db.select().from(workflowWebhooks)).toEqual(webhooks);
    expect(await db.select().from(eventSubscriptions)).toEqual(events);
    const versions = await db.select().from(workflowVersions).where(eq(workflowVersions.workflowId, copy?.id ?? ""));
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({ version: 1, definition: graph });
    await expect(copyWorkflowDefinition(deps, owner, source.id, { teamId: "team1", name: "Team copy" })).rejects.toThrow(/already exists/);
    expect(await db.select().from(workflowDefinitions)).toHaveLength(2);
  });
  it("serializes copies with the same destination name", async () => {
    const source = await createWorkflowDefinition(deps, owner, { name: "Source", definition: graph });
    const target = { teamId: "team1", name: "Same name" };
    const results = await Promise.allSettled([
      copyWorkflowDefinition(deps, owner, source.id, target), copyWorkflowDefinition(deps, owner, source.id, target),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(await db.select().from(workflowDefinitions)).toHaveLength(2);
  });
  it("uses creation membership authority but rejects foreign orgs, nonmembers and inaccessible sources", async () => {
    const source = await createWorkflowDefinition(deps, owner, { name: "Source", definition: graph });
    const target = { teamId: "team1", name: "Copy" };
    await db.update(teamMembers).set({ role: "member" });
    expect(await copyWorkflowDefinition(deps, owner, source.id, target)).toMatchObject({ ownerType: "team" });
    expect(await copyWorkflowDefinition(deps, { userId: "u2", orgId: "org1" }, source.id, target)).toBeNull();
    expect(await copyWorkflowDefinition(deps, { ...owner, principal: { type: "team", id: "team1" } }, source.id, target)).toBeNull();
    await db.update(teams).set({ orgId: "other-org" });
    await expect(copyWorkflowDefinition(deps, owner, source.id, { ...target, name: "Other" })).rejects.toThrow(/not found/);
    await db.update(teams).set({ orgId: "org1" });
    await db.delete(teamMembers);
    await expect(copyWorkflowDefinition(deps, owner, source.id, { ...target, name: "Other" })).rejects.toThrow(/not found/);
  });
});


describe("personal artifact copy to team", () => {
  it("copies exact content with a fresh link and rejects collisions and unauthorized sources", async () => {
    const source = await publishArtifact(db, scope, { key: "source", content: "<h1>Exact</h1>", format: "html", orgId: "org1" });
    const input = { artifactId: source.id, teamId: "team1", key: "copy" };
    const copy = await copyArtifactToTeam(db, scope, "org1", input);
    expect(copy).toMatchObject({ ownerType: "team", ownerId: "team1", content: source.content,
      rendered: source.rendered, version: 1, visibility: "org", sourceSessionId: "", sharedVersion: null, publicBy: null });
    expect(copy.token).not.toBe(source.token);
    expect(copy.id).not.toBe(source.id);
    expect(await getArtifactById(db, source.id)).toEqual(source);
    await expect(copyArtifactToTeam(db, scope, "org1", input)).rejects.toThrow(/another key/);
    await expect(copyArtifactToTeam(db, { owner: { type: "user", id: "u2" }, actorUserId: "u2" }, "org1", input)).rejects.toThrow(/not found/);
    await expect(copyArtifactToTeam(db, scope, "other-org", input)).rejects.toThrow(/not found/);
    await db.delete(teamMembers);
    await expect(copyArtifactToTeam(db, scope, "org1", { ...input, key: "denied" })).rejects.toThrow(/not found/);
  });
});
