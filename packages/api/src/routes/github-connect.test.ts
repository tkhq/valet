/**
 * `/api/me/github` user App-OAuth connect flow (GitHub/repo integration
 * plan, Task 6). Route-level: real Hono app via `bootTestApi`, a fake
 * GitHub API server (`startGithubFixture`) subbed in via `GITHUB_API_URL`.
 */
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { startGithubFixture, type GithubFixture } from "../test-helpers/github-fixture.js";
import { githubInstallations } from "../schema/index.js";
import type {
  ListCredentialsResponse,
  PostGithubAppManifestResponse,
  PostGithubConnectResponse,
} from "../wire/types.js";

const HEADERS = { "Content-Type": "application/json" };
const MEMBER_HEADERS = { "Content-Type": "application/json", "x-valet-test-user-id": "test-member" };

let api: TestApi | undefined;
let fixture: GithubFixture | undefined;
const prevGithubApiUrl = process.env.GITHUB_API_URL;
const prevGithubUrl = process.env.GITHUB_URL;

afterEach(async () => {
  await api?.cleanup();
  api = undefined;
  await fixture?.close();
  fixture = undefined;
  if (prevGithubApiUrl === undefined) delete process.env.GITHUB_API_URL;
  else process.env.GITHUB_API_URL = prevGithubApiUrl;
  if (prevGithubUrl === undefined) delete process.env.GITHUB_URL;
  else process.env.GITHUB_URL = prevGithubUrl;
});

/** Points BOTH `GITHUB_API_URL` (api.github.com — installations,
 * manifest conversion, `/user`) and `GITHUB_URL` (github.com — the
 * `/login/oauth/access_token` exchange) at the fixture; the connect flow's
 * callback hits both hosts. */
function useFixture(overrides: Parameters<typeof startGithubFixture>[0] = {}): GithubFixture {
  fixture = startGithubFixture(overrides);
  process.env.GITHUB_API_URL = fixture.url;
  process.env.GITHUB_URL = fixture.url;
  return fixture;
}

/** Runs the App-manifest flow (Task 5) so the org has a configured App —
 * a pre-requisite for every connect-flow test. Discovery triggered along
 * the way is harmless-but-failing (fixture PEM isn't a real key) — it's
 * best-effort and caught, same as `github-app.test.ts` documents. */
async function configureOrgApp(baseUrl: string): Promise<void> {
  const manifestRes = await fetch(`${baseUrl}/api/org/github-app/manifest`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({}),
  });
  expect(manifestRes.status).toBe(200);
  const { state } = (await manifestRes.json()) as PostGithubAppManifestResponse;

  const setupRes = await fetch(`${baseUrl}/api/org/github-app/setup?code=some-code&state=${encodeURIComponent(state)}`, {
    redirect: "manual",
  });
  expect(setupRes.status).toBe(302);
}

