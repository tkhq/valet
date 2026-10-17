import { afterEach, expect, it } from "vitest";
import { Type } from "typebox";
import { eq } from "drizzle-orm";
import type { PluginActionContext, ValetPlugin } from "@valet/engine";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { credentials, workflowAccountGrants, workflowActionGrants } from "../schema/index.js";
import { shareCredential, revokeShare } from "../services/credential-shares.js";
import { canBorrowCredential } from "../services/credential-borrow.js";
import { addMember, createTeam } from "../services/teams.js";
import { createWorkflowDefinition, updateWorkflowDefinition, type WorkflowServiceDeps } from "../workflows/service.js";
import { workflowsActionPlugin } from "../workflows/actions.js";


async function reviewedApproval(url: string, init: RequestInit = {}): Promise<Response> {
  const preview = await fetch(url.slice(0, -"/allow".length), { headers: init.headers });
  const reviewed: unknown = await preview.json();
  const definitionToken = reviewed && typeof reviewed === "object" && "definitionToken" in reviewed && typeof reviewed.definitionToken === "string"
    ? reviewed.definitionToken : "0".repeat(64);
  const requested: unknown = typeof init.body === "string" ? JSON.parse(init.body) : {};
  if (!requested || typeof requested !== "object" || Array.isArray(requested)) throw new Error("Expected an approval object.");
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json");
  return fetch(url, { ...init, method: "POST", headers, body: JSON.stringify({ ...requested, definitionToken }) });
}

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

