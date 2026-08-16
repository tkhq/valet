/**
 * `/api/org/policies` — org-admin CRUD + resolver preview.
 * `/api/org/action-log` — org-admin keyset-paginated audit read.
 * Same DB-backed org-admin gate as `routes/org.test.ts`/
 * `routes/llm-providers.test.ts`. Cross-org isolation is exercised by
 * inserting a row directly under a different `orgId` — the stub-auth
 * harness always resolves the caller to `local-org`, so any row seeded
 * under another org id is "cross-org" from every test request's POV.
 */
import { eq } from "drizzle-orm";
import { Type } from "typebox";
import { describe, it, expect, afterEach } from "vitest";
import type { ValetPlugin } from "@valet/engine";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { actionInvocations, actionPolicies } from "../schema/index.js";
import type {
  ActionPolicyWire,
  CreateOrgPolicyResponse,
  ListActionLogResponse,
  ListOrgPoliciesResponse,
  PatchOrgPolicyResponse,
  PreviewOrgPolicyResponse,
} from "../wire/types.js";

const HEADERS = { "Content-Type": "application/json" };
const MEMBER_HEADERS = { "Content-Type": "application/json", "x-valet-test-user-id": "test-member" };

let api: TestApi | undefined;

afterEach(async () => {
  await api?.cleanup();
  api = undefined;
});

// ── Admin gating ─────────────────────────────────────────────────────────

describe("/api/org/policies admin gating", () => {
  it("403s GET/POST/PATCH/DELETE for a non-admin org member", async () => {
    api = await bootTestApi();

    const listRes = await fetch(`${api.baseUrl}/api/org/policies`, { headers: MEMBER_HEADERS });
    expect(listRes.status).toBe(403);

    const createRes = await fetch(`${api.baseUrl}/api/org/policies`, {
      method: "POST",
      headers: MEMBER_HEADERS,
      body: JSON.stringify({ actionId: "x", mode: "allow" }),
    });
    expect(createRes.status).toBe(403);

    const patchRes = await fetch(`${api.baseUrl}/api/org/policies/whatever`, {
      method: "PATCH",
      headers: MEMBER_HEADERS,
      body: JSON.stringify({ mode: "deny" }),
    });
    expect(patchRes.status).toBe(403);

    const deleteRes = await fetch(`${api.baseUrl}/api/org/policies/whatever`, {
      method: "DELETE",
      headers: MEMBER_HEADERS,
    });
    expect(deleteRes.status).toBe(403);
  });

  it("403s GET /api/org/action-log for a non-admin org member", async () => {
    api = await bootTestApi();
    const res = await fetch(`${api.baseUrl}/api/org/action-log`, { headers: MEMBER_HEADERS });
    expect(res.status).toBe(403);
  });
});

// ── CRUD validation matrix ───────────────────────────────────────────────

describe("POST /api/org/policies — validation", () => {
  it("400s when zero of service/actionId/riskLevel are set", async () => {
    api = await bootTestApi();
    const res = await fetch(`${api.baseUrl}/api/org/policies`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ mode: "allow" }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({
      error: expect.stringContaining("exactly one of"),
    });
  });

  it("400s when more than one of service/actionId/riskLevel are set", async () => {
    api = await bootTestApi();
    const res = await fetch(`${api.baseUrl}/api/org/policies`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ service: "github", actionId: "create_issue", mode: "allow" }),
    });
    expect(res.status).toBe(400);
  });

  it("400s for an invalid mode", async () => {
    api = await bootTestApi();
    const res = await fetch(`${api.baseUrl}/api/org/policies`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ actionId: "create_issue", mode: "yolo" }),
    });
    expect(res.status).toBe(400);
  });

  it("400s for an invalid riskLevel", async () => {
    api = await bootTestApi();
    const res = await fetch(`${api.baseUrl}/api/org/policies`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ riskLevel: "extreme", mode: "allow" }),
    });
    expect(res.status).toBe(400);
  });

  it("400s for a malformed paramMatchers entry", async () => {
    api = await bootTestApi();
    const res = await fetch(`${api.baseUrl}/api/org/policies`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ actionId: "create_issue", mode: "allow", paramMatchers: [{ path: "x" }] }),
    });
    expect(res.status).toBe(400);
  });

  it("creates a valid org policy with origin=admin, principalType=org", async () => {
    api = await bootTestApi();
    const res = await fetch(`${api.baseUrl}/api/org/policies`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ actionId: "github.create_issue", mode: "require_approval", appliesIn: "session" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as CreateOrgPolicyResponse;
    expect(body.actionId).toBe("github.create_issue");
    expect(body.mode).toBe("require_approval");
    expect(body.appliesIn).toBe("session");
    expect(body.origin).toBe("admin");
    expect(body.managedBy).toBe("local-user");
    expect(typeof body.id).toBe("string");
  });
});

