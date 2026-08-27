/**
 * GET /api/proxy/usage/summary, /api/proxy/requests, /api/proxy/requests/:id
 *
 * Ownership gating: a member sees only their own rows; an org admin sees the
 * whole org. A row outside the caller's org 404s (no 403).
 */
import { describe, it, expect, afterEach } from "vitest";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { llmProxyRequests, orgMembers, orgs, users } from "../schema/index.js";
import type { ProxyUsageSummary, ProxyRequestListItem, ProxyRequestDetail, ProxyDayBucket } from "../wire/types.js";

let api: TestApi | undefined;

afterEach(async () => {
  await api?.cleanup();
  api = undefined;
});

/** Minimal valid llmProxyRequests row. */
function makeRow(overrides: Partial<typeof llmProxyRequests.$inferInsert>): typeof llmProxyRequests.$inferInsert {
  return {
    id: "req-" + Math.random().toString(36).slice(2),
    createdAt: Date.now(),
    orgId: "local-org",
    userId: "local-user",
    apiKeyId: "key-1",
    providerKind: "anthropic",
    model: "claude-3-5-sonnet",
    harness: "valet-engine",
    endpoint: "/v1/messages",
    stream: false,
    statusCode: 200,
    requestBody: '{"model":"claude-3-5-sonnet"}',
    responseBody: '{"id":"resp-1"}',
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 150,
    costUsd: 0.001,
    latencyMs: 400,
    parsed: null,
    ...overrides,
  };
}

