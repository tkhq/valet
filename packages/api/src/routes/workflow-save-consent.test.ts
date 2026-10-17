import { afterEach, expect, it } from "vitest";
import { Type } from "typebox";
import { eq } from "drizzle-orm";
import type { ValetPlugin } from "@valet/engine";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { credentials, workflowAccountGrants, workflowActionGrants } from "../schema/index.js";
import { shareCredential, revokeShare } from "../services/credential-shares.js";
import { canBorrowCredential } from "../services/credential-borrow.js";
import { addMember, createTeam } from "../services/teams.js";
import { createWorkflowDefinition, updateWorkflowDefinition, type WorkflowServiceDeps } from "../workflows/service.js";

let api: TestApi | undefined;
afterEach(async () => { await api?.cleanup(); api = undefined; });
const definition = {
  version: "dag/v1", nodes: [
    { id: "start", type: "trigger" },
    { id: "read", type: "tool", service: "fixture", action: "read", params: {} },
    { id: "stop", type: "stop" },
  ], edges: [{ from: "start", to: "read" }, { from: "read", to: "stop" }],
};
const plugin: ValetPlugin = { name: "fixture", version: "1", actions: [{ service: "fixture", credentialService: "fixture_account", actions: [{
  id: "read", name: "Read", description: "Read fixture", riskLevel: "high", parameters: Type.Object({}),
  execute: async () => ({ success: true, data: {} }),
}]}] };

async function setup() {
  api = await bootTestApi({ plugins: [plugin] });
  const p = api.providers;
  const team = await createTeam(p.db, { orgId: "local-org", name: "Workflow accounts", creatorUserId: "local-user" });
  await p.db.insert(credentials).values({ ownerType: "user", ownerId: "local-user", service: "fixture_account", type: "api_key", apiKeyEnc: "fixture", createdAt: 1, updatedAt: 1 });
  await shareCredential(p.db, { teamId: team.id, userId: "local-user", service: "fixture_account", createdAt: 1 });
  const deps: WorkflowServiceDeps = { db: p.db, workflowStore: p.workflowStore, workflowRunHost: p.workflowRunHost,
    credentials: p.engineCredentials, engineStore: p.engineStore, actionPluginByService: p.actionPluginByService };
  const owner = { userId: "local-user", orgId: "local-org", principal: { type: "user" as const, id: "local-user" }, humanAccountConsent: true };
  return { p, team, deps, owner, baseUrl: api.baseUrl };
}

it("reuses a creator's saved account consent across scheduled runs only for that workflow", async () => {
  const { p, team, baseUrl } = await setup();
  const response = await fetch(`${baseUrl}/api/workflows`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Account automation", definition, teamId: team.id }) });
  expect(response.status).toBe(201);
  const saved = await response.json();
  if (!saved || typeof saved !== "object" || !("id" in saved) || typeof saved.id !== "string") throw new Error("Missing workflow ID");
  expect(await p.db.select().from(workflowAccountGrants)).toMatchObject([{ workflowId: saved.id, memberId: "local-user", service: "fixture_account" }]);
  const scope = { orgId: "local-org", teamId: team.id, actorId: `team:${team.id}`, service: "fixture_account", memberId: "local-user" };
  for (const runId of ["schedule-one", "schedule-two"]) {
    await p.workflowStore.createRun(runId, { workflowId: saved.id, definitionVersionId: "v1" }, definition, "v1",
      { ownerType: "team", ownerId: team.id, actorUserId: scope.actorId });
    expect(await canBorrowCredential(p.db, { ...scope, sessionId: `wf:${runId}` })).toBe(true);
  }
  const reset = await fetch(`${baseUrl}/api/workflows/${saved.id}/permissions/allow`, { method: "DELETE" });
  expect(reset.status).toBe(200);
  expect(await canBorrowCredential(p.db, { ...scope, sessionId: "wf:schedule-two" })).toBe(false);
  // Reviewing the saved graph can authorize accounts even with no selected action grants.
  const review = await fetch(`${baseUrl}/api/workflows/${saved.id}/permissions/allow`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ actionIds: [] }) });
  expect(review.status).toBe(200);
  expect(await canBorrowCredential(p.db, { ...scope, sessionId: "wf:schedule-two" })).toBe(true);
  await revokeShare(p.db, { teamId: team.id, service: "fixture_account", userId: "local-user" });
  await shareCredential(p.db, { teamId: team.id, service: "fixture_account", userId: "local-user", createdAt: 2 });
  expect(await canBorrowCredential(p.db, { ...scope, sessionId: "wf:schedule-two" })).toBe(false);
});

