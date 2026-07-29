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
import { serve, type ServerType } from "@hono/node-server";
import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { fauxAssistantMessage, registerFauxProvider, type FauxProviderRegistration } from "@mariozechner/pi-ai";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { llmProviders } from "../schema/index.js";
import { OPENROUTER_DEFAULT_MODEL_IDS } from "../services/openrouter.js";
import type {
  CreateLlmProviderResponse,
  GetLlmProviderPreferencesResponse,
  ListLlmProvidersResponse,
  OpenrouterRegistryResponse,
  ProbeLlmProviderResponse,
  PutLlmProviderKeyResponse,
  TestLlmProviderResponse,
} from "../wire/types.js";

/** Tiny `/v1/models`-shaped fixture server (pattern: `packages/sandbox-gateway/test/fake-backend.ts`) —
 * a real HTTP server on port 0 the probe route hits instead of a live upstream. */
interface FakeModelsServer {
  baseUrl: string;
  lastAuthHeader(): string | undefined;
  close(): Promise<void>;
}

function listenAddress(server: ServerType): number {
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port assigned");
  return address.port;
}

function startFakeModelsServer(
  handler: (
    auth: string | undefined,
  ) =>
    | { status: ContentfulStatusCode; body: Record<string, unknown> }
    | { status: ContentfulStatusCode; text: string },
): FakeModelsServer {
  let lastAuth: string | undefined;
  const app = new Hono();
  app.get("/v1/models", (c) => {
    lastAuth = c.req.header("authorization") ?? undefined;
    const result = handler(lastAuth);
    if ("text" in result) return c.text(result.text, result.status);
    return c.json(result.body, result.status);
  });
  const server: ServerType = serve({ fetch: app.fetch, port: 0 });
  const port = listenAddress(server);
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    lastAuthHeader: () => lastAuth,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

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

  it("400s when a custom model's contextWindow is not a number", async () => {
    api = await bootTestApi();
    const res = await fetch(`${api.baseUrl}/api/org/llm-providers`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({
        kind: "openai_compatible",
        name: "Custom",
        baseUrl: "https://api.example.com/v1",
        models: [{ id: "m1", name: "Model 1", contextWindow: "128000" }],
      }),
    });
    expect(res.status).toBe(400);
  });

  it("400s when a custom model's pricing fields are not numbers", async () => {
    api = await bootTestApi();
    const res = await fetch(`${api.baseUrl}/api/org/llm-providers`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({
        kind: "openai_compatible",
        name: "Custom",
        baseUrl: "https://api.example.com/v1",
        models: [{ id: "m1", name: "Model 1", pricing: { input: "1", output: 2 } }],
      }),
    });
    expect(res.status).toBe(400);
  });

  it("accepts a custom model with valid numeric contextWindow and pricing", async () => {
    api = await bootTestApi();
    const res = await fetch(`${api.baseUrl}/api/org/llm-providers`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({
        kind: "openai_compatible",
        name: "Custom",
        baseUrl: "https://api.example.com/v1",
        models: [{ id: "m1", name: "Model 1", contextWindow: 128_000, pricing: { input: 1, output: 2 } }],
      }),
    });
    expect(res.status).toBe(201);
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

  it("creates an openrouter provider seeded with the curated default model selection", async () => {
    api = await bootTestApi();
    const res = await fetch(`${api.baseUrl}/api/org/llm-providers`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ kind: "openrouter", name: "OpenRouter" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as CreateLlmProviderResponse;
    expect(body.kind).toBe("openrouter");
    expect(body.baseUrl).toBeUndefined();
    expect(body.models.map((m) => m.id)).toEqual([...OPENROUTER_DEFAULT_MODEL_IDS]);
    expect(body.models.map((m) => m.id)).toContain("deepseek/deepseek-v4-pro");
  });

  it("openrouter is a per-org singleton (second create 409s)", async () => {
    api = await bootTestApi();
    const mk = () =>
      fetch(`${api!.baseUrl}/api/org/llm-providers`, {
        method: "POST",
        headers: HEADERS,
        body: JSON.stringify({ kind: "openrouter", name: "OpenRouter" }),
      });
    expect((await mk()).status).toBe(201);
    expect((await mk()).status).toBe(409);
  });

  it("accepts an explicit models selection for openrouter at create", async () => {
    api = await bootTestApi();
    const res = await fetch(`${api.baseUrl}/api/org/llm-providers`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({
        kind: "openrouter",
        name: "OpenRouter",
        models: [{ id: "moonshotai/kimi-k2.6", name: "Kimi K2.6" }],
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as CreateLlmProviderResponse;
    expect(body.models).toEqual([{ id: "moonshotai/kimi-k2.6", name: "Kimi K2.6" }]);
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

  it("204s revoking a known-kind provider's key even when it's the org default (env fallback may cover it)", async () => {
    api = await bootTestApi();
    const created = await createAnthropicProvider(api.baseUrl);
    await fetch(`${api.baseUrl}/api/org/llm-providers/${created.id}/key`, {
      method: "PUT",
      headers: HEADERS,
      body: JSON.stringify({ apiKey: "sk-ant-secret-value-1234" }),
    });
    await fetch(`${api.baseUrl}/api/org/llm-providers/preferences`, {
      method: "PUT",
      headers: HEADERS,
      body: JSON.stringify({ preferences: ["anthropic/claude-haiku-4-5"] }),
    });

    const delRes = await fetch(`${api.baseUrl}/api/org/llm-providers/${created.id}/key`, {
      method: "DELETE",
      headers: HEADERS,
    });
    expect(delRes.status).toBe(204);
  });

  it("409s revoking a custom provider's key when it backs preferences[0]", async () => {
    api = await bootTestApi();
    const createRes = await fetch(`${api.baseUrl}/api/org/llm-providers`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ kind: "openai_compatible", name: "Custom", baseUrl: "https://api.example.com/v1" }),
    });
    const created = (await createRes.json()) as CreateLlmProviderResponse;
    await fetch(`${api.baseUrl}/api/org/llm-providers/${created.id}/key`, {
      method: "PUT",
      headers: HEADERS,
      body: JSON.stringify({ apiKey: "custom-secret-1234" }),
    });
    await fetch(`${api.baseUrl}/api/org/llm-providers/${created.id}`, {
      method: "PATCH",
      headers: HEADERS,
      body: JSON.stringify({ models: [{ id: "m1", name: "M1" }] }),
    });
    const prefRes = await fetch(`${api.baseUrl}/api/org/llm-providers/preferences`, {
      method: "PUT",
      headers: HEADERS,
      body: JSON.stringify({ preferences: [`${created.id}/m1`] }),
    });
    expect(prefRes.status).toBe(200);

    const delRes = await fetch(`${api.baseUrl}/api/org/llm-providers/${created.id}/key`, {
      method: "DELETE",
      headers: HEADERS,
    });
    expect(delRes.status).toBe(409);
    const body = (await delRes.json()) as { error: string };
    expect(body.error).toBe("provider is the org default model's provider");

    // Key must still be present — the guard fired before any mutation.
    const listRes = await fetch(`${api.baseUrl}/api/org/llm-providers`, { headers: HEADERS });
    const listBody = (await listRes.json()) as ListLlmProvidersResponse;
    expect(listBody.providers.find((p) => p.id === created.id)?.hasKey).toBe(true);
  });

  it("204s revoking a custom provider's key when it is NOT the org default", async () => {
    api = await bootTestApi();
    const createRes = await fetch(`${api.baseUrl}/api/org/llm-providers`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ kind: "openai_compatible", name: "Custom", baseUrl: "https://api.example.com/v1" }),
    });
    const created = (await createRes.json()) as CreateLlmProviderResponse;
    await fetch(`${api.baseUrl}/api/org/llm-providers/${created.id}/key`, {
      method: "PUT",
      headers: HEADERS,
      body: JSON.stringify({ apiKey: "custom-secret-1234" }),
    });

    const delRes = await fetch(`${api.baseUrl}/api/org/llm-providers/${created.id}/key`, {
      method: "DELETE",
      headers: HEADERS,
    });
    expect(delRes.status).toBe(204);
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
    await fetch(`${api.baseUrl}/api/org/llm-providers/${created.id}/key`, {
      method: "PUT",
      headers: HEADERS,
      body: JSON.stringify({ apiKey: "sk-ant-secret-value-1234" }),
    });

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
    await fetch(`${api.baseUrl}/api/org/llm-providers/${created.id}/key`, {
      method: "PUT",
      headers: HEADERS,
      body: JSON.stringify({ apiKey: "sk-ant-secret-value-1234" }),
    });

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

    // Ids must be active in the org catalog — seed keyed providers first.
    const anthropic = await createAnthropicProvider(api.baseUrl);
    await fetch(`${api.baseUrl}/api/org/llm-providers/${anthropic.id}/key`, {
      method: "PUT",
      headers: HEADERS,
      body: JSON.stringify({ apiKey: "sk-ant-secret-value-1234" }),
    });
    const openaiRes = await fetch(`${api.baseUrl}/api/org/llm-providers`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ kind: "openai", name: "OpenAI" }),
    });
    const openai = (await openaiRes.json()) as CreateLlmProviderResponse;
    await fetch(`${api.baseUrl}/api/org/llm-providers/${openai.id}/key`, {
      method: "PUT",
      headers: HEADERS,
      body: JSON.stringify({ apiKey: "sk-openai-secret-value-1234" }),
    });

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

  it("400s ids that aren't in the org catalog's active set", async () => {
    api = await bootTestApi();
    const res = await fetch(`${api.baseUrl}/api/org/llm-providers/preferences`, {
      method: "PUT",
      headers: HEADERS,
      body: JSON.stringify({ preferences: ["anthropic/claude-haiku-4-5"] }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("anthropic/claude-haiku-4-5");
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

describe("POST /api/org/llm-providers/:id/probe", () => {
  let fake: FakeModelsServer | undefined;

  afterEach(async () => {
    await fake?.close();
    fake = undefined;
  });

  async function createCustomProvider(baseUrl: string, providerBaseUrl: string): Promise<CreateLlmProviderResponse> {
    const res = await fetch(`${baseUrl}/api/org/llm-providers`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ kind: "openai_compatible", name: "Custom", baseUrl: providerBaseUrl }),
    });
    expect(res.status).toBe(201);
    return (await res.json()) as CreateLlmProviderResponse;
  }

  it("403s for a non-admin org member", async () => {
    api = await bootTestApi();
    const created = await createAnthropicProvider(api.baseUrl);
    const res = await fetch(`${api.baseUrl}/api/org/llm-providers/${created.id}/probe`, {
      method: "POST",
      headers: MEMBER_HEADERS,
    });
    expect(res.status).toBe(403);
  });

  it("404s a cross-org id", async () => {
    api = await bootTestApi();
    await api.providers.db.insert(llmProviders).values({
      id: "prov_probe_cross_org",
      orgId: "other-org",
      kind: "openai_compatible",
      name: "Other org's Custom",
      baseUrl: "https://example.com/v1",
      enabled: true,
      models: [],
      createdAt: Date.now(),
    });
    const res = await fetch(`${api.baseUrl}/api/org/llm-providers/prov_probe_cross_org/probe`, {
      method: "POST",
      headers: HEADERS,
    });
    expect(res.status).toBe(404);
  });

  it("400s for a known-kind provider", async () => {
    api = await bootTestApi();
    const created = await createAnthropicProvider(api.baseUrl);
    const res = await fetch(`${api.baseUrl}/api/org/llm-providers/${created.id}/probe`, {
      method: "POST",
      headers: HEADERS,
    });
    expect(res.status).toBe(400);
  });

  it("400s when the custom provider has no API key", async () => {
    api = await bootTestApi();
    const created = await createCustomProvider(api.baseUrl, "https://example.com/v1");
    const res = await fetch(`${api.baseUrl}/api/org/llm-providers/${created.id}/probe`, {
      method: "POST",
      headers: HEADERS,
    });
    expect(res.status).toBe(400);
  });

  it("returns { models } from data[].id on a successful probe, sending the stored key as Bearer auth", async () => {
    api = await bootTestApi();
    fake = startFakeModelsServer(() => ({
      status: 200,
      body: { object: "list", data: [{ id: "model-a" }, { id: "model-b" }] },
    }));
    const created = await createCustomProvider(api.baseUrl, fake.baseUrl);
    const secretKey = "sk-custom-probe-secret-1234";
    await fetch(`${api.baseUrl}/api/org/llm-providers/${created.id}/key`, {
      method: "PUT",
      headers: HEADERS,
      body: JSON.stringify({ apiKey: secretKey }),
    });

    const res = await fetch(`${api.baseUrl}/api/org/llm-providers/${created.id}/probe`, {
      method: "POST",
      headers: HEADERS,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ProbeLlmProviderResponse;
    expect(body).toEqual({ models: [{ id: "model-a" }, { id: "model-b" }] });
    expect(fake.lastAuthHeader()).toBe(`Bearer ${secretKey}`);
  });

  it("502s with the verbatim upstream status + body on upstream failure, never echoing the stored key", async () => {
    api = await bootTestApi();
    fake = startFakeModelsServer(() => ({ status: 401, text: "unauthorized upstream" }));
    const created = await createCustomProvider(api.baseUrl, fake.baseUrl);
    const secretKey = "sk-custom-probe-secret-5678";
    await fetch(`${api.baseUrl}/api/org/llm-providers/${created.id}/key`, {
      method: "PUT",
      headers: HEADERS,
      body: JSON.stringify({ apiKey: secretKey }),
    });

    const res = await fetch(`${api.baseUrl}/api/org/llm-providers/${created.id}/probe`, {
      method: "POST",
      headers: HEADERS,
    });
    expect(res.status).toBe(502);
    const bodyText = await res.text();
    expect(bodyText).toContain("401");
    expect(bodyText).toContain("unauthorized upstream");
    expect(bodyText).not.toContain(secretKey);
  });

  it("502s and redacts the key even if a pathological upstream echoes it back", async () => {
    api = await bootTestApi();
    const secretKey = "sk-custom-probe-secret-echo";
    fake = startFakeModelsServer((auth) => ({ status: 403, text: `forbidden: saw header ${auth ?? "none"}` }));
    const created = await createCustomProvider(api.baseUrl, fake.baseUrl);
    await fetch(`${api.baseUrl}/api/org/llm-providers/${created.id}/key`, {
      method: "PUT",
      headers: HEADERS,
      body: JSON.stringify({ apiKey: secretKey }),
    });

    const res = await fetch(`${api.baseUrl}/api/org/llm-providers/${created.id}/probe`, {
      method: "POST",
      headers: HEADERS,
    });
    expect(res.status).toBe(502);
    const bodyText = await res.text();
    expect(bodyText).not.toContain(secretKey);
    expect(bodyText).toContain("[REDACTED]");
  });
});

describe("POST /api/org/llm-providers/:id/test", () => {
  let faux: FauxProviderRegistration | undefined;

  afterEach(() => {
    faux?.unregister();
    faux = undefined;
  });

  async function createCustomProviderWithModel(baseUrl: string): Promise<CreateLlmProviderResponse> {
    const res = await fetch(`${baseUrl}/api/org/llm-providers`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({
        kind: "openai_compatible",
        name: "Custom",
        baseUrl: "https://example.com/v1",
        models: [{ id: "faux-model", name: "Faux Model" }],
      }),
    });
    expect(res.status).toBe(201);
    return (await res.json()) as CreateLlmProviderResponse;
  }

  it("403s for a non-admin org member", async () => {
    api = await bootTestApi();
    const created = await createAnthropicProvider(api.baseUrl);
    const res = await fetch(`${api.baseUrl}/api/org/llm-providers/${created.id}/test`, {
      method: "POST",
      headers: MEMBER_HEADERS,
      body: JSON.stringify({ modelId: "claude-haiku-4-5" }),
    });
    expect(res.status).toBe(403);
  });

  it("404s a cross-org id", async () => {
    api = await bootTestApi();
    await api.providers.db.insert(llmProviders).values({
      id: "prov_test_cross_org",
      orgId: "other-org",
      kind: "openai",
      name: "Other org's OpenAI",
      baseUrl: null,
      enabled: true,
      models: [],
      createdAt: Date.now(),
    });
    const res = await fetch(`${api.baseUrl}/api/org/llm-providers/prov_test_cross_org/test`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ modelId: "gpt-5" }),
    });
    expect(res.status).toBe(404);
  });

  it("400s when modelId is missing", async () => {
    api = await bootTestApi();
    const created = await createAnthropicProvider(api.baseUrl);
    const res = await fetch(`${api.baseUrl}/api/org/llm-providers/${created.id}/test`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("200s { ok: true, latencyMs } on a successful 1-token completion through the resolution bridge", async () => {
    api = await bootTestApi();
    const created = await createCustomProviderWithModel(api.baseUrl);
    await fetch(`${api.baseUrl}/api/org/llm-providers/${created.id}/key`, {
      method: "PUT",
      headers: HEADERS,
      body: JSON.stringify({ apiKey: "sk-custom-test-secret-1234" }),
    });

    faux = registerFauxProvider({ api: "openai-completions", provider: created.id });
    faux.setResponses([fauxAssistantMessage("ok")]);

    const res = await fetch(`${api.baseUrl}/api/org/llm-providers/${created.id}/test`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ modelId: "faux-model" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as TestLlmProviderResponse;
    expect(body.ok).toBe(true);
    if (body.ok) {
      expect(typeof body.latencyMs).toBe("number");
    }
  });

  it("200s { ok: false, error } when the completion errors, and never echoes the stored key", async () => {
    api = await bootTestApi();
    const created = await createCustomProviderWithModel(api.baseUrl);
    const secretKey = "sk-custom-test-secret-5678";
    await fetch(`${api.baseUrl}/api/org/llm-providers/${created.id}/key`, {
      method: "PUT",
      headers: HEADERS,
      body: JSON.stringify({ apiKey: secretKey }),
    });

    faux = registerFauxProvider({ api: "openai-completions", provider: created.id });
    faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: `boom ${secretKey}` })]);

    const res = await fetch(`${api.baseUrl}/api/org/llm-providers/${created.id}/test`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ modelId: "faux-model" }),
    });
    expect(res.status).toBe(200);
    const bodyText = await res.text();
    expect(bodyText).not.toContain(secretKey);
    const body = JSON.parse(bodyText) as TestLlmProviderResponse;
    expect(body.ok).toBe(false);
  });

  it("200s { ok: false } for a provider with no key, rather than a transport error", async () => {
    api = await bootTestApi();
    const created = await createCustomProviderWithModel(api.baseUrl);

    const res = await fetch(`${api.baseUrl}/api/org/llm-providers/${created.id}/test`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ modelId: "faux-model" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as TestLlmProviderResponse;
    expect(body.ok).toBe(false);
  });

  it("200s { ok: false } for an unknown modelId on the provider", async () => {
    api = await bootTestApi();
    const created = await createCustomProviderWithModel(api.baseUrl);
    await fetch(`${api.baseUrl}/api/org/llm-providers/${created.id}/key`, {
      method: "PUT",
      headers: HEADERS,
      body: JSON.stringify({ apiKey: "sk-custom-test-secret-9999" }),
    });

    const res = await fetch(`${api.baseUrl}/api/org/llm-providers/${created.id}/test`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ modelId: "no-such-model" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as TestLlmProviderResponse;
    expect(body.ok).toBe(false);
  });
});

