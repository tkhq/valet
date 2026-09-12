import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { agentSessions, workflowDefinitions, workflowRuns, runtimeGrants, actionPolicies, teamMembers, teams } from "../schema/index.js";
import { resolveActionPolicy } from "../policies/service.js";
import type { ActionPolicyWire } from "../wire/types.js";

let api: TestApi | undefined;
afterEach(async () => { await api?.cleanup(); api = undefined; });
const headers = { "Content-Type": "application/json" };
const member = { ...headers, "x-valet-test-user-id": "test-member" };

async function setup() {
  api = await bootTestApi();
  await api.providers.db.insert(teams).values([
    { id: "policy-a", orgId: "local-org", name: "A", createdAt: Date.now() },
    { id: "policy-b", orgId: "local-org", name: "B", createdAt: Date.now() },
    { id: "policy-other-org", orgId: "other-org", name: "Other", createdAt: Date.now() },
  ]);
  await api.providers.db.insert(teamMembers).values({ teamId: "policy-a", userId: "test-member", role: "member" });
  return api;
}

describe("team policies", () => {
  it("allows members to read but only admins to write, and hides other teams", async () => {
    const app = await setup();
    const url = `${app.baseUrl}/api/teams/policy-a/policies`;
    const created = await fetch(url, { method: "POST", headers, body: JSON.stringify({ service: "gmail", mode: "deny" }) });
    expect(created.status).toBe(201);
    const policy = await created.json() as ActionPolicyWire;
    expect((await fetch(url, { headers: member })).status).toBe(200);
    for (const method of ["POST", "PATCH", "DELETE"]) {
      const res = await fetch(method === "POST" ? url : `${url}/${policy.id}`, { method, headers: member, ...(method !== "DELETE" ? { body: JSON.stringify({ service: "gmail", mode: "allow" }) } : {}) });
      expect(res.status).toBe(403);
    }
    for (const id of ["policy-b", "policy-other-org", "missing"]) expect((await fetch(`${app.baseUrl}/api/teams/${id}/policies`, { headers: member })).status).toBe(404);
    expect((await fetch(`${app.baseUrl}/api/teams/policy-other-org/policies`, { headers })).status).toBe(404);
  });

  it("isolates CRUD from other teams and org policy routes and reaps on deletion", async () => {
    const app = await setup();
    const url = `${app.baseUrl}/api/teams/policy-a/policies`;
    const response = await fetch(url, { method: "POST", headers, body: JSON.stringify({ riskLevel: "high", mode: "require_approval" }) });
    const policy = await response.json() as ActionPolicyWire;
    expect(response.status).toBe(201);
    for (const base of [`${app.baseUrl}/api/teams/policy-b/policies`, `${app.baseUrl}/api/org/policies`]) {
      expect((await fetch(`${base}/${policy.id}`, { method: "PATCH", headers, body: JSON.stringify({ mode: "allow" }) })).status).toBe(404);
      expect((await fetch(`${base}/${policy.id}`, { method: "DELETE", headers })).status).toBe(404);
      expect(await (await fetch(base, { headers })).json()).toEqual({ policies: [] });
    }
    const patched = await fetch(`${url}/${policy.id}`, { method: "PATCH", headers, body: JSON.stringify({ mode: "deny" }) });
    expect(patched.status).toBe(200);
    expect(await patched.json()).toMatchObject({ mode: "deny" });
    expect((await fetch(`${app.baseUrl}/api/teams/policy-a`, { method: "DELETE", headers })).status).toBe(200);
    expect(await app.providers.db.select().from(actionPolicies).where(eq(actionPolicies.id, policy.id))).toEqual([]);
  });

  it("validates payloads before writes and accepts scoped revocation", async () => {
    const app = await setup();
    const url = `${app.baseUrl}/api/teams/policy-a/policies`;
    for (const body of [null, [], { mode: "allow" }, { service: 12, mode: "allow" }, { service: "gmail", mode: "oops" }, { service: "gmail", mode: "allow", expiresAt: "tomorrow" }]) {
      expect((await fetch(url, { method: "POST", headers, body: JSON.stringify(body) })).status).toBe(400);
    }
    const response = await fetch(url, { method: "POST", headers, body: JSON.stringify({ actionId: "gmail.send_email", mode: "deny" }) });
    const policy = await response.json() as ActionPolicyWire;
    expect((await fetch(`${url}/${policy.id}`, { method: "DELETE", headers })).status).toBe(200);
    expect((await fetch(`${url}/${policy.id}`, { method: "DELETE", headers })).status).toBe(200);
    expect(await (await fetch(url, { headers })).json()).toEqual({ policies: [] });
  });

  it("enforces a team rule for workflow tool calls without leaking it to another team", async () => {
    const app = await setup();
    await fetch(`${app.baseUrl}/api/teams/policy-a/policies`, { method: "POST", headers, body: JSON.stringify({ service: "gmail", mode: "deny" }) });
    const input = { orgId: "local-org", service: "gmail", actionId: "gmail.send_email", riskLevel: "low" as const, params: undefined, appliesIn: "workflow" as const, workflowExecutionId: "run", pluginDefault: undefined, now: Date.now() };
    expect(await resolveActionPolicy(app.providers.db, { ...input, teamId: "policy-a" })).toMatchObject({ mode: "deny", provenance: { source: "team_policy" } });
    expect((await resolveActionPolicy(app.providers.db, { ...input, teamId: "policy-b" })).mode).toBe("allow");
    expect((await resolveActionPolicy(app.providers.db, input)).mode).toBe("allow");
  });
});


