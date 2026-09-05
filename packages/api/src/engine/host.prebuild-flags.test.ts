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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import type { AppDb } from "../lib/drizzle.js";
import { freshTestPgDb, type TestPgDb } from "../test-helpers/pg-test-db.js";
import { RecordingSandboxProvider } from "../test-helpers/recording-sandbox.js";
import { agentSessions, githubInstallations, sessionRepos, imageSources } from "../schema/index.js";
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

  it("a child bound to a repo gets the repo's runtime flags and resources", async () => {
    fixture = startGithubFixture({
      createInstallationToken: (id) => ({
        body: { token: `inst-${id}`, expires_at: new Date(Date.now() + 3600_000).toISOString() },
      }),
      getContents: (_owner, _repo, path) =>
        path === ".valet/prebuild.yaml"
          ? contentsBody('workspaceStorage: "8Gi"\ndocker: true\nresources:\n  cpu: 4\n  memory: 8Gi\n', "blob1")
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
    expect(call?.resources).toEqual({ cpu: 4, memory: "8Gi" });

    // The contents read must be AUTHENTICATED with the minted installation
    // token — a change that swallows token errors and proceeds tokenless
    // would keep the flags green against this permissive fixture otherwise.
    const contentsCall = fixture.calls.find((c) => c.path.includes("/contents/"));
    expect(contentsCall?.authHeader).toBe("Bearer inst-111");
    expect(fixture.calls.filter((c) => c.path.includes("/contents/.valet/prebuild.yaml"))).toHaveLength(1);
  });

  it.each([null, { cpu: 2, memory: "4Gi" }])("an authenticated missing file applies saved defaults %j authoritatively", async (sandboxResources) => {
    fixture = startGithubFixture({
      createInstallationToken: (id) => ({
        body: { token: `inst-${id}`, expires_at: new Date(Date.now() + 3600_000).toISOString() },
      }),
      getContents: () => ({ status: 404, body: { message: "Not Found" } }),
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
      id: "ghi_absent_resources",
      orgId: "local-org",
      installationId: 222,
      accountLogin: "acme",
      accountType: "Organization",
      repositorySelection: "all",
      suspended: false,
      cachedToken: null,
      cachedTokenExpiresAt: null,
      createdAt: now,
      updatedAt: now,
    });
    const childId = "child-absent-resources";
    await db.insert(imageSources).values({
      id: "child-saved-defaults", orgId: "local-org", kind: "repo", name: "acme/widgets",
      repoHost: "github", repoFullName: "acme/widgets", sandboxResources,
      createdAt: now, updatedAt: now,
    });
    await db.insert(sessionRepos).values({
      sessionId: childId,
      host: "github",
      fullName: "acme/widgets",
      cloneUrl: "https://github.com/acme/widgets.git",
      ref: null,
      auth: "auto",
      position: 0,
      targetDir: "widgets",
    });
    const parent = await engineHost.sessionFor("parent-absent-resources", {
      userId: "local-user",
      orgId: "local-org",
      workspace: "/tmp/parent-absent-resources",
    });
    const child = await engineHost.childSessionFor(childId, {
      parentSessionId: "parent-absent-resources",
      parentThreadId: parent.thread("web:default").id,
      actorUserId: "local-user",
      orgId: "local-org",
      owner: { type: "user", id: "local-user" },
      workspace: `/tmp/${childId}`,
    });
    await child.attachment.ensureReady({ timeoutMs: 5_000 });

    const call = recorder.createCalls.find((candidate) => candidate.sessionId === childId);
    expect(call?.resources).toEqual(sandboxResources ?? {});
    expect(call?.preserveResourcesOnAdopt).toBe(false);
  });

  it("a REST-created repo session gets nonempty repository resources", async () => {
    fixture = startGithubFixture({
      getContents: (_owner, _repo, path) =>
        path === ".valet/prebuild.yaml"
          ? contentsBody("resources:\n  memory: 8Gi\n", "blob-rest")
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
    const sessionId = "rest-prebuild-resources";
    const now = Date.now();
    await db.insert(imageSources).values({
      id: "rest-saved-defaults", orgId: "local-org", kind: "repo", name: "acme/open-widgets",
      repoHost: "github", repoFullName: "acme/open-widgets", sandboxResources: { cpu: 4, memory: "4Gi" },
      createdAt: now, updatedAt: now,
    });
    await db.insert(agentSessions).values({
      id: sessionId,
      userId: "local-user",
      orgId: "local-org",
      workspace: `/tmp/${sessionId}`,
      status: "active",
      ownerType: "user",
      ownerId: "local-user",
      profile: "headless",
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(sessionRepos).values({
      sessionId,
      host: "github",
      fullName: "acme/open-widgets",
      cloneUrl: "https://github.com/acme/open-widgets.git",
      ref: null,
      auth: "auto",
      position: 0,
      targetDir: "open-widgets",
    });

    const session = await engineHost.sessionFor(sessionId, {
      userId: "local-user",
      orgId: "local-org",
      workspace: `/tmp/${sessionId}`,
      repos: [binding({ fullName: "acme/open-widgets" })],
    });
    await session.attachment.ensureReady({ timeoutMs: 5_000 });

    expect(recorder.createCalls.find((call) => call.sessionId === sessionId)?.resources).toEqual({
      cpu: 4,
      memory: "8Gi",
    });
  });

  it.each([null, { cpu: 2, memory: "4Gi" }])("a tokenless missing file preserves adoption and uses saved defaults %j for fresh compute", async (sandboxResources) => {
    fixture = startGithubFixture({
      getContents: () => ({ status: 404, body: { message: "Not Found" } }),
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
    const childId = "child-tokenless-missing-resources";
    await db.insert(imageSources).values({
      id: "child-error-defaults", orgId: "local-org", kind: "repo", name: "acme/private-widgets",
      repoHost: "github", repoFullName: "acme/private-widgets", sandboxResources,
      createdAt: Date.now(), updatedAt: Date.now(),
    });
    await db.insert(sessionRepos).values({
      sessionId: childId,
      host: "github",
      fullName: "acme/private-widgets",
      cloneUrl: "https://github.com/acme/private-widgets.git",
      ref: null,
      auth: "auto",
      position: 0,
      targetDir: "private-widgets",
    });
    const parent = await engineHost.sessionFor("parent-tokenless-missing-resources", {
      userId: "local-user",
      orgId: "local-org",
      workspace: "/tmp/parent-tokenless-missing-resources",
    });
    const child = await engineHost.childSessionFor(childId, {
      parentSessionId: "parent-tokenless-missing-resources",
      parentThreadId: parent.thread("web:default").id,
      actorUserId: "local-user",
      orgId: "local-org",
      owner: { type: "user", id: "local-user" },
      workspace: `/tmp/${childId}`,
    });
    await child.attachment.ensureReady({ timeoutMs: 5_000 });

    const call = recorder.createCalls.find((candidate) => candidate.sessionId === childId);
    expect(call?.resources).toEqual(sandboxResources ?? undefined);
    expect(call?.preserveResourcesOnAdopt).toBe(true);
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

  it("a timed-out read is evicted so the next child retries", async () => {
    let contentReads = 0;
    const fetchImpl: typeof fetch = (_input, init) => {
      contentReads++;
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      if (contentReads === 1) return new Promise<Response>(() => {});
      return Promise.resolve(
        new Response(
          JSON.stringify({ content: Buffer.from('workspaceStorage: "8Gi"').toString("base64"), encoding: "base64" }),
          { status: 200 },
        ),
      );
    };
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const recorder = new RecordingSandboxProvider();
    api = await bootTestApi({
      sandboxProvider: recorder,
      githubTokenDeps: {
        key: deriveSecretKey("test-key"),
        apiUrl: "https://github.test",
        githubUrl: "https://github.test",
        fetchImpl,
      },
    });
    const { engineHost, db } = api.providers;
    for (const childId of ["child-timeout-one", "child-timeout-two"]) {
      await db.insert(sessionRepos).values({
        sessionId: childId,
        host: "github",
        fullName: "acme/hung-flags",
        cloneUrl: "https://github.com/acme/hung-flags.git",
        ref: null,
        auth: "auto",
        position: 0,
        targetDir: "hung-flags",
      });
    }
    const parent = await engineHost.sessionFor("parent-timeout-flags", {
      userId: "local-user",
      orgId: "local-org",
      workspace: "/tmp/parent-timeout-flags",
    });
    const parentThread = parent.thread("web:default");
    const childOpts = {
      parentSessionId: "parent-timeout-flags",
      parentThreadId: parentThread.id,
      actorUserId: "local-user",
      orgId: "local-org",
      owner: { type: "user" as const, id: "local-user" },
    };

    const first = await engineHost.childSessionFor("child-timeout-one", {
      ...childOpts,
      workspace: "/tmp/child-timeout-one",
    });
    await first.attachment.ensureReady({ timeoutMs: 5_000 });
    const second = await engineHost.childSessionFor("child-timeout-two", {
      ...childOpts,
      workspace: "/tmp/child-timeout-two",
    });
    await second.attachment.ensureReady({ timeoutMs: 5_000 });

    expect(contentReads).toBe(2);
    expect(recorder.createCalls.find((call) => call.sessionId === "child-timeout-one")?.workspaceStorage).toBeUndefined();
    expect(recorder.createCalls.find((call) => call.sessionId === "child-timeout-two")?.workspaceStorage).toBe("8Gi");
    errorSpy.mockRestore();
    warnSpy.mockRestore();
  }, 15_000);
});
