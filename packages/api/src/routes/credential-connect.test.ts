/**
 * `/api/credentials/:service/connect` + `/api/credentials/oauth/callback`
 * (docs/specs/2026-07-20-integration-oauth-design.md, Task 3). Exercises
 * both OAuth declaration modes against `test-helpers/oauth-fixture.ts`'s
 * fake authorization server.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { createHmac, randomUUID } from "node:crypto";
import { Pool } from "pg";
import type { StoredCredential, ValetPlugin } from "@valet/engine";
import { OAuthInterpretError, type TokenInterpretation } from "@valet/engine";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { startFakeOAuthServer, type FakeOAuthServer } from "../test-helpers/oauth-fixture.js";
import type { ListCredentialsResponse } from "../wire/types.js";
import { parseAddScopes, verifyOAuthConnectState } from "./credential-connect.js";
import { createTeam, addMember, removeMember, setRole, deleteTeam } from "../services/teams.js";
import { and, eq } from "drizzle-orm";
import { teams, credentials, orgMembers, mcpOauthClients, agentSessions } from "../schema/index.js";
import { signState } from "../lib/oauth-state.js";
import { deriveSecretKey } from "../lib/secret-crypto.js";
import { buildAppDb } from "../lib/drizzle.js";
import { insertCredentialIfAbsent, lockTeamCredentialRole } from "../services/credential-insert.js";
import {
  identityForExternal,
  identityForUser,
  linkIdentity,
  setNotifyAttention,
} from "../channels/identity-links.js";

let api: TestApi | undefined;
let fake: FakeOAuthServer;

function mcpPlugin(serverUrl: string, scopes?: string[]): ValetPlugin {
  return {
    name: "linear",
    version: "0.1.0",
    credentials: [
      {
        type: "oauth2",
        ...(scopes ? { scopes } : {}),
        configKeys: ["accessToken"],
        oauth: { mode: "mcp", serverUrl },
      },
    ],
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

  it("mcp mode: the authorize request names only the declared scopes", async () => {
    // The server advertises more, but Valet never grants a scope the entry
    // does not declare.
    fake.resourceScopesSupported = ["agent:content:read", "agent:query:run"];
    api = await bootTestApi({ plugins: [mcpPlugin(fake.url, ["agent:query:run", "agent:search"])] });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const res = await fetch(`${api.baseUrl}/api/credentials/linear/connect`, { redirect: "manual" });
      expect(res.status).toBe(302);
      const location = new URL(res.headers.get("location") ?? "");
      expect(location.searchParams.get("scope")).toBe("agent:query:run agent:search");
    } finally {
      warn.mockRestore();
    }
  });

  it("step-up: the authorize request asks for the declared scopes plus the added ones", async () => {
    api = await bootTestApi({ plugins: [mcpPlugin(fake.url, ["agent:query:run"])] });
    const res = await fetch(`${api.baseUrl}/api/credentials/linear/connect?addScopes=agent%3Acontent%3Aread+agent%3Aquery%3Arun`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get("location") ?? "").searchParams.get("scope")).toBe("agent:content:read agent:query:run");
  });

  it("step-up: refuses malformed scopes and a session the caller does not own", async () => {
    api = await bootTestApi({ plugins: [mcpPlugin(fake.url, ["read"])] });
    const bad = await fetch(`${api.baseUrl}/api/credentials/linear/connect?addScopes=${encodeURIComponent('read "quoted"')}`, { redirect: "manual" });
    expect(bad.status).toBe(400);
    await api.providers.db.insert(agentSessions).values({ id: "someone-else", userId: "test-member", orgId: "local-org",
      ownerType: "user", ownerId: "test-member", workspace: "w", createdAt: 1, updatedAt: 1 });
    const foreign = await fetch(`${api.baseUrl}/api/credentials/linear/connect?addScopes=write&session=someone-else`, { redirect: "manual" });
    expect(foreign.status).toBe(404);
    expect(parseAddScopes(" b a  b ")).toEqual(["a", "b"]);
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
  async function startConnect(baseUrl: string, service: string, query = ""): Promise<URL> {
    const res = await fetch(`${baseUrl}/api/credentials/${service}/connect${query}`, { redirect: "manual" });
    expect(res.status).toBe(302);
    return new URL(res.headers.get("location") ?? "");
  }

  // Integrations holds every connection, so an old link that still asks
  // for Connected accounts lands there too.
  it("lands a connect on Integrations even when an old link names Connected accounts", async () => {
    api = await bootTestApi({ plugins: [mcpPlugin(fake.url)] });
    const state = (await startConnect(api.baseUrl, "linear", "?landing=connected-accounts")).searchParams.get("state") ?? "";

    const ok = await fetch(`${api.baseUrl}/api/credentials/oauth/callback?code=code-1&state=${encodeURIComponent(state)}`, { redirect: "manual" });
    expect(ok.headers.get("location")).toBe("/integrations?connected=linear");

    const state2 = (await startConnect(api.baseUrl, "linear", "?landing=connected-accounts")).searchParams.get("state") ?? "";
    const failed = await fetch(`${api.baseUrl}/api/credentials/oauth/callback?error=access_denied&state=${encodeURIComponent(state2)}`, { redirect: "manual" });
    expect(failed.headers.get("location")).toBe("/integrations?error=access_denied");
  });

  it("ignores a landing parameter, so a link cannot steer the callback", async () => {
    api = await bootTestApi({ plugins: [mcpPlugin(fake.url)] });
    const state = (await startConnect(api.baseUrl, "linear", "?landing=https://evil.example")).searchParams.get("state") ?? "";
    const ok = await fetch(`${api.baseUrl}/api/credentials/oauth/callback?code=code-1&state=${encodeURIComponent(state)}`, { redirect: "manual" });
    expect(ok.headers.get("location")).toBe("/integrations?connected=linear");
  });

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

  it("mcp mode: stores the scopes the token response grants, not the declared list", async () => {
    api = await bootTestApi({ plugins: [mcpPlugin(fake.url, ["agent:query", "agent:search", "agent:extra"])] });
    fake.tokenResponse = { access_token: "at-1", expires_in: 3600, scope: "agent:query agent:search" };
    const authUrl = await startConnect(api.baseUrl, "linear");
    const state = authUrl.searchParams.get("state") ?? "";

    await fetch(`${api.baseUrl}/api/credentials/oauth/callback?code=c&state=${encodeURIComponent(state)}`, {
      redirect: "manual",
    });

    const stored = await api.providers.engineCredentials.get({ type: "user", id: "local-user" }, "linear");
    expect(stored?.scopes).toEqual(["agent:query", "agent:search"]);
  });

  it("mcp mode: an empty scope grant stores an empty scopes list, not the declared one", async () => {
    // Metabase returns scope: "" for a zero-scope token — the credential must
    // record that honestly instead of the declared list masking the failure.
    api = await bootTestApi({ plugins: [mcpPlugin(fake.url, ["agent:query"])] });
    fake.tokenResponse = { access_token: "at-1", expires_in: 3600, scope: "" };
    const authUrl = await startConnect(api.baseUrl, "linear");
    const state = authUrl.searchParams.get("state") ?? "";

    await fetch(`${api.baseUrl}/api/credentials/oauth/callback?code=c&state=${encodeURIComponent(state)}`, {
      redirect: "manual",
    });

    const stored = await api.providers.engineCredentials.get({ type: "user", id: "local-user" }, "linear");
    expect(stored?.scopes).toEqual([]);
  });

  it("mcp mode: a token response without scope falls back to the declared list", async () => {
    api = await bootTestApi({ plugins: [mcpPlugin(fake.url, ["agent:query"])] });
    const authUrl = await startConnect(api.baseUrl, "linear");
    const state = authUrl.searchParams.get("state") ?? "";

    await fetch(`${api.baseUrl}/api/credentials/oauth/callback?code=c&state=${encodeURIComponent(state)}`, {
      redirect: "manual",
    });

    const stored = await api.providers.engineCredentials.get({ type: "user", id: "local-user" }, "linear");
    expect(stored?.scopes).toEqual(["agent:query"]);
  });

  it("mcp mode: the callback refuses a code when another connect replaced the client", async () => {
    api = await bootTestApi({ plugins: [mcpPlugin(fake.url, ["agent:query:run"])] });
    const first = (await startConnect(api.baseUrl, "linear")).searchParams.get("state") ?? "";

    // Another connect re-registered the client after this authorize.
    await api.providers.db
      .update(mcpOauthClients)
      .set({ clientId: "client-2" })
      .where(eq(mcpOauthClients.service, "linear"));

    const cb = await fetch(`${api.baseUrl}/api/credentials/oauth/callback?code=c&state=${encodeURIComponent(first)}`, {
      redirect: "manual",
    });
    expect(cb.headers.get("location")).toBe("/integrations?error=oauth_client_changed");
    expect(fake.tokenRequests).toHaveLength(0);
  });

  it("mcp mode: a state minted before client binding still completes", async () => {
    api = await bootTestApi({ plugins: [mcpPlugin(fake.url)] });
    const key = deriveSecretKey(api.providers.encryptionKey);
    const minted = (await startConnect(api.baseUrl, "linear")).searchParams.get("state") ?? "";
    const verified = verifyOAuthConnectState(minted, key, Date.now());
    if (!verified) throw new Error("connect state did not verify");
    // A connect started before this deploy signed no client id.
    const { clientId: _bound, ...legacy } = verified;
    const state = signState("integration-connect", legacy, key);

    const cb = await fetch(`${api.baseUrl}/api/credentials/oauth/callback?code=c&state=${encodeURIComponent(state)}`, {
      redirect: "manual",
    });
    expect(cb.headers.get("location")).toBe("/integrations?connected=linear");
    expect(fake.tokenRequests[0]?.client_id).toBe("client-1");
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
    // OAuthInterpretError messages are user-facing: the redirect carries the
    // corrective action in `detail` for the integrations page to render.
    const location = new URL(cb.headers.get("location") ?? "", "http://web.test");
    expect(location.pathname).toBe("/integrations");
    expect(location.searchParams.get("error")).toBe("oauth_failed");
    expect(location.searchParams.get("detail")).toContain("Reinstall the Slack app");

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

  /** Built per test: an `exp` fixed at collection time expires on a slow run. */
  function payload(expInMs = 60_000) {
    return { userId: "u1", orgId: "o1", teamId: "t1", service: "linear", nonce: "n1", exp: Date.now() + expInMs };
  }

  it("keeps reconnect only as true, and only on a team state", () => {
    expect(verifyOAuthConnectState(signState("integration-connect", { ...payload(), reconnect: true }, key), key, Date.now()))
      .toMatchObject({ teamId: "t1", reconnect: true });
    expect(verifyOAuthConnectState(signState("integration-connect", { ...payload(), reconnect: "yes" }, key), key, Date.now())).toBeNull();
    const { teamId: _teamId, orgId: _orgId, ...personal } = payload();
    expect(verifyOAuthConnectState(signState("integration-connect", { ...personal, reconnect: true }, key), key, Date.now())).toBeNull();
  });

  it("accepts a validly signed, unexpired payload", () => {
    const state = signState("integration-connect", payload(), key);
    const verified = verifyOAuthConnectState(state, key, Date.now());
    expect(verified).toMatchObject({ userId: "u1", service: "linear" });
  });

  it("rejects an expired payload", () => {
    const state = signState("integration-connect", payload(-1000), key);
    expect(verifyOAuthConnectState(state, key, Date.now())).toBeNull();
  });

  it.each(["github-app-setup", "github-connect"] as const)("rejects a %s state with a matching payload", (purpose) => {
    expect(verifyOAuthConnectState(signState(purpose, payload(), key), key, Date.now())).toBeNull();
  });

  it("rejects a state signed without a purpose, as states were before purpose keys", () => {
    const payloadB64 = Buffer.from(JSON.stringify(payload()), "utf8").toString("base64url");
    const unpurposed = `${payloadB64}.${createHmac("sha256", key).update(payloadB64).digest("base64url")}`;
    expect(verifyOAuthConnectState(unpurposed, key, Date.now())).toBeNull();
  });
});

