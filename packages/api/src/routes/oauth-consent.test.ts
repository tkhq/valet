/**
 * MCP OAuth consent: every authorization goes through Valet's consent page,
 * the client receives a code only after the person accepts, a denied code
 * cannot be exchanged, and only the signed-in browser user the code belongs
 * to can decide.
 */
import { createHash, randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { verification } from "../schema/index.js";

let api: TestApi | undefined;
afterEach(async () => {
  await api?.cleanup();
  api = undefined;
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
});