describe("GET /api/proxy/requests — member scoping", () => {
  it("returns only the caller's own rows, not another member's", async () => {
    api = await bootTestApi();
    const now = Date.now();

    // Seed a row owned by the default local-user
    await api.providers.db.insert(llmProxyRequests).values(
      makeRow({ id: "req-mine", userId: "local-user", createdAt: now }),
    );
    // Seed a row owned by the test-member (different user, same org)
    await api.providers.db.insert(llmProxyRequests).values(
      makeRow({ id: "req-theirs", userId: "test-member", createdAt: now }),
    );

    // Default caller is local-user (member role via stub auth)
    // local-user is actually an org admin in the test harness; use test-member
    // (org member, not admin) so we exercise the member path.
    const res = await fetch(`${api.baseUrl}/api/proxy/requests`, {
      headers: { "x-valet-test-user-id": "test-member" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { requests: ProxyRequestListItem[]; nextCursor?: string };
    const ids = body.requests.map((r) => r.id);
    expect(ids).toContain("req-theirs");
    expect(ids).not.toContain("req-mine");
  });
});

describe("GET /api/proxy/requests — admin scoping", () => {
  it("returns all rows in the org for an admin", async () => {
    api = await bootTestApi();
    const now = Date.now();

    await api.providers.db.insert(llmProxyRequests).values(
      makeRow({ id: "req-user1", userId: "local-user", createdAt: now }),
    );
    await api.providers.db.insert(llmProxyRequests).values(
      makeRow({ id: "req-user2", userId: "test-member", createdAt: now }),
    );

    // local-user is an org admin in the harness
    const res = await fetch(`${api.baseUrl}/api/proxy/requests`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { requests: ProxyRequestListItem[]; nextCursor?: string };
    const ids = body.requests.map((r) => r.id);
    expect(ids).toContain("req-user1");
    expect(ids).toContain("req-user2");
  });
});

describe("GET /api/proxy/requests/:id — gating", () => {
  it("404s when a non-admin tries to read another member's row", async () => {
    api = await bootTestApi();

    await api.providers.db.insert(llmProxyRequests).values(
      makeRow({ id: "req-other", userId: "local-user" }),
    );

    const res = await fetch(`${api.baseUrl}/api/proxy/requests/req-other`, {
      headers: { "x-valet-test-user-id": "test-member" },
    });
    expect(res.status).toBe(404);
  });

  it("404s for a row that belongs to a different org", async () => {
    api = await bootTestApi();
    const now = Date.now();

    // Seed a second org and a user in it
    await api.providers.db.insert(orgs).values({ id: "other-org", name: "Other Org", createdAt: now });
    await api.providers.db.insert(users).values({ id: "other-user", email: "other@dev", name: "Other", role: "member" });
    await api.providers.db.insert(orgMembers).values({ orgId: "other-org", userId: "other-user", role: "admin", createdAt: now });

    await api.providers.db.insert(llmProxyRequests).values(
      makeRow({ id: "req-cross-org", orgId: "other-org", userId: "other-user" }),
    );

    // local-user is admin of local-org but not of other-org
    const res = await fetch(`${api.baseUrl}/api/proxy/requests/req-cross-org`);
    expect(res.status).toBe(404);
  });

  it("returns the full row including request_body for an admin", async () => {
    api = await bootTestApi();

    await api.providers.db.insert(llmProxyRequests).values(
      makeRow({
        id: "req-full",
        userId: "test-member",
        requestBody: '{"model":"claude-3-5-sonnet","max_tokens":1024}',
        responseBody: '{"id":"resp-full","type":"message"}',
        parsed: { tokens: 150 },
      }),
    );

    // local-user is an org admin
    const res = await fetch(`${api.baseUrl}/api/proxy/requests/req-full`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ProxyRequestDetail;
    expect(body.id).toBe("req-full");
    expect(body.requestBody).toBe('{"model":"claude-3-5-sonnet","max_tokens":1024}');
    expect(body.responseBody).toBe('{"id":"resp-full","type":"message"}');
    expect(body.parsed).toEqual({ tokens: 150 });
  });

  it("returns a member's own row via the detail endpoint", async () => {
    api = await bootTestApi();

    await api.providers.db.insert(llmProxyRequests).values(
      makeRow({ id: "req-own", userId: "test-member" }),
    );

    const res = await fetch(`${api.baseUrl}/api/proxy/requests/req-own`, {
      headers: { "x-valet-test-user-id": "test-member" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ProxyRequestDetail;
    expect(body.id).toBe("req-own");
  });
});

describe("GET /api/proxy/usage/summary — cost aggregation", () => {
  it("buckets cost by user, model, and harness with correct sums", async () => {
    api = await bootTestApi();
    const now = Date.now();

    // Two rows for local-user, same model + harness
    await api.providers.db.insert(llmProxyRequests).values(
      makeRow({
        id: "req-s1",
        userId: "local-user",
        model: "claude-3-5-sonnet",
        harness: "valet-engine",
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
        costUsd: 0.01,
        createdAt: now - 1000,
      }),
    );
    await api.providers.db.insert(llmProxyRequests).values(
      makeRow({
        id: "req-s2",
        userId: "local-user",
        model: "claude-3-5-sonnet",
        harness: "valet-engine",
        inputTokens: 200,
        outputTokens: 100,
        totalTokens: 300,
        costUsd: 0.02,
        createdAt: now - 2000,
      }),
    );
    // One row for test-member, different model
    await api.providers.db.insert(llmProxyRequests).values(
      makeRow({
        id: "req-s3",
        userId: "test-member",
        model: "claude-opus-4",
        harness: "valet-engine",
        inputTokens: 500,
        outputTokens: 250,
        totalTokens: 750,
        costUsd: 0.05,
        createdAt: now - 3000,
      }),
    );

    // local-user is an org admin — should see all three rows' aggregates
    const res = await fetch(`${api.baseUrl}/api/proxy/usage/summary?window=7d`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ProxyUsageSummary;

    // Total cost across the org
    expect(body.totalCostUsd).toBeCloseTo(0.08, 5);
    expect(body.totalRequests).toBe(3);

    // By-user breakdown
    const userEntry = body.byUser.find((u) => u.userId === "local-user");
    expect(userEntry).toBeDefined();
    expect(userEntry!.costUsd).toBeCloseTo(0.03, 5);
    expect(userEntry!.requests).toBe(2);

    const memberEntry = body.byUser.find((u) => u.userId === "test-member");
    expect(memberEntry).toBeDefined();
    expect(memberEntry!.costUsd).toBeCloseTo(0.05, 5);
    expect(memberEntry!.requests).toBe(1);

    // By-model breakdown
    const sonnetEntry = body.byModel.find((m) => m.model === "claude-3-5-sonnet");
    expect(sonnetEntry).toBeDefined();
    expect(sonnetEntry!.costUsd).toBeCloseTo(0.03, 5);
    expect(sonnetEntry!.requests).toBe(2);

    const opusEntry = body.byModel.find((m) => m.model === "claude-opus-4");
    expect(opusEntry).toBeDefined();
    expect(opusEntry!.costUsd).toBeCloseTo(0.05, 5);

    // By-harness breakdown
    const harnessEntry = body.byHarness.find((h) => h.harness === "valet-engine");
    expect(harnessEntry).toBeDefined();
    expect(harnessEntry!.requests).toBe(3);
    expect(harnessEntry!.costUsd).toBeCloseTo(0.08, 5);
  });

  it("a member sees only their own rows in the summary", async () => {
    api = await bootTestApi();
    const now = Date.now();

    await api.providers.db.insert(llmProxyRequests).values(
      makeRow({
        id: "req-m1",
        userId: "test-member",
        model: "claude-3-5-sonnet",
        harness: "sdk",
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
        costUsd: 0.001,
        createdAt: now - 1000,
      }),
    );
    await api.providers.db.insert(llmProxyRequests).values(
      makeRow({
        id: "req-m2",
        userId: "local-user",
        model: "claude-3-5-sonnet",
        harness: "sdk",
        costUsd: 0.999,
        createdAt: now - 2000,
      }),
    );

    const res = await fetch(`${api.baseUrl}/api/proxy/usage/summary?window=7d`, {
      headers: { "x-valet-test-user-id": "test-member" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ProxyUsageSummary;

    // Member should only see their own request
    expect(body.totalRequests).toBe(1);
    expect(body.totalCostUsd).toBeCloseTo(0.001, 5);
    expect(body.byUser.every((u) => u.userId === "test-member")).toBe(true);
  });
});

describe("GET /api/proxy/usage/summary — byDay buckets", () => {
  it("groups rows by UTC day with correct cost sums", async () => {
    api = await bootTestApi();

    // Two rows on "today", one row two days ago — within a 7d window.
    const now = Date.now();
    const todayBucket = Math.floor(now / 86_400_000) * 86_400_000;
    const twoDaysAgo = now - 2 * 86_400_000;
    const twoDaysAgoBucket = Math.floor(twoDaysAgo / 86_400_000) * 86_400_000;

    await api.providers.db.insert(llmProxyRequests).values(
      makeRow({ id: "req-d1", userId: "local-user", costUsd: 0.01, totalTokens: 100, createdAt: now - 1000 }),
    );
    await api.providers.db.insert(llmProxyRequests).values(
      makeRow({ id: "req-d2", userId: "local-user", costUsd: 0.02, totalTokens: 200, createdAt: now - 2000 }),
    );
    await api.providers.db.insert(llmProxyRequests).values(
      makeRow({ id: "req-d3", userId: "local-user", costUsd: 0.05, totalTokens: 500, createdAt: twoDaysAgo }),
    );

    const res = await fetch(`${api.baseUrl}/api/proxy/usage/summary?window=7d`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ProxyUsageSummary;

    expect(Array.isArray(body.byDay)).toBe(true);
    // Must contain exactly two day buckets (today + two-days-ago).
    expect(body.byDay).toHaveLength(2);

    const buckets = body.byDay as ProxyDayBucket[];
    // Ordered ascending by day: two-days-ago first, then today.
    expect(buckets[0].dayMs).toBe(twoDaysAgoBucket);
    expect(buckets[1].dayMs).toBe(todayBucket);

    // Two-days-ago: one row costing 0.05.
    expect(buckets[0].requests).toBe(1);
    expect(buckets[0].costUsd).toBeCloseTo(0.05, 5);

    // Today: two rows summing 0.03.
    expect(buckets[1].requests).toBe(2);
    expect(buckets[1].costUsd).toBeCloseTo(0.03, 5);
  });

  it("byDay respects member scoping — a member only sees their own rows", async () => {
    api = await bootTestApi();

    const now = Date.now();
    const todayBucket = Math.floor(now / 86_400_000) * 86_400_000;

    await api.providers.db.insert(llmProxyRequests).values(
      makeRow({ id: "req-scope-member", userId: "test-member", costUsd: 0.007, totalTokens: 70, createdAt: now - 1000 }),
    );
    await api.providers.db.insert(llmProxyRequests).values(
      makeRow({ id: "req-scope-admin", userId: "local-user", costUsd: 0.999, totalTokens: 9999, createdAt: now - 2000 }),
    );

    const res = await fetch(`${api.baseUrl}/api/proxy/usage/summary?window=7d`, {
      headers: { "x-valet-test-user-id": "test-member" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ProxyUsageSummary;

    const buckets = body.byDay as ProxyDayBucket[];
    // Member sees only one day bucket covering their own row.
    expect(buckets).toHaveLength(1);
    expect(buckets[0].dayMs).toBe(todayBucket);
    expect(buckets[0].requests).toBe(1);
    expect(buckets[0].costUsd).toBeCloseTo(0.007, 5);
  });
});