// PGlite serializes transactions. Run these with TEST_DATABASE_URL to verify
// real writer contention on separate Postgres connections in a private schema.
describe.skipIf(!process.env.TEST_DATABASE_URL)("team credential authority row locks", () => {
  it.each([
    { name: "team admin demotion", mutation: "UPDATE team_members SET role = 'member' WHERE user_id = 'actor'" },
    { name: "team member removal", mutation: "DELETE FROM team_members WHERE user_id = 'actor'" },
    { name: "org admin demotion", mutation: "UPDATE org_members SET role = 'member' WHERE user_id = 'actor'" },
    { name: "org membership removal", mutation: "DELETE FROM org_members WHERE user_id = 'actor'" },
    { name: "team organization change", mutation: "UPDATE teams SET org_id = 'other-org'" },
    { name: "team deletion", mutation: "DELETE FROM teams" },
  ])("holds off $name until the authorized insert commits", async ({ mutation }) => {
    const schema = `credential_auth_${randomUUID().replaceAll("-", "")}`;
    const connectionString = process.env.TEST_DATABASE_URL;
    const admin = new Pool({ connectionString });
    const pool = new Pool({ connectionString, options: `-c search_path=${schema}`, max: 3 });
    let release = () => {};
    let insertion: Promise<boolean> | undefined;
    try {
      await admin.query(`CREATE SCHEMA ${schema}`);
      // Only the columns this boundary uses; the API tests use full migrations.
      await pool.query(`
        CREATE TABLE teams (id text PRIMARY KEY, org_id text NOT NULL);
        CREATE TABLE org_members (org_id text, user_id text, role text, PRIMARY KEY (org_id, user_id));
        CREATE TABLE team_members (team_id text, user_id text, role text, PRIMARY KEY (team_id, user_id));
        CREATE TABLE credentials (
          owner_type text, owner_id text, service text, type text,
          access_token_enc text, api_key_enc text, refresh_token_enc text,
          expires_at bigint, scopes jsonb, metadata jsonb, created_at bigint, updated_at bigint,
          PRIMARY KEY (owner_type, owner_id, service)
        );
      `);
      await pool.query("INSERT INTO teams VALUES ($1, 'org')", [schema]);
      // Each role is independently authoritative in the corresponding test.
      const orgAuthority = mutation.includes("org_members");
      await pool.query("INSERT INTO org_members VALUES ('org', 'actor', $1)", [orgAuthority ? "admin" : "member"]);
      await pool.query("INSERT INTO team_members VALUES ($1, 'actor', $2)", [schema, orgAuthority ? "member" : "admin"]);
      const db = buildAppDb(pool);
      let signalLocked = () => {};
      const locked = new Promise<void>((resolve) => { signalLocked = resolve; });
      const released = new Promise<void>((resolve) => { release = resolve; });
      insertion = db.transaction(async (tx) => {
        expect(await lockTeamCredentialRole(tx, { orgId: "org", userId: "actor", teamId: schema })).toBe("admin");
        signalLocked();
        await released;
        return insertCredentialIfAbsent(tx, "test-key", { type: "team", id: schema }, "demo", {
          type: "oauth2", accessToken: "locked-access-sentinel", refreshToken: "locked-refresh-sentinel",
        });
      });
      await Promise.race([locked, insertion]);
      const writer = await pool.connect();
      try {
        await writer.query("SET lock_timeout = '100ms'");
        // These ordinary UPDATE/DELETE writers take no advisory lock.
        await expect(writer.query(mutation)).rejects.toMatchObject({ code: "55P03" });
        release();
        expect(await insertion).toBe(true);
        await expect(writer.query(mutation)).resolves.toMatchObject({ rowCount: 1 });
        const saved = await writer.query("SELECT * FROM credentials");
        expect(saved.rows).toHaveLength(1);
        expect(JSON.stringify(saved.rows)).not.toContain("locked-access-sentinel");
        expect(JSON.stringify(saved.rows)).not.toContain("locked-refresh-sentinel");
      } finally {
        writer.release();
      }
    } finally {
      release();
      await insertion?.catch(() => undefined);
      await pool.end();
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
  });
});


describe("team OAuth connections", () => {
  async function setup() {
    const app = await bootTestApi({ plugins: [mcpPlugin(fake.url, ["read"])] });
    api = app;
    const team = await createTeam(app.providers.db, { orgId: "local-org", name: "OAuth team", creatorUserId: "local-user" });
    return { app, team };
  }

  async function start(baseUrl: string, teamId: string, userId = "local-user") {
    const response = await fetch(`${baseUrl}/api/credentials/linear/connect?scope=team&teamId=${teamId}`, {
      redirect: "manual", headers: { "x-valet-test-user-id": userId },
    });
    expect(response.status).toBe(302);
    return new URL(response.headers.get("location") ?? "").searchParams.get("state") ?? "";
  }

  async function finish(baseUrl: string, state: string, userId = "local-user") {
    return fetch(`${baseUrl}/api/credentials/oauth/callback?code=team-code&state=${encodeURIComponent(state)}`, {
      redirect: "manual", headers: { "x-valet-test-user-id": userId },
    });
  }

  it("stores encrypted team tokens and granted scopes without replacing the personal account", async () => {
    const { app, team } = await setup();
    await app.providers.engineCredentials.save({ type: "user", id: "local-user" }, "linear", { type: "oauth2", accessToken: "personal" });
    fake.tokenResponse = { access_token: "team-access", refresh_token: "team-refresh", expires_in: 3600, scope: "read" };
    const response = await finish(app.baseUrl, await start(app.baseUrl, team.id));
    expect(response.headers.get("location")).toBe(`/integrations?teamId=${team.id}&connected=linear`);
    expect(await app.providers.engineCredentials.get({ type: "team", id: team.id }, "linear")).toMatchObject({
      accessToken: "team-access", refreshToken: "team-refresh", scopes: ["read"],
    });
    expect(await app.providers.engineCredentials.get({ type: "user", id: "local-user" }, "linear")).toMatchObject({ accessToken: "personal" });
    const rows = await app.providers.db.select().from(credentials).where(eq(credentials.ownerId, team.id));
    expect(JSON.stringify(rows)).not.toContain("team-access");
    expect(JSON.stringify(rows)).not.toContain("team-refresh");
    const listed = await fetch(`${app.baseUrl}/api/credentials?scope=team&teamId=${team.id}`);
    const publicOutput = `${response.headers.get("location")} ${await listed.text()}`;
    expect(publicOutput).not.toContain("team-access");
    expect(publicOutput).not.toContain("team-refresh");
  });

  it("lets a member grant an added scope through the conversation, replacing the live team connection", async () => {
    const { app, team } = await setup();
    await addMember(app.providers.db, { teamId: team.id, userId: "test-member", role: "member" });
    await app.providers.engineCredentials.save({ type: "team", id: team.id }, "linear", { type: "oauth2", accessToken: "old-team", scopes: ["read"] });
    await app.providers.db.insert(agentSessions).values({ id: "team-thread-session", userId: "test-member", orgId: "local-org",
      ownerType: "team", ownerId: team.id, workspace: "w", createdAt: 1, updatedAt: 1 });
    const started = await fetch(`${app.baseUrl}/api/credentials/linear/connect?addScopes=read+write&session=team-thread-session`, {
      redirect: "manual", headers: { "x-valet-test-user-id": "test-member" },
    });
    expect(started.status).toBe(302);
    const authorize = new URL(started.headers.get("location") ?? "");
    expect(authorize.searchParams.get("scope")).toBe("read write");
    fake.tokenResponse = { access_token: "stepped-up", refresh_token: "stepped-refresh", expires_in: 3600 };
    const response = await finish(app.baseUrl, authorize.searchParams.get("state") ?? "", "test-member");
    expect(response.headers.get("location")).toBe(`/integrations?teamId=${team.id}&connected=linear`);
    // The token response named no scope, so the requested set is stored.
    expect(await app.providers.engineCredentials.get({ type: "team", id: team.id }, "linear")).toMatchObject({
      accessToken: "stepped-up", scopes: ["read", "write"],
    });
  });

  async function startStepUp(baseUrl: string, db: NonNullable<typeof api>["providers"]["db"], teamId: string, addScopes: string) {
    await addMember(db, { teamId, userId: "test-member", role: "member" });
    await db.insert(agentSessions).values({ id: "team-thread-session", userId: "test-member", orgId: "local-org",
      ownerType: "team", ownerId: teamId, workspace: "w", createdAt: 1, updatedAt: 1 });
    const started = await fetch(`${baseUrl}/api/credentials/linear/connect?addScopes=${encodeURIComponent(addScopes)}&session=team-thread-session`, {
      redirect: "manual", headers: { "x-valet-test-user-id": "test-member" },
    });
    expect(started.status).toBe(302);
    return new URL(started.headers.get("location") ?? "").searchParams.get("state") ?? "";
  }

  it("keeps a healthy team connection when a step-up adds no scope, or names no conversation", async () => {
    const { app, team } = await setup();
    await app.providers.engineCredentials.save({ type: "team", id: team.id }, "linear", { type: "oauth2", accessToken: "old-team", scopes: ["read", "write"] });
    const state = await startStepUp(app.baseUrl, app.providers.db, team.id, "read");
    fake.tokenResponse = { access_token: "member-token", expires_in: 3600, scope: "read write" };
    expect((await finish(app.baseUrl, state, "test-member")).headers.get("location")).toContain("error=team_step_up_not_granted");
    // Without a session the request is an ordinary team connect, which never replaces a live connection.
    const bare = await fetch(`${app.baseUrl}/api/credentials/linear/connect?scope=team&teamId=${team.id}&addScopes=read`, {
      redirect: "manual", headers: { "x-valet-test-user-id": "test-member" },
    });
    const bareState = new URL(bare.headers.get("location") ?? "").searchParams.get("state") ?? "";
    expect((await finish(app.baseUrl, bareState, "test-member")).headers.get("location")).toContain("error=team_connection_exists");
    expect(await app.providers.engineCredentials.get({ type: "team", id: team.id }, "linear")).toMatchObject({ accessToken: "old-team" });
  });

  it("keeps the team connection when the provider grants less than the step-up asked for", async () => {
    const { app, team } = await setup();
    await app.providers.engineCredentials.save({ type: "team", id: team.id }, "linear", { type: "oauth2", accessToken: "old-team", scopes: ["read", "write"] });
    const state = await startStepUp(app.baseUrl, app.providers.db, team.id, "read write extra");
    fake.tokenResponse = { access_token: "narrow", expires_in: 3600, scope: "read" };
    expect((await finish(app.baseUrl, state, "test-member")).headers.get("location")).toContain("error=team_step_up_not_granted");
    expect(await app.providers.engineCredentials.get({ type: "team", id: team.id }, "linear")).toMatchObject({
      accessToken: "old-team", scopes: ["read", "write"],
    });
  });

  it("keeps a connection that an admin repaired while the member signed in", async () => {
    const { app, team } = await setup();
    await app.providers.engineCredentials.save({ type: "team", id: team.id }, "linear", { type: "oauth2", accessToken: "old-team", scopes: ["read"] });
    const state = await startStepUp(app.baseUrl, app.providers.db, team.id, "read extra");
    await app.providers.engineCredentials.save({ type: "team", id: team.id }, "linear", {
      type: "oauth2", accessToken: "admin-repair", scopes: ["read", "extra", "write"],
    });
    fake.tokenResponse = { access_token: "stale", expires_in: 3600, scope: "read extra" };
    expect((await finish(app.baseUrl, state, "test-member")).headers.get("location")).toContain("error=team_step_up_not_granted");
    expect(await app.providers.engineCredentials.get({ type: "team", id: team.id }, "linear")).toMatchObject({ accessToken: "admin-repair" });
  });

  it("keeps an account an admin swapped in, with the same scopes, while the member signed in", async () => {
    const { app, team } = await setup();
    await app.providers.engineCredentials.save({ type: "team", id: team.id }, "linear", { type: "oauth2", accessToken: "old-team", scopes: ["read"] });
    const state = await startStepUp(app.baseUrl, app.providers.db, team.id, "read extra");
    await new Promise((resolve) => setTimeout(resolve, 5));
    await app.providers.engineCredentials.save({ type: "team", id: team.id }, "linear", { type: "oauth2", accessToken: "admin-account", scopes: ["read"] });
    fake.tokenResponse = { access_token: "stale", expires_in: 3600, scope: "read extra" };
    expect((await finish(app.baseUrl, state, "test-member")).headers.get("location")).toContain("error=team_step_up_not_granted");
    expect(await app.providers.engineCredentials.get({ type: "team", id: team.id }, "linear")).toMatchObject({ accessToken: "admin-account" });
  });

  it("keeps a connection that was deleted and created again while the member signed in", async () => {
    const { app, team } = await setup();
    await app.providers.engineCredentials.save({ type: "team", id: team.id }, "linear", { type: "oauth2", accessToken: "old-team", scopes: ["read"] });
    const state = await startStepUp(app.baseUrl, app.providers.db, team.id, "read extra");
    await app.providers.engineCredentials.delete({ type: "team", id: team.id }, "linear");
    await new Promise((resolve) => setTimeout(resolve, 5));
    await app.providers.engineCredentials.save({ type: "team", id: team.id }, "linear", { type: "oauth2", accessToken: "recreated", scopes: ["read"] });
    fake.tokenResponse = { access_token: "stale", expires_in: 3600, scope: "read extra" };
    expect((await finish(app.baseUrl, state, "test-member")).headers.get("location")).toContain("error=team_step_up_not_granted");
    expect(await app.providers.engineCredentials.get({ type: "team", id: team.id }, "linear")).toMatchObject({ accessToken: "recreated" });
  });

  it("refuses a team step-up when the team has no connection", async () => {
    const { app, team } = await setup();
    await addMember(app.providers.db, { teamId: team.id, userId: "test-member", role: "member" });
    await app.providers.db.insert(agentSessions).values({ id: "team-thread-session", userId: "test-member", orgId: "local-org",
      ownerType: "team", ownerId: team.id, workspace: "w", createdAt: 1, updatedAt: 1 });
    const started = await fetch(`${app.baseUrl}/api/credentials/linear/connect?addScopes=read+extra&session=team-thread-session`, {
      redirect: "manual", headers: { "x-valet-test-user-id": "test-member" },
    });
    expect(started.status).toBe(400);
  });

  it("lets a team member connect a team account", async () => {
    const { app, team } = await setup();
    await addMember(app.providers.db, { teamId: team.id, userId: "test-member", role: "member" });
    fake.tokenResponse = { access_token: "member-team-access", refresh_token: "member-team-refresh", expires_in: 3600, scope: "read" };
    const response = await finish(app.baseUrl, await start(app.baseUrl, team.id, "test-member"), "test-member");
    expect(response.headers.get("location")).toBe(`/integrations?teamId=${team.id}&connected=linear`);
    expect(await app.providers.engineCredentials.get({ type: "team", id: team.id }, "linear")).toMatchObject({ accessToken: "member-team-access" });
  });

  it("refuses someone outside the team and missing teams before contacting the provider", async () => {
    const { app, team } = await setup();
    for (const id of [team.id, "missing-team"]) {
      const response = await fetch(`${app.baseUrl}/api/credentials/linear/connect?scope=team&teamId=${id}`, {
        redirect: "manual", headers: { "x-valet-test-user-id": "test-member" },
      });
      expect(response.status).toBe(404);
    }
    expect(fake.registrations).toHaveLength(0);
  });

  it("refuses another organization's team even when the user has a team-admin row", async () => {
    const { app, team } = await setup();
    const state = await start(app.baseUrl, team.id);
    await app.providers.db.update(teams).set({ orgId: "other-org" }).where(eq(teams.id, team.id));
    const response = await fetch(`${app.baseUrl}/api/credentials/linear/connect?scope=team&teamId=${team.id}`, { redirect: "manual" });
    expect(response.status).toBe(404);
    expect((await finish(app.baseUrl, state)).headers.get("location")).toContain("error=team_access_changed");
    expect(fake.tokenRequests).toHaveLength(0);
  });

  it("refuses a callback after the connecting admin leaves", async () => {
    const { app, team } = await setup();
    await addMember(app.providers.db, { teamId: team.id, userId: "test-member", role: "admin" });
    const state = await start(app.baseUrl, team.id, "test-member");
    await removeMember(app.providers.db, { teamId: team.id, userId: "test-member" });
    const response = await finish(app.baseUrl, state, "test-member");
    expect(response.headers.get("location")).toContain("error=team_access_changed");
    expect(fake.tokenRequests).toHaveLength(0);
    expect(await app.providers.engineCredentials.get({ type: "team", id: team.id }, "linear")).toBeNull();
  });

  it("refuses callbacks for a deleted team or a different signed-in user", async () => {
    const { app, team } = await setup();
    const state = await start(app.baseUrl, team.id);
    expect((await finish(app.baseUrl, state, "test-member")).headers.get("location")).toContain("error=oauth_state");
    await app.providers.db.delete(teams).where(eq(teams.id, team.id));
    expect((await finish(app.baseUrl, state)).headers.get("location")).toContain("error=team_access_changed");
    expect(fake.tokenRequests).toHaveLength(0);
  });

  // A demotion to member keeps the right to add a team connection, so only a
  // change that ends team access refuses the callback.
  it.each(["remove", "org-demote", "org-remove", "delete-team"])(
    "refuses a callback when %s occurs during token exchange", async (change) => {
      const { app, team } = await setup();
      const orgAdmin = change.startsWith("org-");
      if (orgAdmin) {
        await app.providers.db.update(orgMembers).set({ role: "admin" }).where(eq(orgMembers.userId, "test-member"));
      } else {
        await addMember(app.providers.db, { teamId: team.id, userId: "test-member", role: "admin" });
      }
      const state = await start(app.baseUrl, team.id, "test-member");
      const actualFetch = globalThis.fetch;
      let revoked = false;
      const exchange = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
        const url = input instanceof Request ? input.url : String(input);
        if (url === `${fake.url}/token`) {
          if (change === "remove") await removeMember(app.providers.db, { teamId: team.id, userId: "test-member" });
          if (change === "demote") await setRole(app.providers.db, { teamId: team.id, userId: "test-member", role: "member" });
          if (change === "org-demote") await app.providers.db.update(orgMembers).set({ role: "member" }).where(eq(orgMembers.userId, "test-member"));
          if (change === "org-remove") await app.providers.db.delete(orgMembers).where(eq(orgMembers.userId, "test-member"));
          if (change === "delete-team") await deleteTeam(app.providers.db, { teamId: team.id });
          revoked = true;
        }
        return actualFetch(input, init);
      });
      try {
        const response = await finish(app.baseUrl, state, "test-member");
        expect(revoked).toBe(true);
        expect(response.headers.get("location")).toContain("error=team_access_changed");
        expect(await app.providers.db.select().from(credentials).where(and(eq(credentials.ownerType, "team"), eq(credentials.ownerId, team.id)))).toEqual([]);
      } finally {
        exchange.mockRestore();
      }
    },
  );

  it("stores a confidential-client OAuth connection on the team", async () => {
    process.env.TEST_GOOGLE_ID = "gid";
    process.env.TEST_GOOGLE_SECRET = "gsecret";
    const app = await bootTestApi({ plugins: [authCodePlugin(fake.url)] });
    api = app;
    const team = await createTeam(app.providers.db, { orgId: "local-org", name: "Google team", creatorUserId: "local-user" });
    const response = await fetch(`${app.baseUrl}/api/credentials/gmail/connect?scope=team&teamId=${team.id}`, { redirect: "manual" });
    const state = new URL(response.headers.get("location") ?? "").searchParams.get("state") ?? "";
    expect((await finish(app.baseUrl, state)).headers.get("location")).toContain("connected=gmail");
    expect(await app.providers.engineCredentials.get({ type: "team", id: team.id }, "gmail")).toMatchObject({ accessToken: "at-1", refreshToken: "rt-1" });
    expect(await app.providers.engineCredentials.get({ type: "user", id: "local-user" }, "gmail")).toBeNull();
  });

  it("does not turn an OAuth personal identity link into a team credential", async () => {
    process.env.SLACKISH_ID = "sid";
    process.env.SLACKISH_SECRET = "secret";
    const app = await bootTestApi({ plugins: [slackishPlugin(fake.url)] });
    api = app;
    const team = await createTeam(app.providers.db, { orgId: "local-org", name: "Identity team", creatorUserId: "local-user" });
    await linkIdentity(app.providers.db, { provider: "slack", externalId: "existing-slack-user", userId: "local-user" });
    await setNotifyAttention(app.providers.db, "slack", "local-user", true);
    const personalIdentity = await identityForUser(app.providers.db, "slack", "local-user");
    const personalCredential = { type: "oauth2" as const, accessToken: "personal-access-sentinel", refreshToken: "personal-refresh-sentinel" };
    await app.providers.engineCredentials.save({ type: "user", id: "local-user" }, "slackish", personalCredential);
    fake.tokenResponse = { ok: true, authed_user: { id: "slack-user", access_token: "personal-slack", scope: "chat:write" } };
    const response = await fetch(`${app.baseUrl}/api/credentials/slackish/connect?scope=team&teamId=${team.id}`, { redirect: "manual" });
    const state = new URL(response.headers.get("location") ?? "").searchParams.get("state") ?? "";
    const callback = await finish(app.baseUrl, state);
    expect(callback.headers.get("location")).toContain("error=team_identity_unsupported");
    expect(callback.headers.get("location")).not.toContain("personal-slack");
    expect(await identityForUser(app.providers.db, "slack", "local-user")).toEqual(personalIdentity);
    expect(await identityForExternal(app.providers.db, "slack", "slack-user")).toBeNull();
    expect(await app.providers.engineCredentials.get({ type: "user", id: "local-user" }, "slackish")).toMatchObject(personalCredential);
    expect(await app.providers.engineCredentials.get({ type: "team", id: team.id }, "slackish")).toBeNull();
  });

  it("reports a saved connection accurately when workflow resync fails", async () => {
    const { app, team } = await setup();
    const resync = vi.spyOn(app.providers.contentSync, "resyncTeamWorkflowSources").mockRejectedValueOnce(new Error("sync unavailable"));
    try {
      const response = await finish(app.baseUrl, await start(app.baseUrl, team.id));
      expect(response.headers.get("location")).toContain("error=team_sync_failed");
      expect(await app.providers.engineCredentials.get({ type: "team", id: team.id }, "linear")).toMatchObject({ accessToken: "at-1" });
    } finally {
      resync.mockRestore();
    }
  });

  describe("reconnect", () => {
    const dead = { type: "oauth2" as const, accessToken: "dead", refreshToken: "dead-refresh", expiresAt: 1, metadata: { refreshFailedAt: 2, refreshRefused: true } };
    const startReconnect = (baseUrl: string, teamId: string, userId: string) =>
      fetch(`${baseUrl}/api/credentials/linear/connect?scope=team&teamId=${teamId}&reconnect=1`, {
        redirect: "manual", headers: { "x-valet-test-user-id": userId },
      });
    const stateOf = (response: Response) => new URL(response.headers.get("location") ?? "").searchParams.get("state") ?? "";
    // Saved straight to the store, so no refresh runs on the dead row.
    const saveTeamRow = (app: TestApi, teamId: string, row: StoredCredential) =>
      app.providers.engineCredentials.save({ type: "team", id: teamId }, "linear", row);

    it("lets any team member replace a dead team connection", async () => {
      const { app, team } = await setup();
      await addMember(app.providers.db, { teamId: team.id, userId: "test-member", role: "member" });
      await saveTeamRow(app, team.id, dead);
      fake.tokenResponse = { access_token: "member-access", refresh_token: "member-refresh", expires_in: 3600, scope: "read" };
      const started = await startReconnect(app.baseUrl, team.id, "test-member");
      expect(started.status).toBe(302);
      const response = await finish(app.baseUrl, stateOf(started), "test-member");
      expect(response.headers.get("location")).toBe(`/integrations?teamId=${team.id}&connected=linear`);
      expect(await app.providers.engineCredentials.get({ type: "team", id: team.id }, "linear")).toMatchObject({
        accessToken: "member-access", refreshToken: "member-refresh",
      });
    });

    it("refuses someone outside the team, and sends a member back when the connection is not dead", async () => {
      const { app, team } = await setup();
      await saveTeamRow(app, team.id, dead);
      // An organization member who is not on the team.
      expect((await startReconnect(app.baseUrl, team.id, "test-member")).status).toBe(404);
      await addMember(app.providers.db, { teamId: team.id, userId: "test-member", role: "member" });
      const unneeded = `/integrations?teamId=${team.id}&error=team_reconnect_unneeded`;
      // A working connection, and one whose last refresh failed only temporarily.
      for (const row of [
        { type: "oauth2" as const, accessToken: "live", refreshToken: "rt", expiresAt: Date.now() + 3_600_000 },
        { type: "oauth2" as const, accessToken: "blip", refreshToken: "rt", expiresAt: 1, metadata: { refreshFailedAt: 2 } },
      ]) {
        await saveTeamRow(app, team.id, row);
        const response = await startReconnect(app.baseUrl, team.id, "test-member");
        expect(response.status).toBe(302);
        expect(response.headers.get("location")).toBe(unneeded);
      }
      expect(fake.registrations).toHaveLength(0);
    });

    it("keeps a connection that someone repaired while the member signed in", async () => {
      const { app, team } = await setup();
      await addMember(app.providers.db, { teamId: team.id, userId: "test-member", role: "member" });
      await saveTeamRow(app, team.id, dead);
      const started = await startReconnect(app.baseUrl, team.id, "test-member");
      await saveTeamRow(app, team.id, { type: "oauth2", accessToken: "repaired", refreshToken: "rt", expiresAt: Date.now() + 3_600_000 });
      const response = await finish(app.baseUrl, stateOf(started), "test-member");
      expect(response.headers.get("location")).toBe(`/integrations?teamId=${team.id}&error=team_reconnect_unneeded`);
      expect(await app.providers.engineCredentials.get({ type: "team", id: team.id }, "linear")).toMatchObject({ accessToken: "repaired" });
    });

  });

  it("keeps an occupied team slot when two OAuth callbacks complete", async () => {
    const { app, team } = await setup();
    const first = await start(app.baseUrl, team.id);
    const second = await start(app.baseUrl, team.id);
    const responses = await Promise.all([finish(app.baseUrl, first), finish(app.baseUrl, second)]);
    const locations = responses.map((r) => r.headers.get("location"));
    expect(locations.filter((v) => v?.includes("connected=linear"))).toHaveLength(1);
    expect(locations.filter((v) => v?.includes("error=team_connection_exists"))).toHaveLength(1);
    expect(await app.providers.db.select().from(credentials).where(eq(credentials.ownerId, team.id))).toHaveLength(1);
  });
});
