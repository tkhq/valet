/**
 * `/api/org/llm-providers` — org-admin CRUD + encrypted key management.
 * Same gating pattern as `routes/org-invites.test.ts`. Cross-org isolation
 * is exercised by inserting a row directly under a different `orgId` — the
 * stub-auth harness always resolves the caller to `local-org` (see
 * `middleware/auth.ts`), so any row seeded under another org id is
 * "cross-org" from every test request's point of view.
 */
import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { llmProviders } from "../schema/index.js";
import type {
  CreateLlmProviderResponse,
  GetLlmProviderPreferencesResponse,
  ListLlmProvidersResponse,
  PutLlmProviderKeyResponse,
} from "../wire/types.js";

const HEADERS = { "Content-Type": "application/json" };
const MEMBER_HEADERS = { "Content-Type": "application/json", "x-valet-test-user-id": "test-member" };

let api: TestApi | undefined;

afterEach(async () => {
  await api?.cleanup();
  api = undefined;
});

async function createAnthropicProvider(baseUrl: string): Promise<CreateLlmProviderResponse> {
  const res = await fetch(`${baseUrl}/api/org/llm-providers`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({ kind: "anthropic", name: "Anthropic" }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as CreateLlmProviderResponse;
}

describe("POST /api/org/llm-providers", () => {
  it("403s for a non-admin org member", async () => {
    api = await bootTestApi();
    const res = await fetch(`${api.baseUrl}/api/org/llm-providers`, {
      method: "POST",
      headers: MEMBER_HEADERS,
      body: JSON.stringify({ kind: "anthropic", name: "Anthropic" }),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "org admin required" });
  });

  it("creates a known-kind provider as admin", async () => {
    api = await bootTestApi();
    const body = await createAnthropicProvider(api.baseUrl);
    expect(body.kind).toBe("anthropic");
    expect(body.name).toBe("Anthropic");
    expect(body.baseUrl).toBeUndefined();
    expect(body.enabled).toBe(true);
    expect(body.hasKey).toBe(false);
    expect(typeof body.id).toBe("string");
    expect(typeof body.createdAt).toBe("number");
  });

  it("400s when baseUrl is present for a known kind", async () => {
    api = await bootTestApi();
    const res = await fetch(`${api.baseUrl}/api/org/llm-providers`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ kind: "anthropic", name: "Anthropic", baseUrl: "https://example.com" }),
    });
    expect(res.status).toBe(400);
  });

  it("400s when baseUrl is missing for openai_compatible", async () => {
    api = await bootTestApi();
    const res = await fetch(`${api.baseUrl}/api/org/llm-providers`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ kind: "openai_compatible", name: "Custom" }),
    });
    expect(res.status).toBe(400);
  });

  it("creates an openai_compatible provider with baseUrl", async () => {
    api = await bootTestApi();
    const res = await fetch(`${api.baseUrl}/api/org/llm-providers`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ kind: "openai_compatible", name: "Custom", baseUrl: "https://api.example.com/v1" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as CreateLlmProviderResponse;
    expect(body.baseUrl).toBe("https://api.example.com/v1");
  });

  it("409s creating a second known-kind provider for the same org (clean shape, not a raw 500)", async () => {
    api = await bootTestApi();
    await createAnthropicProvider(api.baseUrl);

    const res = await fetch(`${api.baseUrl}/api/org/llm-providers`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ kind: "anthropic", name: "Anthropic Again" }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(typeof body.error).toBe("string");
  });

  it("400s when models is present for a known kind", async () => {
    api = await bootTestApi();
    const res = await fetch(`${api.baseUrl}/api/org/llm-providers`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ kind: "anthropic", name: "Anthropic", models: [{ id: "m1", name: "Model 1" }] }),
    });
    expect(res.status).toBe(400);
  });

  it("allows multiple openai_compatible providers for the same org", async () => {
    api = await bootTestApi();
    const res1 = await fetch(`${api.baseUrl}/api/org/llm-providers`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ kind: "openai_compatible", name: "Custom 1", baseUrl: "https://a.example.com" }),
    });
    const res2 = await fetch(`${api.baseUrl}/api/org/llm-providers`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ kind: "openai_compatible", name: "Custom 2", baseUrl: "https://b.example.com" }),
    });
    expect(res1.status).toBe(201);
    expect(res2.status).toBe(201);
  });
});

