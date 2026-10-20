/**
 * `GET /api/workflows/:id/permissions` + `POST .../permissions/allow` route
 * tests. Definitions with tool nodes are inserted directly into the DB
 * (the save-time validator rejects services absent from the catalog, and
 * one test needs exactly such a node to assert the `unknown` mode).
 */
import { describe, it, expect, afterEach } from "vitest";
import { Type } from "typebox";
import { eq } from "drizzle-orm";
import type { PluginAction, ValetPlugin } from "@valet/engine";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { actionPolicies, actionPolicyOverrides, workflowActionGrants, workflowRuns, workflowDefinitions, workflowVersions } from "../schema/index.js";
import { addMember, createTeam } from "../services/teams.js";
import { loadPolicyRows, resolveActionPolicy } from "../policies/service.js";
import { isRiskLevel } from "../policies/admin.js";
import { needsGrant } from "../workflows/permissions.js";
import type {
  AllowWorkflowPermissionsResponse,
  GetWorkflowPermissionsResponse,
} from "../wire/types.js";

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

afterEach(async () => {
  await api?.cleanup();
  api = undefined;
});

function widgetAction(id: string, riskLevel: PluginAction["riskLevel"]): PluginAction {
  return {
    id,
    name: id,
    description: `fixture action ${id}`,
    riskLevel,
    parameters: Type.Object({}),
    execute: async () => ({ success: true, data: {} }),
  };
}

/** One service, two static actions: `deploy` (high risk → gates by risk
 * default) and `list` (low risk → allows by risk default). */
function widgetsPlugin(): ValetPlugin {
  return {
    name: "widgets",
    version: "0.0.1",
    actions: [
      {
        service: "widgets",
        actions: [widgetAction("deploy", "high"), widgetAction("list", "low"), widgetAction("purge", "critical")],
      },
    ],
  };
}

const DEFINITION = {
  version: "dag/v1",
  nodes: [
    { id: "trigger", type: "trigger" },
    { id: "ship", type: "tool", service: "widgets", action: "deploy", params: {} },
    { id: "inventory", type: "tool", service: "widgets", action: "list", params: {} },
    { id: "mystery", type: "tool", service: "unplugged", action: "thing", params: {} },
    // A foreach whose body is a gating tool action: the run gates on it
    // exactly like a top-level tool node, so the analysis must report it —
    // attributed to the foreach node's id, the card the editor draws.
    {
      id: "fanout",
      type: "foreach",
      items: "{{ trigger.data.items }}",
      body: { id: "fanout-body", type: "tool", service: "widgets", action: "purge", params: {} },
    },
    { id: "human", type: "approval", prompt: "ok to continue?" },
    { id: "stop", type: "stop" },
  ],
  edges: [
    { from: "trigger", to: "ship" },
    { from: "ship", to: "inventory" },
    { from: "inventory", to: "mystery" },
    { from: "mystery", to: "fanout" },
    { from: "fanout", to: "human" },
    { from: "human", to: "stop" },
  ],
};

async function insertWorkflow(
  localApi: TestApi,
  opts: { ownerId?: string; ownerType?: "user" | "team"; definition?: unknown } = {},
): Promise<string> {
  const now = Date.now();
  const id = `wf_perm_${now}_${Math.random().toString(36).slice(2, 8)}`;
  await localApi.providers.db.insert(workflowDefinitions).values({
    id,
    orgId: "local-org",
    name: "perm-test-wf",
    definition: opts.definition ?? DEFINITION,
    ownerType: opts.ownerType ?? "user",
    ownerId: opts.ownerId ?? "local-user",
    createdAt: now,
    updatedAt: now,
  });
  await localApi.providers.db.insert(workflowVersions).values({
    id: `wfv_${id}`,
    workflowId: id,
    version: 1,
    name: "perm-test-wf",
    definition: opts.definition ?? DEFINITION,
    createdAt: now,
  });
  return id;
}

function byNodeId(resp: GetWorkflowPermissionsResponse): Map<string, GetWorkflowPermissionsResponse["nodes"][number]> {
  return new Map(resp.nodes.map((n) => [n.nodeId, n]));
}