describe("GET /api/org/policies — list + cross-org isolation", () => {
  it("lists only live (non-revoked) policies for the caller's own org", async () => {
    api = await bootTestApi();
    const { db } = api.providers;
    const now = Date.now();

    await db.insert(actionPolicies).values([
      {
        id: "p_mine", orgId: "local-org", principalType: "org", principalId: "local-org",
        service: "github", actionId: null, riskLevel: null, mode: "allow", paramMatchers: [],
        appliesIn: "any", origin: "admin", managedBy: "local-user", expiresAt: null, revokedAt: null,
        createdAt: now, updatedAt: now,
      },
      {
        id: "p_revoked", orgId: "local-org", principalType: "org", principalId: "local-org",
        service: "slack", actionId: null, riskLevel: null, mode: "deny", paramMatchers: [],
        appliesIn: "any", origin: "admin", managedBy: "local-user", expiresAt: null, revokedAt: now,
        createdAt: now, updatedAt: now,
      },
      {
        id: "p_other_org", orgId: "other-org", principalType: "org", principalId: "other-org",
        service: "gmail", actionId: null, riskLevel: null, mode: "deny", paramMatchers: [],
        appliesIn: "any", origin: "admin", managedBy: "someone", expiresAt: null, revokedAt: null,
        createdAt: now, updatedAt: now,
      },
    ]);

    const res = await fetch(`${api.baseUrl}/api/org/policies`, { headers: HEADERS });
    expect(res.status).toBe(200);
    const { policies } = (await res.json()) as ListOrgPoliciesResponse;
    const ids = policies.map((p) => p.id);
    expect(ids).toContain("p_mine");
    expect(ids).not.toContain("p_revoked");
    expect(ids).not.toContain("p_other_org");
  });
});

