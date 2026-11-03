/**
 * MCP dynamic client registration through the real endpoints: registration
 * stays open, redirect URIs are checked at register and at authorize,
 * registrations are limited, and the consent page shows where the code goes.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../env.js";
import { freshTestPgDb } from "../test-helpers/pg-test-db.js";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { seedMcpConsent } from "../integration/_mcp-consent.js";
import { oauthApplication } from "../schema/index.js";
import { bootstrapAdminInviteCode } from "../test-helpers/bootstrap-admin-code.js";
import { DEFAULT_MCP_REGISTRATION } from "./config.js";
import { mcpRegisterGate } from "./mcp-registration.js";

let api: TestApi | undefined;
afterEach(async () => {
  await api?.cleanup();
  api = undefined;
  vi.unstubAllEnvs();
});

const LOOPBACK = "http://localhost:33418/callback";
const CLAUDE_APP = "claude://claude.ai/mcp-auth-callback/sdk";

async function boot(): Promise<{ testApi: TestApi; cookie: string; userId: string }> {
  const testApi = await bootTestApi({ auth: true });
  api = testApi;
  const signUp = await fetch(`${testApi.baseUrl}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Reg User", email: "reg@nowhere.test", password: "correct-horse-battery", inviteCode: await bootstrapAdminInviteCode(testApi.providers.db) }),
  });
  expect(signUp.status).toBe(200);
  const match = signUp.headers.get("set-cookie")?.match(/better-auth\.session_token=[^;]+/);
  if (!match) throw new Error("no session cookie");
  const { user } = (await signUp.json()) as { user: { id: string } };
  return { testApi, cookie: match[0], userId: user.id };
}

async function register(base: string, redirectUris: unknown, cookie?: string) {
  const res = await fetch(`${base}/api/auth/mcp/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify({ client_name: "Agent", redirect_uris: redirectUris, token_endpoint_auth_method: "none", grant_types: ["authorization_code"], response_types: ["code"] }),
  });
  const body = (await res.json()) as { client_id?: string; error?: string; error_description?: string };
  return { status: res.status, body };
}

function authorizeUrl(base: string, clientId: string, redirect: string): string {
  const challenge = createHash("sha256").update(randomBytes(32).toString("base64url")).digest("base64url");
  const q = new URLSearchParams({
    response_type: "code", client_id: clientId, redirect_uri: redirect, code_challenge: challenge,
    code_challenge_method: "S256", scope: "openid", state: "s1", prompt: "consent",
  });
  return `${base}/api/auth/mcp/authorize?${q.toString()}`;
}

describe("MCP client registration", () => {
  it("refuses the redirect URIs seen in the attack and keeps accepting valid ones without a session", async () => {
    const { testApi, cookie } = await boot();
    const attacks = [
      "*",
      "https://*",
      "https://*.evil.example/cb",
      "https://victim@evil.example/cb",
      "https://victim:pw@evil.example/cb",
      "http://evil.example/cb",
      "http://localhost@evil.example/cb",
      "javascript:alert(1)",
      "data:text/html,hi",
      "vbscript:msgbox(1)",
      "https://app.example.com/cb#frag",
      "https://app.example.com/cb,https://evil.example/cb",
      "https://intranet/cb",
      "https:///cb",
      "custom-scheme://cb",
      "claude://victim@claude.ai/cb",
      "claude:alert(1)",
      "https://app.example.com/c b",
      "/relative/cb",
    ];
    for (const uri of attacks) {
      for (const who of [undefined, cookie]) {
        const res = await register(testApi.baseUrl, [uri], who);
        expect(res.status, `${uri} ${who ? "signed in" : "anonymous"}`).toBe(400);
        expect(res.body.error).toBe("invalid_redirect_uri");
      }
    }
    expect((await testApi.providers.db.select().from(oauthApplication)).length).toBe(0);
    // Registration stays open: Claude Code (loopback), claude.ai (https),
    // and the Claude app (claude://) register before anyone signs in.
    for (const uri of ["https://claude.ai/api/mcp/auth_callback", LOOPBACK, "http://127.0.0.1:9000/cb", "http://[::1]:7777/cb", CLAUDE_APP, "cursor://anysphere.cursor-mcp/oauth/callback"]) {
      expect((await register(testApi.baseUrl, [uri])).status, uri).toBe(201);
    }
  });

  it("allows only the app schemes AUTH_MCP_APP_SCHEMES lists", async () => {
    vi.stubEnv("AUTH_MCP_APP_SCHEMES", "cursor");
    const { testApi } = await boot();
    expect((await register(testApi.baseUrl, [CLAUDE_APP])).status).toBe(400);
    expect((await register(testApi.baseUrl, ["cursor://anysphere.cursor-mcp/oauth/callback"])).status).toBe(201);
  });

  it("caps the redirect list at the default, and needs at least one URI", async () => {
    const { testApi } = await boot();
    const max = DEFAULT_MCP_REGISTRATION.maxRedirectUris;
    const many = Array.from({ length: max + 1 }, (_, i) => `http://localhost:${4000 + i}/cb`);
    expect((await register(testApi.baseUrl, many)).status).toBe(400);
    expect((await register(testApi.baseUrl, [])).status).toBe(400);
    expect((await register(testApi.baseUrl, "http://localhost:4000/cb")).status).toBe(400);
    expect((await register(testApi.baseUrl, many.slice(0, max))).status).toBe(201);
  });

  it("caps the redirect list at AUTH_MCP_MAX_REDIRECT_URIS", async () => {
    vi.stubEnv("AUTH_MCP_MAX_REDIRECT_URIS", "2");
    const { testApi } = await boot();
    expect((await register(testApi.baseUrl, [LOOPBACK, "http://localhost:4001/cb", "http://localhost:4002/cb"])).status).toBe(400);
    expect((await register(testApi.baseUrl, [LOOPBACK, "http://localhost:4001/cb"])).status).toBe(201);
  });

  it("AUTH_MCP_REGISTRATION=off refuses registration and names the fix; existing clients still authorize", async () => {
    vi.stubEnv("AUTH_MCP_REGISTRATION", "off");
    const { testApi, cookie } = await boot();
    for (const who of [undefined, cookie]) {
      const res = await register(testApi.baseUrl, [LOOPBACK], who);
      expect(res.status).toBe(403);
      expect(res.body.error_description).toMatch(/AUTH_MCP_REGISTRATION=open/);
    }
    const clientId = randomUUID();
    const now = new Date();
    await testApi.providers.db.insert(oauthApplication).values({ id: `app-${clientId}`, name: "Existing", clientId, redirectUrls: LOOPBACK, type: "public", createdAt: now, updatedAt: now });
    const res = await fetch(authorizeUrl(testApi.baseUrl, clientId, LOOPBACK), { headers: { cookie }, redirect: "manual" });
    expect(new URL(res.headers.get("location") ?? "", testApi.baseUrl).pathname).toBe("/oauth/consent");
  });

  it("refuses a body that is not JSON", async () => {
    const { testApi } = await boot();
    const res = await fetch(`${testApi.baseUrl}/api/auth/mcp/register`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ redirect_uris: "https://evil.example/cb" }),
    });
    expect(res.status).toBe(400);
  });

  it("limits registrations per address at the default", async () => {
    const { testApi } = await boot();
    for (let i = 0; i < DEFAULT_MCP_REGISTRATION.ratePerHour; i++) expect((await register(testApi.baseUrl, [LOOPBACK])).status).toBe(201);
    const over = await register(testApi.baseUrl, [LOOPBACK]);
    expect(over.status).toBe(429);
    expect(over.body.error).toBe("slow_down");
  });

  it("limits registrations per address at AUTH_MCP_REGISTRATION_RATE_PER_HOUR", async () => {
    vi.stubEnv("AUTH_MCP_REGISTRATION_RATE_PER_HOUR", "3");
    const { testApi } = await boot();
    for (let i = 0; i < 3; i++) expect((await register(testApi.baseUrl, [LOOPBACK])).status).toBe(201);
    expect((await register(testApi.baseUrl, [LOOPBACK])).status).toBe(429);
  });

  it("AUTH_MCP_REGISTRATION_RATE_PER_HOUR=0 turns the per-address limit off", async () => {
    vi.stubEnv("AUTH_MCP_REGISTRATION_RATE_PER_HOUR", "0");
    const { testApi } = await boot();
    for (let i = 0; i < DEFAULT_MCP_REGISTRATION.ratePerHour + 5; i++) expect((await register(testApi.baseUrl, [LOOPBACK])).status).toBe(201);
  });

  async function seedUnapproved(testApi: TestApi, count: number): Promise<string[]> {
    const now = new Date();
    const ids = Array.from({ length: count }, () => randomUUID());
    await testApi.providers.db.insert(oauthApplication).values(ids.map((clientId) => (
      { id: `app-${clientId}`, name: "junk", clientId, redirectUrls: LOOPBACK, type: "public", createdAt: now, updatedAt: now }
    )));
    return ids;
  }

  it("caps clients from the last day that nobody approved at the default; an approved one no longer counts", async () => {
    const { testApi, userId } = await boot();
    const ids = await seedUnapproved(testApi, DEFAULT_MCP_REGISTRATION.unconsentedCap);
    expect((await register(testApi.baseUrl, [LOOPBACK])).status).toBe(429);
    await seedMcpConsent(testApi.providers.db, userId, ids[0] ?? "");
    expect((await register(testApi.baseUrl, [LOOPBACK])).status).toBe(201);
  });

  it("caps unapproved clients at AUTH_MCP_UNCONSENTED_CLIENT_CAP, and 0 turns the cap off", async () => {
    vi.stubEnv("AUTH_MCP_UNCONSENTED_CLIENT_CAP", "4");
    const capped = await boot();
    await seedUnapproved(capped.testApi, 3);
    expect((await register(capped.testApi.baseUrl, [LOOPBACK])).status).toBe(201);
    expect((await register(capped.testApi.baseUrl, [LOOPBACK])).status).toBe(429);
    await capped.testApi.cleanup();
    api = undefined;

    vi.stubEnv("AUTH_MCP_UNCONSENTED_CLIENT_CAP", "0");
    const uncapped = await boot();
    await seedUnapproved(uncapped.testApi, DEFAULT_MCP_REGISTRATION.unconsentedCap + 5);
    expect((await register(uncapped.testApi.baseUrl, [LOOPBACK])).status).toBe(201);
  });

  it("holds the unapproved cap under a concurrent burst", async () => {
    // In process, so the requests truly overlap: the test server above
    // handles one HTTP request at a time. The slow insert stands in for
    // better-auth's handler, so admissions still in flight must count.
    // mcp-registration.postgres.test.ts covers two replicas.
    const { appDb: db } = await freshTestPgDb();
    const now = new Date();
    const insert = async () => {
      const clientId = randomUUID();
      await db.insert(oauthApplication).values({ id: `app-${clientId}`, name: "burst", clientId, redirectUrls: LOOPBACK, type: "public", createdAt: now, updatedAt: now });
    };
    await insert();
    await insert();
    const app = new Hono<AppEnv>();
    app.post("/register", mcpRegisterGate(db, { ...DEFAULT_MCP_REGISTRATION, unconsentedCap: 3, ratePerHour: 0 }), async (c) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      await insert();
      return c.json({}, 201);
    });
    const results = await Promise.all(Array.from({ length: 8 }, () => app.request("/register", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ redirect_uris: [LOOPBACK] }),
    })));
    expect(results.map((r) => r.status).sort()).toEqual([201, 429, 429, 429, 429, 429, 429, 429]);
    expect((await db.select().from(oauthApplication)).length).toBe(3);
  });

  it("refuses to authorize a client stored earlier with a wildcard or user-name redirect", async () => {
    const { testApi, cookie } = await boot();
    const now = new Date();
    for (const redirect of ["*", "https://victim@evil.example/cb"]) {
      const clientId = randomUUID();
      await testApi.providers.db.insert(oauthApplication).values({ id: `app-${clientId}`, name: "junk", clientId, redirectUrls: redirect, type: "public", createdAt: now, updatedAt: now });
      const res = await fetch(authorizeUrl(testApi.baseUrl, clientId, redirect), { headers: { cookie }, redirect: "manual" });
      expect(res.status, redirect).toBe(400);
    }
  });

  it("tells the consent page the full redirect host, port and app scheme included", async () => {
    const { testApi, cookie } = await boot();
    const cases = [
      { uri: CLAUDE_APP, origin: "claude://claude.ai", local: true },
      { uri: "https://app.example.com:8443/cb", origin: "https://app.example.com:8443", local: false },
    ];
    for (const { uri, origin, local } of cases) {
      const { body } = await register(testApi.baseUrl, [uri]);
      const res = await fetch(authorizeUrl(testApi.baseUrl, body.client_id ?? "", uri), { headers: { cookie }, redirect: "manual" });
      const landed = new URL(res.headers.get("location") ?? "", testApi.baseUrl);
      expect(landed.pathname, uri).toBe("/oauth/consent");
      const info = await fetch(`${testApi.baseUrl}/api/oauth/consent?consent_code=${encodeURIComponent(landed.searchParams.get("consent_code") ?? "")}`, { headers: { cookie } });
      expect(await info.json(), uri).toMatchObject({ redirect_origin: origin, redirect_is_local: local });
    }
  });
});