describe("GET /api/workflows/:id/permissions", () => {
  it("predicts per tool node; approval nodes are absent", async () => {
    api = await bootTestApi({ plugins: [widgetsPlugin()] });
    const wfId = await insertWorkflow(api);

    const res = await fetch(`${api.baseUrl}/api/workflows/${wfId}/permissions`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as GetWorkflowPermissionsResponse;
    const nodes = byNodeId(body);

    expect(body.nodes).toHaveLength(4);
    expect(nodes.get("ship")).toMatchObject({
      service: "widgets",
      action: "deploy",
      actionId: "widgets.deploy",
      riskLevel: "high",
      mode: "require_approval",
      provenance: "risk_default",
    });
    // The foreach body's tool action, attributed to the foreach node's id.
    expect(nodes.get("fanout")).toMatchObject({
      service: "widgets",
      action: "purge",
      actionId: "widgets.purge",
      riskLevel: "critical",
      mode: "require_approval",
      provenance: "risk_default",
    });
    expect(nodes.has("fanout-body")).toBe(false);
    expect(nodes.get("inventory")).toMatchObject({
      actionId: "widgets.list",
      riskLevel: "low",
      mode: "allow",
      provenance: "risk_default",
    });
    expect(nodes.get("mystery")).toMatchObject({
      service: "unplugged",
      action: "thing",
      actionId: null,
      mode: "unknown",
    });
    expect(nodes.has("human")).toBe(false);
  });

  // "Allow for this workflow" on a parked run's card saves this grant. The
  // review shows it, so the step-design warning about the step goes quiet.
  it("shows the saved grant on a tool step's dynamic action", async () => {
    api = await bootTestApi({ plugins: [widgetsPlugin()] });
    const wfId = await insertWorkflow(api);
    const mystery = async () => ((await (await fetch(`${api!.baseUrl}/api/workflows/${wfId}/permissions`)).json()) as GetWorkflowPermissionsResponse)
      .nodes.find((n) => n.nodeId === "mystery");
    expect(await mystery()).not.toHaveProperty("granted");
    await api.providers.db.insert(workflowActionGrants).values({
      id: "grant-mystery", orgId: "local-org", workflowId: wfId, ownerType: "user", ownerId: "local-user",
      actionId: "unplugged.thing", grantedBy: "local-user", createdAt: Date.now(),
    });
    expect(await mystery()).toMatchObject({ actionId: null, mode: "unknown", granted: true });
  });

  it("an org deny surfaces as mode deny with org_policy provenance", async () => {
    api = await bootTestApi({ plugins: [widgetsPlugin()] });
    const wfId = await insertWorkflow(api);
    await api.providers.db.insert(actionPolicies).values({
      id: "pol_deny_deploy", orgId: "local-org", principalType: "org", principalId: "local-org",
      service: null, actionId: "widgets.deploy", riskLevel: null, mode: "deny",
      paramMatchers: [], appliesIn: "any", origin: "settings", managedBy: null,
      expiresAt: null, revokedAt: null, createdAt: 1, updatedAt: 1,
    });

    const res = await fetch(`${api.baseUrl}/api/workflows/${wfId}/permissions`);
    const body = (await res.json()) as GetWorkflowPermissionsResponse;
    expect(byNodeId(body).get("ship")).toMatchObject({ mode: "deny", provenance: "org_policy" });
  });

  it("another user's workflow → 404", async () => {
    api = await bootTestApi({ plugins: [widgetsPlugin()] });
    const wfId = await insertWorkflow(api, { ownerId: "someone-else" });
    const res = await fetch(`${api.baseUrl}/api/workflows/${wfId}/permissions`);
    expect(res.status).toBe(404);
  });
});

describe("team workflow permissions", () => {
  it("matches runtime team decisions and ignores personal overrides", async () => {
    api = await bootTestApi({ plugins: [widgetsPlugin()] });
    const team = await createTeam(api.providers.db, { orgId: "local-org", name: "Permissions team", creatorUserId: "local-user" });
    const wfId = await insertWorkflow(api, { ownerType: "team", ownerId: team.id });
    await api.providers.db.insert(actionPolicies).values([
      { id: "team-deny", orgId: "local-org", principalType: "team", principalId: team.id,
        actionId: "widgets.deploy", mode: "deny", paramMatchers: [], appliesIn: "workflow", origin: "admin", createdAt: 1, updatedAt: 1 },
      { id: "team-approval", orgId: "local-org", principalType: "team", principalId: team.id,
        actionId: "widgets.list", mode: "require_approval", paramMatchers: [], appliesIn: "workflow", origin: "admin", createdAt: 1, updatedAt: 1 },
    ]);
    await api.providers.db.insert(actionPolicyOverrides).values({
      id: "personal-allow", orgId: "local-org", userId: "local-user", service: "widgets",
      mode: "allow", paramMatchers: [], createdAt: 1, updatedAt: 1,
    });

    const response = await fetch(`${api.baseUrl}/api/workflows/${wfId}/permissions`);
    expect(response.status).toBe(200);
    const preview = (await response.json()) as GetWorkflowPermissionsResponse;
    const nodes = byNodeId(preview);
    expect(nodes.get("ship")).toMatchObject({ mode: "deny", provenance: "team_policy" });
    expect(nodes.get("inventory")).toMatchObject({ mode: "require_approval", provenance: "team_policy" });
    expect(nodes.get("fanout")).toMatchObject({ mode: "require_approval", provenance: "risk_default" });
    for (const node of preview.nodes) {
      if (!node.actionId) continue;
      if (!isRiskLevel(node.riskLevel)) throw new Error(`Invalid risk level for ${node.actionId}`);
      const runtime = await resolveActionPolicy(api.providers.db, {
        orgId: "local-org", teamId: team.id, userId: "local-user", service: node.service,
        actionId: node.actionId, riskLevel: node.riskLevel, params: {}, appliesIn: "workflow",
        workflowExecutionId: "team-preview-run", pluginDefault: undefined, now: Date.now(),
      });
      expect({ mode: node.mode, source: node.provenance }).toEqual({ mode: runtime.mode, source: runtime.provenance.source });
    }
    const personalId = await insertWorkflow(api);
    const personalResponse = await fetch(`${api.baseUrl}/api/workflows/${personalId}/permissions`);
    const personal = (await personalResponse.json()) as GetWorkflowPermissionsResponse;
    expect(byNodeId(personal).get("ship")).toMatchObject({ mode: "allow", provenance: "override" });
  });

  it("team admins grant only this workflow without changing personal overrides", async () => {
    api = await bootTestApi({ plugins: [widgetsPlugin()] });
    const team = await createTeam(api.providers.db, { orgId: "local-org", name: "Team", creatorUserId: "local-user" });
    const wfId = await insertWorkflow(api, { ownerType: "team", ownerId: team.id });
    const response = await reviewedApproval(`${api.baseUrl}/api/workflows/${wfId}/permissions/allow`, { method: "POST" });
    expect(response.status).toBe(200);
    expect(await api.providers.db.select().from(actionPolicyOverrides)).toHaveLength(0);
    expect(await api.providers.db.select().from(workflowActionGrants)).toHaveLength(2);
    const outsider = await reviewedApproval(`${api.baseUrl}/api/workflows/${wfId}/permissions/allow`, { method: "POST", headers: { "x-valet-test-user-id": "test-member" } });
    expect(outsider.status).toBe(404);
  });
});

describe("workflow grants after a definition change", () => {
  it("end on any step edit, the approver's too, and survive a move on the map", async () => {
    api = await bootTestApi({ plugins: [widgetsPlugin()] });
    const team = await createTeam(api.providers.db, { orgId: "local-org", name: "Grant team", creatorUserId: "local-user" });
    await addMember(api.providers.db, { teamId: team.id, userId: "test-member", role: "member" });
    // Each edit adds one more step that uses the approved action.
    const ships = (count: number) => {
      const ids = Array.from({ length: count }, (_, index) => `ship${index}`);
      return { version: "dag/v1",
        nodes: [{ id: "trigger", type: "trigger" }, ...ids.map((id) => ({ id, type: "tool", service: "widgets", action: "deploy", params: {} })), { id: "stop", type: "stop" }],
        edges: ["trigger", ...ids, "stop"].slice(1).map((to, index) => ({ from: ["trigger", ...ids][index]!, to })) };
    };
    const wfId = await insertWorkflow(api, { ownerType: "team", ownerId: team.id, definition: ships(1) });
    const allow = () => reviewedApproval(`${api!.baseUrl}/api/workflows/${wfId}/permissions/allow`, { method: "POST" });
    expect((await allow()).status).toBe(200);
    expect(await api.providers.db.select().from(workflowActionGrants)).toHaveLength(1);
    const edit = (count: number, headers: Record<string, string> = {}) => fetch(`${api!.baseUrl}/api/workflows/${wfId}`, {
      method: "PUT", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify({ definition: ships(count) }),
    });
    // A member only moves a step on the map: the steps are the same, so the approval stands.
    const moved = await fetch(`${api.baseUrl}/api/workflows/${wfId}`, {
      method: "PUT", headers: { "Content-Type": "application/json", "x-valet-test-user-id": "test-member" },
      body: JSON.stringify({ definition: { ...ships(1), ui: { nodes: { ship0: { position: { x: 512, y: 96 } } } } } }),
    });
    expect(moved.status).toBe(200);
    expect(await api.providers.db.select().from(workflowActionGrants)).toHaveLength(1);
    // The approver adds another use of the approved action: the grant covered
    // the steps as reviewed, so it ends and a person allows the new steps.
    expect((await edit(2)).status).toBe(200);
    expect(await api.providers.db.select().from(workflowActionGrants)).toHaveLength(0);
    expect((await allow()).status).toBe(200);
    expect((await edit(3, { "x-valet-test-user-id": "test-member" })).status).toBe(200);
    expect(await api.providers.db.select().from(workflowActionGrants)).toHaveLength(0);
  });

  it("do not cover a run that started on other steps", async () => {
    api = await bootTestApi({ plugins: [widgetsPlugin()] });
    const reviewed = { version: "dag/v1", nodes: [{ id: "trigger", type: "trigger" }, { id: "ship", type: "tool", service: "widgets", action: "deploy", params: { target: "staging" } }, { id: "stop", type: "stop" }],
      edges: [{ from: "trigger", to: "ship" }, { from: "ship", to: "stop" }] };
    const older = { ...reviewed, nodes: reviewed.nodes.map((node) => node.id === "ship" ? { ...node, params: { target: "attacker" } } : node) };
    const wfId = await insertWorkflow(api, { definition: reviewed });
    expect((await reviewedApproval(`${api.baseUrl}/api/workflows/${wfId}/permissions/allow`, { method: "POST" })).status).toBe(200);
    const owner = { ownerType: "user", ownerId: "local-user" };
    await api.providers.workflowStore.createRun("run-reviewed", { workflowId: wfId, definitionVersionId: "v2" }, reviewed, "v2", owner);
    await api.providers.workflowStore.createRun("run-older", { workflowId: wfId, definitionVersionId: "v1" }, older, "v1", owner);
    const rows = (runId: string) => loadPolicyRows(api!.providers.db, { orgId: "local-org", userId: "local-user", workflowExecutionId: runId });
    expect((await rows("run-reviewed")).workflowGrants).toMatchObject([{ actionId: "widgets.deploy" }]);
    expect((await rows("run-older")).workflowGrants).toEqual([]);
  });

  it("are removed with the workflow", async () => {
    api = await bootTestApi({ plugins: [widgetsPlugin()] });
    const wfId = await insertWorkflow(api);
    expect((await reviewedApproval(`${api.baseUrl}/api/workflows/${wfId}/permissions/allow`, { method: "POST" })).status).toBe(200);
    expect((await api.providers.db.select().from(workflowActionGrants)).length).toBeGreaterThan(0);
    expect((await fetch(`${api.baseUrl}/api/workflows/${wfId}`, { method: "DELETE" })).ok).toBe(true);
    expect(await api.providers.db.select().from(workflowActionGrants)).toHaveLength(0);
  });
});

describe("POST /api/workflows/:id/permissions/allow", () => {
  it("writes one workflow grant per gating action; the next preview allows", async () => {
    api = await bootTestApi({ plugins: [widgetsPlugin()] });
    const wfId = await insertWorkflow(api);

    const res = await reviewedApproval(`${api.baseUrl}/api/workflows/${wfId}/permissions/allow`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as AllowWorkflowPermissionsResponse;
    expect(body).toEqual({ allowed: ["widgets.deploy", "widgets.purge"], blocked: [] });

    const rows = await api.providers.db.select().from(workflowActionGrants);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.actionId).sort()).toEqual(["widgets.deploy", "widgets.purge"]);
    expect(rows.every((r) => r.ownerId === "local-user" && r.workflowId === wfId)).toBe(true);

    const preview = await fetch(`${api.baseUrl}/api/workflows/${wfId}/permissions`);
    const previewBody = (await preview.json()) as GetWorkflowPermissionsResponse;
    expect(byNodeId(previewBody).get("ship")).toMatchObject({ mode: "allow", provenance: "workflow_grant" });
    expect(byNodeId(previewBody).get("fanout")).toMatchObject({ mode: "allow", provenance: "workflow_grant" });
  });

  it("is idempotent — a second call updates the same workflow grant row", async () => {
    api = await bootTestApi({ plugins: [widgetsPlugin()] });
    const wfId = await insertWorkflow(api);

    const first = await reviewedApproval(`${api.baseUrl}/api/workflows/${wfId}/permissions/allow`, { method: "POST" });
    expect(first.status).toBe(200);
    // The gating set is empty on the second call (the overrides now allow
    // the actions), so the response allows nothing and writes nothing new.
    const second = await reviewedApproval(`${api.baseUrl}/api/workflows/${wfId}/permissions/allow`, { method: "POST" });
    expect(second.status).toBe(200);
    expect((await second.json()) as AllowWorkflowPermissionsResponse).toEqual({ allowed: [], blocked: [] });

    const rows = await api.providers.db.select().from(workflowActionGrants);
    expect(rows).toHaveLength(2);
  });

  it("an actionId outside the gating set → 400", async () => {
    api = await bootTestApi({ plugins: [widgetsPlugin()] });
    const wfId = await insertWorkflow(api);

    const res = await reviewedApproval(`${api.baseUrl}/api/workflows/${wfId}/permissions/allow`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ actionIds: ["widgets.list"] }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("not a gating action") });
    const rows = await api.providers.db.select().from(workflowActionGrants);
    expect(rows).toHaveLength(0);
  });

  it("an org require_approval policy blocks the override (bounds check)", async () => {
    api = await bootTestApi({ plugins: [widgetsPlugin()] });
    const wfId = await insertWorkflow(api);
    await api.providers.db.insert(actionPolicies).values({
      id: "pol_gate_deploy", orgId: "local-org", principalType: "org", principalId: "local-org",
      service: null, actionId: "widgets.deploy", riskLevel: null, mode: "require_approval",
      paramMatchers: [], appliesIn: "any", origin: "settings", managedBy: null,
      expiresAt: null, revokedAt: null, createdAt: 1, updatedAt: 1,
    });

    const res = await reviewedApproval(`${api.baseUrl}/api/workflows/${wfId}/permissions/allow`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as AllowWorkflowPermissionsResponse;
    // The org policy pins widgets.deploy; widgets.purge stays self-serviceable.
    expect(body.allowed).toEqual(["widgets.purge"]);
    expect(body.blocked).toHaveLength(1);
    expect(body.blocked[0].actionId).toBe("widgets.deploy");
    const rows = await api.providers.db.select().from(workflowActionGrants);
    expect(rows).toHaveLength(1);
    expect(rows[0].actionId).toBe("widgets.purge");
  });

  it("a null body → 400, a bare-array body → 400, nothing written", async () => {
    api = await bootTestApi({ plugins: [widgetsPlugin()] });
    const wfId = await insertWorkflow(api);

    for (const raw of ["null", '["widgets.deploy"]']) {
      const res = await fetch(`${api.baseUrl}/api/workflows/${wfId}/permissions/allow`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: raw,
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: expect.stringContaining("JSON object") });
    }
    const rows = await api.providers.db.select().from(workflowActionGrants);
    expect(rows).toHaveLength(0);
  });

  it("unknown workflow → 404", async () => {
    api = await bootTestApi({ plugins: [widgetsPlugin()] });
    const res = await reviewedApproval(`${api.baseUrl}/api/workflows/wf_nope/permissions/allow`, { method: "POST" });
    expect(res.status).toBe(404);
  });
});


