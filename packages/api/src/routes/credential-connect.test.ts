/**
 * `/api/credentials/:service/connect` + `/api/credentials/oauth/callback`
 * (docs/specs/2026-07-20-integration-oauth-design.md, Task 3). Exercises
 * both OAuth declaration modes against `test-helpers/oauth-fixture.ts`'s
 * fake authorization server.
 */
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import type { ValetPlugin } from "@valet/engine";
import { OAuthInterpretError, type TokenInterpretation } from "@valet/engine";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { startFakeOAuthServer, type FakeOAuthServer } from "../test-helpers/oauth-fixture.js";
import type { ListCredentialsResponse } from "../wire/types.js";
import { verifyOAuthConnectState } from "./credential-connect.js";
import { signState } from "../lib/oauth-state.js";
import {
  identityForExternal,
  identityForUser,
  linkIdentity,
  setNotifyAttention,
} from "../channels/identity-links.js";

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

function slackishPlugin(url: string): ValetPlugin {
  return {
    name: "slackish",
    version: "0.0.1",
    credentials: [
      {
        type: "oauth2",
        configKeys: ["accessToken"],
        scopes: ["chat:write", "search:read"],
        oauth: {
          mode: "authorization_code" as const,
          authorizationUrl: "https://slack.test/authorize",
          tokenUrl: `${url}/token`,
          clientIdEnv: "SLACKISH_ID",
          clientSecretEnv: "SLACKISH_SECRET",
          scopesParam: "user_scope",
          interpretTokenResponse: (raw: unknown): TokenInterpretation => {
            const r = raw as {
              ok?: boolean;
              authed_user?: { id?: string; access_token?: string; scope?: string };
            };
            if (!r.ok || typeof r.authed_user?.access_token !== "string") {
              throw new OAuthInterpretError(
                "Slack returned no user token. Reinstall the Slack app, then connect again.",
              );
            }
            return {
              accessToken: r.authed_user.access_token,
              grantedScopes: r.authed_user.scope?.split(",") ?? [],
              metadata: { slack_user_id: r.authed_user.id ?? "" },
              identity: { provider: "slack", externalId: r.authed_user.id ?? "" },
            };
          },
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
  delete process.env.SLACKISH_ID;
  delete process.env.SLACKISH_SECRET;
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
    const body = (await res.json()) as { missing?: string[]; fix?: string };
    expect(body.missing).toEqual(["TEST_GOOGLE_ID", "TEST_GOOGLE_SECRET"]);
    expect(body.fix).toMatch(/restart the server/);
  });

  /**
   * The variable names go to a caller who can set them, the audience rule
   * `/api/plugins` applies to `missingEnv`. `local-user` holds
   * `org_members.role = "admin"` in the harness (the test above);
   * `test-member` holds `"member"` and selects itself through the
   * `x-valet-test-user-id` impersonation header.
   */
  it("authorization_code mode: names no variable to a plain member, and still names the fix", async () => {
    api = await bootTestApi({ plugins: [authCodePlugin(fake.url)] });
    const res = await fetch(`${api.baseUrl}/api/credentials/gmail/connect`, {
      redirect: "manual",
      headers: { "x-valet-test-user-id": "test-member" },
    });
    expect(res.status).toBe(503);
    const raw = await res.text();
    expect(raw).not.toContain("TEST_GOOGLE_ID");
    expect(raw).not.toContain("TEST_GOOGLE_SECRET");
    const body = JSON.parse(raw) as { error?: string; missing?: string[]; fix?: string };
    expect(body.error).toBe("oauth not configured");
    expect(body.missing).toBeUndefined();
    expect(body.fix).toMatch(/Ask an org admin/);
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

  it("authorization_code mode: scopesParam replaces 'scope' key and has no 'scope=' param", async () => {
    process.env.SLACKISH_ID = "slack-id";
    process.env.SLACKISH_SECRET = "slack-secret";
    api = await bootTestApi({ plugins: [slackishPlugin(fake.url)] });
    const res = await fetch(`${api.baseUrl}/api/credentials/slackish/connect`, { redirect: "manual" });
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location") ?? "");
    expect(location.searchParams.get("user_scope")).toBe("chat:write search:read");
    expect(location.searchParams.has("scope")).toBe(false);
    expect(location.searchParams.get("client_id")).toBe("slack-id");
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

  it("interpretTokenResponse: saves credential with interpreter fields and redirects to connected", async () => {
    process.env.SLACKISH_ID = "slack-id";
    process.env.SLACKISH_SECRET = "slack-secret";
    api = await bootTestApi({ plugins: [slackishPlugin(fake.url)] });
    fake.tokenResponse = { ok: true, authed_user: { id: "U9", access_token: "xoxp-9", scope: "chat:write,search:read" } };

    const authUrl = await startConnect(api.baseUrl, "slackish");
    const state = authUrl.searchParams.get("state") ?? "";

    const cb = await fetch(
      `${api.baseUrl}/api/credentials/oauth/callback?code=code-1&state=${encodeURIComponent(state)}`,
      { redirect: "manual" },
    );
    expect(cb.status).toBe(302);
    expect(cb.headers.get("location")).toBe("/integrations?connected=slackish");

    const stored = await api.providers.engineCredentials.get({ type: "user", id: "local-user" }, "slackish");
    expect(stored).not.toBeNull();
    expect(stored?.accessToken).toBe("xoxp-9");
    expect(stored?.scopes).toEqual(["chat:write", "search:read"]);
    expect(stored?.metadata?.["slack_user_id"]).toBe("U9");
  });

  it("interpretTokenResponse: interpreter error redirects to error=oauth_failed with no credential saved", async () => {
    process.env.SLACKISH_ID = "slack-id";
    process.env.SLACKISH_SECRET = "slack-secret";
    api = await bootTestApi({ plugins: [slackishPlugin(fake.url)] });
    fake.tokenResponse = { ok: false, error: "access_denied" };

    const authUrl = await startConnect(api.baseUrl, "slackish");
    const state = authUrl.searchParams.get("state") ?? "";

    const cb = await fetch(
      `${api.baseUrl}/api/credentials/oauth/callback?code=code-1&state=${encodeURIComponent(state)}`,
      { redirect: "manual" },
    );
    expect(cb.status).toBe(302);
    expect(cb.headers.get("location")).toBe("/integrations?error=oauth_failed");

    const stored = await api.providers.engineCredentials.get({ type: "user", id: "local-user" }, "slackish");
    expect(stored).toBeNull();
  });

  it("standard authorization_code path (no interpretTokenResponse) still works end to end", async () => {
    process.env.TEST_GOOGLE_ID = "gid";
    process.env.TEST_GOOGLE_SECRET = "gsecret";
    api = await bootTestApi({ plugins: [authCodePlugin(fake.url)] });

    const authUrl = await startConnect(api.baseUrl, "gmail");
    const state = authUrl.searchParams.get("state") ?? "";

    const cb = await fetch(
      `${api.baseUrl}/api/credentials/oauth/callback?code=code-1&state=${encodeURIComponent(state)}`,
      { redirect: "manual" },
    );
    expect(cb.status).toBe(302);
    expect(cb.headers.get("location")).toBe("/integrations?connected=gmail");

    const stored = await api.providers.engineCredentials.get({ type: "user", id: "local-user" }, "gmail");
    expect(stored).not.toBeNull();
    expect(stored?.accessToken).toBe("at-1");
    expect(stored?.scopes).toEqual(["scope-a"]);
    expect(stored?.metadata?.["connectedVia"]).toBe("oauth");
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

describe("identity auto-link (slackish plugin)", () => {
  async function startSlackishCallback(baseUrl: string, fakeUrl: string): Promise<{ state: string }> {
    process.env.SLACKISH_ID = "slack-id";
    process.env.SLACKISH_SECRET = "slack-secret";
    const res = await fetch(`${baseUrl}/api/credentials/slackish/connect`, { redirect: "manual" });
    expect(res.status).toBe(302);
    const authUrl = new URL(res.headers.get("location") ?? "");
    const state = authUrl.searchParams.get("state") ?? "";
    return { state };
  }

  it("auto-link on success: writes a user_identity_links row after a successful connect", async () => {
    api = await bootTestApi({ plugins: [slackishPlugin(fake.url)] });
    fake.tokenResponse = {
      ok: true,
      authed_user: { id: "U9", access_token: "xoxp-9", scope: "chat:write,search:read" },
    };

    const { state } = await startSlackishCallback(api.baseUrl, fake.url);

    const cb = await fetch(
      `${api.baseUrl}/api/credentials/oauth/callback?code=code-1&state=${encodeURIComponent(state)}`,
      { redirect: "manual" },
    );
    expect(cb.status).toBe(302);
    expect(cb.headers.get("location")).toBe("/integrations?connected=slackish");

    const link = await identityForExternal(api.providers.db, "slack", "U9");
    expect(link).not.toBeNull();
    expect(link?.userId).toBe("local-user");
  });

  it("cross-user conflict: redirects to error=identity_conflict and saves no credential", async () => {
    api = await bootTestApi({ plugins: [slackishPlugin(fake.url)] });
    // Seed a link for U9 to a DIFFERENT user.
    await linkIdentity(api.providers.db, { provider: "slack", externalId: "U9", userId: "test-member" });

    fake.tokenResponse = {
      ok: true,
      authed_user: { id: "U9", access_token: "xoxp-9", scope: "chat:write,search:read" },
    };

    const { state } = await startSlackishCallback(api.baseUrl, fake.url);

    const cb = await fetch(
      `${api.baseUrl}/api/credentials/oauth/callback?code=code-1&state=${encodeURIComponent(state)}`,
      { redirect: "manual" },
    );
    expect(cb.status).toBe(302);
    expect(cb.headers.get("location")).toBe("/integrations?error=identity_conflict");

    // No credential saved.
    const stored = await api.providers.engineCredentials.get({ type: "user", id: "local-user" }, "slackish");
    expect(stored).toBeNull();

    // Existing link is untouched — still points to the original user.
    const link = await identityForExternal(api.providers.db, "slack", "U9");
    expect(link?.userId).toBe("test-member");
  });

  it("same-user reconnect: succeeds and credential is saved, link remains present", async () => {
    api = await bootTestApi({ plugins: [slackishPlugin(fake.url)] });
    // Seed a link for U9 to the SAME user who will complete the callback.
    await linkIdentity(api.providers.db, { provider: "slack", externalId: "U9", userId: "local-user" });

    fake.tokenResponse = {
      ok: true,
      authed_user: { id: "U9", access_token: "xoxp-reconnect", scope: "chat:write,search:read" },
    };

    const { state } = await startSlackishCallback(api.baseUrl, fake.url);

    const cb = await fetch(
      `${api.baseUrl}/api/credentials/oauth/callback?code=code-1&state=${encodeURIComponent(state)}`,
      { redirect: "manual" },
    );
    expect(cb.status).toBe(302);
    expect(cb.headers.get("location")).toBe("/integrations?connected=slackish");

    // Credential is saved.
    const stored = await api.providers.engineCredentials.get({ type: "user", id: "local-user" }, "slackish");
    expect(stored).not.toBeNull();

    // Link is still present.
    const link = await identityForExternal(api.providers.db, "slack", "U9");
    expect(link?.userId).toBe("local-user");
  });

  it("same-user reconnect: preserves notifyAttention=false from the prior link", async () => {
    api = await bootTestApi({ plugins: [slackishPlugin(fake.url)] });
    // Seed a link with notifyAttention=false.
    await linkIdentity(api.providers.db, { provider: "slack", externalId: "U9", userId: "local-user" });
    await setNotifyAttention(api.providers.db, "slack", "local-user", false);

    fake.tokenResponse = {
      ok: true,
      authed_user: { id: "U9", access_token: "xoxp-reconnect2", scope: "chat:write,search:read" },
    };

    const { state } = await startSlackishCallback(api.baseUrl, fake.url);

    const cb = await fetch(
      `${api.baseUrl}/api/credentials/oauth/callback?code=code-1&state=${encodeURIComponent(state)}`,
      { redirect: "manual" },
    );
    expect(cb.status).toBe(302);
    expect(cb.headers.get("location")).toBe("/integrations?connected=slackish");

    // notifyAttention must still be false after reconnect.
    const link = await identityForUser(api.providers.db, "slack", "local-user");
    expect(link).not.toBeNull();
    expect(link?.notifyAttention).toBe(false);
  });

  it("compensation: when credential save throws, the new identity link is removed", async () => {
    api = await bootTestApi({ plugins: [slackishPlugin(fake.url)] });

    // Intercept save to throw.
    const origSave = api.providers.engineCredentials.save.bind(api.providers.engineCredentials);
    let threw = false;
    api.providers.engineCredentials.save = async (...args) => {
      if (!threw) {
        threw = true;
        throw new Error("simulated credential save failure");
      }
      return origSave(...args);
    };

    fake.tokenResponse = {
      ok: true,
      authed_user: { id: "U9", access_token: "xoxp-comp", scope: "chat:write,search:read" },
    };

    const { state } = await startSlackishCallback(api.baseUrl, fake.url);

    const cb = await fetch(
      `${api.baseUrl}/api/credentials/oauth/callback?code=code-1&state=${encodeURIComponent(state)}`,
      { redirect: "manual" },
    );
    expect(cb.status).toBe(302);
    expect(cb.headers.get("location")).toBe("/integrations?error=oauth_failed");

    // No link row should remain — compensation unlinkIdentity ran.
    const link = await identityForExternal(api.providers.db, "slack", "U9");
    expect(link).toBeNull();
  });

  it("compensation (same-user reconnect): save throws → error=oauth_failed and pre-existing link is preserved", async () => {
    api = await bootTestApi({ plugins: [slackishPlugin(fake.url)] });
    // Seed the same user + same externalId as the flow will produce.
    await linkIdentity(api.providers.db, { provider: "slack", externalId: "U9", userId: "local-user" });

    // Intercept save to throw once.
    const origSave = api.providers.engineCredentials.save.bind(api.providers.engineCredentials);
    let threw = false;
    api.providers.engineCredentials.save = async (...args) => {
      if (!threw) {
        threw = true;
        throw new Error("simulated credential save failure");
      }
      return origSave(...args);
    };

    fake.tokenResponse = {
      ok: true,
      authed_user: { id: "U9", access_token: "xoxp-reconnect-fail", scope: "chat:write,search:read" },
    };

    const { state } = await startSlackishCallback(api.baseUrl, fake.url);

    const cb = await fetch(
      `${api.baseUrl}/api/credentials/oauth/callback?code=code-1&state=${encodeURIComponent(state)}`,
      { redirect: "manual" },
    );
    expect(cb.status).toBe(302);
    expect(cb.headers.get("location")).toBe("/integrations?error=oauth_failed");

    // Link must still be present — it was pre-existing and compensation restores it.
    const link = await identityForExternal(api.providers.db, "slack", "U9");
    expect(link).not.toBeNull();
    expect(link?.userId).toBe("local-user");
  });

  it("compensation (prior different externalId): save throws → pre-existing link restored, new one removed", async () => {
    api = await bootTestApi({ plugins: [slackishPlugin(fake.url)] });
    // Seed the user with a different externalId ("U-OLD") linked before the flow.
    await linkIdentity(api.providers.db, { provider: "slack", externalId: "U-OLD", userId: "local-user" });

    // Intercept save to throw once.
    const origSave = api.providers.engineCredentials.save.bind(api.providers.engineCredentials);
    let threw = false;
    api.providers.engineCredentials.save = async (...args) => {
      if (!threw) {
        threw = true;
        throw new Error("simulated credential save failure");
      }
      return origSave(...args);
    };

    // Callback returns externalId "U9" — different from the seeded "U-OLD".
    fake.tokenResponse = {
      ok: true,
      authed_user: { id: "U9", access_token: "xoxp-restore", scope: "chat:write,search:read" },
    };

    const { state } = await startSlackishCallback(api.baseUrl, fake.url);

    const cb = await fetch(
      `${api.baseUrl}/api/credentials/oauth/callback?code=code-1&state=${encodeURIComponent(state)}`,
      { redirect: "manual" },
    );
    expect(cb.status).toBe(302);
    expect(cb.headers.get("location")).toBe("/integrations?error=oauth_failed");

    // "U-OLD" must be restored — compensation ran linkIdentity with the prior externalId.
    const oldLink = await identityForExternal(api.providers.db, "slack", "U-OLD");
    expect(oldLink).not.toBeNull();
    expect(oldLink?.userId).toBe("local-user");

    // "U9" must NOT be linked — it was the new link that compensation undid.
    const newLink = await identityForExternal(api.providers.db, "slack", "U9");
    expect(newLink).toBeNull();
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
