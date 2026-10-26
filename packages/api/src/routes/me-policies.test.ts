/**
 * `/api/me/policy-overrides`, `/api/me/grants` — a caller's own
 * per-user policy overrides and runtime grants. No admin gate (see
 * `routes/me-policies.ts` doc comment); the write-time bounds check on
 * overrides is what stops a member self-granting past an org policy —
 * across EVERY org-policy dimension the override could be outranked by at
 * real invocation time (`resolvePolicyDecision` puts a per-user override at
 * rung 2, above org allow/require_approval at rung 3 — see
 * `policies/admin.ts`'s `validateOverrideBounds` doc comment), not just the
 * override's own target dimension.
 */
import { describe, it, expect, afterEach } from "vitest";
import { Type } from "typebox";
import type { ActionPlugin, PluginAction, RiskLevel, ValetPlugin } from "@valet/engine";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { runtimeGrants, teamMembers, teams } from "../schema/index.js";
import { buildPolicyResolver } from "../policies/service.js";
import type {
  DeleteGrantResponse,
  DeletePolicyOverrideResponse,
  ListGrantsResponse,
  ListPolicyOverridesResponse,
  ListToolPermissionsResponse,
  PutPolicyOverrideResponse,
} from "../wire/types.js";

const HEADERS = { "Content-Type": "application/json" };

/** Minimal catalog fixture: `github` service (a medium-risk and a high-risk
 *  action) + `slack` service (a low-risk action) — enough for
 *  `validateOverrideBounds` to resolve every actionId-scoped override's real
 *  service/riskLevel, and for the cross-dimension bounds tests below to
 *  exercise both the "same service" and "provably different service" cases. */
function testCatalogAction(id: string, riskLevel: RiskLevel): PluginAction {
  return {
    id,
    name: id,
    description: id,
    riskLevel,
    parameters: Type.Object({}),
    execute: async () => ({ success: true }),
  };
}

function testPolicyPlugin(): ValetPlugin {
  const github: ActionPlugin = {
    service: "github",
    actions: [testCatalogAction("github.create_issue", "medium"), testCatalogAction("github.create_repository", "high")],
  };
  const slack: ActionPlugin = {
    service: "slack",
    actions: [testCatalogAction("slack.post_message", "low")],
  };
  // A plugin default, so the tool-permissions read can report `plugin`.
  const notion: ActionPlugin = {
    service: "notion",
    defaultApprovalMode: "require_approval",
    actions: [testCatalogAction("notion.search", "low")],
  };
  return { name: "test-policy-plugin", version: "0.0.1", actions: [github, slack, notion] };
}

const PLUGINS = [testPolicyPlugin()];

let api: TestApi | undefined;

afterEach(async () => {
  await api?.cleanup();
  api = undefined;
});

// ── Overrides: PUT upsert-by-target ──────────────────────────────────────

