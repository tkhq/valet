/**
 * MCP OAuth consent: every authorization goes through Valet's consent page,
 * the client receives a code only after the person accepts, a denied code
 * cannot be exchanged, and only the signed-in browser user the code belongs
 * to can decide.
 */
import { createHash, randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { oauthAccessToken, verification } from "../schema/index.js";
import { seedMcpConsent } from "../integration/_mcp-consent.js";

let api: TestApi | undefined;
afterEach(async () => {
  await api?.cleanup();
  api = undefined;
  vi.unstubAllEnvs();
});

const REDIRECT = "http://localhost:33418/callback";

function sessionCookie(setCookie: string | null): string {
  const match = setCookie?.match(/better-auth\.session_token=[^;]+/);
  if (!match) throw new Error("no session cookie");
  return match[0];
}

async function setup() {
  const testApi = await bootTestApi({ auth: true });
  api = testApi;
  const signUp = await fetch(`${testApi.baseUrl}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Consent User", email: "consent@nowhere.test", password: "correct-horse-battery" }),
  });
  expect(signUp.status).toBe(200);
  const cookie = sessionCookie(signUp.headers.get("set-cookie"));
  const reg = await fetch(`${testApi.baseUrl}/api/auth/mcp/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_name: "Test Agent", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none", grant_types: ["authorization_code"], response_types: ["code"] }),
  });
  const { client_id: clientId } = (await reg.json()) as { client_id: string };
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { testApi, cookie, clientId, verifier, challenge };
}

function authorizeUrl(base: string, clientId: string, challenge: string, extra: Record<string, string> = {}) {
  const q = new URLSearchParams({
    response_type: "code", client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge,
    code_challenge_method: "S256", scope: "openid profile email offline_access", state: "s1", ...extra,
  });
  return `${base}/api/auth/mcp/authorize?${q.toString()}`;
}

/** Follow redirects on the Valet origin until one leaves it or reaches the consent page. */
async function follow(base: string, url: string, cookie: string): Promise<URL> {
  let next = url;
  for (let i = 0; i < 5; i++) {
    const res = await fetch(next, { headers: { cookie }, redirect: "manual" });
    const location = res.headers.get("location");
    if (!location) throw new Error(`no redirect from ${next} (status ${res.status})`);
    const target = new URL(location, base);
    if (target.origin !== new URL(base).origin || target.pathname === "/oauth/consent") return target;
    next = target.toString();
  }
  throw new Error("too many redirects");
}

