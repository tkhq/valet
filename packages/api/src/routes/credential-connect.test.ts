/**
 * `/api/credentials/:service/connect` + `/api/credentials/oauth/callback`
 * (docs/specs/2026-07-20-integration-oauth-design.md, Task 3). Exercises
 * both OAuth declaration modes against `test-helpers/oauth-fixture.ts`'s
 * fake authorization server.
 */
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import type { ValetPlugin } from "@valet/engine";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { startFakeOAuthServer, type FakeOAuthServer } from "../test-helpers/oauth-fixture.js";
import type { ListCredentialsResponse } from "../wire/types.js";
import { verifyOAuthConnectState } from "./credential-connect.js";
import { signState } from "../lib/oauth-state.js";

let api: TestApi | undefined;
let fake: FakeOAuthServer;

function mcpPlugin(serverUrl: string): ValetPlugin {
  return {
    name: "linear",
    version: "0.1.0",
    credentials: [{ type: "oauth2", configKeys: ["accessToken"], oauth: { mode: "mcp", serverUrl } }],
  };
}
function authCodePlugin(url: string): ValetPlugin {
  return {
    name: "gmail",
    version: "0.1.0",
    credentials: [
      {
        type: "oauth2",
        configKeys: ["accessToken", "refreshToken"],
        scopes: ["scope-a"],
        oauth: {
          mode: "authorization_code",
          authorizationUrl: `${url}/authorize`,
          tokenUrl: `${url}/token`,
          clientIdEnv: "TEST_GOOGLE_ID",
          clientSecretEnv: "TEST_GOOGLE_SECRET",
          extraAuthParams: { access_type: "offline", prompt: "consent" },
        },
      },
    ],
  };
}

beforeEach(async () => {
  fake = await startFakeOAuthServer();
});
afterEach(async () => {
  await api?.cleanup();
  api = undefined;
  await fake.close();
  delete process.env.TEST_GOOGLE_ID;
  delete process.env.TEST_GOOGLE_SECRET;
});

describe("GET /api/credentials/:service/connect", () => {
  it("404s for a service with no oauth declaration", async () => {
    api = await bootTestApi({ plugins: [mcpPlugin(fake.url)] });
    const res = await fetch(`${api.baseUrl}/api/credentials/slack/connect`, { redirect: "manual" });
    expect(res.status).toBe(404);
  });

  it("mcp mode: registers a client and 302s to the authorization endpoint with PKCE + signed state", async () => {
    api = await bootTestApi({ plugins: [mcpPlugin(fake.url)] });
    const res = await fetch(`${api.baseUrl}/api/credentials/linear/connect`, { redirect: "manual" });
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location") ?? "");
    expect(location.origin + location.pathname).toBe(`${fake.url}/authorize`);
    expect(location.searchParams.get("client_id")).toBe("client-1");
    expect(location.searchParams.get("code_challenge_method")).toBe("S256");
    expect(location.searchParams.get("redirect_uri")).toContain("/api/credentials/oauth/callback");
    expect(location.searchParams.get("state")).toBeTruthy();
  });

  it("authorization_code mode: 503s with the missing env var names when unconfigured", async () => {
    api = await bootTestApi({ plugins: [authCodePlugin(fake.url)] });
    const res = await fetch(`${api.baseUrl}/api/credentials/gmail/connect`, { redirect: "manual" });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { missing?: string[] };
    expect(body.missing).toEqual(["TEST_GOOGLE_ID", "TEST_GOOGLE_SECRET"]);
  });

  it("authorization_code mode: 302s with client_id, scopes, and extraAuthParams", async () => {
    process.env.TEST_GOOGLE_ID = "gid";
    process.env.TEST_GOOGLE_SECRET = "gsecret";
    api = await bootTestApi({ plugins: [authCodePlugin(fake.url)] });
    const res = await fetch(`${api.baseUrl}/api/credentials/gmail/connect`, { redirect: "manual" });
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location") ?? "");
    expect(location.searchParams.get("client_id")).toBe("gid");
    expect(location.searchParams.get("scope")).toBe("scope-a");
    expect(location.searchParams.get("access_type")).toBe("offline");
    expect(location.searchParams.get("prompt")).toBe("consent");
    expect(location.searchParams.get("response_type")).toBe("code");
  });

  it("github is never connectable through this surface", async () => {
    api = await bootTestApi({ plugins: [] });
    const res = await fetch(`${api.baseUrl}/api/credentials/github/connect`, { redirect: "manual" });
    expect(res.status).toBe(404);
  });
});