describe("GET /api/org/llm-providers/openrouter/models (live ∪ registry)", () => {
  // Never let these tests hit the real openrouter.ai — every test below
  // pins VALET_OPENROUTER_MODELS_URL to a local fixture or a dead port.
  afterEach(() => {
    delete process.env.VALET_OPENROUTER_MODELS_URL;
  });

  it("403s for a non-admin org member", async () => {
    process.env.VALET_OPENROUTER_MODELS_URL = "http://127.0.0.1:9/models";
    api = await bootTestApi();
    const res = await fetch(`${api.baseUrl}/api/org/llm-providers/openrouter/models`, {
      headers: MEMBER_HEADERS,
    });
    expect(res.status).toBe(403);
  });

  it("live fetch failure degrades to the pi-ai registry (sorted, live:false)", async () => {
    process.env.VALET_OPENROUTER_MODELS_URL = "http://127.0.0.1:9/models"; // unreachable
    api = await bootTestApi();
    const res = await fetch(`${api.baseUrl}/api/org/llm-providers/openrouter/models`, {
      headers: HEADERS,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as OpenrouterRegistryResponse;
    expect(body.live).toBe(false);
    // Far more than the curated default set — this is the full registry.
    expect(body.models.length).toBeGreaterThan(100);
    const ids = body.models.map((m) => m.id);
    expect(ids).toEqual([...ids].sort((a, b) => a.localeCompare(b)));
    expect(ids).toContain("deepseek/deepseek-v4-pro");
    const entry = body.models.find((m) => m.id === "deepseek/deepseek-v4-pro");
    expect(typeof entry?.name).toBe("string");
    expect(typeof entry?.pricing?.input).toBe("number");
  });

  it("merges the LIVE catalog over the registry — brand-new models become pickable", async () => {
    const app = new Hono();
    app.get("/or-models", (c) =>
      c.json({
        data: [
          {
            id: "moonshotai/kimi-k3",
            name: "MoonshotAI: Kimi K3",
            context_length: 1_048_576,
            pricing: { prompt: "0.000003", completion: "0.000015" },
          },
          // Also present in the registry — the live entry must win.
          {
            id: "moonshotai/kimi-k2.6",
            name: "Kimi K2.6 (live)",
            context_length: 262_144,
            pricing: { prompt: "0.000001", completion: "0.000002" },
          },
        ],
      }),
    );
    const server: ServerType = serve({ fetch: app.fetch, port: 0 });
    const port = listenAddress(server);
    process.env.VALET_OPENROUTER_MODELS_URL = `http://127.0.0.1:${port}/or-models`;
    try {
      api = await bootTestApi();
      const res = await fetch(`${api.baseUrl}/api/org/llm-providers/openrouter/models`, {
        headers: HEADERS,
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as OpenrouterRegistryResponse;
      expect(body.live).toBe(true);
      const k3 = body.models.find((m) => m.id === "moonshotai/kimi-k3");
      expect(k3).toEqual({
        id: "moonshotai/kimi-k3",
        name: "MoonshotAI: Kimi K3",
        contextWindow: 1_048_576,
        pricing: { input: 3, output: 15 },
      });
      const k26 = body.models.find((m) => m.id === "moonshotai/kimi-k2.6");
      expect(k26?.name).toBe("Kimi K2.6 (live)"); // live wins over registry
      // Registry-only models are still present (merge, not replace).
      expect(body.models.some((m) => m.id === "deepseek/deepseek-v4-pro")).toBe(true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("PATCH accepts a models selection on an openrouter row", async () => {
    api = await bootTestApi();
    const createRes = await fetch(`${api.baseUrl}/api/org/llm-providers`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ kind: "openrouter", name: "OpenRouter" }),
    });
    const created = (await createRes.json()) as CreateLlmProviderResponse;
    const patchRes = await fetch(`${api.baseUrl}/api/org/llm-providers/${created.id}`, {
      method: "PATCH",
      headers: HEADERS,
      body: JSON.stringify({ models: [{ id: "moonshotai/kimi-k2.6", name: "Kimi K2.6" }] }),
    });
    expect(patchRes.status).toBe(200);
    const patched = (await patchRes.json()) as CreateLlmProviderResponse;
    expect(patched.models).toEqual([{ id: "moonshotai/kimi-k2.6", name: "Kimi K2.6" }]);
  });
});