async function exchange(base: string, clientId: string, code: string, verifier: string) {
  return fetch(`${base}/api/auth/mcp/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier }),
  });
}

describe("MCP OAuth consent", () => {
  it("sends every authorization to the consent page, even without prompt=consent", async () => {
    const { testApi, cookie, clientId, challenge } = await setup();
    const landed = await follow(testApi.baseUrl, authorizeUrl(testApi.baseUrl, clientId, challenge), cookie);
    expect(landed.pathname).toBe("/oauth/consent");
    expect(landed.searchParams.get("consent_code")).toBeTruthy();
    // The client's redirect URI was never reached, so it holds no code.
    expect(landed.origin).toBe(new URL(testApi.baseUrl).origin);
  });

  it("treats a repeated prompt parameter as one prompt=consent, so it cannot skip the page", async () => {
    const { testApi, cookie, clientId, challenge } = await setup();
    const url = new URL(authorizeUrl(testApi.baseUrl, clientId, challenge, { prompt: "consent" }));
    url.searchParams.append("prompt", "consent");
    const landed = await follow(testApi.baseUrl, url.toString(), cookie);
    expect(landed.pathname).toBe("/oauth/consent");
    expect(landed.origin).toBe(new URL(testApi.baseUrl).origin);
  });

  it("refuses to exchange a code the person did not accept on the consent page", async () => {
    const { testApi, cookie, clientId, verifier, challenge } = await setup();
    const landed = await follow(testApi.baseUrl, authorizeUrl(testApi.baseUrl, clientId, challenge), cookie);
    const code = landed.searchParams.get("consent_code") ?? "";
    const refused = await exchange(testApi.baseUrl, clientId, code, verifier);
    expect(refused.status).toBe(400);
    expect(await refused.text()).toContain("not approved on the Valet consent page");
  });

  it("refuses a token request whose content type would make the gate and better-auth read different bodies", async () => {
    const { testApi, cookie, clientId, verifier, challenge } = await setup();
    const landed = await follow(testApi.baseUrl, authorizeUrl(testApi.baseUrl, clientId, challenge), cookie);
    const code = landed.searchParams.get("consent_code") ?? "";
    // The reviewer's repro: a body that is valid JSON (a refresh grant, which
    // skips the consent check) and also a valid form (a code exchange). The
    // old gate read the JSON; better-auth reads the form.
    const form = new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier }).toString();
    const both = `{"grant_type":"refresh_token","pad":"&${form}&z="}`;
    expect(JSON.parse(both)).toMatchObject({ grant_type: "refresh_token" });
    expect(new URLSearchParams(both).get("grant_type")).toBe("authorization_code");
    const smuggled = await fetch(`${testApi.baseUrl}/api/auth/mcp/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded; charset=application/json" },
      body: both,
    });
    expect(smuggled.status).toBe(400);
    expect(await smuggled.text()).toContain("not approved on the Valet consent page");
    const plain = await fetch(`${testApi.baseUrl}/api/auth/mcp/token`, { method: "POST", headers: { "Content-Type": "text/plain" }, body: `grant_type=authorization_code&code=${code}` });
    expect(plain.status).toBe(400);
  });

  it("shows who is asking, then hands the code to the client only after acceptance", async () => {
    const { testApi, cookie, clientId, verifier, challenge } = await setup();
    const landed = await follow(testApi.baseUrl, authorizeUrl(testApi.baseUrl, clientId, challenge), cookie);
    const code = landed.searchParams.get("consent_code") ?? "";

    const info = await fetch(`${testApi.baseUrl}/api/oauth/consent?consent_code=${encodeURIComponent(code)}`, { headers: { cookie } });
    expect(info.status).toBe(200);
    expect(await info.json()).toMatchObject({ client_name: "Test Agent", redirect_origin: "http://localhost:33418", redirect_is_local: true, account: "consent@nowhere.test" });

    const accepted = await fetch(`${testApi.baseUrl}/api/oauth/consent`, {
      method: "POST", headers: { cookie, "Content-Type": "application/json", Origin: new URL(testApi.baseUrl).origin },
      body: JSON.stringify({ consent_code: code, accept: true }),
    });
    expect(accepted.status).toBe(200);
    const redirect = new URL(((await accepted.json()) as { redirect: string }).redirect);
    expect(`${redirect.origin}${redirect.pathname}`).toBe(REDIRECT);
    expect(redirect.searchParams.get("state")).toBe("s1");
    const token = await exchange(testApi.baseUrl, clientId, redirect.searchParams.get("code") ?? "", verifier);
    expect(token.status).toBe(200);
    expect(((await token.json()) as { access_token?: string }).access_token).toBeTruthy();
  });

  it("deletes a denied code so it cannot be exchanged", async () => {
    const { testApi, cookie, clientId, verifier, challenge } = await setup();
    const landed = await follow(testApi.baseUrl, authorizeUrl(testApi.baseUrl, clientId, challenge), cookie);
    const code = landed.searchParams.get("consent_code") ?? "";
    const denied = await fetch(`${testApi.baseUrl}/api/oauth/consent`, {
      method: "POST", headers: { cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ consent_code: code, accept: false }),
    });
    const redirect = new URL(((await denied.json()) as { redirect: string }).redirect);
    expect(redirect.searchParams.get("error")).toBe("access_denied");
    expect(redirect.searchParams.get("code")).toBeNull();
    expect((await exchange(testApi.baseUrl, clientId, code, verifier)).status).not.toBe(200);
  });

  it("sends a signed-out authorization to login with next, and resumes it after sign-in", async () => {
    const { testApi, clientId, challenge } = await setup();
    const signedOut = await fetch(authorizeUrl(testApi.baseUrl, clientId, challenge, { prompt: "consent" }), { redirect: "manual" });
    const login = new URL(signedOut.headers.get("location") ?? "", testApi.baseUrl);
    expect(login.pathname).toBe("/login");
    const next = login.searchParams.get("next") ?? "";
    expect(next.startsWith("/api/auth/mcp/authorize?")).toBe(true);
    expect(new URLSearchParams(next.split("?")[1]).get("prompt")).toBe("consent");
    // The login page loads `next` after sign-in. With a session, it reaches consent.
    const signIn = await fetch(`${testApi.baseUrl}/api/auth/sign-in/email`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "consent@nowhere.test", password: "correct-horse-battery" }),
    });
    const fresh = sessionCookie(signIn.headers.get("set-cookie"));
    const landed = await follow(testApi.baseUrl, `${testApi.baseUrl}${next}`, fresh);
    expect(landed.pathname).toBe("/oauth/consent");
  });

  it("accepts a decision posted from the public HTTPS origin behind a TLS-terminating proxy", async () => {
    // Production: the browser is on https://valet.example.com, the server
    // listens on plain http behind the ingress.
    vi.stubEnv("VALET_PUBLIC_URL", "https://valet.example.com");
    const { testApi, cookie, clientId, challenge } = await setup();
    const landed = await follow(testApi.baseUrl, authorizeUrl(testApi.baseUrl, clientId, challenge), cookie);
    const code = landed.searchParams.get("consent_code") ?? "";
    const res = await fetch(`${testApi.baseUrl}/api/oauth/consent`, {
      method: "POST", headers: { cookie, "Content-Type": "application/json", Origin: "https://valet.example.com" },
      body: JSON.stringify({ consent_code: code, accept: true }),
    });
    expect(res.status).toBe(200);
    expect(new URL(((await res.json()) as { redirect: string }).redirect).searchParams.get("code")).toBeTruthy();
  });

  it("refuses a code issued to another user, an API key caller, and a foreign origin", async () => {
    const { testApi, cookie } = await setup();
    await testApi.providers.db.insert(verification).values({
      id: "v-other", identifier: "code-for-someone-else", expiresAt: new Date(Date.now() + 600_000),
      value: JSON.stringify({ clientId: "c", redirectURI: REDIRECT, scope: [], userId: "someone-else", state: null }),
    });
    expect((await fetch(`${testApi.baseUrl}/api/oauth/consent?consent_code=code-for-someone-else`, { headers: { cookie } })).status).toBe(404);

    const keyRes = await fetch(`${testApi.baseUrl}/api/auth/api-key/create`, {
      method: "POST", headers: { cookie, "Content-Type": "application/json" }, body: JSON.stringify({ name: "k" }),
    });
    const { key } = (await keyRes.json()) as { key: string };
    const viaKey = await fetch(`${testApi.baseUrl}/api/oauth/consent?consent_code=anything`, { headers: { "x-api-key": key } });
    expect(viaKey.status).toBe(403);

    const foreign = await fetch(`${testApi.baseUrl}/api/oauth/consent`, {
      method: "POST", headers: { cookie, "Content-Type": "application/json", Origin: "https://evil.example" },
      body: JSON.stringify({ consent_code: "code-for-someone-else", accept: true }),
    });
    expect(foreign.status).toBe(403);
  });

  it("refuses an MCP token issued without consent, such as one from before the consent page", async () => {
    const { testApi, cookie } = await setup();
    const me = (await (await fetch(`${testApi.baseUrl}/api/me`, { headers: { cookie } })).json()) as { id: string };
    const now = Date.now();
    const seedToken = (token: string, clientId: string) => testApi.providers.db.insert(oauthAccessToken).values({
      id: `tok-${token}`, accessToken: token, refreshToken: `r-${token}`, clientId, userId: me.id, scopes: "openid",
      accessTokenExpiresAt: new Date(now + 600_000), refreshTokenExpiresAt: new Date(now + 3_600_000), createdAt: new Date(now), updatedAt: new Date(now),
    });
    const whoami = (token: string) => fetch(`${testApi.baseUrl}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "whoami", arguments: {} } }),
    });
    // An app the person never approved: a valid token alone is refused.
    const { oauthApplication } = await import("../schema/index.js");
    await testApi.providers.db.insert(oauthApplication).values({ id: "app-old", name: "Old Agent", clientId: "old-client-2", type: "public", createdAt: new Date(now), updatedAt: new Date(now) });
    await seedToken("pre-consent", "old-client-2");
    const refused = await whoami("pre-consent");
    expect(refused.status).toBe(401);
    expect(refused.headers.get("www-authenticate")).toContain("resource_metadata");
    // With a consent record, the same kind of token works.
    await seedMcpConsent(testApi.providers.db, me.id, "approved-client");
    await seedToken("approved", "approved-client");
    expect((await whoami("approved")).status).toBe(200);
  });
});
