/**
 * `/api/me/policy-overrides`, `/api/me/grants` — a caller's own
 * per-user policy overrides and runtime grants. No admin gate (see
 * `routes/me-policies.ts` doc comment); the write-time bounds check on
 * overrides is what stops a member self-granting past an org policy.
 */
import { describe, it, expect, afterEach } from "vitest";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { runtimeGrants } from "../schema/index.js";
import type {
  DeleteGrantResponse,
  DeletePolicyOverrideResponse,
  ListGrantsResponse,
  ListPolicyOverridesResponse,
  PutPolicyOverrideResponse,
} from "../wire/types.js";

const HEADERS = { "Content-Type": "application/json" };

let api: TestApi | undefined;

afterEach(async () => {
  await api?.cleanup();
  api = undefined;
});

// ── Overrides: PUT upsert-by-target ──────────────────────────────────────

describe("PUT /api/me/policy-overrides", () => {
  it("400s when zero of service/actionId/riskLevel are set", async () => {
    api = await bootTestApi();
    const res = await fetch(`${api.baseUrl}/api/me/policy-overrides`, {
      method: "PUT",
      headers: HEADERS,
      body: JSON.stringify({ mode: "deny" }),
    });
    expect(res.status).toBe(400);
  });

  it("400s when more than one of service/actionId/riskLevel are set", async () => {
    api = await bootTestApi();
    const res = await fetch(`${api.baseUrl}/api/me/policy-overrides`, {
      method: "PUT",
      headers: HEADERS,
      body: JSON.stringify({ service: "github", riskLevel: "low", mode: "deny" }),
    });
    expect(res.status).toBe(400);
  });

  it("creates then updates the SAME row for the same target (upsert, not insert-twice)", async () => {
    api = await bootTestApi();

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
    api = await bootTestApi();
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
    api = await bootTestApi();
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
    api = await bootTestApi();
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
    api = await bootTestApi();
    const res = await fetch(`${api.baseUrl}/api/me/policy-overrides`, {
      method: "PUT",
      headers: HEADERS,
      body: JSON.stringify({ actionId: "github.create_issue", mode: "allow" }),
    });
    expect(res.status).toBe(200);
  });

  it("allows loosening to allow when the org policy for that exact target is itself allow", async () => {
    api = await bootTestApi();
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
    api = await bootTestApi();
    const res = await fetch(`${api.baseUrl}/api/me/policy-overrides`, {
      method: "PUT",
      headers: HEADERS,
      body: JSON.stringify({ actionId: "x", mode: "deny", paramMatchers: [{ op: "eq" }] }),
    });
    expect(res.status).toBe(400);
  });

  it("scopes overrides to the caller — a second user's PUT doesn't affect the first user's list", async () => {
    api = await bootTestApi();
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

// ── Overrides: DELETE by target ───────────────────────────────────────────

describe("DELETE /api/me/policy-overrides", () => {
  it("deletes the row matching the exact target (hard delete)", async () => {
    api = await bootTestApi();
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
    api = await bootTestApi();
    const res = await fetch(`${api.baseUrl}/api/me/policy-overrides`, {
      method: "DELETE",
      headers: HEADERS,
      body: JSON.stringify({ actionId: "nope" }),
    });
    expect(res.status).toBe(404);
  });

  it("400s for a bad target shape", async () => {
    api = await bootTestApi();
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
    api = await bootTestApi();
    await seedGrant({ sessionId: "s1", grantedBy: "local-user" });
    await seedGrant({ sessionId: "s2", grantedBy: "test-member" });

    const res = await fetch(`${api.baseUrl}/api/me/grants`, { headers: HEADERS });
    expect(res.status).toBe(200);
    const { grants } = (await res.json()) as ListGrantsResponse;
    expect(grants).toHaveLength(1);
    expect(grants[0]?.sessionId).toBe("s1");
  });

  it("excludes an already-revoked grant from the list", async () => {
    api = await bootTestApi();
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
    api = await bootTestApi();
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
    api = await bootTestApi();
    await seedGrant({ sessionId: "s1" });

    const res = await fetch(`${api.baseUrl}/api/me/grants`, {
      method: "DELETE",
      headers: HEADERS,
      body: JSON.stringify({ sessionId: "does-not-exist", service: "github", actionId: "create_issue" }),
    });
    expect(res.status).toBe(404);
  });

  it("400s when both sessionId and workflowExecutionId are given, or neither", async () => {
    api = await bootTestApi();
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
    api = await bootTestApi();
    await seedGrant({ sessionId: "s1", grantedBy: "test-member" });

    const res = await fetch(`${api.baseUrl}/api/me/grants`, {
      method: "DELETE",
      headers: HEADERS, // local-user (admin), grant was granted by test-member
      body: JSON.stringify({ sessionId: "s1", service: "github", actionId: "create_issue" }),
    });
    expect(res.status).toBe(404);
  });
});
