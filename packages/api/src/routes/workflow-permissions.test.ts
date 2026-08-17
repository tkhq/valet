/**
 * `GET /api/workflows/:id/permissions` + `POST .../permissions/allow` route
 * tests. Definitions with tool nodes are inserted directly into the DB
 * (the save-time validator rejects services absent from the catalog, and
 * one test needs exactly such a node to assert the `unknown` mode).
 */
import { describe, it, expect, afterEach } from "vitest";
import { Type } from "typebox";
import type { PluginAction, ValetPlugin } from "@valet/engine";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { actionPolicies, actionPolicyOverrides, workflowDefinitions, workflowVersions } from "../schema/index.js";
import type {
  AllowWorkflowPermissionsResponse,
  GetWorkflowPermissionsResponse,
} from "../wire/types.js";

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
    actions: [{ service: "widgets", actions: [widgetAction("deploy", "high"), widgetAction("list", "low")] }],
  };
}

const DEFINITION = {
  version: "dag/v1",
  nodes: [
    { id: "trigger", type: "trigger" },
    { id: "ship", type: "tool", service: "widgets", action: "deploy", params: {} },
    { id: "inventory", type: "tool", service: "widgets", action: "list", params: {} },
    { id: "mystery", type: "tool", service: "unplugged", action: "thing", params: {} },
    { id: "human", type: "approval", prompt: "ok to continue?" },
    { id: "stop", type: "stop" },
  ],
  edges: [
    { from: "trigger", to: "ship" },
    { from: "ship", to: "inventory" },
    { from: "inventory", to: "mystery" },
    { from: "mystery", to: "human" },
    { from: "human", to: "stop" },
  ],
};

async function insertWorkflow(
  localApi: TestApi,
  opts: { ownerId?: string } = {},
): Promise<string> {
  const now = Date.now();
  const id = `wf_perm_${now}_${Math.random().toString(36).slice(2, 8)}`;
  await localApi.providers.db.insert(workflowDefinitions).values({
    id,
    orgId: "local-org",
    name: "perm-test-wf",
    definition: DEFINITION,
    ownerType: "user",
    ownerId: opts.ownerId ?? "local-user",
    createdAt: now,
    updatedAt: now,
  });
  await localApi.providers.db.insert(workflowVersions).values({
    id: `wfv_${id}`,
    workflowId: id,
    version: 1,
    name: "perm-test-wf",
    definition: DEFINITION,
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

    expect(body.nodes).toHaveLength(3);
    expect(nodes.get("ship")).toMatchObject({
      service: "widgets",
      action: "deploy",
      actionId: "widgets.deploy",
      riskLevel: "high",
      mode: "require_approval",
      provenance: "risk_default",
    });
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

describe("POST /api/workflows/:id/permissions/allow", () => {
  it("writes one allow override per gating action; the next preview allows", async () => {
    api = await bootTestApi({ plugins: [widgetsPlugin()] });
    const wfId = await insertWorkflow(api);

    const res = await fetch(`${api.baseUrl}/api/workflows/${wfId}/permissions/allow`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as AllowWorkflowPermissionsResponse;
    expect(body).toEqual({ allowed: ["widgets.deploy"], blocked: [] });

    const rows = await api.providers.db.select().from(actionPolicyOverrides);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      userId: "local-user",
      actionId: "widgets.deploy",
      mode: "allow",
    });

    const preview = await fetch(`${api.baseUrl}/api/workflows/${wfId}/permissions`);
    const previewBody = (await preview.json()) as GetWorkflowPermissionsResponse;
    expect(byNodeId(previewBody).get("ship")).toMatchObject({ mode: "allow", provenance: "override" });
  });

  it("is idempotent — a second call updates the same override row", async () => {
    api = await bootTestApi({ plugins: [widgetsPlugin()] });
    const wfId = await insertWorkflow(api);

    const first = await fetch(`${api.baseUrl}/api/workflows/${wfId}/permissions/allow`, { method: "POST" });
    expect(first.status).toBe(200);
    // The gating set is empty on the second call (the override now allows
    // the action), so the response allows nothing and writes nothing new.
    const second = await fetch(`${api.baseUrl}/api/workflows/${wfId}/permissions/allow`, { method: "POST" });
    expect(second.status).toBe(200);
    expect((await second.json()) as AllowWorkflowPermissionsResponse).toEqual({ allowed: [], blocked: [] });

    const rows = await api.providers.db.select().from(actionPolicyOverrides);
    expect(rows).toHaveLength(1);
  });

  it("an actionId outside the gating set → 400", async () => {
    api = await bootTestApi({ plugins: [widgetsPlugin()] });
    const wfId = await insertWorkflow(api);

    const res = await fetch(`${api.baseUrl}/api/workflows/${wfId}/permissions/allow`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ actionIds: ["widgets.list"] }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("not a gating action") });
    const rows = await api.providers.db.select().from(actionPolicyOverrides);
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

    const res = await fetch(`${api.baseUrl}/api/workflows/${wfId}/permissions/allow`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as AllowWorkflowPermissionsResponse;
    expect(body.allowed).toEqual([]);
    expect(body.blocked).toHaveLength(1);
    expect(body.blocked[0].actionId).toBe("widgets.deploy");
    const rows = await api.providers.db.select().from(actionPolicyOverrides);
    expect(rows).toHaveLength(0);
  });

  it("unknown workflow → 404", async () => {
    api = await bootTestApi({ plugins: [widgetsPlugin()] });
    const res = await fetch(`${api.baseUrl}/api/workflows/wf_nope/permissions/allow`, { method: "POST" });
    expect(res.status).toBe(404);
  });
});
