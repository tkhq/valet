/**
 * Unit coverage for `primaryGitHubRepoTarget`. Repo-backed configuration
 * reads use this guard to select a session's primary GitHub repo (TKAI-385).
 *
 * Regression: the guard once matched only host === "github.com", but
 * `session_repos.host` stores "github" (the schema default). Every bound
 * session silently resolved default flags, so a repo-declared
 * `workspaceStorage` never reached the workspace claim and the repo `docker`
 * flag never applied. The DB-backed cases pin the schema default through
 * `loadSessionMeta` into the guard, so the stored value and the guard cannot
 * drift apart again.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import type { AppDb } from "../lib/drizzle.js";
import { freshTestPgDb, type TestPgDb } from "../test-helpers/pg-test-db.js";
import { RecordingSandboxProvider } from "../test-helpers/recording-sandbox.js";
import { agentSessions, githubInstallations, sessionRepos } from "../schema/index.js";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { startGithubFixture, contentsBody, type GithubFixture } from "../test-helpers/github-fixture.js";
import { clearRepoPrebuildFlagsCache } from "../bakes/source-service.js";
import { saveAppConfig, type GithubAppConfig } from "../services/github-app.js";
import { deriveSecretKey } from "../lib/secret-crypto.js";
import { loadSessionMeta } from "./session-meta.js";
import { primaryGitHubRepoTarget } from "./host.js";
import type { RepoBinding } from "../wire/types.js";

function binding(overrides: Partial<RepoBinding> = {}): RepoBinding & { targetDir: string } {
  return {
    fullName: "acme/widgets",
    cloneUrl: "https://github.com/acme/widgets.git",
    auth: "auto",
    targetDir: "widgets",
    ...overrides,
  };
}

describe("primaryGitHubRepoTarget", () => {
  it('host "github" (the session_repos schema default) resolves — the TKAI-385 regression', () => {
    const target = primaryGitHubRepoTarget([binding({ host: "github" })]);
    expect(target).toEqual({ ok: true, owner: "acme", repo: "widgets", ref: "HEAD" });
  });

  it('host "github.com" (hand-built metas) also resolves', () => {
    const target = primaryGitHubRepoTarget([binding({ host: "github.com" })]);
    expect(target).toEqual({ ok: true, owner: "acme", repo: "widgets", ref: "HEAD" });
  });

  it("absent host defaults to GitHub", () => {
    const target = primaryGitHubRepoTarget([binding()]);
    expect(target).toEqual({ ok: true, owner: "acme", repo: "widgets", ref: "HEAD" });
  });

  it("a bound ref is passed through", () => {
    const target = primaryGitHubRepoTarget([binding({ host: "github", ref: "release-1.2" })]);
    expect(target).toEqual({ ok: true, owner: "acme", repo: "widgets", ref: "release-1.2" });
  });

  it("a non-GitHub host is skipped with the host named", () => {
    const target = primaryGitHubRepoTarget([binding({ host: "gitlab.example.com" })]);
    expect(target).toEqual({ ok: false, reason: "non-github-host", host: "gitlab.example.com" });
  });

  it("no repo bindings → no-repo", () => {
    expect(primaryGitHubRepoTarget(undefined)).toEqual({ ok: false, reason: "no-repo" });
    expect(primaryGitHubRepoTarget([])).toEqual({ ok: false, reason: "no-repo" });
  });

  it("a fullName without owner/name parts → bad-full-name", () => {
    const target = primaryGitHubRepoTarget([binding({ fullName: "widgets" })]);
    expect(target).toEqual({ ok: false, reason: "bad-full-name" });
  });
});

describe("primaryGitHubRepoTarget over loadSessionMeta (session_repos schema default)", () => {
  const ORG = "test-org";
  const USER = "test-user";
  const NOW = Date.now();
  let harness: TestPgDb;
  let db: AppDb;

  beforeEach(async () => {
    harness = await freshTestPgDb();
    db = harness.appDb;
  });
  afterEach(async () => {
    await harness.cleanup();
  });

  it("a row that takes the host column DEFAULT resolves to a GitHub target", async () => {
    await db.insert(agentSessions).values({
      id: "s-flags",
      userId: USER,
      orgId: ORG,
      workspace: "/tmp/s-flags",
      status: "active",
      ownerType: "user",
      ownerId: USER,
      profile: "headless",
      createdAt: NOW,
      updatedAt: NOW,
    });
    // No `host` value: the row takes the column DEFAULT, exactly like rows
    // written by the bind flow. The guard must accept whatever that is.
    await db.insert(sessionRepos).values({
      sessionId: "s-flags",
      fullName: "tkhq/mono",
      cloneUrl: "https://github.com/tkhq/mono.git",
      ref: null,
      auth: "auto",
      position: 0,
      targetDir: "mono",
    });

    const meta = await loadSessionMeta(db, {
      id: "s-flags",
      userId: USER,
      orgId: ORG,
      workspace: "/tmp/s-flags",
    });
    const target = primaryGitHubRepoTarget(meta.repos);
    expect(target).toEqual({ ok: true, owner: "tkhq", repo: "mono", ref: "HEAD" });
  });
});

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

/**
 * Regression (TKAI-385, second miss): `buildChildSession` assembled its own
 * sandbox opts and never called `resolveRepoPrebuildFlags` — an
 * orchestrator-spawned child bound to a repo provisioned the deploy-default
 * workspace claim (1Gi) while a REST-created session honored the repo's
 * `workspaceStorage`. This drives the REAL `childSessionFor` path against a
 * GitHub fixture serving `.valet/prebuild.yaml` and asserts the flags reach
 * the provider's `SandboxCreateOpts`.
 */
