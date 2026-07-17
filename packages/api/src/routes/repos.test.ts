/**
 * `GET /api/repos` (GitHub/repo integration plan, Task 7). Route-level: real
 * Hono app via `bootTestApi`, a fake GitHub API server (`startGithubFixture`)
 * subbed in via `GITHUB_API_URL` for tests that need the `github` `RepoHost`
 * to actually call out.
 */
import { afterEach, describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { startGithubFixture, type GithubFixture } from "../test-helpers/github-fixture.js";
import { githubInstallations } from "../schema/index.js";
import type { GetReposResponse, PostGithubAppManifestResponse } from "../wire/types.js";

const HEADERS = { "Content-Type": "application/json" };

const { privateKey: TEST_PEM } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

let api: TestApi | undefined;
let fixture: GithubFixture | undefined;
const prevGithubApiUrl = process.env.GITHUB_API_URL;

afterEach(async () => {
  await api?.cleanup();
  api = undefined;
  await fixture?.close();
  fixture = undefined;
  if (prevGithubApiUrl === undefined) delete process.env.GITHUB_API_URL;
  else process.env.GITHUB_API_URL = prevGithubApiUrl;
});

function useFixture(overrides: Parameters<typeof startGithubFixture>[0] = {}): GithubFixture {
  fixture = startGithubFixture(overrides);
  process.env.GITHUB_API_URL = fixture.url;
  return fixture;
}

/** Runs the App-manifest flow with a REAL RSA PEM (mirrors
 * `github-app.test.ts`'s `setupConfiguredOrg`) so `mintInstallationToken`'s
 * JWT signing succeeds — a fake PEM string would fail `createPrivateKey`
 * before ever reaching the fixture. */
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

async function seedInstallationRow(overrides: Partial<typeof githubInstallations.$inferInsert> = {}): Promise<void> {
  const now = Date.now();
  await api!.providers.db.insert(githubInstallations).values({
    id: "ghi_seed",
    orgId: "local-org",
    installationId: 999,
    accountLogin: "acme",
    accountType: "Organization",
    repositorySelection: "all",
    suspended: false,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  });
}

async function saveUserCredential(accessToken: string, login: string): Promise<void> {
  await api!.providers.engineCredentials.save({ type: "user", id: "local-user" }, "github", {
    type: "oauth2",
    accessToken,
    metadata: { login },
  });
}

async function saveOrgPatCredential(accessToken: string, login: string): Promise<void> {
  await api!.providers.engineCredentials.save({ type: "org", id: "local-org" }, "github", {
    type: "oauth2",
    accessToken,
    metadata: { login },
  });
}

function rawRepo(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 1,
    name: "one",
    full_name: "acme/one",
    html_url: "https://github.com/acme/one",
    clone_url: "https://github.com/acme/one.git",
    default_branch: "main",
    private: false,
    description: null,
    updated_at: "2026-01-01T00:00:00Z",
    language: null,
    ...overrides,
  };
}