describe("workflow grant isolation", () => {
  it("applies across runs of one workflow, never other workflows or chats, and revokes", async () => {
    api = await bootTestApi({ plugins: [widgetsPlugin()] });
    const first = await insertWorkflow(api);
    const second = await insertWorkflow(api);
    expect((await reviewedApproval(`${api.baseUrl}/api/workflows/${first}/permissions/allow`, { method: "POST" })).status).toBe(200);
    for (const [runId, workflowId, expected] of [["run-a", first, "allow"], ["run-b", first, "allow"], ["run-c", second, "require_approval"]] as const) {
      await api.providers.db.insert(workflowRuns).values({ id: runId, workflowId, definitionVersionId: `wfv_${workflowId}`, definition: DEFINITION, params: {}, createdAt: 1, updatedAt: 1 });
      const result = await resolveActionPolicy(api.providers.db, { orgId: "local-org", userId: "local-user", service: "widgets", actionId: "widgets.deploy", riskLevel: "high", params: {}, appliesIn: "workflow", workflowExecutionId: runId, pluginDefault: undefined, now: Date.now() });
      expect(result.mode).toBe(expected);
    }
    const chat = await resolveActionPolicy(api.providers.db, { orgId: "local-org", userId: "local-user", service: "widgets", actionId: "widgets.deploy", riskLevel: "high", params: {}, appliesIn: "session", sessionId: "chat", pluginDefault: undefined, now: Date.now() });
    expect(chat.mode).toBe("require_approval");
    expect((await fetch(`${api.baseUrl}/api/workflows/${first}/permissions/allow`, { method: "DELETE" })).status).toBe(200);
    const preview = await fetch(`${api.baseUrl}/api/workflows/${first}/permissions`);
    expect(await preview.json()).toMatchObject({ nodes: expect.arrayContaining([expect.objectContaining({ nodeId: "ship", mode: "require_approval" })]) });
  });
});


