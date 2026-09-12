import { afterEach, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { apikey, llmProxyRequests, orgMembers, teams } from "../schema/index.js";
import { createLlmProvider } from "../services/llm-providers.js";
import { setProxySettings } from "../services/org.js";


let api: TestApi | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  await api?.cleanup();
  api = undefined;
});

describe("shared team proxy key", () => {
  it("preserves org governance, records the team, survives creator departure, and rejects invalid pins and revoked keys", async () => {
    api = await bootTestApi({ auth: true });
    const { baseUrl, providers } = api;
    const signup = await fetch(`${baseUrl}/api/auth/sign-up/email`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Admin", email: "proxy-admin@example.test", password: "correct-horse-battery" }),
    });
    expect(signup.status).toBe(200);
    const cookie = signup.headers.get("set-cookie")?.match(/better-auth\.session_token=[^;]+/)?.[0];
    if (!cookie) throw new Error("Expected a signup session cookie");
    const create = await fetch(`${baseUrl}/api/teams`, {
      method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ name: "Proxy team" }),
    });
    expect(create.status).toBe(201);
    const teamBody = await create.json();
    if (!teamBody || typeof teamBody !== "object" || !("team" in teamBody)) throw new Error("Expected team response");
    const team = teamBody.team;
    if (!team || typeof team !== "object" || !("id" in team) || typeof team.id !== "string" || !("orgId" in team) || typeof team.orgId !== "string") throw new Error("Expected team identity");
    const keyResponse = await fetch(`${baseUrl}/api/teams/${team.id}/api-keys`, {
      method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ name: "Shared proxy" }),
    });
    expect(keyResponse.status).toBe(201);
    const keyBody = await keyResponse.json();
    if (!keyBody || typeof keyBody !== "object"
      || !("id" in keyBody) || typeof keyBody.id !== "string"
      || !("key" in keyBody) || typeof keyBody.key !== "string"
      || !("createdBy" in keyBody) || typeof keyBody.createdBy !== "string") throw new Error("Expected created team key");
    const key = { id: keyBody.id, key: keyBody.key, createdBy: keyBody.createdBy };
    const nativeFetch = globalThis.fetch;
    const upstream = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({
      id: "resp-team", model: "gpt-4o-mini", usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
      choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
    }), { headers: { "content-type": "application/json" } }));
    vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      return url.startsWith("https://api.openai.com/") ? upstream(input, init) : nativeFetch(input, init);
    });
    async function proxy(providerKey?: string) {
      return fetch(`${baseUrl}/proxy/openai/v1/chat/completions`, {
        method: "POST", headers: {
          "content-type": "application/json", "x-api-key": key.key,
          ...(providerKey ? { authorization: `Bearer ${providerKey}` } : {}),
        }, body: JSON.stringify({ model: "gpt-4o-mini", messages: [{ role: "user", content: "hello" }] }),
      });
    }
    await setProxySettings(providers.db, team.orgId, { enabled: false, mode: "passthrough" });
    expect((await proxy("approved-provider-key")).status).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
    await setProxySettings(providers.db, team.orgId, { enabled: true });
    expect((await proxy()).status).toBe(400);
    expect(upstream).not.toHaveBeenCalled();
    const forwarded = await proxy("approved-provider-key");
    expect(forwarded.status).toBe(200);
    await forwarded.text();
    expect(new Headers(upstream.mock.calls[0][1]?.headers).get("authorization")).toBe("Bearer approved-provider-key");
    expect(new Headers(upstream.mock.calls[0][1]?.headers).get("x-api-key")).toBeNull();
    await expect.poll(async () => providers.db.select().from(llmProxyRequests).where(eq(llmProxyRequests.apiKeyId, key.id))).toEqual([
      expect.objectContaining({ orgId: team.orgId, teamId: team.id, userId: null, totalTokens: 120 }),
    ]);
    const costs = await providers.db.execute(sql`SELECT user_id, owner_type, owner_id FROM cost_entries WHERE use_case = 'proxy'`);
    expect(costs).toMatchObject({ rows: [{ user_id: null, owner_type: "team", owner_id: team.id }] });
    const provider = await createLlmProvider(providers.db, { orgId: team.orgId, kind: "openai", name: "Org proxy" });
    await providers.engineCredentials.save({ type: "org", id: team.orgId }, `llm:${provider.id}`, { type: "api_key", apiKey: "org-provider-key" });
    await setProxySettings(providers.db, team.orgId, { mode: "centralized" });
    expect((await proxy("ignored-personal-key")).status).toBe(200);
    expect(new Headers(upstream.mock.calls.at(-1)?.[1]?.headers).get("authorization")).toBe("Bearer org-provider-key");
    // A shared key must not inherit its creating admin's governance authority.
    expect((await fetch(`${baseUrl}/api/proxy/settings`, {
      method: "PUT", headers: { "x-api-key": key.key, "content-type": "application/json" }, body: JSON.stringify({ enabled: false }),
    })).status).toBe(403);
    if (!key.createdBy) throw new Error("Expected key creator");
    await providers.db.delete(orgMembers).where(and(eq(orgMembers.orgId, team.orgId), eq(orgMembers.userId, key.createdBy)));
    expect((await proxy("approved-provider-key")).status).toBe(200);
    await providers.db.update(apikey).set({ teamId: "different-team" }).where(eq(apikey.id, key.id));
    expect((await proxy("approved-provider-key")).status).toBe(401);
    await providers.db.update(apikey).set({ teamId: team.id }).where(eq(apikey.id, key.id));
    await providers.db.delete(teams).where(eq(teams.id, team.id));
    expect((await proxy("approved-provider-key")).status).toBe(401);
    await providers.db.delete(apikey).where(eq(apikey.id, key.id));
    expect((await proxy("approved-provider-key")).status).toBe(401);
  });
});