describe("GET /api/credentials/oauth/callback", () => {
  async function startConnect(baseUrl: string, service: string): Promise<URL> {
    const res = await fetch(`${baseUrl}/api/credentials/${service}/connect`, { redirect: "manual" });
    expect(res.status).toBe(302);
    return new URL(res.headers.get("location") ?? "");
  }

  it("mcp mode: exchanges the code with the stored PKCE verifier and persists the credential", async () => {
    api = await bootTestApi({ plugins: [mcpPlugin(fake.url)] });
    const authUrl = await startConnect(api.baseUrl, "linear");
    const state = authUrl.searchParams.get("state") ?? "";

    const cb = await fetch(
      `${api.baseUrl}/api/credentials/oauth/callback?code=code-1&state=${encodeURIComponent(state)}`,
      { redirect: "manual" },
    );
    expect(cb.status).toBe(302);
    expect(cb.headers.get("location")).toBe("/integrations?connected=linear");

    // PKCE verifier from the signed state reached the token endpoint.
    expect(fake.tokenRequests[0]).toMatchObject({ grant_type: "authorization_code", code: "code-1" });
    expect(fake.tokenRequests[0]?.code_verifier).toBeTruthy();

    const list = await fetch(`${api.baseUrl}/api/credentials`);
    const { credentials } = (await list.json()) as ListCredentialsResponse;
    expect(credentials).toHaveLength(1);
    expect(credentials[0]).toMatchObject({ service: "linear", type: "oauth2" });
    expect(typeof credentials[0]?.expiresAt).toBe("number"); // expires_in: 3600 mapped
    expect(JSON.stringify(credentials)).not.toContain("at-1");
  });

  it("provider error param redirects to /integrations with the error code", async () => {
    api = await bootTestApi({ plugins: [mcpPlugin(fake.url)] });
    const authUrl = await startConnect(api.baseUrl, "linear");
    const state = authUrl.searchParams.get("state") ?? "";
    const cb = await fetch(
      `${api.baseUrl}/api/credentials/oauth/callback?error=access_denied&state=${encodeURIComponent(state)}`,
      { redirect: "manual" },
    );
    expect(cb.status).toBe(302);
    expect(cb.headers.get("location")).toBe("/integrations?error=access_denied");
  });

  it("tampered state redirects with error=oauth_state and persists nothing", async () => {
    api = await bootTestApi({ plugins: [mcpPlugin(fake.url)] });
    await startConnect(api.baseUrl, "linear");
    const cb = await fetch(`${api.baseUrl}/api/credentials/oauth/callback?code=c&state=forged.state`, {
      redirect: "manual",
    });
    expect(cb.status).toBe(302);
    expect(cb.headers.get("location")).toBe("/integrations?error=oauth_state");
    const list = await fetch(`${api.baseUrl}/api/credentials`);
    expect(((await list.json()) as ListCredentialsResponse).credentials).toHaveLength(0);
  });

  it("token-exchange failure redirects with error=oauth_failed", async () => {
    api = await bootTestApi({ plugins: [mcpPlugin(fake.url)] });
    const authUrl = await startConnect(api.baseUrl, "linear");
    const state = authUrl.searchParams.get("state") ?? "";
    fake.tokenFailure = 400;
    const cb = await fetch(
      `${api.baseUrl}/api/credentials/oauth/callback?code=bad&state=${encodeURIComponent(state)}`,
      { redirect: "manual" },
    );
    expect(cb.headers.get("location")).toBe("/integrations?error=oauth_failed");
  });

  it("state signed for a different user redirects with error=oauth_state and persists nothing for either user", async () => {
    api = await bootTestApi({ plugins: [mcpPlugin(fake.url)] });
    // Started as the default (local-user) identity.
    const authUrl = await startConnect(api.baseUrl, "linear");
    const state = authUrl.searchParams.get("state") ?? "";

    // Completed as a different authenticated user (test-member).
    const cb = await fetch(
      `${api.baseUrl}/api/credentials/oauth/callback?code=code-1&state=${encodeURIComponent(state)}`,
      { redirect: "manual", headers: { "x-valet-test-user-id": "test-member" } },
    );
    expect(cb.status).toBe(302);
    expect(cb.headers.get("location")).toBe("/integrations?error=oauth_state");

    // The mismatch must be caught before any token exchange is attempted.
    expect(fake.tokenRequests).toHaveLength(0);

    // Nothing persisted for either identity.
    const listAsStarter = await fetch(`${api.baseUrl}/api/credentials`);
    expect(((await listAsStarter.json()) as ListCredentialsResponse).credentials).toHaveLength(0);
    const listAsCompleter = await fetch(`${api.baseUrl}/api/credentials`, {
      headers: { "x-valet-test-user-id": "test-member" },
    });
    expect(((await listAsCompleter.json()) as ListCredentialsResponse).credentials).toHaveLength(0);
  });
});