describe("PUT /api/me/policy-overrides", () => {
  it("400s when zero of service/actionId/riskLevel are set", async () => {
    api = await bootTestApi({ plugins: PLUGINS });
    const res = await fetch(`${api.baseUrl}/api/me/policy-overrides`, {
      method: "PUT",
      headers: HEADERS,
      body: JSON.stringify({ mode: "deny" }),
    });
    expect(res.status).toBe(400);
  });

  it("400s when more than one of service/actionId/riskLevel are set", async () => {
    api = await bootTestApi({ plugins: PLUGINS });
    const res = await fetch(`${api.baseUrl}/api/me/policy-overrides`, {
      method: "PUT",
      headers: HEADERS,
      body: JSON.stringify({ service: "github", riskLevel: "low", mode: "deny" }),
    });
    expect(res.status).toBe(400);
  });

  it("creates then updates the SAME row for the same target (upsert, not insert-twice)", async () => {
    api = await bootTestApi({ plugins: PLUGINS });

    const first = await fetch(`${api.baseUrl}/api/me/policy-overrides`, {
      method: "PUT",
      headers: HEADERS,
      body: JSON.stringify({ actionId: "github.create_issue", mode: "require_approval" }),
    });
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as PutPolicyOverrideResponse;

    const second = await fetch(`${api.baseUrl}/api/me/policy-overrides`, {
      method: "PUT",
      headers: HEADERS,
      body: JSON.stringify({ actionId: "github.create_issue", mode: "deny" }),
    });
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as PutPolicyOverrideResponse;

    expect(secondBody.id).toBe(firstBody.id);
    expect(secondBody.mode).toBe("deny");

    const listRes = await fetch(`${api.baseUrl}/api/me/policy-overrides`, { headers: HEADERS });
    const { overrides } = (await listRes.json()) as ListPolicyOverridesResponse;
    expect(overrides).toHaveLength(1);
  });

  it("tightening (require_approval/deny) is always allowed regardless of org policy", async () => {
    api = await bootTestApi({ plugins: PLUGINS });
    await fetch(`${api.baseUrl}/api/org/policies`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ actionId: "github.create_issue", mode: "allow" }),
    });
    const res = await fetch(`${api.baseUrl}/api/me/policy-overrides`, {
      method: "PUT",
      headers: HEADERS,
      body: JSON.stringify({ actionId: "github.create_issue", mode: "deny" }),
    });
    expect(res.status).toBe(200);
  });

  it("400s loosening to allow when the org policy for that exact target resolves require_approval", async () => {
    api = await bootTestApi({ plugins: PLUGINS });
    await fetch(`${api.baseUrl}/api/org/policies`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ actionId: "github.create_issue", mode: "require_approval" }),
    });

    const res = await fetch(`${api.baseUrl}/api/me/policy-overrides`, {
      method: "PUT",
      headers: HEADERS,
      body: JSON.stringify({ actionId: "github.create_issue", mode: "allow" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("require_approval");
  });

  it("400s loosening to allow when the org policy for that exact target resolves deny", async () => {
    api = await bootTestApi({ plugins: PLUGINS });
    await fetch(`${api.baseUrl}/api/org/policies`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ actionId: "github.create_issue", mode: "deny" }),
    });

    const res = await fetch(`${api.baseUrl}/api/me/policy-overrides`, {
      method: "PUT",
      headers: HEADERS,
      body: JSON.stringify({ actionId: "github.create_issue", mode: "allow" }),
    });
    expect(res.status).toBe(400);
  });

  it("allows loosening to allow when there is no matching org policy (unset)", async () => {
    api = await bootTestApi({ plugins: PLUGINS });
    const res = await fetch(`${api.baseUrl}/api/me/policy-overrides`, {
      method: "PUT",
      headers: HEADERS,
      body: JSON.stringify({ actionId: "github.create_issue", mode: "allow" }),
    });
    expect(res.status).toBe(200);
  });

  it("allows loosening to allow when the org policy for that exact target is itself allow", async () => {
    api = await bootTestApi({ plugins: PLUGINS });
    await fetch(`${api.baseUrl}/api/org/policies`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ actionId: "github.create_issue", mode: "allow" }),
    });
    const res = await fetch(`${api.baseUrl}/api/me/policy-overrides`, {
      method: "PUT",
      headers: HEADERS,
      body: JSON.stringify({ actionId: "github.create_issue", mode: "allow" }),
    });
    expect(res.status).toBe(200);
  });

  it("400s for a malformed paramMatchers entry", async () => {
    api = await bootTestApi({ plugins: PLUGINS });
    const res = await fetch(`${api.baseUrl}/api/me/policy-overrides`, {
      method: "PUT",
      headers: HEADERS,
      body: JSON.stringify({ actionId: "x", mode: "deny", paramMatchers: [{ op: "eq" }] }),
    });
    expect(res.status).toBe(400);
  });

  it("scopes overrides to the caller — a second user's PUT doesn't affect the first user's list", async () => {
    api = await bootTestApi({ plugins: PLUGINS });
    await fetch(`${api.baseUrl}/api/me/policy-overrides`, {
      method: "PUT",
      headers: HEADERS,
      body: JSON.stringify({ actionId: "github.create_issue", mode: "deny" }),
    });
    await fetch(`${api.baseUrl}/api/me/policy-overrides`, {
      method: "PUT",
      headers: { ...HEADERS, "x-valet-test-user-id": "test-member" },
      body: JSON.stringify({ actionId: "slack.post_message", mode: "deny" }),
    });

    const adminList = (await (
      await fetch(`${api.baseUrl}/api/me/policy-overrides`, { headers: HEADERS })
    ).json()) as ListPolicyOverridesResponse;
    expect(adminList.overrides).toHaveLength(1);
    expect(adminList.overrides[0]?.actionId).toBe("github.create_issue");
  });
});

