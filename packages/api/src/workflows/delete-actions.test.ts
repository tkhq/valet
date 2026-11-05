import { beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { InMemoryCredentialStore, InMemorySessionStore, type PluginActionContext } from "@valet/engine";
import { InMemoryWorkflowStore } from "@valet/workflow";
import { freshTestPgDb } from "../test-helpers/pg-test-db.js";
import { orgMembers, orgs, teamDeletionRequests, teamMembers, teams, users, workflowDefinitions } from "../schema/index.js";
import { decideDeletionRequest } from "../services/team-deletion-requests.js";
import { workflowsActionPlugin } from "./actions.js";
import type { WorkflowServiceDeps } from "./service.js";

let deps: WorkflowServiceDeps;
const unsupported = async (): Promise<never> => { throw new Error("Unexpected test operation"); };
function context(userId = "admin", overrides: Partial<PluginActionContext> = {}): PluginActionContext {
  return {
    userId, orgId: "org", owner: { type: "team", id: "team" }, interactiveActor: { id: userId },
    sessionId: "session", threadId: "thread", sessionPurpose: "orchestrator", actionId: "", service: "workflows",
    credentials: { get: async () => null, request: unsupported },
    sandbox: { id: "sandbox", readFile: unsupported, readBinary: unsupported, writeFile: unsupported, writeBinary: unsupported, readdir: unsupported, stat: unsupported, mkdir: unsupported, rm: unsupported, exec: unsupported },
    requestDecision: unsupported, signal: new AbortController().signal, threadRead: async () => [], listThreads: async () => [], setModel: unsupported,
    ...overrides,
  };
}
function invoke(name: "delete_workflow" | "request_workflow_deletion", ctx: PluginActionContext, workflowId = "workflow") {
  const action = workflowsActionPlugin(() => deps).actions.find((candidate) => candidate.id === `workflows.${name}`);
  if (!action) throw new Error("Workflow deletion action missing");
  return action.execute({ workflow_id: workflowId, reason: "Retired" }, ctx);
}
beforeEach(async () => {
  const { appDb } = await freshTestPgDb();
  deps = {
    db: appDb, workflowStore: new InMemoryWorkflowStore(), engineStore: new InMemorySessionStore(), credentials: new InMemoryCredentialStore(),
    workflowRunHost: { start: unsupported, wake: unsupported, scheduleWake: unsupported, terminate: unsupported, startHost() {}, async stopHost() {} },
  };
  await appDb.insert(orgs).values([{ id: "org", name: "Org", createdAt: 1 }, { id: "other-org", name: "Other", createdAt: 1 }]);
  await appDb.insert(users).values(["admin", "member", "outsider"].map((id) => ({ id, name: id, email: `${id}@test.invalid`, role: "member" as const })));
  await appDb.insert(orgMembers).values(["admin", "member", "outsider"].map((userId) => ({ orgId: "org", userId, role: "member" as const })));
  await appDb.insert(teams).values([
    { id: "team", orgId: "org", name: "Team", createdAt: 1 },
    { id: "other-team", orgId: "org", name: "Other team", createdAt: 1 },
    { id: "foreign-team", orgId: "other-org", name: "Foreign team", createdAt: 1 },
  ]);
  await appDb.insert(teamMembers).values([{ teamId: "team", userId: "admin", role: "admin" }, { teamId: "team", userId: "member", role: "member" }]);
  await appDb.insert(workflowDefinitions).values([
    { id: "workflow", orgId: "org", ownerId: "team" },
    { id: "other-workflow", orgId: "org", ownerId: "other-team" },
    { id: "foreign-workflow", orgId: "other-org", ownerId: "foreign-team" },
  ].map((row) => ({ ...row, ownerType: "team" as const, name: row.id, definition: { version: "dag/v1", nodes: [], edges: [] }, createdAt: 1, updatedAt: 1 })));
});

describe("workflow deletion through chat", () => {
  it("lets the authenticated admin delete directly in the exact team scope", async () => {
    expect(await invoke("delete_workflow", context())).toMatchObject({ success: true, data: { deleted: true } });
    expect(await deps.db.select().from(workflowDefinitions).where(eq(workflowDefinitions.id, "workflow"))).toEqual([]);
    expect(await deps.db.select().from(teamDeletionRequests)).toEqual([]);
  });

  it("gives a member a structured request action and deduplicates their request", async () => {
    expect(await invoke("delete_workflow", context("member"))).toMatchObject({ success: false, data: { code: "team_admin_required", nextAction: "workflows.request_workflow_deletion", teamId: "team" } });
    expect(await invoke("request_workflow_deletion", context("member"))).toMatchObject({ success: true, data: { deleted: false, status: "pending", created: true } });
    expect(await invoke("request_workflow_deletion", context("member"))).toMatchObject({ success: true, data: { deleted: false, created: false } });
    expect(await deps.db.select().from(teamDeletionRequests)).toHaveLength(1);
    expect(await deps.db.select().from(workflowDefinitions).where(eq(workflowDefinitions.id, "workflow"))).toHaveLength(1);
  });

  it.each(["machine", "workflow", "child", "mismatched author", "external"] as const)("does not borrow admin rights for %s contexts", async (kind) => {
    const ctx = context("admin", kind === "machine" ? { interactiveActor: undefined }
      : kind === "external" ? { externalSender: true }
      : kind === "mismatched author" ? { interactiveActor: { id: "member" } }
      : { sessionPurpose: kind });
    for (const action of ["delete_workflow", "request_workflow_deletion"] as const) {
      expect(await invoke(action, ctx)).toMatchObject({ success: false });
    }
    expect(await deps.db.select().from(workflowDefinitions).where(eq(workflowDefinitions.id, "workflow"))).toHaveLength(1);
    expect(await deps.db.select().from(teamDeletionRequests)).toEqual([]);
  });

  it.each(["authorless", "workflow", "child", "signal"] as const)("does not inherit a personal admin's role for %s team deletion", async (kind) => {
    const ctx = context("admin", {
      owner: { type: "user", id: "admin" },
      sessionPurpose: kind === "workflow" || kind === "child" ? kind : "orchestrator",
      interactiveActor: undefined,
    });
    for (const action of ["delete_workflow", "request_workflow_deletion"] as const) {
      expect(await invoke(action, ctx)).toMatchObject({ success: false });
    }
    expect(await deps.db.select().from(workflowDefinitions).where(eq(workflowDefinitions.id, "workflow"))).toHaveLength(1);
    expect(await deps.db.select().from(teamDeletionRequests)).toEqual([]);
  });

  it("hides another team's workflow from an automated personal nonmember", async () => {
    await expect(invoke("delete_workflow", context("outsider", {
      owner: { type: "user", id: "outsider" }, interactiveActor: undefined,
    }))).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it.each(["other-workflow", "foreign-workflow"])("hides an out-of-scope target %s", async (id) => {
    for (const action of ["delete_workflow", "request_workflow_deletion"] as const) {
      expect(await invoke(action, context(), id)).toEqual({ success: false, error: `workflow not found: ${id}` });
    }
  });

  it("rechecks the actor's current role instead of using earlier admin authority", async () => {
    await deps.db.update(teamMembers).set({ role: "member" }).where(and(eq(teamMembers.teamId, "team"), eq(teamMembers.userId, "admin")));
    expect(await invoke("delete_workflow", context())).toMatchObject({ success: false, data: { code: "team_admin_required" } });
  });

  it("keeps decision authority with the current admin after the requester leaves", async () => {
    await invoke("request_workflow_deletion", context("member"));
    const [request] = await deps.db.select().from(teamDeletionRequests);
    await deps.db.delete(teamMembers).where(and(eq(teamMembers.teamId, "team"), eq(teamMembers.userId, "member")));
    await expect(invoke("request_workflow_deletion", context("member"))).resolves.toMatchObject({ success: false });
    await decideDeletionRequest(deps, { userId: "admin", orgId: "org", teamId: "team" }, request.id, "approve");
    expect(await deps.db.select().from(workflowDefinitions).where(eq(workflowDefinitions.id, "workflow"))).toEqual([]);
  });
});