async function setup(extraPlugins: ValetPlugin[] = []) {
  api = await bootTestApi({ plugins: [plugin, ...extraPlugins] });
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
  const review = await reviewedApproval(`${baseUrl}/api/workflows/${saved.id}/permissions/allow`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ actionIds: [] }) });
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
  const { allowWorkflowPermissions, analyzeWorkflowPermissions, revokeOwnWorkflowAccounts } = await import("../workflows/permissions.js");
  const review = await analyzeWorkflowPermissions(deps, owner, created.id);
  if (!review) throw new Error("Expected a visible workflow review.");
  expect((await allowWorkflowPermissions(deps, owner, created.id, undefined, review.definitionToken))?.ok).toBe(true);
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
  const review = await reviewedApproval(`${baseUrl}/api/workflows/${workflow.id}/permissions/allow`, { method: "POST",
    headers: { "Content-Type": "application/json", "x-valet-test-user-id": "test-member" }, body: JSON.stringify({ actionIds: [] }) });
  expect(review.status).toBe(200);
  expect(await p.db.select().from(workflowAccountGrants)).toMatchObject([{ memberId: "test-member", workflowId: workflow.id }]);
  expect(await p.db.select().from(workflowActionGrants)).toHaveLength(0);
  const escalate = await reviewedApproval(`${baseUrl}/api/workflows/${workflow.id}/permissions/allow`, { method: "POST",
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
  const reviewed = await reviewedApproval(`${baseUrl}/api/workflows/${saved.id}/permissions/allow`, { method: "POST" });
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
  expect((await reviewedApproval(`${baseUrl}/api/workflows/${saved.id}/permissions/allow`, { method: "POST", headers, body: JSON.stringify({ actionIds: [] }) })).status).toBe(200);
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

it.each([false, true])("authorizes human workflow copies at creation (team=%s)", async (teamCopy) => {
  const { p, team, deps, owner, baseUrl } = await setup();
  const source = await createWorkflowDefinition(deps, { ...owner, agentEditor: true }, { name: "Source draft", definition });
  const response = await fetch(`${baseUrl}/api/workflows/${source.id}/${teamCopy ? "copy-to-team" : "copy"}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: teamCopy ? JSON.stringify({ teamId: team.id, name: "Copied automation" }) : undefined,
  });
  expect(response.status).toBe(201);
  const copy = await response.json();
  if (!copy || typeof copy !== "object" || !("id" in copy) || typeof copy.id !== "string") throw new Error("Missing copy ID");
  expect(await p.db.select().from(workflowActionGrants)).toMatchObject([{ workflowId: copy.id, actionId: "fixture.read" }]);
  const accounts = await p.db.select().from(workflowAccountGrants);
  expect(accounts).toHaveLength(teamCopy ? 1 : 0);
  if (teamCopy) expect(accounts[0]).toMatchObject({ workflowId: copy.id, memberId: "local-user" });
});


it("rejects a stale permissions review before authorizing newly added shared accounts or actions", async () => {
  const lowRiskPlugin: ValetPlugin = { name: "new-account", version: "1", actions: [{ service: "new-account", actions: [{
    id: "read", name: "Read", description: "Read the new account", riskLevel: "low", parameters: Type.Object({}),
    execute: async () => ({ success: true, data: {} }),
  }] }] };
  const { p, team, deps, owner, baseUrl } = await setup([lowRiskPlugin]);
  const saved = await createWorkflowDefinition(deps, { ...owner, agentEditor: true }, { name: "Stale account review", definition, teamId: team.id });
  const review = await fetch(`${baseUrl}/api/workflows/${saved.id}/permissions`);
  const reviewed: unknown = await review.json();
  const definitionToken = reviewed && typeof reviewed === "object" && "definitionToken" in reviewed ? reviewed.definitionToken : undefined;
  expect(definitionToken).toEqual(expect.any(String));
  await p.db.insert(credentials).values({ ownerType: "user", ownerId: "local-user", service: "new-account", type: "api_key", apiKeyEnc: "fixture", createdAt: 1, updatedAt: 1 });
  await shareCredential(p.db, { teamId: team.id, userId: "local-user", service: "new-account", createdAt: 1 });
  const changed = { ...definition, nodes: [...definition.nodes, { id: "new-account", type: "tool", service: "new-account", action: "read", params: {} }],
    edges: [...definition.edges, { from: "start", to: "new-account" }] };
  await updateWorkflowDefinition(deps, { ...owner, agentEditor: true }, saved.id, { definition: changed });
  for (const actionIds of [[], ["fixture.read"]]) {
    const approval = await fetch(`${baseUrl}/api/workflows/${saved.id}/permissions/allow`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ actionIds, definitionToken }) });
    expect(approval.status).toBe(409);
  }
  expect(await p.db.select().from(workflowActionGrants)).toHaveLength(0);
  expect(await p.db.select().from(workflowAccountGrants)).toHaveLength(0);
});

it("previews the named team's full account scope including allowed and dynamic tool services", async () => {
  const lowRiskPlugin: ValetPlugin = { name: "allowed-tool", version: "1", actions: [{ service: "allowed-tool", credentialService: "allowed-account", actions: [{
    id: "read", name: "Read", description: "Read the allowed account", riskLevel: "low", parameters: Type.Object({}),
    execute: async () => ({ success: true, data: {} }),
  }] }] };
  const { p, team, deps, owner, baseUrl } = await setup([lowRiskPlugin]);
  const complete = { ...definition, nodes: [...definition.nodes,
    { id: "allowed", type: "tool", service: "allowed-tool", action: "read", params: {} },
    { id: "dynamic", type: "tool", service: "dynamic-account", action: "discovered_read", params: {} },
    { id: "git", type: "tool", service: "github", action: "discovered_read", params: {} },
  ], edges: [...definition.edges, { from: "start", to: "allowed" }, { from: "start", to: "dynamic" }, { from: "start", to: "git" }] };
  const saved = await createWorkflowDefinition(deps, { ...owner, agentEditor: true }, { name: "Complete consent review", definition: complete, teamId: team.id });
  const response = await fetch(`${baseUrl}/api/workflows/${saved.id}/permissions`);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    definitionToken: expect.any(String),
    accountConsent: { teamId: team.id, teamName: team.name, services: ["fixture_account", "allowed-account", "dynamic-account"] },
    nodes: expect.arrayContaining([
      expect.objectContaining({ nodeId: "read", mode: "require_approval" }),
      expect.objectContaining({ nodeId: "allowed", mode: "allow" }),
      expect.objectContaining({ nodeId: "dynamic", mode: "unknown" }),
    ]),
  });
  expect(await p.db.select().from(workflowActionGrants)).toHaveLength(0);
  expect(await p.db.select().from(workflowAccountGrants)).toHaveLength(0);
});

it("rejects account approval if the declared credential service mapping changed after review", async () => {
  const { p, team, deps, owner, baseUrl } = await setup();
  const saved = await createWorkflowDefinition(deps, { ...owner, agentEditor: true }, { name: "Changed service mapping", definition, teamId: team.id });
  const review: unknown = await (await fetch(`${baseUrl}/api/workflows/${saved.id}/permissions`)).json();
  if (!review || typeof review !== "object" || !("definitionToken" in review)) throw new Error("Missing reviewed definition token.");
  await p.db.insert(credentials).values({ ownerType: "user", ownerId: "local-user", service: "changed-account", type: "api_key", apiKeyEnc: "fixture", createdAt: 1, updatedAt: 1 });
  await shareCredential(p.db, { teamId: team.id, userId: "local-user", service: "changed-account", createdAt: 1 });
  const original = p.actionPluginByService.get("fixture");
  if (!original) throw new Error("Missing fixture action plugin.");
  p.actionPluginByService.set("fixture", { ...original, actionPlugin: { ...original.actionPlugin, credentialService: "changed-account" } });
  const approval = await fetch(`${baseUrl}/api/workflows/${saved.id}/permissions/allow`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ actionIds: [], definitionToken: review.definitionToken }) });
  expect(approval.status).toBe(409);
  expect(await p.db.select().from(workflowAccountGrants)).toHaveLength(0);
  expect(await p.db.select().from(workflowActionGrants)).toHaveLength(0);
});

const unsupported = async (): Promise<never> => { throw new Error("Unexpected test operation"); };
function assistantTurn(teamId: string, overrides: Partial<PluginActionContext> = {}): PluginActionContext {
  return {
    userId: "local-user", orgId: "local-org", owner: { type: "team", id: teamId }, interactiveActor: { id: "local-user" },
    sessionId: "session", threadId: "thread", sessionPurpose: "orchestrator", actionId: "workflows.save_workflow", service: "workflows",
    credentials: { get: async () => null, request: unsupported },
    sandbox: { id: "sandbox", readFile: unsupported, readBinary: unsupported, writeFile: unsupported, writeBinary: unsupported, readdir: unsupported, stat: unsupported, mkdir: unsupported, rm: unsupported, exec: unsupported },
    requestDecision: unsupported, signal: new AbortController().signal, threadRead: async () => [], listThreads: async () => [], setModel: unsupported,
    ...overrides,
  };
}

it("grants an assistant save made on the person's own prompt and nothing for automated turns", async () => {
  const { p, team, deps } = await setup();
  const save = workflowsActionPlugin(() => deps).actions.find((action) => action.id === "workflows.save_workflow");
  if (!save) throw new Error("save_workflow missing");
  const automated: [string, Partial<PluginActionContext>][] = [
    ["event or signal turn", { interactiveActor: undefined }],
    ["delegated child work", { sessionPurpose: "child" }],
    ["workflow step", { sessionPurpose: "workflow" }],
    ["another person's prompt", { interactiveActor: { id: "test-member" } }],
  ];
  for (const [label, overrides] of automated) {
    expect(await save.execute({ name: label, definition }, assistantTurn(team.id, overrides)), label).toMatchObject({ success: true });
  }
  expect(await p.db.select().from(workflowAccountGrants)).toHaveLength(0);
  expect(await p.db.select().from(workflowActionGrants)).toHaveLength(0);

  const saved = await save.execute({ name: "Requested in chat", definition }, assistantTurn(team.id));
  const workflowId = saved.data && typeof saved.data === "object" && "workflowId" in saved.data ? saved.data.workflowId : undefined;
  if (typeof workflowId !== "string") throw new Error("Missing workflow ID");
  expect(await p.db.select().from(workflowAccountGrants)).toMatchObject([{ workflowId, memberId: "local-user", service: "fixture_account" }]);
  expect(await p.db.select().from(workflowActionGrants)).toMatchObject([{ workflowId, ownerType: "team", ownerId: team.id }]);
  const scope = { orgId: "local-org", teamId: team.id, actorId: `team:${team.id}`, service: "fixture_account", memberId: "local-user" };
  await p.workflowStore.createRun("scheduled", { workflowId, definitionVersionId: "v1" }, definition, "v1",
    { ownerType: "team", ownerId: team.id, actorUserId: scope.actorId });
  expect(await canBorrowCredential(p.db, { ...scope, sessionId: "wf:scheduled" })).toBe(true);
});