it("does not grant permissions to agent saves and retires consent after an agent changes the steps", async () => {
  const { p, team, deps, owner } = await setup();
  await createWorkflowDefinition(deps, { ...owner, humanAccountConsent: false }, { name: "API key draft", definition, teamId: team.id });
  expect(await p.db.select().from(workflowAccountGrants)).toHaveLength(0);
  expect(await p.db.select().from(workflowActionGrants)).toHaveLength(0);
  const agent = { ...owner, agentEditor: true };
  const created = await createWorkflowDefinition(deps, agent, { name: "Agent draft", definition, teamId: team.id });
  expect(await p.db.select().from(workflowAccountGrants)).toHaveLength(0);
  expect(await p.db.select().from(workflowActionGrants)).toHaveLength(0);
  const { allowWorkflowPermissions, revokeOwnWorkflowAccounts } = await import("../workflows/permissions.js");
  expect((await allowWorkflowPermissions(deps, owner, created.id, undefined))?.ok).toBe(true);
  expect(await revokeOwnWorkflowAccounts(deps, agent, created.id)).toBe(false);
  expect(await revokeOwnWorkflowAccounts(deps, { ...owner, humanAccountConsent: false }, created.id)).toBe(false);
  expect(await p.db.select().from(workflowAccountGrants)).toHaveLength(1);
  expect(await p.db.select().from(workflowActionGrants)).toHaveLength(1);
  await updateWorkflowDefinition(deps, agent, created.id, { definition: { ...definition, nodes: definition.nodes.map(n => n.id === "read" ? { ...n, params: { value: "changed" } } : n) } });
  expect(await p.db.select().from(workflowAccountGrants)).toHaveLength(0);
  expect(await p.db.select().from(workflowActionGrants)).toHaveLength(0);
});

it("does not add unrelated services or another member's account when saving", async () => {
  const { p, team, deps, owner } = await setup();
  await p.db.insert(credentials).values({ ownerType: "user", ownerId: "local-user", service: "other", type: "api_key", apiKeyEnc: "fixture", createdAt: 1, updatedAt: 1 });
  await shareCredential(p.db, { teamId: team.id, userId: "local-user", service: "other", createdAt: 1 });
  await p.db.update(credentials).set({ ownerId: "test-member" }).where(eq(credentials.service, "fixture_account"));
  await createWorkflowDefinition(deps, owner, { name: "Own accounts only", definition, teamId: team.id });
  expect(await p.db.select().from(workflowAccountGrants)).toHaveLength(0);
});


it("lets a team member review only their own accounts without granting tool actions", async () => {
  const { p, team, deps, owner, baseUrl } = await setup();
  await addMember(p.db, { teamId: team.id, userId: "test-member", role: "member" });
  const workflow = await createWorkflowDefinition(deps, { ...owner, agentEditor: true }, { name: "Member consent", definition, teamId: team.id });
  // The saving member is not an admin, but can still authorize their own share.
  await p.db.update(credentials).set({ ownerId: "test-member" }).where(eq(credentials.service, "fixture_account"));
  await shareCredential(p.db, { teamId: team.id, userId: "test-member", service: "fixture_account", createdAt: 2 });
  const review = await fetch(`${baseUrl}/api/workflows/${workflow.id}/permissions/allow`, { method: "POST",
    headers: { "Content-Type": "application/json", "x-valet-test-user-id": "test-member" }, body: JSON.stringify({ actionIds: [] }) });
  expect(review.status).toBe(200);
  expect(await p.db.select().from(workflowAccountGrants)).toMatchObject([{ memberId: "test-member", workflowId: workflow.id }]);
  expect(await p.db.select().from(workflowActionGrants)).toHaveLength(0);
  const escalate = await fetch(`${baseUrl}/api/workflows/${workflow.id}/permissions/allow`, { method: "POST",
    headers: { "Content-Type": "application/json", "x-valet-test-user-id": "test-member" }, body: JSON.stringify({ actionIds: ["fixture.read"] }) });
  expect(escalate.status).toBe(400);
});