describe("childSessionFor repo prebuild flags", () => {
  let api: TestApi | undefined;
  let fixture: GithubFixture | undefined;

  beforeEach(() => {
    clearRepoPrebuildFlagsCache();
  });
  afterEach(async () => {
    await api?.cleanup();
    api = undefined;
    await fixture?.close();
    fixture = undefined;
    clearRepoPrebuildFlagsCache();
  });

  it("a child bound to a repo gets the repo's workspaceStorage and docker flag", async () => {
    fixture = startGithubFixture({
      createInstallationToken: (id) => ({
        body: { token: `inst-${id}`, expires_at: new Date(Date.now() + 3600_000).toISOString() },
      }),
      getContents: (_owner, _repo, path) =>
        path === ".valet/prebuild.yaml"
          ? contentsBody('workspaceStorage: "8Gi"\ndocker: true\n', "blob1")
          : { status: 404, body: { message: "Not Found" } },
    });
    const recorder = new RecordingSandboxProvider();
    api = await bootTestApi({
      sandboxProvider: recorder,
      githubTokenDeps: {
        key: deriveSecretKey("test-key"),
        apiUrl: fixture.url,
        githubUrl: fixture.url,
      },
    });
    const { engineHost, db, engineCredentials } = api.providers;
    await saveAppConfig({ credentials: engineCredentials }, "local-org", appConfig);
    const now = Date.now();
    await db.insert(githubInstallations).values({
      id: "ghi_flags",
      orgId: "local-org",
      installationId: 111,
      accountLogin: "tkhq",
      accountType: "Organization",
      repositorySelection: "all",
      suspended: false,
      cachedToken: null,
      cachedTokenExpiresAt: null,
      createdAt: now,
      updatedAt: now,
    });

    const childId = "child-prebuild-flags";
    // The binding row lands BEFORE the build, same order as the spawner
    // (`orchestrator/children.ts`).
    await db.insert(sessionRepos).values({
      sessionId: childId,
      host: "github",
      fullName: "tkhq/mono",
      cloneUrl: "https://github.com/tkhq/mono.git",
      ref: null,
      auth: "auto",
      position: 0,
      targetDir: "mono",
    });

    const parent = await engineHost.sessionFor("parent-prebuild-flags", {
      userId: "local-user",
      orgId: "local-org",
      workspace: "/tmp/parent-prebuild-flags",
    });
    const parentThread = parent.thread("web:default");
    const child = await engineHost.childSessionFor(childId, {
      parentSessionId: "parent-prebuild-flags",
      parentThreadId: parentThread.id,
      actorUserId: "local-user",
      orgId: "local-org",
      owner: { type: "user", id: "local-user" },
      workspace: `/tmp/${childId}`,
    });
    await child.attachment.ensureReady({ timeoutMs: 5_000 });

    const call = recorder.createCalls.find((c) => c.sessionId === childId);
    expect(call).toBeDefined();
    expect(call?.workspaceStorage).toBe("8Gi");
    expect(call?.docker).toBe(true);

    // The contents read must be AUTHENTICATED with the minted installation
    // token — a change that swallows token errors and proceeds tokenless
    // would keep the flags green against this permissive fixture otherwise.
    const contentsCall = fixture.calls.find((c) => c.path.includes("/contents/"));
    expect(contentsCall?.authHeader).toBe("Bearer inst-111");
  });

  it("an org with NO GitHub configured still reads a public repo's flags tokenless (TKAI-401)", async () => {
    fixture = startGithubFixture({
      getContents: (_owner, _repo, path) =>
        path === ".valet/prebuild.yaml"
          ? contentsBody('workspaceStorage: "8Gi"\n', "blob1")
          : { status: 404, body: { message: "Not Found" } },
    });
    const recorder = new RecordingSandboxProvider();
    api = await bootTestApi({
      sandboxProvider: recorder,
      githubTokenDeps: {
        key: deriveSecretKey("test-key"),
        apiUrl: fixture.url,
        githubUrl: fixture.url,
      },
    });
    const { engineHost, db } = api.providers;
    // No app config, no installation, no user credential: token resolution
    // throws, and the read degrades to tokenless — which a public repo serves.
    const childId = "child-tokenless-flags";
    await db.insert(sessionRepos).values({
      sessionId: childId,
      host: "github",
      fullName: "acme/open-widgets",
      cloneUrl: "https://github.com/acme/open-widgets.git",
      ref: null,
      auth: "auto",
      position: 0,
      targetDir: "open-widgets",
    });
    const parent = await engineHost.sessionFor("parent-tokenless-flags", {
      userId: "local-user",
      orgId: "local-org",
      workspace: "/tmp/parent-tokenless-flags",
    });
    const parentThread = parent.thread("web:default");
    const child = await engineHost.childSessionFor(childId, {
      parentSessionId: "parent-tokenless-flags",
      parentThreadId: parentThread.id,
      actorUserId: "local-user",
      orgId: "local-org",
      owner: { type: "user", id: "local-user" },
      workspace: `/tmp/${childId}`,
    });
    await child.attachment.ensureReady({ timeoutMs: 5_000 });

    const call = recorder.createCalls.find((c) => c.sessionId === childId);
    expect(call?.workspaceStorage).toBe("8Gi");
    const contentsCall = fixture.calls.find((c) => c.path.includes("/contents/"));
    expect(contentsCall).toBeDefined();
    expect(contentsCall?.authHeader).toBeUndefined();
  });
});