describe("team policy flow parity", () => {
  it("atomically upserts simple targets, preserves independent advanced rules, and keeps org denies authoritative", async () => {
    const app = await setup();
    const base = `${app.baseUrl}/api/teams/policy-a`;
    const advanced: ActionPolicyWire[] = [];
    for (const fields of [{ appliesIn: "workflow" }, { expiresAt: Date.now() + 60000 }, { paramMatchers: [{ path: "to", op: "eq", value: "sentinel" }] }]) {
      const response = await fetch(`${base}/policies`, { method: "POST", headers, body: JSON.stringify({ service: "gmail", mode: "deny", ...fields }) });
      expect(response.status).toBe(201); advanced.push(await response.json() as ActionPolicyWire);
    }
    const save = (mode: string) => fetch(`${base}/policy-overrides`, { method: "PUT", headers, body: JSON.stringify({ service: "gmail", mode }) });
    const initial = await save("deny"); expect(initial.status).toBe(200);
    const first = await initial.json() as ActionPolicyWire;
    const concurrent = await Promise.all([save("allow"), save("require_approval"), save("deny")]);
    for (const response of concurrent) { expect(response.status).toBe(200); expect((await response.json() as ActionPolicyWire).id).toBe(first.id); }
    await save("allow");
    const listed = await (await fetch(`${base}/policies`, { headers })).json() as { policies: ActionPolicyWire[] };
    expect(listed.policies).toHaveLength(4);
    for (const row of advanced) expect(listed.policies.find(p => p.id === row.id)).toEqual(row);
    expect((await fetch(`${base}/policy-overrides`, { method: "PUT", headers, body: JSON.stringify({ service: "gmail", mode: "allow", appliesIn: "workflow" }) })).status).toBe(400);
    await fetch(`${app.baseUrl}/api/org/policies`, { method: "POST", headers, body: JSON.stringify({ service: "gmail", mode: "deny" }) });
    const refused = await save("allow");
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ error: expect.stringContaining("org") });
    const decision = await resolveActionPolicy(app.providers.db, { orgId: "local-org", teamId: "policy-a", service: "gmail", actionId: "gmail.send", riskLevel: "low", params: {}, appliesIn: "session", pluginDefault: undefined, now: Date.now() });
    expect(decision).toMatchObject({ mode: "deny", provenance: { source: "org_policy" } });
    expect((await fetch(`${base}/policies/${advanced[0].id}`, { method: "DELETE", headers })).status).toBe(200);
  });

  it("gates simple writes by live membership and organization", async () => {
    const app = await setup();
    const save = (id: string, h: Record<string, string> = member) => fetch(`${app.baseUrl}/api/teams/${id}/policy-overrides`, { method: "PUT", headers: h, body: JSON.stringify({ riskLevel: "low", mode: "allow" }) });
    expect((await save("policy-a")).status).toBe(403);
    for (const id of ["policy-b", "policy-other-org", "missing"]) expect((await save(id)).status).toBe(404);
    expect((await save("policy-other-org", headers)).status).toBe(404);
    await app.providers.db.update(teamMembers).set({ role: "admin" }).where(eq(teamMembers.teamId, "policy-a"));
    expect((await save("policy-a")).status).toBe(200);
    await app.providers.db.delete(teamMembers).where(eq(teamMembers.teamId, "policy-a"));
    expect((await save("policy-a")).status).toBe(404);
  });

  it("lists and revokes by the session/run owner and org, never the approving user", async () => {
    const app = await setup(); const db = app.providers.db; const now = Date.now();
    for (const [id, orgId, ownerType, ownerId] of [["s-team", "local-org", "team", "policy-a"], ["s-other", "local-org", "team", "policy-b"], ["s-personal", "local-org", "user", "test-admin"], ["s-foreign", "other-org", "team", "policy-a"]]) {
      await db.insert(agentSessions).values({ id, orgId, ownerType, ownerId, userId: "test-admin", workspace: "/fixture", createdAt: now, updatedAt: now });
      await db.insert(runtimeGrants).values({ id: `g-${id}`, orgId: "local-org", sessionId: id, policyKey: "gmail.send", grantedBy: id === "s-team" ? "someone-else" : "test-admin", createdAt: now });
    }
    await db.insert(workflowDefinitions).values({ id: "def", orgId: "local-org", ownerType: "user", ownerId: "test-admin", name: "fixture", definition: {}, createdAt: now, updatedAt: now });
    await db.insert(workflowRuns).values({ id: "run", workflowId: "def", definitionVersionId: "fixture", definition: {}, params: {}, ownerType: "team", ownerId: "policy-a", createdAt: now, updatedAt: now });
    await db.insert(runtimeGrants).values({ id: "g-run", orgId: "local-org", workflowExecutionId: "run", policyKey: "gmail.send", grantedBy: "someone-else", createdAt: now });
    const base = `${app.baseUrl}/api/teams/policy-a/grants`;
    const list = await fetch(base, { headers: member }); expect(list.status).toBe(200);
    const body = await list.json() as { grants: { id: string }[] };
    expect(body.grants.map(g => g.id).sort()).toEqual(["g-run", "g-s-team"]);
    expect((await fetch(`${base}/g-s-team`, { method: "DELETE", headers: member })).status).toBe(403);
    for (const id of ["g-s-other", "g-s-personal", "g-s-foreign"]) expect((await fetch(`${base}/${id}`, { method: "DELETE", headers })).status).toBe(404);
    expect((await fetch(`${app.baseUrl}/api/teams/policy-other-org/grants`, { headers })).status).toBe(404);
    for (const id of ["g-s-team", "g-run"]) expect((await fetch(`${base}/${id}`, { method: "DELETE", headers })).status).toBe(200);
    expect(await (await fetch(base, { headers })).json()).toEqual({ grants: [] });
    expect((await db.select().from(runtimeGrants)).filter(g => g.revokedAt === null)).toHaveLength(3);
  });
});