// ── PUT /api/me/policy-overrides — cross-dimension bounds (finding 1) ────
//
// `validateOverrideBounds` previously only checked org policies in the SAME
// target dimension as the override being written — an actionId-scoped
// override was never bounded against a service- or riskLevel-scoped org
// policy that would still apply to that exact action at real invocation
// time (where a per-user override outranks org allow/require_approval).
// These pin the exploit and its fix directly.

describe("PUT /api/me/policy-overrides — cross-dimension bounds", () => {
  async function putOrgPolicy(target: Record<string, unknown>) {
    return fetch(`${api!.baseUrl}/api/org/policies`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify(target),
    });
  }

  it("EXPLOIT: a service-level require_approval blocks an actionId-scoped allow override", async () => {
    api = await bootTestApi({ plugins: PLUGINS });
    const orgRes = await putOrgPolicy({ service: "github", mode: "require_approval" });
    expect(orgRes.status).toBe(201);

    const res = await fetch(`${api.baseUrl}/api/me/policy-overrides`, {
      method: "PUT",
      headers: HEADERS,
      body: JSON.stringify({ actionId: "github.create_issue", mode: "allow" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("require_approval");
  });

  it("a riskLevel-level require_approval blocks an actionId-scoped allow override", async () => {
    api = await bootTestApi({ plugins: PLUGINS });
    // github.create_issue is riskLevel "medium" in the test catalog.
    const orgRes = await putOrgPolicy({ riskLevel: "medium", mode: "require_approval" });
    expect(orgRes.status).toBe(201);

    const res = await fetch(`${api.baseUrl}/api/me/policy-overrides`, {
      method: "PUT",
      headers: HEADERS,
      body: JSON.stringify({ actionId: "github.create_issue", mode: "allow" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("require_approval");
  });

  it("a cross-dimension org deny (service scope) is also blocked at write time (consistency)", async () => {
    api = await bootTestApi({ plugins: PLUGINS });
    const orgRes = await putOrgPolicy({ service: "github", mode: "deny" });
    expect(orgRes.status).toBe(201);

    const res = await fetch(`${api.baseUrl}/api/me/policy-overrides`, {
      method: "PUT",
      headers: HEADERS,
      body: JSON.stringify({ actionId: "github.create_issue", mode: "allow" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("deny");
  });

  it("a service-scoped allow override is blocked by an org riskLevel require_approval policy", async () => {
    api = await bootTestApi({ plugins: PLUGINS });
    const orgRes = await putOrgPolicy({ riskLevel: "high", mode: "require_approval" });
    expect(orgRes.status).toBe(201);

    const res = await fetch(`${api.baseUrl}/api/me/policy-overrides`, {
      method: "PUT",
      headers: HEADERS,
      body: JSON.stringify({ service: "github", mode: "allow" }),
    });
    expect(res.status).toBe(400);
  });

  it("a service-scoped allow override IS permitted when the only org deny is an actionId policy in a DIFFERENT service (provable-disjoint case)", async () => {
    api = await bootTestApi({ plugins: PLUGINS });
    const orgRes = await putOrgPolicy({ actionId: "slack.post_message", mode: "deny" });
    expect(orgRes.status).toBe(201);

    const res = await fetch(`${api.baseUrl}/api/me/policy-overrides`, {
      method: "PUT",
      headers: HEADERS,
      body: JSON.stringify({ service: "github", mode: "allow" }),
    });
    expect(res.status).toBe(200);
  });

  it("EXPLOIT (fix round 2): a workflow-only org require_approval blocks an actionId-scoped allow override", async () => {
    api = await bootTestApi({ plugins: PLUGINS });
    // appliesIn:"workflow" org policies are invisible to a session-only
    // bounds check, but a per-user override has no appliesIn of its own —
    // it's consulted on the workflow-side resolution path too
    // (action-invoker.ts resolves with appliesIn:"workflow" + a real
    // userId), so a session-only bound left this outrankable at rung 2.
    const orgRes = await putOrgPolicy({ actionId: "github.create_issue", mode: "require_approval", appliesIn: "workflow" });
    expect(orgRes.status).toBe(201);

    const res = await fetch(`${api.baseUrl}/api/me/policy-overrides`, {
      method: "PUT",
      headers: HEADERS,
      body: JSON.stringify({ actionId: "github.create_issue", mode: "allow" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("require_approval");
  });

  it("a workflow-only org policy scoped to a DIFFERENT service does not block an unrelated actionId override", async () => {
    api = await bootTestApi({ plugins: PLUGINS });
    const orgRes = await putOrgPolicy({ service: "slack", mode: "require_approval", appliesIn: "workflow" });
    expect(orgRes.status).toBe(201);

    // No org policy touches github in either appliesIn context — still
    // permitted (allow/unset in both session and workflow contexts).
    const res = await fetch(`${api.baseUrl}/api/me/policy-overrides`, {
      method: "PUT",
      headers: HEADERS,
      body: JSON.stringify({ actionId: "github.create_issue", mode: "allow" }),
    });
    expect(res.status).toBe(200);
  });

  it("400s an unknown actionId override (fails closed — can't be verified against org policy)", async () => {
    api = await bootTestApi({ plugins: PLUGINS });
    const res = await fetch(`${api.baseUrl}/api/me/policy-overrides`, {
      method: "PUT",
      headers: HEADERS,
      body: JSON.stringify({ actionId: "unknown.does_not_exist", mode: "allow" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("not in the plugin catalog");
  });
});

// ── Dynamic (MCP) tools in the policy catalog ────────────────────────────
//
// A dynamic service declares no static actions, so its tools used to be
// unverifiable: the bounds check refused every `allow` override on one, and
// the tool-permissions read listed none. The service's tool listing for the
// caller's own credential (`ServiceProbes`, the cached tool schema) now puts
// them in the catalog once the caller is connected.

describe("PUT /api/me/policy-overrides and GET /api/me/tool-permissions for a dynamic service", () => {
  function dynamicPlugin(): ValetPlugin {
    const grafana: ActionPlugin = {
      service: "grafana",
      actions: [],
      resolveActions: async () => [testCatalogAction("grafana.query_sql", "medium"), testCatalogAction("grafana.list_dashboards", "low")],
    };
    return {
      name: "dynamic-policy-plugin",
      version: "0.0.1",
      actions: [grafana],
      credentials: [{ service: "grafana", type: "api_key", configKeys: ["apiKey"] }],
    };
  }

  async function putAllow(actionId: string): Promise<Response> {
    return fetch(`${api!.baseUrl}/api/me/policy-overrides`, {
      method: "PUT",
      headers: HEADERS,
      body: JSON.stringify({ actionId, mode: "allow" }),
    });
  }

  async function putOrgPolicy(target: Record<string, unknown>): Promise<Response> {
    return fetch(`${api!.baseUrl}/api/org/policies`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify(target),
    });
  }

  async function connect(): Promise<void> {
    const res = await fetch(`${api!.baseUrl}/api/credentials/grafana`, {
      method: "PUT",
      headers: HEADERS,
      body: JSON.stringify({ type: "api_key", apiKey: "k-1" }),
    });
    expect(res.status).toBe(200);
  }

  it("refuses an allow override on a dynamic tool while the caller is not connected, and names the fix", async () => {
    api = await bootTestApi({ plugins: [...PLUGINS, dynamicPlugin()] });
    const res = await putAllow("grafana.query_sql");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("not in the plugin catalog");
    expect(body.error).toContain("connect the service");
  });

  it("accepts an allow override on a dynamic tool the caller's listing names, and still refuses one it does not", async () => {
    api = await bootTestApi({ plugins: [...PLUGINS, dynamicPlugin()] });
    await connect();

    const ok = await putAllow("grafana.query_sql");
    expect(ok.status).toBe(200);
    const row = (await ok.json()) as PutPolicyOverrideResponse;
    expect(row).toMatchObject({ actionId: "grafana.query_sql", mode: "allow" });

    const unknown = await putAllow("grafana.drop_everything");
    expect(unknown.status).toBe(400);
  });

  it("bounds a dynamic tool against org policy by its listed service and risk level", async () => {
    api = await bootTestApi({ plugins: [...PLUGINS, dynamicPlugin()] });
    await connect();
    const orgRes = await putOrgPolicy({ riskLevel: "medium", mode: "require_approval" });
    expect(orgRes.status).toBe(201);

    // query_sql is medium: the org rule applies, so the member may not self-allow it.
    const blocked = await putAllow("grafana.query_sql");
    expect(blocked.status).toBe(400);
    expect(((await blocked.json()) as { error: string }).error).toContain("org policy");
    // list_dashboards is low: no org rule reaches it.
    expect((await putAllow("grafana.list_dashboards")).status).toBe(200);
  });

  it("lists a connected dynamic service's tools in tool-permissions, and none while disconnected", async () => {
    api = await bootTestApi({ plugins: [...PLUGINS, dynamicPlugin()] });
    const read = async (): Promise<ListToolPermissionsResponse> => {
      const res = await fetch(`${api!.baseUrl}/api/me/tool-permissions?service=grafana`, { headers: HEADERS });
      expect(res.status).toBe(200);
      return (await res.json()) as ListToolPermissionsResponse;
    };
    expect((await read()).tools).toEqual([]);

    await connect();
    const { tools } = await read();
    expect(tools.map((tool) => tool.actionId)).toEqual(["grafana.query_sql", "grafana.list_dashboards"]);
    // Medium risk resolves to the engine's risk default (allow) with no rule in the way.
    expect(tools[0]).toMatchObject({ service: "grafana", riskLevel: "medium", mode: "allow", source: "default" });
    expect(tools[0]?.settable).toEqual(["allow", "require_approval", "deny"]);
  });
});

// ── PUT /api/me/policy-overrides — matcher-blind bounds (finding C1) ─────
//
// `validateActionIdOverrideBounds` resolves the org-side decision with
// `params: undefined`. Before the C1 fix it did so WITHOUT stripping the org
// policies' `paramMatchers`, so a matcher-carrying org policy evaluated every
// matcher to false, fell out of precedence, and the bounds check accepted a
// member's `allow` override — which then outranked that same org policy at
// rung 2 whenever the params DID match at real invocation. The fix strips
// `paramMatchers` from org rows ("might match" ⇒ treat as matching) before
// resolving. These pin that a matcher-carrying org policy still blocks the
// override; a refactor back to the matcher-blind resolveActionPolicy path
// would fail here instead of silently reopening the bypass.

describe("PUT /api/me/policy-overrides — matcher-carrying org policy bounds (C1)", () => {
  async function putOrgPolicy(target: Record<string, unknown>) {
    return fetch(`${api!.baseUrl}/api/org/policies`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify(target),
    });
  }

  it("a matcher-scoped org require_approval blocks an actionId-scoped allow override", async () => {
    api = await bootTestApi({ plugins: PLUGINS });
    const orgRes = await putOrgPolicy({
      actionId: "github.create_issue",
      mode: "require_approval",
      paramMatchers: [{ path: "repo", op: "eq", value: "prod" }],
    });
    expect(orgRes.status).toBe(201);

    const res = await fetch(`${api.baseUrl}/api/me/policy-overrides`, {
      method: "PUT",
      headers: HEADERS,
      body: JSON.stringify({ actionId: "github.create_issue", mode: "allow" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("require_approval");
  });

  it("a matcher-scoped workflow-only org require_approval also blocks the allow override", async () => {
    api = await bootTestApi({ plugins: PLUGINS });
    const orgRes = await putOrgPolicy({
      actionId: "github.create_issue",
      mode: "require_approval",
      appliesIn: "workflow",
      paramMatchers: [{ path: "repo", op: "eq", value: "prod" }],
    });
    expect(orgRes.status).toBe(201);

    const res = await fetch(`${api.baseUrl}/api/me/policy-overrides`, {
      method: "PUT",
      headers: HEADERS,
      body: JSON.stringify({ actionId: "github.create_issue", mode: "allow" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("require_approval");
  });
});

// ── Overrides: DELETE by target ───────────────────────────────────────────

describe("DELETE /api/me/policy-overrides", () => {
  it("deletes the row matching the exact target (hard delete)", async () => {
    api = await bootTestApi({ plugins: PLUGINS });
    await fetch(`${api.baseUrl}/api/me/policy-overrides`, {
      method: "PUT",
      headers: HEADERS,
      body: JSON.stringify({ actionId: "github.create_issue", mode: "deny" }),
    });

    const delRes = await fetch(`${api.baseUrl}/api/me/policy-overrides`, {
      method: "DELETE",
      headers: HEADERS,
      body: JSON.stringify({ actionId: "github.create_issue" }),
    });
    expect(delRes.status).toBe(200);
    expect((await delRes.json()) as DeletePolicyOverrideResponse).toEqual({ ok: true });

    const listRes = await fetch(`${api.baseUrl}/api/me/policy-overrides`, { headers: HEADERS });
    const { overrides } = (await listRes.json()) as ListPolicyOverridesResponse;
    expect(overrides).toHaveLength(0);
  });

  it("404s when no matching override exists", async () => {
    api = await bootTestApi({ plugins: PLUGINS });
    const res = await fetch(`${api.baseUrl}/api/me/policy-overrides`, {
      method: "DELETE",
      headers: HEADERS,
      body: JSON.stringify({ actionId: "nope" }),
    });
    expect(res.status).toBe(404);
  });

  it("400s for a bad target shape", async () => {
    api = await bootTestApi({ plugins: PLUGINS });
    const res = await fetch(`${api.baseUrl}/api/me/policy-overrides`, {
      method: "DELETE",
      headers: HEADERS,
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});

// ── Grants: GET list + DELETE revoke ──────────────────────────────────────

describe("GET/DELETE /api/me/grants", () => {
  async function seedGrant(opts: { sessionId?: string; workflowExecutionId?: string; grantedBy?: string; orgId?: string }) {
    const { db } = api!.providers;
    const now = Date.now();
    await db.insert(runtimeGrants).values({
      id: `g_${Math.random().toString(36).slice(2)}`,
      orgId: opts.orgId ?? "local-org",
      sessionId: opts.sessionId ?? null,
      workflowExecutionId: opts.workflowExecutionId ?? null,
      policyKey: "github.create_issue",
      mode: "allow",
      grantedBy: opts.grantedBy ?? "local-user",
      createdAt: now,
      revokedAt: null,
    });
  }

  it("lists only the caller's own live grants", async () => {
    api = await bootTestApi({ plugins: PLUGINS });
    await seedGrant({ sessionId: "s1", grantedBy: "local-user" });
    await seedGrant({ sessionId: "s2", grantedBy: "test-member" });

    const res = await fetch(`${api.baseUrl}/api/me/grants`, { headers: HEADERS });
    expect(res.status).toBe(200);
    const { grants } = (await res.json()) as ListGrantsResponse;
    expect(grants).toHaveLength(1);
    expect(grants[0]?.sessionId).toBe("s1");
  });

  it("excludes an already-revoked grant from the list", async () => {
    api = await bootTestApi({ plugins: PLUGINS });
    const { db } = api.providers;
    const now = Date.now();
    await db.insert(runtimeGrants).values({
      id: "g_revoked", orgId: "local-org", sessionId: "s1", workflowExecutionId: null,
      policyKey: "github.create_issue", mode: "allow", grantedBy: "local-user",
      createdAt: now, revokedAt: now,
    });
    const res = await fetch(`${api.baseUrl}/api/me/grants`, { headers: HEADERS });
    const { grants } = (await res.json()) as ListGrantsResponse;
    expect(grants).toHaveLength(0);
  });

  it("DELETE stamps revokedAt (soft revoke, not a row delete)", async () => {
    api = await bootTestApi({ plugins: PLUGINS });
    await seedGrant({ sessionId: "s1" });

    const delRes = await fetch(`${api.baseUrl}/api/me/grants`, {
      method: "DELETE",
      headers: HEADERS,
      body: JSON.stringify({ sessionId: "s1", service: "github", actionId: "create_issue" }),
    });
    expect(delRes.status).toBe(200);
    expect((await delRes.json()) as DeleteGrantResponse).toEqual({ ok: true });

    const { db } = api.providers;
    const rows = await db.select().from(runtimeGrants);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.revokedAt).not.toBeNull();
  });

  it("404s when no matching live grant exists (wrong scope)", async () => {
    api = await bootTestApi({ plugins: PLUGINS });
    await seedGrant({ sessionId: "s1" });

    const res = await fetch(`${api.baseUrl}/api/me/grants`, {
      method: "DELETE",
      headers: HEADERS,
      body: JSON.stringify({ sessionId: "does-not-exist", service: "github", actionId: "create_issue" }),
    });
    expect(res.status).toBe(404);
  });

  it("400s when both sessionId and workflowExecutionId are given, or neither", async () => {
    api = await bootTestApi({ plugins: PLUGINS });
    const both = await fetch(`${api.baseUrl}/api/me/grants`, {
      method: "DELETE",
      headers: HEADERS,
      body: JSON.stringify({ sessionId: "s1", workflowExecutionId: "w1", service: "github", actionId: "x" }),
    });
    expect(both.status).toBe(400);

    const neither = await fetch(`${api.baseUrl}/api/me/grants`, {
      method: "DELETE",
      headers: HEADERS,
      body: JSON.stringify({ service: "github", actionId: "x" }),
    });
    expect(neither.status).toBe(400);
  });

  it("cannot revoke another user's grant (grantedBy scoping)", async () => {
    api = await bootTestApi({ plugins: PLUGINS });
    await seedGrant({ sessionId: "s1", grantedBy: "test-member" });

    const res = await fetch(`${api.baseUrl}/api/me/grants`, {
      method: "DELETE",
      headers: HEADERS, // local-user (admin), grant was granted by test-member
      body: JSON.stringify({ sessionId: "s1", service: "github", actionId: "create_issue" }),
    });
    expect(res.status).toBe(404);
  });
});

// ── GET /api/me/tool-permissions — effective mode per action ────────────

describe("GET /api/me/tool-permissions", () => {
  async function tools(query = ""): Promise<Map<string, ListToolPermissionsResponse["tools"][number]>> {
    const res = await fetch(`${api!.baseUrl}/api/me/tool-permissions${query}`, { headers: HEADERS });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListToolPermissionsResponse;
    return new Map(body.tools.map((tool) => [tool.actionId, tool]));
  }

  it("reports the risk default and the plugin default when no rule applies", async () => {
    api = await bootTestApi({ plugins: PLUGINS });
    const all = await tools();
    expect(all.get("github.create_issue")).toMatchObject({
      service: "github", name: "github.create_issue", description: "github.create_issue", riskLevel: "medium",
      mode: "allow", source: "default", overridden: false, settable: ["allow", "require_approval", "deny"],
    });
    expect(all.get("github.create_repository")).toMatchObject({ mode: "require_approval", source: "default" });
    expect(all.get("notion.search")).toMatchObject({ mode: "require_approval", source: "plugin" });
    expect(all.get("github.create_issue")?.lockedBy).toBeUndefined();
  });

  it("narrows to one service and 404s an unknown one", async () => {
    api = await bootTestApi({ plugins: PLUGINS });
    expect([...(await tools("?service=github")).keys()]).toEqual(["github.create_issue", "github.create_repository"]);
    const res = await fetch(`${api.baseUrl}/api/me/tool-permissions?service=nope`, { headers: HEADERS });
    expect(res.status).toBe(404);
  });

  it("reports an org rule and locks the modes it forbids", async () => {
    api = await bootTestApi({ plugins: PLUGINS });
    await fetch(`${api.baseUrl}/api/org/policies`, {
      method: "POST", headers: HEADERS, body: JSON.stringify({ actionId: "github.create_issue", mode: "require_approval" }),
    });
    await fetch(`${api.baseUrl}/api/org/policies`, {
      method: "POST", headers: HEADERS, body: JSON.stringify({ actionId: "slack.post_message", mode: "deny" }),
    });
    const all = await tools();
    expect(all.get("github.create_issue")).toMatchObject({
      mode: "require_approval", source: "org", settable: ["require_approval", "deny"], lockedBy: "org",
    });
    expect(all.get("slack.post_message")).toMatchObject({ mode: "deny", source: "org", settable: ["deny"], lockedBy: "org" });
    // The lock matches the write path: the bounds check refuses the same allow.
    const refused = await fetch(`${api.baseUrl}/api/me/policy-overrides`, {
      method: "PUT", headers: HEADERS, body: JSON.stringify({ actionId: "github.create_issue", mode: "allow" }),
    });
    expect(refused.status).toBe(400);
  });

  it("reports a personal override, and Off makes the session resolver deny the tool", async () => {
    api = await bootTestApi({ plugins: PLUGINS });
    const put = await fetch(`${api.baseUrl}/api/me/policy-overrides`, {
      method: "PUT", headers: HEADERS, body: JSON.stringify({ actionId: "slack.post_message", mode: "deny" }),
    });
    expect(put.status).toBe(200);
    expect((await tools()).get("slack.post_message")).toMatchObject({ mode: "deny", source: "personal", overridden: true });

    const resolver = buildPolicyResolver({ db: api.providers.db, actionPluginByService: api.providers.actionPluginByService });
    const decision = await resolver.resolve({
      orgId: "local-org", userId: "local-user", service: "slack", actionId: "slack.post_message", riskLevel: "low",
      params: {}, sessionId: "s-1", threadId: "t-1", appliesIn: "session",
    });
    expect(decision).toMatchObject({ mode: "deny", provenance: { source: "override" } });

    const reset = await fetch(`${api.baseUrl}/api/me/policy-overrides`, {
      method: "DELETE", headers: HEADERS, body: JSON.stringify({ actionId: "slack.post_message" }),
    });
    expect(reset.status).toBe(200);
    expect((await tools()).get("slack.post_message")).toMatchObject({ mode: "allow", source: "default", overridden: false });
  });

  it("reports a team rule for a team the caller is on, with nothing settable", async () => {
    api = await bootTestApi({ plugins: PLUGINS });
    await api.providers.db.insert(teams).values({ id: "perm-team", orgId: "local-org", name: "Team", createdAt: Date.now() });
    await api.providers.db.insert(teamMembers).values({ teamId: "perm-team", userId: "local-user", role: "admin" });
    await fetch(`${api.baseUrl}/api/teams/perm-team/policies`, {
      method: "POST", headers: HEADERS, body: JSON.stringify({ service: "github", mode: "deny" }),
    });
    expect((await tools("?teamId=perm-team")).get("github.create_issue")).toMatchObject({
      mode: "deny", source: "team", settable: [], lockedBy: "team",
    });
    // The team rule stays out of the personal workspace.
    expect((await tools()).get("github.create_issue")).toMatchObject({ mode: "allow", source: "default" });
    const res = await fetch(`${api.baseUrl}/api/me/tool-permissions?teamId=other`, { headers: HEADERS });
    expect(res.status).toBe(404);
  });
});