describe("GET /api/org/llm-providers", () => {
  it("403s for a non-admin org member", async () => {
    api = await bootTestApi();
    const res = await fetch(`${api.baseUrl}/api/org/llm-providers`, { headers: MEMBER_HEADERS });
    expect(res.status).toBe(403);
  });

  it("lists providers scoped to the caller's org only", async () => {
    api = await bootTestApi();
    await createAnthropicProvider(api.baseUrl);

    // Seed a cross-org row directly — must never appear in the list.
    await api.providers.db.insert(llmProviders).values({
      id: "prov_other_org",
      orgId: "other-org",
      kind: "openai",
      name: "Other org's OpenAI",
      baseUrl: null,
      enabled: true,
      models: [],
      createdAt: Date.now(),
    });

    const res = await fetch(`${api.baseUrl}/api/org/llm-providers`, { headers: HEADERS });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListLlmProvidersResponse;
    expect(body.providers).toHaveLength(1);
    expect(body.providers[0]?.kind).toBe("anthropic");
  });

  it("envFallback is false with no key and no env var, true once the env var is stubbed", async () => {
    api = await bootTestApi();
    await createAnthropicProvider(api.baseUrl);

    const before = await fetch(`${api.baseUrl}/api/org/llm-providers`, { headers: HEADERS });
    const beforeBody = (await before.json()) as ListLlmProvidersResponse;
    expect(beforeBody.providers[0]?.envFallback).toBe(false);

    const prev = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-ant-stub-env-key";
    try {
      const after = await fetch(`${api.baseUrl}/api/org/llm-providers`, { headers: HEADERS });
      const afterBody = (await after.json()) as ListLlmProvidersResponse;
      expect(afterBody.providers[0]?.envFallback).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prev;
    }
  });

  it("envFallback is false once an org key is stored, even with the env var stubbed", async () => {
    api = await bootTestApi();
    const created = await createAnthropicProvider(api.baseUrl);

    const prev = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-ant-stub-env-key";
    try {
      await fetch(`${api.baseUrl}/api/org/llm-providers/${created.id}/key`, {
        method: "PUT",
        headers: HEADERS,
        body: JSON.stringify({ apiKey: "sk-ant-real-key-1234" }),
      });
      const res = await fetch(`${api.baseUrl}/api/org/llm-providers`, { headers: HEADERS });
      const body = (await res.json()) as ListLlmProvidersResponse;
      expect(body.providers[0]?.hasKey).toBe(true);
      expect(body.providers[0]?.envFallback).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prev;
    }
  });
});