describe("GET /api/repos", () => {
  it("soft-empties when nothing is configured (no App, no personal connection)", async () => {
    api = await bootTestApi();
    const res = await fetch(`${api.baseUrl}/api/repos`, { headers: HEADERS });
    expect(res.status).toBe(200);
    const body = (await res.json()) as GetReposResponse;
    expect(body).toEqual({ repos: [], connected: false, installed: false });
  });

  it("unions installation + personal repos, dedupes by fullName (installation wins), sorts by updatedAt desc", async () => {
    api = await bootTestApi();
    useFixture({
      listInstallations: () => ({ body: [] }),
      convertManifest: () => ({
        body: {
          id: 42,
          slug: "valet-acme",
          name: "Valet Acme",
          client_id: "Iv1.client",
          client_secret: "oauth-client-secret",
          webhook_secret: "the-webhook-secret",
          pem: TEST_PEM,
          html_url: "https://github.com/apps/valet-acme",
        },
      }),
      createInstallationToken: () => ({
        body: { token: "installation-secret-token", expires_at: new Date(Date.now() + 3600_000).toISOString() },
      }),
      listInstallationRepositories: () => ({
        body: {
          total_count: 2,
          repositories: [
            rawRepo({ id: 1, full_name: "acme/one", updated_at: "2026-01-01T00:00:00Z" }),
            rawRepo({ id: 2, full_name: "acme/shared", updated_at: "2026-01-03T00:00:00Z" }),
          ],
        },
      }),
      listUserRepos: () => ({
        body: [
          // Same fullName as an installation repo, different updatedAt — the
          // installation-sourced entry must win the dedupe (kept updatedAt
          // 01-03, not this row's 01-04).
          rawRepo({ id: 2, full_name: "acme/shared", updated_at: "2026-01-04T00:00:00Z" }),
          rawRepo({ id: 3, full_name: "bob/two", updated_at: "2026-01-05T00:00:00Z" }),
        ],
      }),
    });
    await configureOrgApp(api.baseUrl);
    await seedInstallationRow();
    await saveUserCredential("user-secret-token", "local-user-login");

    const res = await fetch(`${api.baseUrl}/api/repos`, { headers: HEADERS });
    expect(res.status).toBe(200);
    const body = (await res.json()) as GetReposResponse;

    expect(body.connected).toBe(true);
    expect(body.installed).toBe(true);
    expect(body.repos.map((r) => r.fullName)).toEqual(["bob/two", "acme/shared", "acme/one"]);

    const shared = body.repos.find((r) => r.fullName === "acme/shared");
    expect(shared?.installed).toBe(true);
    expect(shared?.updatedAt).toBe("2026-01-03T00:00:00Z"); // installation source wins, not the user-source 01-04

    const one = body.repos.find((r) => r.fullName === "acme/one");
    expect(one?.installed).toBe(true);

    const two = body.repos.find((r) => r.fullName === "bob/two");
    expect(two?.installed).toBeUndefined();
  });

  it("soft-degrades when the installation-repositories call fails: still 200, partial results", async () => {
    api = await bootTestApi();
    useFixture({
      listInstallations: () => ({ body: [] }),
      convertManifest: () => ({
        body: {
          id: 42,
          slug: "valet-acme",
          name: "Valet Acme",
          client_id: "Iv1.client",
          client_secret: "oauth-client-secret",
          webhook_secret: "the-webhook-secret",
          pem: TEST_PEM,
          html_url: "https://github.com/apps/valet-acme",
        },
      }),
      createInstallationToken: () => ({
        body: { token: "installation-secret-token", expires_at: new Date(Date.now() + 3600_000).toISOString() },
      }),
      listInstallationRepositories: () => ({ status: 500, body: { message: "boom" } }),
      listUserRepos: () => ({ body: [rawRepo({ id: 3, full_name: "bob/two", updated_at: "2026-01-05T00:00:00Z" })] }),
    });
    await configureOrgApp(api.baseUrl);
    await seedInstallationRow();
    await saveUserCredential("user-secret-token", "local-user-login");

    const res = await fetch(`${api.baseUrl}/api/repos`, { headers: HEADERS });
    expect(res.status).toBe(200);
    const body = (await res.json()) as GetReposResponse;
    expect(body.repos.map((r) => r.fullName)).toEqual(["bob/two"]);
    // Flags are independent direct checks, not derived from `repos` — the
    // installation row still exists even though its repo listing failed.
    expect(body.installed).toBe(true);
    expect(body.connected).toBe(true);
  });

  it("soft-degrades a single failing installation among several: still 200, partial results from the healthy one", async () => {
    api = await bootTestApi();
    useFixture({
      listInstallations: () => ({ body: [] }),
      convertManifest: () => ({
        body: {
          id: 42,
          slug: "valet-acme",
          name: "Valet Acme",
          client_id: "Iv1.client",
          client_secret: "oauth-client-secret",
          webhook_secret: "the-webhook-secret",
          pem: TEST_PEM,
          html_url: "https://github.com/apps/valet-acme",
        },
      }),
      // Installation 999 (acme) mints fine; installation 998 (bob) fails to
      // mint — exercises the per-installation try/catch that lets the
      // parallelized `Promise.all` in `listInstallationRepos` still return
      // the healthy installation's repos.
      createInstallationToken: (installationId) =>
        installationId === "998"
          ? { status: 500, body: { message: "boom" } }
          : {
              body: {
                token: "installation-secret-token",
                expires_at: new Date(Date.now() + 3600_000).toISOString(),
              },
            },
      listInstallationRepositories: () => ({
        body: { total_count: 1, repositories: [rawRepo({ id: 1, full_name: "acme/one" })] },
      }),
      listUserRepos: () => ({ body: [] }),
    });
    await configureOrgApp(api.baseUrl);
    await seedInstallationRow();
    await seedInstallationRow({ id: "ghi_seed_2", installationId: 998, accountLogin: "bob" });
    await saveUserCredential("user-secret-token", "local-user-login");

    const res = await fetch(`${api.baseUrl}/api/repos`, { headers: HEADERS });
    expect(res.status).toBe(200);
    const body = (await res.json()) as GetReposResponse;
    expect(body.repos.map((r) => r.fullName)).toEqual(["acme/one"]);
    expect(body.installed).toBe(true);
  });

  it("falls back to the org-owned PAT for personal-tier listing when the user has no connection", async () => {
    api = await bootTestApi();
    useFixture({
      listUserRepos: () => ({ body: [rawRepo({ id: 5, full_name: "org/pat-repo", updated_at: "2026-01-02T00:00:00Z" })] }),
    });
    await saveOrgPatCredential("org-pat-token", "org-bot");

    const res = await fetch(`${api.baseUrl}/api/repos`, { headers: HEADERS });
    expect(res.status).toBe(200);
    const body = (await res.json()) as GetReposResponse;
    expect(body.repos.map((r) => r.fullName)).toEqual(["org/pat-repo"]);
    // `connected` names the SIGNED-IN USER's own credential, not the org PAT.
    expect(body.connected).toBe(false);
    expect(body.installed).toBe(false);
  });

  it("never leaks token material into the response body", async () => {
    api = await bootTestApi();
    useFixture({
      listInstallations: () => ({ body: [] }),
      convertManifest: () => ({
        body: {
          id: 42,
          slug: "valet-acme",
          name: "Valet Acme",
          client_id: "Iv1.client",
          client_secret: "oauth-client-secret",
          webhook_secret: "the-webhook-secret",
          pem: TEST_PEM,
          html_url: "https://github.com/apps/valet-acme",
        },
      }),
      createInstallationToken: () => ({
        body: { token: "super-secret-installation-token", expires_at: new Date(Date.now() + 3600_000).toISOString() },
      }),
      listInstallationRepositories: () => ({
        body: { total_count: 1, repositories: [rawRepo({ id: 1, full_name: "acme/one" })] },
      }),
      listUserRepos: () => ({ body: [rawRepo({ id: 3, full_name: "bob/two" })] }),
    });
    await configureOrgApp(api.baseUrl);
    await seedInstallationRow();
    await saveUserCredential("super-secret-user-token", "local-user-login");

    const res = await fetch(`${api.baseUrl}/api/repos`, { headers: HEADERS });
    const text = await res.text();
    expect(text).not.toContain("super-secret-installation-token");
    expect(text).not.toContain("super-secret-user-token");
    expect(text).not.toContain("oauth-client-secret");
    expect(text).not.toContain("the-webhook-secret");
  });
});
