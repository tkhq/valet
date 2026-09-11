import { afterEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { PluginActionContext } from "@valet/engine";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { assistants, teams, teamMembers, workflowDefinitions } from "../schema/index.js";
import { buildWorkflowEngineDeps } from "./engine-deps.js";
import { workflowsActionPlugin } from "./actions.js";
import { createWorkflowDefinition, copyWorkflowDefinition, updateWorkflowDefinition, startWorkflowRun } from "./service.js";

let api: TestApi | undefined;
afterEach(async () => { await api?.cleanup(); api = undefined; });
const graph = { version: "dag/v1", nodes: [{ id: "start", type: "trigger" }, { id: "end", type: "stop" }], edges: [{ from: "start", to: "end" }] };
async function setup() {
  api = await bootTestApi();
  const p = api.providers;
  await p.db.insert(teams).values([
    { id: "team-a", orgId: "local-org", name: "A", createdAt: 1 },
    { id: "team-b", orgId: "local-org", name: "B", createdAt: 1 },
  ]);
  await p.db.insert(teamMembers).values([
    { teamId: "team-a", userId: "local-user", role: "admin" },
    { teamId: "team-b", userId: "local-user", role: "admin" },
  ]);
  await p.db.insert(assistants).values([
    { id: "chosen", orgId: "local-org", ownerType: "team", ownerId: "team-a", sessionId: "assistant:chosen", isDefault: false, createdAt: 1 },
    { id: "default-a", orgId: "local-org", ownerType: "team", ownerId: "team-a", sessionId: "assistant:default-a", isDefault: true, createdAt: 1 },
    { id: "other", orgId: "local-org", ownerType: "team", ownerId: "team-b", sessionId: "assistant:other", isDefault: true, createdAt: 1 },
    { id: "foreign", orgId: "other-org", ownerType: "team", ownerId: "team-a", sessionId: "assistant:foreign", isDefault: false, createdAt: 1 },
  ]);
  return { api, p, deps: { db: p.db, workflowStore: p.workflowStore, workflowRunHost: p.workflowRunHost, credentials: p.engineCredentials } };
}
const owner = { userId: "local-user", orgId: "local-org" };

describe("workflow explicit assistant routing", () => {
  it("rejects cross-team, foreign-org, missing and malformed selections through HTTP, including updates", async () => {
    const { api, p } = await setup();
    for (const assistantId of ["other", "foreign", "missing", 42, ""]) {
      const res = await fetch(`${api.baseUrl}/api/workflows`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Rejected", teamId: "team-a", definition: { ...graph, assistantId } }) });
      expect(res.status).toBe(typeof assistantId === "number" || assistantId === "" ? 400 : 404);
    }
    expect(await p.db.select().from(workflowDefinitions)).toEqual([]);
    const res = await fetch(`${api.baseUrl}/api/workflows`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Chosen", teamId: "team-a", definition: { ...graph, assistantId: "chosen" } }) });
    expect(res.status).toBe(201);
    const created = await res.json() as { id: string; ownerType: string; ownerId: string };
    expect(created).toMatchObject({ ownerType: "team", ownerId: "team-a" });
    const rejected = await fetch(`${api.baseUrl}/api/workflows/${created.id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ definition: { ...graph, assistantId: "other" } }) });
    expect(rejected.status).toBe(404);
    const saved = await (await fetch(`${api.baseUrl}/api/workflows/${created.id}`)).json();
    expect(saved).toMatchObject({ definition: { assistantId: "chosen" } });
  });

  it("binds an orchestrator-created team workflow and preserves explicitly supplied routing", async () => {
    const { p, deps } = await setup();
    const save = workflowsActionPlugin(() => deps).actions.find((a) => a.id === "workflows.save_workflow");
    if (!save) throw new Error("Missing save action");
    // This action only reads identity fields; credentials and sandbox are unused.
    const ctx = { ...owner, sessionId: "assistant:chosen", owner: { type: "team", id: "team-a" }, actionId: "workflows.save_workflow", service: "workflows" } as PluginActionContext;
    expect((await save.execute({ name: "Implicit", definition: graph }, ctx)).success).toBe(true);
    expect((await save.execute({ name: "Explicit", definition: { ...graph, assistantId: "default-a" } }, ctx)).success).toBe(true);
    const rows = await p.db.select().from(workflowDefinitions);
    expect(rows.find((r) => r.name === "Implicit")).toMatchObject({ ownerType: "team", ownerId: "team-a", definition: { assistantId: "chosen" } });
    expect(rows.find((r) => r.name === "Explicit")).toMatchObject({ definition: { assistantId: "default-a" } });
    const implicit = rows.find((r) => r.name === "Implicit");
    if (!implicit) throw new Error("Missing implicit workflow");
    expect((await save.execute({ workflow_id: implicit.id, name: "Edited", definition: graph }, { ...ctx, userId: "team:team-a" })).success).toBe(true);
    // A team assistant has team reach, not its first user's other teams.
    const other = await createWorkflowDefinition(deps, owner, { name: "Other", teamId: "team-b", definition: graph });
    expect((await save.execute({ workflow_id: other.id, definition: graph }, ctx)).success).toBe(false);
  });

  it("rebinds cross-workspace copies and retains routing for same-owner copies", async () => {
    const { deps } = await setup();
    const team = await createWorkflowDefinition(deps, owner, { name: "Source", teamId: "team-a", definition: { ...graph, assistantId: "chosen" } });
    const personal = await copyWorkflowDefinition(deps, owner, team.id);
    expect(personal?.ownerType).toBe("user");
    expect(personal?.definition).not.toMatchObject({ assistantId: "chosen" });
    if (!personal) throw new Error("Missing copy");
    const sameOwner = await copyWorkflowDefinition(deps, owner, personal.id);
    expect(sameOwner?.definition).toEqual(personal.definition);
    const otherTeam = await copyWorkflowDefinition(deps, owner, personal.id, { teamId: "team-b", name: "Destination" });
    expect(otherTeam).toMatchObject({ ownerType: "team", ownerId: "team-b", definition: { assistantId: "other" } });
  });

  it("routes every node and repair to the run snapshot, preserves manual actor, and refuses archived targets", async () => {
    const { p, deps } = await setup();
    const created = await createWorkflowDefinition(deps, owner, { name: "Pinned", teamId: "team-a", definition: { ...graph, assistantId: "chosen" } });
    const unchanged = await updateWorkflowDefinition(deps, owner, created.id, { definition: graph });
    expect(unchanged).toMatchObject({ definition: { assistantId: "chosen" } });
    const start = vi.spyOn(p.workflowRunHost, "start").mockImplementation(async (id, params, definition, runOwner) => {
      await p.workflowStore.createRun(id, params, definition, params.definitionVersionId, runOwner);
    });
    const started = await startWorkflowRun(deps, owner, created.id);
    if (!started || !("runId" in started)) throw new Error("Run not started");
    expect(start.mock.calls[0]?.[3]).toEqual({ ownerType: "team", ownerId: "team-a", actorUserId: "local-user" });
    await updateWorkflowDefinition(deps, owner, created.id, { definition: { ...graph, assistantId: "default-a" } });
    const hostSpy = vi.spyOn(p.engineHost, "assistantSessionFor");
    const engine = buildWorkflowEngineDeps({ db: p.db, host: p.engineHost, store: p.workflowStore, engineStore: p.engineStore, actionPluginByService: p.actionPluginByService, credentials: p.engineCredentials });
    for (const node of ["one", "two", "one:repair"]) {
      const receipt = await engine.promptOrchestrator("hello", { dispatchId: `workflow:${started.runId}:${node}`, queueMode: "followup", ownerHint: { ownerType: "team", ownerId: "team-a" } });
      expect(receipt.sessionId).toBe("assistant:chosen");
    }
    expect(hostSpy).toHaveBeenCalledWith("chosen", { actorUserId: "local-user", orgId: "local-org" }, { sessionId: "assistant:chosen" });
    await p.db.update(assistants).set({ archivedAt: Date.now() }).where(eq(assistants.id, "chosen"));
    await expect(engine.promptOrchestrator("hello", { dispatchId: `workflow:${started.runId}:three`, queueMode: "followup", ownerHint: { ownerType: "team", ownerId: "team-a" } })).rejects.toThrow("archived");
  });
});