describe("PATCH /api/org/llm-providers/:id", () => {
  it("403s for a non-admin org member", async () => {
    api = await bootTestApi();
    const created = await createAnthropicProvider(api.baseUrl);
    const res = await fetch(`${api.baseUrl}/api/org/llm-providers/${created.id}`, {
      method: "PATCH",
      headers: MEMBER_HEADERS,
      body: JSON.stringify({ name: "New name" }),
    });
    expect(res.status).toBe(403);
  });

  it("404s a cross-org id", async () => {
    api = await bootTestApi();
    await api.providers.db.insert(llmProviders).values({
      id: "prov_other_org_2",
      orgId: "other-org",
      kind: "google",
      name: "Other org's Google",
      baseUrl: null,
      enabled: true,
      models: [],
      createdAt: Date.now(),
    });

    const res = await fetch(`${api.baseUrl}/api/org/llm-providers/prov_other_org_2`, {
      method: "PATCH",
      headers: HEADERS,
      body: JSON.stringify({ name: "Hijacked" }),
    });
    expect(res.status).toBe(404);
  });

  it("updates name/enabled and rejects baseUrl for a known kind", async () => {
    api = await bootTestApi();
    const created = await createAnthropicProvider(api.baseUrl);

    const res = await fetch(`${api.baseUrl}/api/org/llm-providers/${created.id}`, {
      method: "PATCH",
      headers: HEADERS,
      body: JSON.stringify({ name: "Renamed", enabled: false }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as CreateLlmProviderResponse;
    expect(body.name).toBe("Renamed");
    expect(body.enabled).toBe(false);

    const badRes = await fetch(`${api.baseUrl}/api/org/llm-providers/${created.id}`, {
      method: "PATCH",
      headers: HEADERS,
      body: JSON.stringify({ baseUrl: "https://example.com" }),
    });
    expect(badRes.status).toBe(400);
  });

  it("400s when models is patched on a known-kind provider", async () => {
    api = await bootTestApi();
    const created = await createAnthropicProvider(api.baseUrl);
    const res = await fetch(`${api.baseUrl}/api/org/llm-providers/${created.id}`, {
      method: "PATCH",
      headers: HEADERS,
      body: JSON.stringify({ models: [{ id: "m1", name: "Model 1" }] }),
    });
    expect(res.status).toBe(400);
  });

  it("updates baseUrl for openai_compatible, rejects an empty baseUrl", async () => {
    api = await bootTestApi();
    const createRes = await fetch(`${api.baseUrl}/api/org/llm-providers`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ kind: "openai_compatible", name: "Custom", baseUrl: "https://a.example.com" }),
    });
    const created = (await createRes.json()) as CreateLlmProviderResponse;

    const res = await fetch(`${api.baseUrl}/api/org/llm-providers/${created.id}`, {
      method: "PATCH",
      headers: HEADERS,
      body: JSON.stringify({ baseUrl: "https://b.example.com" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as CreateLlmProviderResponse;
    expect(body.baseUrl).toBe("https://b.example.com");

    const badRes = await fetch(`${api.baseUrl}/api/org/llm-providers/${created.id}`, {
      method: "PATCH",
      headers: HEADERS,
      body: JSON.stringify({ baseUrl: "" }),
    });
    expect(badRes.status).toBe(400);
  });
});

describe("PUT /api/org/llm-providers/:id/key", () => {
  it("403s for a non-admin org member", async () => {
    api = await bootTestApi();
    const created = await createAnthropicProvider(api.baseUrl);
    const res = await fetch(`${api.baseUrl}/api/org/llm-providers/${created.id}/key`, {
      method: "PUT",
      headers: MEMBER_HEADERS,
      body: JSON.stringify({ apiKey: "sk-ant-secret-value-1234" }),
    });
    expect(res.status).toBe(403);
  });

  it("404s a cross-org id", async () => {
    api = await bootTestApi();
    await api.providers.db.insert(llmProviders).values({
      id: "prov_other_org_3",
      orgId: "other-org",
      kind: "openai",
      name: "Other org's OpenAI",
      baseUrl: null,
      enabled: true,
      models: [],
      createdAt: Date.now(),
    });
    const res = await fetch(`${api.baseUrl}/api/org/llm-providers/prov_other_org_3/key`, {
      method: "PUT",
      headers: HEADERS,
      body: JSON.stringify({ apiKey: "sk-secret-value-1234" }),
    });
    expect(res.status).toBe(404);
  });

  it("stores the key, never echoes it, and the list shows hasKey + last4", async () => {
    api = await bootTestApi();
    const created = await createAnthropicProvider(api.baseUrl);
    const secretKey = "sk-ant-super-secret-key-abcd1234";

    const putRes = await fetch(`${api.baseUrl}/api/org/llm-providers/${created.id}/key`, {
      method: "PUT",
      headers: HEADERS,
      body: JSON.stringify({ apiKey: secretKey }),
    });
    expect(putRes.status).toBe(200);
    const putBodyText = await putRes.text();
    expect(putBodyText).not.toContain(secretKey);
    const putBody = JSON.parse(putBodyText) as PutLlmProviderKeyResponse;
    expect(putBody).toEqual({ hasKey: true, keyLast4: "1234" });

    const listRes = await fetch(`${api.baseUrl}/api/org/llm-providers`, { headers: HEADERS });
    const listBodyText = await listRes.text();
    expect(listBodyText).not.toContain(secretKey);
    const listBody = JSON.parse(listBodyText) as ListLlmProvidersResponse;
    expect(listBody.providers[0]).toMatchObject({ hasKey: true, keyLast4: "1234" });
  });
});

describe("DELETE /api/org/llm-providers/:id/key", () => {
  it("403s for a non-admin org member", async () => {
    api = await bootTestApi();
    const created = await createAnthropicProvider(api.baseUrl);
    const res = await fetch(`${api.baseUrl}/api/org/llm-providers/${created.id}/key`, {
      method: "DELETE",
      headers: MEMBER_HEADERS,
    });
    expect(res.status).toBe(403);
  });

  it("revokes the credential", async () => {
    api = await bootTestApi();
    const created = await createAnthropicProvider(api.baseUrl);
    await fetch(`${api.baseUrl}/api/org/llm-providers/${created.id}/key`, {
      method: "PUT",
      headers: HEADERS,
      body: JSON.stringify({ apiKey: "sk-ant-secret-value-1234" }),
    });

    const delRes = await fetch(`${api.baseUrl}/api/org/llm-providers/${created.id}/key`, {
      method: "DELETE",
      headers: HEADERS,
    });
    expect(delRes.status).toBe(204);

    const stored = await api.providers.engineCredentials.get({ type: "org", id: "local-org" }, `llm:${created.id}`);
    expect(stored).toBeNull();

    const listRes = await fetch(`${api.baseUrl}/api/org/llm-providers`, { headers: HEADERS });
    const listBody = (await listRes.json()) as ListLlmProvidersResponse;
    expect(listBody.providers[0]?.hasKey).toBe(false);
  });
});

describe("DELETE /api/org/llm-providers/:id", () => {
  it("403s for a non-admin org member", async () => {
    api = await bootTestApi();
    const created = await createAnthropicProvider(api.baseUrl);
    const res = await fetch(`${api.baseUrl}/api/org/llm-providers/${created.id}`, {
      method: "DELETE",
      headers: MEMBER_HEADERS,
    });
    expect(res.status).toBe(403);
  });

  it("404s a cross-org id", async () => {
    api = await bootTestApi();
    await api.providers.db.insert(llmProviders).values({
      id: "prov_other_org_4",
      orgId: "other-org",
      kind: "google",
      name: "Other org's Google",
      baseUrl: null,
      enabled: true,
      models: [],
      createdAt: Date.now(),
    });
    const res = await fetch(`${api.baseUrl}/api/org/llm-providers/prov_other_org_4`, {
      method: "DELETE",
      headers: HEADERS,
    });
    expect(res.status).toBe(404);
  });

  it("revokes the credential and deletes the row when not the org default", async () => {
    api = await bootTestApi();
    const created = await createAnthropicProvider(api.baseUrl);
    await fetch(`${api.baseUrl}/api/org/llm-providers/${created.id}/key`, {
      method: "PUT",
      headers: HEADERS,
      body: JSON.stringify({ apiKey: "sk-ant-secret-value-1234" }),
    });

    const delRes = await fetch(`${api.baseUrl}/api/org/llm-providers/${created.id}`, {
      method: "DELETE",
      headers: HEADERS,
    });
    expect(delRes.status).toBe(204);

    const stored = await api.providers.engineCredentials.get({ type: "org", id: "local-org" }, `llm:${created.id}`);
    expect(stored).toBeNull();

    const rows = await api.providers.db.select().from(llmProviders).where(eq(llmProviders.id, created.id));
    expect(rows).toHaveLength(0);
  });

  it("409s deleting the provider that is the org default model's provider", async () => {
    api = await bootTestApi();
    const created = await createAnthropicProvider(api.baseUrl);

    const prefRes = await fetch(`${api.baseUrl}/api/org/llm-providers/preferences`, {
      method: "PUT",
      headers: HEADERS,
      body: JSON.stringify({ preferences: ["anthropic/claude-haiku-4-5"] }),
    });
    expect(prefRes.status).toBe(200);

    const delRes = await fetch(`${api.baseUrl}/api/org/llm-providers/${created.id}`, {
      method: "DELETE",
      headers: HEADERS,
    });
    expect(delRes.status).toBe(409);
    const body = (await delRes.json()) as { error: string };
    expect(body.error).toBe("provider is the org default model's provider");

    // Row must still exist — the guard fired before any mutation.
    const rows = await api.providers.db.select().from(llmProviders).where(eq(llmProviders.id, created.id));
    expect(rows).toHaveLength(1);
  });

  it("409s deleting the default provider via a bare (unnamespaced) preference id, which means anthropic", async () => {
    api = await bootTestApi();
    const created = await createAnthropicProvider(api.baseUrl);

    await fetch(`${api.baseUrl}/api/org/llm-providers/preferences`, {
      method: "PUT",
      headers: HEADERS,
      body: JSON.stringify({ preferences: ["claude-haiku-4-5"] }),
    });

    const delRes = await fetch(`${api.baseUrl}/api/org/llm-providers/${created.id}`, {
      method: "DELETE",
      headers: HEADERS,
    });
    expect(delRes.status).toBe(409);
  });
});

describe("GET/PUT /api/org/llm-providers/preferences", () => {
  it("403s for a non-admin org member on both verbs", async () => {
    api = await bootTestApi();
    const getRes = await fetch(`${api.baseUrl}/api/org/llm-providers/preferences`, { headers: MEMBER_HEADERS });
    expect(getRes.status).toBe(403);
    const putRes = await fetch(`${api.baseUrl}/api/org/llm-providers/preferences`, {
      method: "PUT",
      headers: MEMBER_HEADERS,
      body: JSON.stringify({ preferences: [] }),
    });
    expect(putRes.status).toBe(403);
  });

  it("defaults to an empty list, round-trips a set list", async () => {
    api = await bootTestApi();
    const before = await fetch(`${api.baseUrl}/api/org/llm-providers/preferences`, { headers: HEADERS });
    expect(before.status).toBe(200);
    expect((await before.json()) as GetLlmProviderPreferencesResponse).toEqual({ preferences: [] });

    const putRes = await fetch(`${api.baseUrl}/api/org/llm-providers/preferences`, {
      method: "PUT",
      headers: HEADERS,
      body: JSON.stringify({ preferences: ["anthropic/claude-haiku-4-5", "openai/gpt-5"] }),
    });
    expect(putRes.status).toBe(200);
    expect((await putRes.json()) as GetLlmProviderPreferencesResponse).toEqual({
      preferences: ["anthropic/claude-haiku-4-5", "openai/gpt-5"],
    });

    const after = await fetch(`${api.baseUrl}/api/org/llm-providers/preferences`, { headers: HEADERS });
    expect((await after.json()) as GetLlmProviderPreferencesResponse).toEqual({
      preferences: ["anthropic/claude-haiku-4-5", "openai/gpt-5"],
    });
  });

  it("400s a non-array-of-strings body", async () => {
    api = await bootTestApi();
    const res = await fetch(`${api.baseUrl}/api/org/llm-providers/preferences`, {
      method: "PUT",
      headers: HEADERS,
      body: JSON.stringify({ preferences: [123, "anthropic/claude-haiku-4-5"] }),
    });
    expect(res.status).toBe(400);
  });

  it("is not captured by the /:id routes", async () => {
    api = await bootTestApi();
    // If "preferences" were captured as :id, this would 404 (not found as a
    // provider row) instead of returning the (empty) preferences shape.
    const res = await fetch(`${api.baseUrl}/api/org/llm-providers/preferences`, { headers: HEADERS });
    expect(res.status).toBe(200);
  });
});
