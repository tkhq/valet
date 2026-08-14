/**
 * GH-T10 fix: the PRIMARY (live-agent) session path must resolve `github`
 * credentials through the token service, not a raw store read. The trace is
 * session `call_tool` → `plugin-catalog.ts`'s `scopedCredentialProvider` →
 * `ToolContext.credentials` = `Session.credentialProvider()`. This suite
 * drives a REAL `EngineHost` session build (like `ws.repo-prep.test.ts` drives
 * a real session) and reads through that exact `Session.credentialProvider()`
 * seam — the same object a github action's `ctx.credentials.get()` hits — then
 * asserts the fixture-backed token source, proving the `credentialResolver`
 * seam routes the session path through `resolveSessionGitHubToken`.
 */
import { afterEach, describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import {
  InMemoryEventStream,
  InMemorySessionStore,
  VirtualSandboxProvider,
} from "@valet/engine";
import type { AppDb } from "../lib/drizzle.js";
import { freshTestPgDb } from "../test-helpers/pg-test-db.js";
import { deriveSecretKey } from "../lib/secret-crypto.js";
import { sessionRepos, githubInstallations } from "../schema/index.js";
import { startGithubFixture, type GithubFixture } from "../test-helpers/github-fixture.js";
import { PgCredentialStore } from "../plugins/credential-store.js";
import { saveAppConfig, type GithubAppConfig } from "../services/github-app.js";
import { EngineHost } from "./host.js";

const orgId = "gh-org";
const userId = "gh-user";
const NOW = 1_700_000_000_000;

const { privateKey: privateKeyPem } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
const appConfig: GithubAppConfig = {
  appId: "1",
  appSlug: "valet-app",
  oauthClientId: "Iv1.abc",
  htmlUrl: "https://github.com/apps/valet-app",
  oauthClientSecret: "client-secret",
  webhookSecret: "webhook-secret",
  privateKeyPem,
};

describe("EngineHost session github credential resolution", () => {
  let fixture: GithubFixture | undefined;
  let host: EngineHost | undefined;

  afterEach(async () => {
    host?.evictAll();
    host = undefined;
    await fixture?.close();
    fixture = undefined;
  });

  async function harness(): Promise<{ appDb: AppDb; credentials: PgCredentialStore }> {
    const { appDb, pgdb } = await freshTestPgDb();
    return { appDb, credentials: new PgCredentialStore(pgdb, deriveSecretKey("test-key")) };
  }

  function makeHost(appDb: AppDb, credentials: PgCredentialStore, fixtureUrl: string): EngineHost {
    const h = new EngineHost({
      engineStore: new InMemorySessionStore(),
      sandboxProvider: new VirtualSandboxProvider(),
      eventStream: new InMemoryEventStream(),
      engineCredentials: credentials,
      db: appDb,
      githubTokenDeps: {
        key: deriveSecretKey("cache-key"),
        apiUrl: fixtureUrl,
        githubUrl: fixtureUrl,
        now: () => NOW,
      },
    });
    host = h;
    return h;
  }

  it("repo-bound session with binding auth:\"app\" gets the installation token even though the user is connected", async () => {
    const { appDb, credentials } = await harness();
    // A healthy user credential IS connected — it must be ignored because the
    // session's primary binding pins the explicit "app" tier, proving the real
    // session id flows through `primaryRepoBinding`.
    await credentials.save({ type: "user", id: userId }, "github", {
      type: "oauth2",
      accessToken: "user-tok",
      metadata: { login: "octocat" },
    });
    await saveAppConfig({ credentials }, orgId, appConfig);
    await appDb.insert(githubInstallations).values({
      id: "ghi_1",
      orgId,
      installationId: 111,
      accountLogin: "acme",
      accountType: "Organization",
      repositorySelection: "all",
      suspended: false,
      cachedToken: null,
      cachedTokenExpiresAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
    const sessionId = "sess-app";
    await appDb.insert(sessionRepos).values({
      sessionId,
      host: "github",
      fullName: "acme/repo",
      cloneUrl: "https://github.com/acme/repo.git",
      auth: "app",
      position: 0,
    });
    fixture = startGithubFixture({
      createInstallationToken: (id) => ({
        body: { token: `inst-${id}`, expires_at: new Date(NOW + 3600_000).toISOString() },
      }),
    });
    const h = makeHost(appDb, credentials, fixture.url);

    const session = await h.sessionFor(sessionId, { userId, orgId, workspace: "/tmp" });
    const cred = await session.credentialProvider().get("github");

    expect(cred?.accessToken).toBe("inst-111");
  });

  it("unconnected user + sole installation resolves the installation token through the real session path", async () => {
    const { appDb, credentials } = await harness();
    await saveAppConfig({ credentials }, orgId, appConfig);
    await appDb.insert(githubInstallations).values({
      id: "ghi_999",
      orgId,
      installationId: 999,
      accountLogin: "acme",
      accountType: "Organization",
      repositorySelection: "all",
      suspended: false,
      cachedToken: null,
      cachedTokenExpiresAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
    fixture = startGithubFixture({
      createInstallationToken: (id) => ({
        body: { token: `inst-${id}`, expires_at: new Date(NOW + 3600_000).toISOString() },
      }),
    });
    const h = makeHost(appDb, credentials, fixture.url);

    const session = await h.sessionFor("sess-inst", { userId, orgId, workspace: "/tmp" });
    const cred = await session.credentialProvider().get("github");

    expect(cred?.accessToken).toBe("inst-999");
  });

  it('"github:installation" resolves the installation token even though default resolution picks the user token', async () => {
    const { appDb, credentials } = await harness();
    // The reported bug: a linked user credential wins default `github`
    // resolution, and `list_repos scope:"installation"` then 403s on
    // `GET /installation/repositories`. The virtual service must hand the
    // action the installation tier regardless of the user credential.
    await credentials.save({ type: "user", id: userId }, "github", {
      type: "oauth2",
      accessToken: "user-tok",
      metadata: { login: "octocat" },
    });
    await saveAppConfig({ credentials }, orgId, appConfig);
    await appDb.insert(githubInstallations).values({
      id: "ghi_211",
      orgId,
      installationId: 211,
      accountLogin: "acme",
      accountType: "Organization",
      repositorySelection: "all",
      suspended: false,
      cachedToken: null,
      cachedTokenExpiresAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
    fixture = startGithubFixture({
      createInstallationToken: (id) => ({
        body: { token: `inst-${id}`, expires_at: new Date(NOW + 3600_000).toISOString() },
      }),
    });
    const h = makeHost(appDb, credentials, fixture.url);

    const session = await h.sessionFor("sess-scope", { userId, orgId, workspace: "/tmp" });
    const provider = session.credentialProvider();

    expect((await provider.get("github"))?.accessToken).toBe("user-tok");
    expect((await provider.get("github:installation"))?.accessToken).toBe("inst-211");
  });

  it('"github:installation" resolves null (not a user-token substitute) when no installation exists', async () => {
    const { appDb, credentials } = await harness();
    await credentials.save({ type: "user", id: userId }, "github", {
      type: "oauth2",
      accessToken: "user-tok",
      metadata: { login: "octocat" },
    });
    fixture = startGithubFixture();
    const h = makeHost(appDb, credentials, fixture.url);

    const session = await h.sessionFor("sess-scope-none", { userId, orgId, workspace: "/tmp" });

    expect(await session.credentialProvider().get("github:installation")).toBeNull();
  });

  it("non-github service is a byte-identical raw store read through the session path", async () => {
    const { appDb, credentials } = await harness();
    await credentials.save({ type: "user", id: userId }, "linear", {
      type: "api_key",
      apiKey: "linear-key",
    });
    fixture = startGithubFixture();
    const h = makeHost(appDb, credentials, fixture.url);

    const session = await h.sessionFor("sess-other", { userId, orgId, workspace: "/tmp" });
    const cred = await session.credentialProvider().get("linear");

    expect(cred?.accessToken).toBe("linear-key");
  });

  it("no github credential: GitHubAuthError with the connect hint surfaces out of the provider (→ tool error)", async () => {
    const { appDb, credentials } = await harness();
    fixture = startGithubFixture();
    const h = makeHost(appDb, credentials, fixture.url);

    const session = await h.sessionFor("sess-none", { userId, orgId, workspace: "/tmp" });

    await expect(session.credentialProvider().get("github")).rejects.toThrow(
      /connect your GitHub account or install the GitHub App/,
    );
  });
});