describe("a workflow save allows nothing", () => {
  const definition = {
    version: "dag/v1",
    nodes: [
      { id: "trigger", type: "trigger" },
      { id: "ship", type: "tool", service: "widgets", action: "deploy", params: {} },
      { id: "stop", type: "stop" },
    ],
    edges: [{ from: "trigger", to: "ship" }, { from: "ship", to: "stop" }],
  };

  it.each([false, true])("allows nothing on creation until a person allows the steps (team=%s)", async (teamOwned) => {
    api = await bootTestApi({ plugins: [widgetsPlugin()] });
    const team = teamOwned ? await createTeam(api.providers.db, { orgId: "local-org", name: "Save permissions", creatorUserId: "local-user" }) : undefined;
    const response = await fetch(`${api.baseUrl}/api/workflows`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Saved automation", definition, teamId: team?.id }),
    });
    expect(response.status).toBe(201);
    const saved = await response.json();
    if (!saved || typeof saved !== "object" || !("id" in saved) || typeof saved.id !== "string") throw new Error("Missing workflow ID");
    const permissions = () => fetch(`${api!.baseUrl}/api/workflows/${saved.id}/permissions`).then((res) => res.json());
    expect(await permissions()).toMatchObject({ nodes: [expect.objectContaining({ nodeId: "ship", mode: "require_approval" })] });
    expect(await api.providers.db.select().from(workflowActionGrants)).toHaveLength(0);
    expect((await reviewedApproval(`${api.baseUrl}/api/workflows/${saved.id}/permissions/allow`, { method: "POST" })).status).toBe(200);
    expect(await permissions()).toMatchObject({ nodes: [expect.objectContaining({ nodeId: "ship", mode: "allow", provenance: "workflow_grant" })] });
    expect(await api.providers.db.select().from(workflowActionGrants)).toMatchObject([{ workflowId: saved.id, ownerId: team?.id ?? "local-user", grantedBy: "local-user" }]);
    // The grant never quiets the same action in an unrelated workflow.
    const other = await insertWorkflow(api, { definition });
    const unrelated = await fetch(`${api.baseUrl}/api/workflows/${other}/permissions`);
    expect(await unrelated.json()).toMatchObject({ nodes: [expect.objectContaining({ nodeId: "ship", mode: "require_approval" })] });
  });

  it("asks again after a save adds a step, and a review keeps explicit restrictions", async () => {
    api = await bootTestApi({ plugins: [widgetsPlugin()] });
    const id = await insertWorkflow(api, { definition });
    expect((await reviewedApproval(`${api.baseUrl}/api/workflows/${id}/permissions/allow`, { method: "POST" })).status).toBe(200);
    await api.providers.db.insert(actionPolicies).values({
      id: "save-org-gate", orgId: "local-org", principalType: "org", principalId: "local-org",
      actionId: "widgets.purge", mode: "require_approval", paramMatchers: [], appliesIn: "workflow", origin: "admin", createdAt: 1, updatedAt: 1,
    });
    const next = { ...definition, nodes: [...definition.nodes, { id: "purge", type: "tool", service: "widgets", action: "purge", params: {} }],
      edges: [...definition.edges, { from: "trigger", to: "purge" }] };
    const saved = await fetch(`${api.baseUrl}/api/workflows/${id}`, {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ definition: next }),
    });
    expect(saved.status).toBe(200);
    const permissions = () => fetch(`${api!.baseUrl}/api/workflows/${id}/permissions`).then((res) => res.json());
    expect(await permissions()).toMatchObject({ nodes: expect.arrayContaining([expect.objectContaining({ nodeId: "ship", mode: "require_approval" })]) });
    expect((await reviewedApproval(`${api.baseUrl}/api/workflows/${id}/permissions/allow`, { method: "POST" })).status).toBe(200);
    expect(await permissions()).toMatchObject({ nodes: expect.arrayContaining([
      expect.objectContaining({ nodeId: "ship", mode: "allow" }),
      expect.objectContaining({ nodeId: "purge", mode: "require_approval", provenance: "org_policy" }),
    ]) });
  });

  it("does not let a non-admin team member grant action permission by saving", async () => {
    api = await bootTestApi({ plugins: [widgetsPlugin()] });
    const team = await createTeam(api.providers.db, { orgId: "local-org", name: "Member save", creatorUserId: "local-user" });
    await addMember(api.providers.db, { teamId: team.id, userId: "test-member", role: "member" });
    const response = await fetch(`${api.baseUrl}/api/workflows`, {
      method: "POST", headers: { "Content-Type": "application/json", "x-valet-test-user-id": "test-member" },
      body: JSON.stringify({ name: "Member workflow", definition, teamId: team.id }),
    });
    expect(response.status).toBe(201);
    expect(await api.providers.db.select().from(workflowActionGrants)).toHaveLength(0);
  });
});