describe("PATCH /api/org/policies/:id", () => {
  async function createPolicy(): Promise<ActionPolicyWire> {
    const res = await fetch(`${api!.baseUrl}/api/org/policies`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ actionId: "github.create_issue", mode: "allow" }),
    });
    return (await res.json()) as ActionPolicyWire;
  }

  it("updates mode/paramMatchers/appliesIn/expiresAt", async () => {
    api = await bootTestApi();
    const created = await createPolicy();

    const res = await fetch(`${api.baseUrl}/api/org/policies/${created.id}`, {
      method: "PATCH",
      headers: HEADERS,
      body: JSON.stringify({ mode: "deny", appliesIn: "session", expiresAt: 12345 }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as PatchOrgPolicyResponse;
    expect(body.mode).toBe("deny");
    expect(body.appliesIn).toBe("session");
    expect(body.expiresAt).toBe(12345);
    // Target identity is immutable — untouched by the patch.
    expect(body.actionId).toBe("github.create_issue");
  });

  it("404s for a cross-org policy id", async () => {
    api = await bootTestApi();
    const { db } = api.providers;
    const now = Date.now();
    await db.insert(actionPolicies).values({
      id: "p_cross", orgId: "other-org", principalType: "org", principalId: "other-org",
      service: "github", actionId: null, riskLevel: null, mode: "allow", paramMatchers: [],
      appliesIn: "any", origin: "admin", managedBy: "x", expiresAt: null, revokedAt: null,
      createdAt: now, updatedAt: now,
    });

    const res = await fetch(`${api.baseUrl}/api/org/policies/p_cross`, {
      method: "PATCH",
      headers: HEADERS,
      body: JSON.stringify({ mode: "deny" }),
    });
    expect(res.status).toBe(404);
  });

  it("400s for an invalid paramMatchers patch", async () => {
    api = await bootTestApi();
    const created = await createPolicy();
    const res = await fetch(`${api.baseUrl}/api/org/policies/${created.id}`, {
      method: "PATCH",
      headers: HEADERS,
      body: JSON.stringify({ paramMatchers: "not-an-array" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("DELETE /api/org/policies/:id — soft revoke", () => {
  it("stamps revokedAt (not a row delete) and the policy disappears from GET list", async () => {
    api = await bootTestApi();
    const createRes = await fetch(`${api.baseUrl}/api/org/policies`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ actionId: "github.create_issue", mode: "allow" }),
    });
    const created = (await createRes.json()) as CreateOrgPolicyResponse;

    const delRes = await fetch(`${api.baseUrl}/api/org/policies/${created.id}`, {
      method: "DELETE",
      headers: HEADERS,
    });
    expect(delRes.status).toBe(200);
    const revoked = (await delRes.json()) as ActionPolicyWire;
    expect(typeof revoked.id).toBe("string");

    const { db } = api.providers;
    const rows = await db.select().from(actionPolicies);
    const row = rows.find((r) => r.id === created.id);
    // Row still exists (soft delete), but with revokedAt stamped.
    expect(row).toBeDefined();
    expect(row?.revokedAt).not.toBeNull();

    const listRes = await fetch(`${api.baseUrl}/api/org/policies`, { headers: HEADERS });
    const { policies } = (await listRes.json()) as ListOrgPoliciesResponse;
    expect(policies.map((p) => p.id)).not.toContain(created.id);
  });

  it("is idempotent — a second DELETE still 200s (not 404) on an already-revoked row", async () => {
    api = await bootTestApi();
    const createRes = await fetch(`${api.baseUrl}/api/org/policies`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ actionId: "github.create_issue", mode: "allow" }),
    });
    const created = (await createRes.json()) as CreateOrgPolicyResponse;

    await fetch(`${api.baseUrl}/api/org/policies/${created.id}`, { method: "DELETE", headers: HEADERS });
    const second = await fetch(`${api.baseUrl}/api/org/policies/${created.id}`, { method: "DELETE", headers: HEADERS });
    expect(second.status).toBe(200);
  });

  it("404s for a nonexistent id", async () => {
    api = await bootTestApi();
    const res = await fetch(`${api.baseUrl}/api/org/policies/does-not-exist`, {
      method: "DELETE",
      headers: HEADERS,
    });
    expect(res.status).toBe(404);
  });

  it("404s for a cross-org policy id (no existence leak)", async () => {
    api = await bootTestApi();
    const { db } = api.providers;
    const now = Date.now();
    await db.insert(actionPolicies).values({
      id: "p_cross_del", orgId: "other-org", principalType: "org", principalId: "other-org",
      service: "github", actionId: null, riskLevel: null, mode: "allow", paramMatchers: [],
      appliesIn: "any", origin: "admin", managedBy: "x", expiresAt: null, revokedAt: null,
      createdAt: now, updatedAt: now,
    });

    const res = await fetch(`${api.baseUrl}/api/org/policies/p_cross_del`, {
      method: "DELETE",
      headers: HEADERS,
    });
    expect(res.status).toBe(404);
    // The cross-org row is untouched — the 404 is indistinguishable from a
    // genuinely missing id.
    const row = (await db.select().from(actionPolicies).where(eq(actionPolicies.id, "p_cross_del")))[0];
    expect(row.revokedAt).toBeNull();
  });
});

// ── Preview endpoint ─────────────────────────────────────────────────────

describe("POST /api/org/policies/preview", () => {
  it("dry-runs the resolver without writing anything", async () => {
    api = await bootTestApi();
    await fetch(`${api.baseUrl}/api/org/policies`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ actionId: "github.create_issue", mode: "deny" }),
    });

    const res = await fetch(`${api.baseUrl}/api/org/policies/preview`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({
        service: "github", actionId: "github.create_issue", riskLevel: "high",
        appliesIn: "session", sessionId: "s1",
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as PreviewOrgPolicyResponse;
    expect(body.mode).toBe("deny");
    expect(body.provenance.source).toBe("org_policy");

    // No invocation audit row, no policy row mutation — a pure read.
    const { db } = api.providers;
    const invocations = await db.select().from(actionInvocations);
    expect(invocations).toHaveLength(0);
  });

  it("400s when appliesIn=session but sessionId is missing", async () => {
    api = await bootTestApi();
    const res = await fetch(`${api.baseUrl}/api/org/policies/preview`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ service: "github", actionId: "x", riskLevel: "low", appliesIn: "session" }),
    });
    expect(res.status).toBe(400);
  });

  it("resolves the real plugin default (rung 4) when it differs from the risk default", async () => {
    // A plugin whose `defaultApprovalMode` is require_approval on a LOW-risk
    // action (risk default would be allow). With no org policy/override, the
    // preview must surface the plugin default, not the risk default — I4.
    const lowAction = {
      id: "widgets.ping",
      name: "Ping",
      description: "low-risk fixture action",
      riskLevel: "low" as const,
      parameters: Type.Object({}),
      execute: async () => ({ success: true as const, data: {} }),
    };
    const plugin: ValetPlugin = {
      name: "preview-fixture",
      version: "0.0.1",
      actions: [{ service: "widgets", actions: [lowAction], defaultApprovalMode: "require_approval" }],
    };
    api = await bootTestApi({ plugins: [plugin] });

    const res = await fetch(`${api.baseUrl}/api/org/policies/preview`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({
        service: "widgets", actionId: "widgets.ping", riskLevel: "low",
        appliesIn: "session", sessionId: "s1",
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as PreviewOrgPolicyResponse;
    expect(body.mode).toBe("require_approval");
    expect(body.provenance.source).toBe("plugin_default");
  });
});

// ── Action log: keyset pagination ─────────────────────────────────────────

async function seedInvocations(api: TestApi, count: number, opts: { orgId?: string; startBase?: number } = {}) {
  const { db } = api.providers;
  const orgId = opts.orgId ?? "local-org";
  const startBase = opts.startBase ?? 1_000_000;
  const rows = Array.from({ length: count }, (_, i) => ({
    invocationId: `inv_${orgId}_${i}`,
    createdAt: startBase + i,
    service: "github",
    actionId: "github.create_issue",
    riskLevel: "high" as const,
    resolvedMode: "allow" as const,
    baseMode: "allow" as const,
    matchedPolicyId: null,
    matchedGrantId: null,
    matchedOverrideId: null,
    status: "completed" as const,
    sessionId: "s1",
    workflowExecutionId: null,
    userId: "local-user",
    orgId,
    params: null,
    paramsTruncated: null,
    result: null,
    resultTruncated: null,
    error: null,
    durationMs: 5,
    startedAt: startBase + i,
  }));
  await db.insert(actionInvocations).values(rows);
}

describe("GET /api/org/action-log — keyset pagination", () => {
  it("pages through 3 pages with a stable, non-overlapping, non-skipping ordering", async () => {
    api = await bootTestApi();
    await seedInvocations(api, 25);

    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    for (;;) {
      const url = new URL(`${api.baseUrl}/api/org/action-log`);
      url.searchParams.set("limit", "10");
      if (cursor) url.searchParams.set("cursor", cursor);
      const res = await fetch(url);
      expect(res.status).toBe(200);
      const body = (await res.json()) as ListActionLogResponse;
      seen.push(...body.entries.map((e) => e.invocationId));
      pages += 1;
      if (!body.nextCursor) break;
      cursor = body.nextCursor;
      if (pages > 10) throw new Error("pagination did not terminate");
    }

    expect(pages).toBe(3); // 10 + 10 + 5
    expect(new Set(seen).size).toBe(25); // no duplicates
    expect(seen).toHaveLength(25); // no skips

    // Descending startedAt order (newest first) — index 0 is the highest
    // startedAt seeded (startBase + 24).
    expect(seen[0]).toBe("inv_local-org_24");
    expect(seen[24]).toBe("inv_local-org_0");
  });

  it("the invocationId tiebreaker prevents dup/skip when rows share startedAt across a page boundary", async () => {
    api = await bootTestApi();
    const { db } = api.providers;
    const base = {
      service: "github", actionId: "github.create_issue", riskLevel: "high" as const,
      resolvedMode: "allow" as const, baseMode: "allow" as const, matchedPolicyId: null,
      matchedGrantId: null, matchedOverrideId: null, status: "completed" as const, sessionId: "s1",
      workflowExecutionId: null, userId: "local-user", orgId: "local-org", params: null,
      paramsTruncated: null, result: null, resultTruncated: null, error: null, durationMs: 5,
    };
    // Rows "tie_b"/"tie_c"/"tie_d" all share createdAt=2000 — with limit=2 the
    // sort (createdAt desc, invocationId desc) puts "tie_d" on page 1 and
    // "tie_c"/"tie_b" on page 2, straddling the page boundary INSIDE the tied
    // group. "tie_a" (createdAt=3000) and "tie_e" (createdAt=1000) bound the
    // tied group on either side so the boundary isn't just "the last page".
    // `startedAt` is null on every row — the sort keys on `createdAt` (I3), so
    // the ordering must hold with no startedAt at all (under the old
    // coalesce(started_at,0) sort these would all collapse to 0 and order by
    // invocationId alone, i.e. tie_e first — the wrong answer).
    await db.insert(actionInvocations).values([
      { ...base, invocationId: "tie_a", createdAt: 3000, startedAt: null },
      { ...base, invocationId: "tie_d", createdAt: 2000, startedAt: null },
      { ...base, invocationId: "tie_c", createdAt: 2000, startedAt: null },
      { ...base, invocationId: "tie_b", createdAt: 2000, startedAt: null },
      { ...base, invocationId: "tie_e", createdAt: 1000, startedAt: null },
    ]);

    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    for (;;) {
      const url = new URL(`${api.baseUrl}/api/org/action-log`);
      url.searchParams.set("limit", "2");
      if (cursor) url.searchParams.set("cursor", cursor);
      const res = await fetch(url, { headers: HEADERS });
      expect(res.status).toBe(200);
      const body = (await res.json()) as ListActionLogResponse;
      seen.push(...body.entries.map((e) => e.invocationId));
      pages += 1;
      if (!body.nextCursor) break;
      cursor = body.nextCursor;
      if (pages > 10) throw new Error("pagination did not terminate");
    }

    expect(new Set(seen).size).toBe(5); // no duplicates
    expect(seen).toHaveLength(5); // no skips
    // Deterministic full order: createdAt desc, then invocationId desc
    // within the tied createdAt=2000 group.
    expect(seen).toEqual(["tie_a", "tie_d", "tie_c", "tie_b", "tie_e"]);
  });

  it("a denied row (null startedAt) interleaves by createdAt, not sorted to the tail", async () => {
    api = await bootTestApi();
    const { db } = api.providers;
    const shared = {
      service: "github", actionId: "github.create_issue", riskLevel: "high" as const,
      matchedPolicyId: null, matchedGrantId: null, matchedOverrideId: null, sessionId: "s1",
      workflowExecutionId: null, userId: "local-user", orgId: "local-org", params: null,
      paramsTruncated: null, result: null, resultTruncated: null, error: null, durationMs: 5,
    };
    // A denial (null startedAt) chronologically BETWEEN two executed rows.
    // Under the old coalesce(started_at,0) sort it collapsed to 0 and sank to
    // the tail; keyed on createdAt (I3) it interleaves where it belongs.
    await db.insert(actionInvocations).values([
      { ...shared, invocationId: "exec_new", createdAt: 3000, startedAt: 3000, resolvedMode: "allow", baseMode: "allow", status: "completed" },
      { ...shared, invocationId: "denied_mid", createdAt: 2000, startedAt: null, resolvedMode: "deny", baseMode: "deny", status: "denied" },
      { ...shared, invocationId: "exec_old", createdAt: 1000, startedAt: 1000, resolvedMode: "allow", baseMode: "allow", status: "completed" },
    ]);

    const res = await fetch(`${api.baseUrl}/api/org/action-log`, { headers: HEADERS });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListActionLogResponse;
    expect(body.entries.map((e) => e.invocationId)).toEqual(["exec_new", "denied_mid", "exec_old"]);
  });

  it("nextCursor is null on the last page", async () => {
    api = await bootTestApi();
    await seedInvocations(api, 3);
    const res = await fetch(`${api.baseUrl}/api/org/action-log?limit=50`, { headers: HEADERS });
    const body = (await res.json()) as ListActionLogResponse;
    expect(body.entries).toHaveLength(3);
    expect(body.nextCursor).toBeNull();
  });

  it("defaults limit to 50 and clamps a request over 100 down to 100", async () => {
    api = await bootTestApi();
    await seedInvocations(api, 5);

    const defaultRes = await fetch(`${api.baseUrl}/api/org/action-log`, { headers: HEADERS });
    expect((await defaultRes.json() as ListActionLogResponse).entries).toHaveLength(5);

    const clampedRes = await fetch(`${api.baseUrl}/api/org/action-log?limit=500`, { headers: HEADERS });
    expect(clampedRes.status).toBe(200);
    expect((await clampedRes.json() as ListActionLogResponse).entries).toHaveLength(5);
  });

  it("400s for an invalid cursor", async () => {
    api = await bootTestApi();
    const res = await fetch(`${api.baseUrl}/api/org/action-log?cursor=not-valid-base64url-json`, { headers: HEADERS });
    expect(res.status).toBe(400);
  });

  it("filters by service, resolvedMode, status, userId, and from/to", async () => {
    api = await bootTestApi();
    const { db } = api.providers;
    const now = 2_000_000;
    await db.insert(actionInvocations).values([
      {
        invocationId: "inv_match", createdAt: now, service: "github", actionId: "github.create_issue",
        riskLevel: "high", resolvedMode: "allow", baseMode: "allow", status: "completed",
        sessionId: "s1", userId: "local-user", orgId: "local-org", durationMs: 1, startedAt: now,
        matchedPolicyId: null, matchedGrantId: null, matchedOverrideId: null,
        workflowExecutionId: null, params: null, paramsTruncated: null, result: null, resultTruncated: null, error: null,
      },
      {
        invocationId: "inv_wrong_service", createdAt: now, service: "slack", actionId: "slack.post",
        riskLevel: "high", resolvedMode: "allow", baseMode: "allow", status: "completed",
        sessionId: "s1", userId: "local-user", orgId: "local-org", durationMs: 1, startedAt: now,
        matchedPolicyId: null, matchedGrantId: null, matchedOverrideId: null,
        workflowExecutionId: null, params: null, paramsTruncated: null, result: null, resultTruncated: null, error: null,
      },
      {
        invocationId: "inv_wrong_mode", createdAt: now, service: "github", actionId: "github.create_issue",
        riskLevel: "high", resolvedMode: "deny", baseMode: "deny", status: "denied",
        sessionId: "s1", userId: "local-user", orgId: "local-org", durationMs: 1, startedAt: now,
        matchedPolicyId: null, matchedGrantId: null, matchedOverrideId: null,
        workflowExecutionId: null, params: null, paramsTruncated: null, result: null, resultTruncated: null, error: null,
      },
      {
        invocationId: "inv_out_of_range", createdAt: now - 100_000, service: "github", actionId: "github.create_issue",
        riskLevel: "high", resolvedMode: "allow", baseMode: "allow", status: "completed",
        sessionId: "s1", userId: "local-user", orgId: "local-org", durationMs: 1, startedAt: now - 100_000,
        matchedPolicyId: null, matchedGrantId: null, matchedOverrideId: null,
        workflowExecutionId: null, params: null, paramsTruncated: null, result: null, resultTruncated: null, error: null,
      },
    ]);

    const url = new URL(`${api.baseUrl}/api/org/action-log`);
    url.searchParams.set("service", "github");
    url.searchParams.set("resolvedMode", "allow");
    url.searchParams.set("status", "completed");
    url.searchParams.set("userId", "local-user");
    url.searchParams.set("from", String(now - 1000));
    url.searchParams.set("to", String(now + 1000));
    const res = await fetch(url);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListActionLogResponse;
    expect(body.entries.map((e) => e.invocationId)).toEqual(["inv_match"]);
  });

  it("scopes results to the caller's own org", async () => {
    api = await bootTestApi();
    await seedInvocations(api, 2, { orgId: "local-org" });
    await seedInvocations(api, 2, { orgId: "other-org", startBase: 5_000_000 });

    const res = await fetch(`${api.baseUrl}/api/org/action-log`, { headers: HEADERS });
    const body = (await res.json()) as ListActionLogResponse;
    expect(body.entries.every((e) => e.invocationId.startsWith("inv_local-org_"))).toBe(true);
  });

  it("resolvedMode is the audit key, distinct from status", async () => {
    api = await bootTestApi();
    const { db } = api.providers;
    const now = 3_000_000;
    // Same status ("completed"), different resolvedMode — proves a consumer
    // filtering on resolvedMode gets a different result than filtering on
    // status, per the binding spec decision (audit/action-log consumers key
    // on resolvedMode, not status).
    await db.insert(actionInvocations).values([
      {
        invocationId: "inv_allowed", createdAt: now, service: "github", actionId: "x", riskLevel: "low",
        resolvedMode: "allow", baseMode: "allow", status: "completed", sessionId: "s1", userId: "local-user",
        orgId: "local-org", durationMs: 1, startedAt: now, matchedPolicyId: null, matchedGrantId: null,
        matchedOverrideId: null, workflowExecutionId: null, params: null, paramsTruncated: null, result: null, resultTruncated: null, error: null,
      },
      {
        invocationId: "inv_approved", createdAt: now, service: "github", actionId: "x", riskLevel: "high",
        resolvedMode: "require_approval", baseMode: "require_approval", status: "completed", sessionId: "s1",
        userId: "local-user", orgId: "local-org", durationMs: 1, startedAt: now, matchedPolicyId: null,
        matchedGrantId: null, matchedOverrideId: null, workflowExecutionId: null, params: null, paramsTruncated: null, result: null, resultTruncated: null, error: null,
      },
    ]);

    const res = await fetch(`${api.baseUrl}/api/org/action-log?resolvedMode=require_approval`, { headers: HEADERS });
    const body = (await res.json()) as ListActionLogResponse;
    expect(body.entries.map((e) => e.invocationId)).toEqual(["inv_approved"]);
  });

  it("status=pending filter returns 200 and the pending row", async () => {
    api = await bootTestApi();
    const { db } = api.providers;
    const now = 4_000_000;
    await db.insert(actionInvocations).values({
      invocationId: "inv_pending", createdAt: now, service: "demo", actionId: "demo.deploy",
      riskLevel: "high", resolvedMode: "require_approval", baseMode: "require_approval",
      status: "pending", sessionId: null, userId: "local-user", orgId: "local-org",
      durationMs: null, startedAt: null, matchedPolicyId: null, matchedGrantId: null,
      matchedOverrideId: null, workflowExecutionId: "run_wf_pending", params: null,
      paramsTruncated: null, result: null, resultTruncated: null, error: null,
    });

    const res = await fetch(`${api.baseUrl}/api/org/action-log?status=pending`, { headers: HEADERS });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListActionLogResponse;
    expect(body.entries.map((e) => e.invocationId)).toContain("inv_pending");
  });

  it("invalid status value returns 400", async () => {
    api = await bootTestApi();
    const res = await fetch(`${api.baseUrl}/api/org/action-log?status=invalid_status`, { headers: HEADERS });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("pending");
  });
});