describe("POST /api/me/github/connect", () => {
  it("409s when no GitHub App is configured for the org", async () => {
    api = await bootTestApi();
    const res = await fetch(`${api.baseUrl}/api/me/github/connect`, { method: "POST", headers: HEADERS });
    expect(res.status).toBe(409);
  });

  it("returns the App authorize URL with a signed state once the App is configured", async () => {
    api = await bootTestApi();
    useFixture();
    await configureOrgApp(api.baseUrl);

    const res = await fetch(`${api.baseUrl}/api/me/github/connect`, { method: "POST", headers: HEADERS });
    expect(res.status).toBe(200);
    const body = (await res.json()) as PostGithubConnectResponse;
    const url = new URL(body.url);
    expect(url.pathname).toBe("/login/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("fixture-client-id");
    expect(url.searchParams.get("state")).toBeTruthy();
    expect(url.searchParams.get("state")?.split(".")).toHaveLength(2);
  });
});

describe("GET /api/me/github/callback", () => {
  it("400s when code or state is missing", async () => {
    api = await bootTestApi();
    const res = await fetch(`${api.baseUrl}/api/me/github/callback?code=abc`, { redirect: "manual" });
    expect(res.status).toBe(400);
  });

  it("400s on a tampered state", async () => {
    api = await bootTestApi();
    useFixture();
    await configureOrgApp(api.baseUrl);

    const connectRes = await fetch(`${api.baseUrl}/api/me/github/connect`, { method: "POST", headers: HEADERS });
    const { url } = (await connectRes.json()) as PostGithubConnectResponse;
    const state = new URL(url).searchParams.get("state");
    expect(state).toBeTruthy();
    const tampered = `${state}x`;

    const res = await fetch(`${api.baseUrl}/api/me/github/callback?code=abc&state=${encodeURIComponent(tampered)}`, {
      redirect: "manual",
    });
    expect(res.status).toBe(400);
  });

  it("400s when the state's userId doesn't match the authenticated caller", async () => {
    api = await bootTestApi();
    useFixture();
    await configureOrgApp(api.baseUrl);

    const connectRes = await fetch(`${api.baseUrl}/api/me/github/connect`, { method: "POST", headers: HEADERS });
    const { url } = (await connectRes.json()) as PostGithubConnectResponse;
    const state = new URL(url).searchParams.get("state");
    expect(state).toBeTruthy();

    // `state` was minted for `local-user` (default HEADERS caller) — replay
    // it as `test-member`.
    const res = await fetch(
      `${api.baseUrl}/api/me/github/callback?code=abc&state=${encodeURIComponent(state ?? "")}`,
      { headers: MEMBER_HEADERS, redirect: "manual" },
    );
    expect(res.status).toBe(400);
  });

  it("exchanges the code, saves the credential with login + expiresAt, and redirects", async () => {
    api = await bootTestApi();
    useFixture({
      oauthAccessToken: () => ({
        body: {
          access_token: "connect-access-token",
          refresh_token: "connect-refresh-token",
          expires_in: 28800,
          token_type: "bearer",
        },
      }),
      getUser: () => ({ body: { login: "octouser", id: 99 } }),
    });
    await configureOrgApp(api.baseUrl);

    const connectRes = await fetch(`${api.baseUrl}/api/me/github/connect`, { method: "POST", headers: HEADERS });
    const { url } = (await connectRes.json()) as PostGithubConnectResponse;
    const state = new URL(url).searchParams.get("state");

    const beforeMs = Date.now();
    const callbackRes = await fetch(
      `${api.baseUrl}/api/me/github/callback?code=abc&state=${encodeURIComponent(state ?? "")}`,
      { headers: HEADERS, redirect: "manual" },
    );
    expect(callbackRes.status).toBe(302);
    expect(callbackRes.headers.get("location")).toBe("/settings/connected-accounts?github=connected");

    const stored = await api.providers.engineCredentials.get({ type: "user", id: "local-user" }, "github");
    expect(stored).toMatchObject({
      type: "oauth2",
      accessToken: "connect-access-token",
      refreshToken: "connect-refresh-token",
      metadata: { login: "octouser" },
    });
    expect(stored?.metadata?.identityOnly).toBeUndefined();
    expect(stored?.expiresAt).toBeGreaterThan(beforeMs + 28800 * 1000 - 5000);
    expect(stored?.expiresAt).toBeLessThan(beforeMs + 28800 * 1000 + 60_000);
  });

  it("overwrites a prior identity-only social-login credential (repo-capable after connect)", async () => {
    api = await bootTestApi();
    useFixture({
      oauthAccessToken: () => ({ body: { access_token: "connect-access-token", token_type: "bearer" } }),
      getUser: () => ({ body: { login: "octouser", id: 99 } }),
    });
    await configureOrgApp(api.baseUrl);

    await api.providers.engineCredentials.save({ type: "user", id: "local-user" }, "github", {
      type: "oauth2",
      accessToken: "social-login-token",
      metadata: { login: "octouser", identityOnly: true },
    });

    const connectRes = await fetch(`${api.baseUrl}/api/me/github/connect`, { method: "POST", headers: HEADERS });
    const { url } = (await connectRes.json()) as PostGithubConnectResponse;
    const state = new URL(url).searchParams.get("state");

    const callbackRes = await fetch(
      `${api.baseUrl}/api/me/github/callback?code=abc&state=${encodeURIComponent(state ?? "")}`,
      { headers: HEADERS, redirect: "manual" },
    );
    expect(callbackRes.status).toBe(302);

    const stored = await api.providers.engineCredentials.get({ type: "user", id: "local-user" }, "github");
    expect(stored?.accessToken).toBe("connect-access-token");
    expect(stored?.metadata?.identityOnly).toBeUndefined();
  });

  it("re-links a matching installation's linkedUserId after connect", async () => {
    api = await bootTestApi();
    useFixture({
      oauthAccessToken: () => ({ body: { access_token: "connect-access-token", token_type: "bearer" } }),
      getUser: () => ({ body: { login: "octouser", id: 99 } }),
    });
    await configureOrgApp(api.baseUrl);

    const now = Date.now();
    await api.providers.db.insert(githubInstallations).values({
      id: "ghi_test1",
      orgId: "local-org",
      installationId: 555,
      accountLogin: "octouser",
      accountType: "User",
      repositorySelection: "all",
      suspended: false,
      linkedUserId: null,
      createdAt: now,
      updatedAt: now,
    });

    const connectRes = await fetch(`${api.baseUrl}/api/me/github/connect`, { method: "POST", headers: HEADERS });
    const { url } = (await connectRes.json()) as PostGithubConnectResponse;
    const state = new URL(url).searchParams.get("state");
    await fetch(`${api.baseUrl}/api/me/github/callback?code=abc&state=${encodeURIComponent(state ?? "")}`, {
      headers: HEADERS,
      redirect: "manual",
    });

    const [row] = await api.providers.db
      .select()
      .from(githubInstallations)
      .where(eq(githubInstallations.installationId, 555));
    expect(row?.linkedUserId).toBe("local-user");
  });
});

describe("DELETE /api/me/github", () => {
  it("deletes the user credential and clears linkedUserId on matching installations, 204", async () => {
    api = await bootTestApi();

    await api.providers.engineCredentials.save({ type: "user", id: "local-user" }, "github", {
      type: "oauth2",
      accessToken: "connect-access-token",
      metadata: { login: "octouser" },
    });
    const now = Date.now();
    await api.providers.db.insert(githubInstallations).values({
      id: "ghi_test2",
      orgId: "local-org",
      installationId: 556,
      accountLogin: "octouser",
      accountType: "User",
      repositorySelection: "all",
      suspended: false,
      linkedUserId: "local-user",
      createdAt: now,
      updatedAt: now,
    });

    const res = await fetch(`${api.baseUrl}/api/me/github`, { method: "DELETE", headers: HEADERS });
    expect(res.status).toBe(204);

    const stored = await api.providers.engineCredentials.get({ type: "user", id: "local-user" }, "github");
    expect(stored).toBeNull();

    const [row] = await api.providers.db
      .select()
      .from(githubInstallations)
      .where(eq(githubInstallations.installationId, 556));
    expect(row?.linkedUserId).toBeNull();
  });
});

describe("GET /api/credentials — GitHub connect health surfacing", () => {
  it("surfaces expiresAt/login/identityOnly/refreshFailedAt without any secret material", async () => {
    api = await bootTestApi();

    await api.providers.engineCredentials.save({ type: "user", id: "local-user" }, "github", {
      type: "oauth2",
      accessToken: "super-secret-access-token",
      refreshToken: "super-secret-refresh-token",
      expiresAt: Date.now() + 3600_000,
      metadata: { login: "octouser", identityOnly: true, refreshFailedAt: 12345 },
    });

    const res = await fetch(`${api.baseUrl}/api/credentials`, { headers: HEADERS });
    expect(res.status).toBe(200);
    const { credentials } = (await res.json()) as ListCredentialsResponse;
    const github = credentials.find((c) => c.service === "github");
    expect(github).toMatchObject({
      login: "octouser",
      identityOnly: true,
      refreshFailedAt: 12345,
    });
    expect(typeof github?.expiresAt).toBe("number");

    const raw = JSON.stringify(credentials);
    expect(raw).not.toContain("super-secret-access-token");
    expect(raw).not.toContain("super-secret-refresh-token");
    expect(raw).not.toContain("accessToken");
    expect(raw).not.toContain("refreshToken");
    expect(raw).not.toContain("apiKey");
  });
});