it("rejects permission approval without the definition token returned by the review", async () => {
  api = await bootTestApi({ plugins: [widgetsPlugin()] });
  const id = await insertWorkflow(api);
  const approval = await fetch(`${api.baseUrl}/api/workflows/${id}/permissions/allow`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  expect(approval.status).toBe(400);
  expect(await api.providers.db.select().from(workflowActionGrants)).toHaveLength(0);
});


it.each(["workflow", "owner"])("binds a permissions review to the current %s identity", async changed => {
  api = await bootTestApi({ plugins: [widgetsPlugin()] });
  const id = await insertWorkflow(api);
  const response = await fetch(`${api.baseUrl}/api/workflows/${id}/permissions`);
  const reviewed: unknown = await response.json();
  if (!reviewed || typeof reviewed !== "object" || !("definitionToken" in reviewed)) throw new Error("Missing reviewed definition token.");
  let target = id;
  if (changed === "workflow") target = await insertWorkflow(api);
  else {
    const team = await createTeam(api.providers.db, { orgId: "local-org", name: "New workflow owner", creatorUserId: "local-user" });
    await api.providers.db.update(workflowDefinitions).set({ ownerType: "team", ownerId: team.id }).where(eq(workflowDefinitions.id, id));
  }
  const approval = await fetch(`${api.baseUrl}/api/workflows/${target}/permissions/allow`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ definitionToken: reviewed.definitionToken }) });
  expect(approval.status).toBe(409);
  expect(await api.providers.db.select().from(workflowActionGrants)).toHaveLength(0);
});