it("saves account consent for dynamic tools inside foreach steps", async () => {
  const { p, team, deps, owner } = await setup();
  const dynamic = { ...definition, nodes: definition.nodes.map(node => node.id === "read" ? {
    id: "read", type: "foreach", items: "{{ start.data.items }}",
    body: { id: "each", type: "tool", service: "fixture", action: "discovered_read", params: {} },
  } : node) };
  const saved = await createWorkflowDefinition(deps, owner, { name: "Dynamic account", definition: dynamic, teamId: team.id });
  expect(await p.db.select().from(workflowAccountGrants)).toMatchObject([{ workflowId: saved.id, service: "fixture_account", memberId: "local-user" }]);
  expect(await p.db.select().from(workflowActionGrants)).toHaveLength(0);
  await p.workflowStore.createRun("dynamic-run", { workflowId: saved.id, definitionVersionId: "v1" }, dynamic, "v1",
    { ownerType: "team", ownerId: team.id, actorUserId: `team:${team.id}` });
  expect(await canBorrowCredential(p.db, { orgId: "local-org", teamId: team.id, actorId: `team:${team.id}`,
    service: "fixture_account", memberId: "local-user", sessionId: "wf:dynamic-run" })).toBe(true);
});

it("does not restore revoked permissions on layout-only or unchanged human saves", async () => {
  const { p, team, deps, owner, baseUrl } = await setup();
  const saved = await createWorkflowDefinition(deps, owner, { name: "Review steps", definition, teamId: team.id });
  const changed = { ...definition, nodes: definition.nodes.map(node => node.id === "read" ? { ...node, params: { value: "agent edit" } } : node) };
  await updateWorkflowDefinition(deps, { ...owner, agentEditor: true }, saved.id, { definition: changed });
  expect(await p.db.select().from(workflowAccountGrants)).toHaveLength(0);
  expect(await p.db.select().from(workflowActionGrants)).toHaveLength(0);
  await updateWorkflowDefinition(deps, owner, saved.id, { definition: { ...changed, ui: { nodes: { read: { position: { x: 10, y: 20 } } } } } });
  expect(await p.db.select().from(workflowAccountGrants)).toHaveLength(0);
  expect(await p.db.select().from(workflowActionGrants)).toHaveLength(0);
  await updateWorkflowDefinition(deps, owner, saved.id, { definition: changed });
  expect(await p.db.select().from(workflowAccountGrants)).toHaveLength(0);
  expect(await p.db.select().from(workflowActionGrants)).toHaveLength(0);
  const reviewed = await fetch(`${baseUrl}/api/workflows/${saved.id}/permissions/allow`, { method: "POST" });
  expect(reviewed.status).toBe(200);
  expect(await p.db.select().from(workflowAccountGrants)).toHaveLength(1);
  expect(await p.db.select().from(workflowActionGrants)).toHaveLength(1);
});

it("lets a member revoke only their own workflow account consent", async () => {
  const { p, team, deps, owner, baseUrl } = await setup();
  await addMember(p.db, { teamId: team.id, userId: "test-member", role: "member" });
  await p.engineCredentials.save({ type: "user", id: "test-member" }, "fixture_account", { type: "api_key", apiKey: "test-fixture" });
  await shareCredential(p.db, { teamId: team.id, service: "fixture_account", userId: "test-member", createdAt: 2 });
  const saved = await createWorkflowDefinition(deps, owner, { name: "Revocable accounts", definition, teamId: team.id });
  const headers = { "Content-Type": "application/json", "x-valet-test-user-id": "test-member" };
  expect((await fetch(`${baseUrl}/api/workflows/${saved.id}/permissions/allow`, { method: "POST", headers, body: JSON.stringify({ actionIds: [] }) })).status).toBe(200);
  expect(await p.db.select().from(workflowAccountGrants)).toHaveLength(2);
  expect((await fetch(`${baseUrl}/api/workflows/${saved.id}/permissions/accounts`, { method: "DELETE", headers })).status).toBe(200);
  expect(await p.db.select().from(workflowAccountGrants)).toMatchObject([{ memberId: "local-user" }]);
  expect(await p.db.select().from(workflowActionGrants)).toHaveLength(1);
  // A layout save cannot re-create consent the member explicitly withdrew.
  await updateWorkflowDefinition(deps, { ...owner, userId: "test-member", principal: { type: "user", id: "test-member" } }, saved.id,
    { definition: { ...definition, ui: { viewport: { x: 0, y: 0, zoom: 1 } } } });
  expect(await p.db.select().from(workflowAccountGrants)).toMatchObject([{ memberId: "local-user" }]);
  expect((await fetch(`${baseUrl}/api/workflows/${saved.id}/permissions/accounts`, { method: "DELETE", headers: { "x-valet-test-user-id": "test-admin" } })).status).toBe(404);
});