describe("cross-origin return redirect (dev web origin)", () => {
  async function startConnectWithReferer(baseUrl: string, service: string, referer: string): Promise<URL> {
    const res = await fetch(`${baseUrl}/api/credentials/${service}/connect`, {
      redirect: "manual",
      headers: { referer },
    });
    expect(res.status).toBe(302);
    return new URL(res.headers.get("location") ?? "");
  }

  it("a trusted Referer origin rides the signed state and prefixes the callback redirect", async () => {
    api = await bootTestApi({ plugins: [mcpPlugin(fake.url)] });
    // The dev vite origin is always in the auth trustedOrigins allowlist.
    const authUrl = await startConnectWithReferer(api.baseUrl, "linear", "http://localhost:5173/integrations");
    const state = authUrl.searchParams.get("state") ?? "";

    const cb = await fetch(
      `${api.baseUrl}/api/credentials/oauth/callback?code=code-1&state=${encodeURIComponent(state)}`,
      { redirect: "manual" },
    );
    expect(cb.status).toBe(302);
    expect(cb.headers.get("location")).toBe("http://localhost:5173/integrations?connected=linear");
  });

  it("an untrusted Referer origin is ignored — redirect stays relative (no open redirect)", async () => {
    api = await bootTestApi({ plugins: [mcpPlugin(fake.url)] });
    const authUrl = await startConnectWithReferer(api.baseUrl, "linear", "https://evil.example/phish");
    const state = authUrl.searchParams.get("state") ?? "";

    const cb = await fetch(
      `${api.baseUrl}/api/credentials/oauth/callback?code=code-1&state=${encodeURIComponent(state)}`,
      { redirect: "manual" },
    );
    expect(cb.status).toBe(302);
    expect(cb.headers.get("location")).toBe("/integrations?connected=linear");
  });

  it("a trusted Referer also prefixes error redirects (denied consent)", async () => {
    api = await bootTestApi({ plugins: [mcpPlugin(fake.url)] });
    const authUrl = await startConnectWithReferer(api.baseUrl, "linear", "http://localhost:5173/integrations");
    const state = authUrl.searchParams.get("state") ?? "";

    const cb = await fetch(
      `${api.baseUrl}/api/credentials/oauth/callback?error=access_denied&state=${encodeURIComponent(state)}`,
      { redirect: "manual" },
    );
    expect(cb.headers.get("location")).toBe("http://localhost:5173/integrations?error=access_denied");
  });
});

describe("verifyOAuthConnectState", () => {
  const key = Buffer.from("test-key-material-32-bytes-long");

  it("accepts a validly signed, unexpired payload", () => {
    const state = signState({ userId: "u1", service: "linear", nonce: "n1", exp: Date.now() + 10_000 }, key);
    const verified = verifyOAuthConnectState(state, key, Date.now());
    expect(verified).toMatchObject({ userId: "u1", service: "linear" });
  });

  it("rejects an expired payload", () => {
    const state = signState({ userId: "u1", service: "linear", nonce: "n1", exp: Date.now() - 1000 }, key);
    expect(verifyOAuthConnectState(state, key, Date.now())).toBeNull();
  });
});