describe("agent step permissions", () => {
  const AGENT_DEFINITION = {
    version: "dag/v1",
    nodes: [
      { id: "trigger", type: "trigger" },
      { id: "writer", type: "session", mode: "start", prompt: "Ship it.", toolScope: { actions: ["widgets.deploy", "widgets.list", "widgets.*", "granola.list_meetings"] } },
      { id: "reporter", type: "orchestrator", prompt: "Report.", toolScope: { actions: ["widgets.purge"] } },
      { id: "reader", type: "session", mode: "start", prompt: "Read." },
    ],
    edges: [{ from: "trigger", to: "writer" }, { from: "writer", to: "reporter" }, { from: "reporter", to: "reader" }],
  };

  it("reviews and grants only the exact actions agent steps list", async () => {
    api = await bootTestApi({ plugins: [widgetsPlugin()] });
    const wfId = await insertWorkflow(api, { definition: AGENT_DEFINITION });

    const body = (await (await fetch(`${api.baseUrl}/api/workflows/${wfId}/permissions`)).json()) as GetWorkflowPermissionsResponse;
    expect(body.nodes.map((n) => [n.nodeId, n.actionId, n.mode, n.agentStep])).toEqual([
      ["writer", "widgets.deploy", "require_approval", true],
      ["writer", "widgets.list", "allow", true],
      ["writer", "granola.list_meetings", "unknown", true],
      ["reporter", "widgets.purge", "require_approval", true],
    ]);

    const res = await reviewedApproval(`${api.baseUrl}/api/workflows/${wfId}/permissions/allow`, { method: "POST" });
    expect(((await res.json()) as AllowWorkflowPermissionsResponse).allowed.sort()).toEqual(["granola.list_meetings", "widgets.deploy", "widgets.purge"]);
    // The review then reads the agent rows as allowed, as the run does, so nothing asks twice.
    const reviewed = (await (await fetch(`${api.baseUrl}/api/workflows/${wfId}/permissions`)).json()) as GetWorkflowPermissionsResponse;
    expect(reviewed.nodes.find((n) => n.actionId === "widgets.deploy")).toMatchObject({ mode: "allow", provenance: "workflow_grant", agentStep: true });
    // A dynamic action has no risk to read before a run, so it stays unknown,
    // but the review shows the saved grant and no longer counts it as waiting.
    const dynamic = reviewed.nodes.find((n) => n.actionId === "granola.list_meetings");
    expect(dynamic).toMatchObject({ mode: "unknown", agentStep: true, granted: true });
    expect(dynamic && needsGrant(dynamic)).toBe(false);

    await api.providers.workflowStore.createRun("agent-run", { workflowId: wfId, definitionVersionId: "v1" }, AGENT_DEFINITION, "v1",
      { ownerType: "user", ownerId: "local-user", actorUserId: "local-user" });
    const check = (agentStep: boolean) => resolveActionPolicy(api!.providers.db, {
      orgId: "local-org", userId: "local-user", service: "widgets", actionId: "widgets.deploy", riskLevel: "high",
      params: {}, appliesIn: "session", sessionId: "wf:agent-run:writer", pluginDefault: undefined, now: Date.now(),
      ...(agentStep ? { agentStep: { workflowId: wfId, runId: "agent-run" } } : {}),
    });
    expect(await check(true)).toMatchObject({ mode: "allow", provenance: { source: "workflow_grant" } });
    expect((await check(false)).mode).toBe("require_approval");

    // An edit and a new approval after the step check: the run's steps no
    // longer match the saved ones, so the grant lookup gives it nothing.
    const edited = { ...AGENT_DEFINITION, nodes: AGENT_DEFINITION.nodes.slice(0, 2) };
    await api.providers.db.update(workflowDefinitions).set({ definition: edited }).where(eq(workflowDefinitions.id, wfId));
    expect((await check(true)).mode).toBe("require_approval");
  });

  it("does not call a dynamic agent-step action granted while a risk rule could gate it", async () => {
    api = await bootTestApi({ plugins: [widgetsPlugin()] });
    const wfId = await insertWorkflow(api, { definition: AGENT_DEFINITION });
    await reviewedApproval(`${api.baseUrl}/api/workflows/${wfId}/permissions/allow`, { method: "POST" });
    // The run learns the action's risk only from discovery, and this rule
    // would then win over the grant (`resolution.ts`).
    await api.providers.db.insert(actionPolicies).values({
      id: "pol_critical", orgId: "local-org", principalType: "org", principalId: "local-org", riskLevel: "critical",
      mode: "require_approval", appliesIn: "any", paramMatchers: [], origin: "admin", createdAt: 1, updatedAt: 1,
    });
    const reviewed = (await (await fetch(`${api.baseUrl}/api/workflows/${wfId}/permissions`)).json()) as GetWorkflowPermissionsResponse;
    const dynamic = reviewed.nodes.find((n) => n.actionId === "granola.list_meetings");
    expect(dynamic).toMatchObject({ mode: "unknown", agentStep: true });
    expect(dynamic?.granted).toBeUndefined();
  });

  it("blocks an agent-step grant that an org rule scoped to workflows keeps gated", async () => {
    api = await bootTestApi({ plugins: [widgetsPlugin()] });
    const wfId = await insertWorkflow(api, { definition: AGENT_DEFINITION });
    await api.providers.db.insert(actionPolicies).values({
      id: "pol_wf_only", orgId: "local-org", principalType: "org", principalId: "local-org", actionId: "widgets.deploy",
      mode: "require_approval", appliesIn: "workflow", paramMatchers: [], origin: "admin", createdAt: 1, updatedAt: 1,
    });
    const res = await reviewedApproval(`${api.baseUrl}/api/workflows/${wfId}/permissions/allow`, { method: "POST" });
    const body = (await res.json()) as AllowWorkflowPermissionsResponse;
    expect(body.blocked.map((b) => b.actionId)).toEqual(["widgets.deploy"]);
    expect(body.allowed).not.toContain("widgets.deploy");
  });
});
