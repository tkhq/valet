/**
 * Unit tests for `buildActionInvoker` (plugin-system-v2 plan Task 6) — the
 * headless dispatch primitive behind the workflow `tool` node's
 * `engine.invokeAction` seam. Exercises the invoker directly (fixture
 * `actionPluginByService` map, in-memory sqlite, a fake `CredentialStore`)
 * rather than through `buildWorkflowEngineDeps`/`bootTestApi` — the run
 * context resolution (`resolveRunContext`) those go through is covered
 * separately in `../workflows/engine-deps.test.ts`.
 */
import { afterEach, describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { eq } from "drizzle-orm";
import { Type } from "typebox";
import type {
  ActionPlugin,
  CredentialOwner,
  CredentialStore,
  PluginAction,
  StoredCredential,
  ValetPlugin,
} from "@valet/engine";
import type { AppDb } from "../lib/drizzle.js";
import { freshTestPgDb } from "../test-helpers/pg-test-db.js";
import { deriveSecretKey } from "../lib/secret-crypto.js";
import { actionInvocations, actionPolicies, runtimeGrants, sessionRepos, githubInstallations } from "../schema/index.js";
import { grantPolicyKey } from "../policies/resolution.js";
import { startGithubFixture, type GithubFixture } from "../test-helpers/github-fixture.js";
import { PgCredentialStore } from "./credential-store.js";
import { saveAppConfig, type GithubAppConfig } from "../services/github-app.js";
import { buildActionInvoker, type ActionInvocationContext } from "./action-invoker.js";

async function makeDb(): Promise<AppDb> {
  const { appDb } = await freshTestPgDb();
  return appDb;
}

/** Minimal in-memory `CredentialStore` — enough to exercise scoping/missing-credential behavior without pulling in `SqliteCredentialStore`'s encryption machinery. */
class FakeCredentialStore implements CredentialStore {
  private readonly rows = new Map<string, StoredCredential>();

  private key(owner: CredentialOwner, service: string): string {
    return `${owner.type}:${owner.id}:${service}`;
  }

  seed(owner: CredentialOwner, service: string, credential: StoredCredential): void {
    this.rows.set(this.key(owner, service), credential);
  }

  async get(owner: CredentialOwner, service: string): Promise<StoredCredential | null> {
    return this.rows.get(this.key(owner, service)) ?? null;
  }

  async save(owner: CredentialOwner, service: string, credential: StoredCredential): Promise<void> {
    this.rows.set(this.key(owner, service), credential);
  }

  async delete(owner: CredentialOwner, service: string): Promise<void> {
    this.rows.delete(this.key(owner, service));
  }

  async list(): Promise<{ service: string; scopes?: string[]; connectedAt: string }[]> {
    return [];
  }
}

const userOwner: ActionInvocationContext = { userId: "u1", orgId: "org1", owner: { type: "user", id: "u1" } };

interface CountingAction {
  action: PluginAction;
  calls: () => number;
  lastArgs: () => Record<string, unknown> | undefined;
}

function countingAction(opts: {
  id?: string;
  execute?: PluginAction["execute"];
} = {}): CountingAction {
  let count = 0;
  let last: Record<string, unknown> | undefined;
  const action: PluginAction = {
    id: opts.id ?? "demo.ping",
    name: "ping",
    description: "ping",
    riskLevel: "low",
    parameters: Type.Object({ msg: Type.String() }),
    execute:
      opts.execute ??
      (async (args, ctx) => {
        count += 1;
        last = args as Record<string, unknown>;
        const credential = await ctx.credentials.get();
        return { success: true, data: { echoed: (args as { msg: string }).msg, hasCredential: credential !== null } };
      }),
  };
  return { action, calls: () => count, lastArgs: () => last };
}

function actionPluginByServiceOf(
  service: string,
  actionPlugin: ActionPlugin,
): Map<string, { plugin: ValetPlugin; actionPlugin: ActionPlugin }> {
  const plugin: ValetPlugin = { name: service, version: "0.0.1", actions: [actionPlugin] };
  return new Map([[service, { plugin, actionPlugin }]]);
}

describe("buildActionInvoker", () => {
  it("happy path: executes the resolved action and returns {ok:true, result}", async () => {
    const fixture = countingAction();
    const actionPluginByService = actionPluginByServiceOf("demo", { service: "demo", actions: [fixture.action] });
    const invoke = buildActionInvoker({ db: await makeDb(), credentials: new FakeCredentialStore(), actionPluginByService });

    const result = await invoke(
      { service: "demo", action: "ping", params: { msg: "hi" }, invocationId: "workflow:r1:n1" },
      userOwner,
    );

    expect(result).toEqual({ ok: true, result: { echoed: "hi", hasCredential: false } });
    expect(fixture.calls()).toBe(1);
  });

  it("dedup: a duplicate invocationId returns the ORIGINAL result without re-invoking execute", async () => {
    const fixture = countingAction();
    const actionPluginByService = actionPluginByServiceOf("demo", { service: "demo", actions: [fixture.action] });
    const invoke = buildActionInvoker({ db: await makeDb(), credentials: new FakeCredentialStore(), actionPluginByService });
    const req = { service: "demo", action: "ping", params: { msg: "hi" }, invocationId: "workflow:r1:n1" };

    const first = await invoke(req, userOwner);
    const second = await invoke(req, userOwner);

    expect(second).toEqual(first);
    expect(fixture.calls()).toBe(1);
  });

  it("unknown service: returns a stable {ok:false} that dedups without ever resolving an action", async () => {
    const actionPluginByService = actionPluginByServiceOf("demo", { service: "demo", actions: [] });
    const invoke = buildActionInvoker({ db: await makeDb(), credentials: new FakeCredentialStore(), actionPluginByService });
    const req = { service: "nope", action: "ping", params: {}, invocationId: "workflow:r1:n1" };

    const first = await invoke(req, userOwner);
    const second = await invoke(req, userOwner);

    expect(first).toEqual({ ok: false, error: "unknown action: nope.ping" });
    expect(second).toEqual(first);
  });

  it("unknown action within a known service: stable {ok:false}, dedup applies", async () => {
    const fixture = countingAction();
    const actionPluginByService = actionPluginByServiceOf("demo", { service: "demo", actions: [fixture.action] });
    const invoke = buildActionInvoker({ db: await makeDb(), credentials: new FakeCredentialStore(), actionPluginByService });
    const req = { service: "demo", action: "does_not_exist", params: {}, invocationId: "workflow:r1:n1" };

    const first = await invoke(req, userOwner);
    const second = await invoke(req, userOwner);

    expect(first).toEqual({ ok: false, error: "unknown action: demo.does_not_exist" });
    expect(second).toEqual(first);
    expect(fixture.calls()).toBe(0);
  });

  it("param validation failure: missing required param never reaches execute", async () => {
    const fixture = countingAction();
    const actionPluginByService = actionPluginByServiceOf("demo", { service: "demo", actions: [fixture.action] });
    const invoke = buildActionInvoker({ db: await makeDb(), credentials: new FakeCredentialStore(), actionPluginByService });

    const result = await invoke(
      { service: "demo", action: "ping", params: {}, invocationId: "workflow:r1:n1" },
      userOwner,
    );

    expect(result.ok).toBe(false);
    expect(fixture.calls()).toBe(0);
  });

  it("missing credential: the action still executes and sees credentials.get() === null", async () => {
    const fixture = countingAction();
    const actionPluginByService = actionPluginByServiceOf("demo", { service: "demo", actions: [fixture.action] });
    const invoke = buildActionInvoker({ db: await makeDb(), credentials: new FakeCredentialStore(), actionPluginByService });

    const result = await invoke(
      { service: "demo", action: "ping", params: { msg: "hi" }, invocationId: "workflow:r1:n1" },
      userOwner,
    );

    expect(result).toEqual({ ok: true, result: { echoed: "hi", hasCredential: false } });
  });

  it("a saved credential is visible to the action via credentials.get()", async () => {
    const store = new FakeCredentialStore();
    store.seed({ type: "user", id: "u1" }, "demo", { type: "api_key", apiKey: "secret-token" });
    const fixture = countingAction();
    const actionPluginByService = actionPluginByServiceOf("demo", { service: "demo", actions: [fixture.action] });
    const invoke = buildActionInvoker({ db: await makeDb(), credentials: store, actionPluginByService });

    const result = await invoke(
      { service: "demo", action: "ping", params: { msg: "hi" }, invocationId: "workflow:r1:n1" },
      userOwner,
    );

    expect(result).toEqual({ ok: true, result: { echoed: "hi", hasCredential: true } });
  });

  it("org owner maps to a CredentialOwner and scopes credential lookups by org", async () => {
    const store = new FakeCredentialStore();
    store.seed({ type: "org", id: "org1" }, "demo", { type: "api_key", apiKey: "org-token" });
    const fixture = countingAction();
    const actionPluginByService = actionPluginByServiceOf("demo", { service: "demo", actions: [fixture.action] });
    const invoke = buildActionInvoker({ db: await makeDb(), credentials: store, actionPluginByService });

    const result = await invoke(
      { service: "demo", action: "ping", params: { msg: "hi" }, invocationId: "workflow:r1:n1" },
      { userId: "u1", orgId: "org1", owner: { type: "org", id: "org1" } },
    );

    expect(result).toEqual({ ok: true, result: { echoed: "hi", hasCredential: true } });
  });

  it("team-owned run: unsupported owner type returns a deterministic {ok:false} and never invokes execute", async () => {
    const fixture = countingAction();
    const actionPluginByService = actionPluginByServiceOf("demo", { service: "demo", actions: [fixture.action] });
    const invoke = buildActionInvoker({ db: await makeDb(), credentials: new FakeCredentialStore(), actionPluginByService });

    const result = await invoke(
      { service: "demo", action: "ping", params: { msg: "hi" }, invocationId: "workflow:r1:n1" },
      { userId: "team:t1", orgId: "org1", owner: { type: "team", id: "t1" } },
    );

    expect(result.ok).toBe(false);
    expect(fixture.calls()).toBe(0);
  });

  it("execute throw is caught and mapped to {ok:false, error}", async () => {
    const fixture = countingAction({
      execute: async () => {
        throw new Error("boom");
      },
    });
    const actionPluginByService = actionPluginByServiceOf("demo", { service: "demo", actions: [fixture.action] });
    const invoke = buildActionInvoker({ db: await makeDb(), credentials: new FakeCredentialStore(), actionPluginByService });

    const result = await invoke(
      { service: "demo", action: "ping", params: { msg: "hi" }, invocationId: "workflow:r1:n1" },
      userOwner,
    );

    expect(result).toEqual({ ok: false, error: "boom" });
  });

  it("PluginActionResult failure maps to {ok:false, error}", async () => {
    const fixture = countingAction({
      execute: async () => ({ success: false, error: "denied by upstream" }),
    });
    const actionPluginByService = actionPluginByServiceOf("demo", { service: "demo", actions: [fixture.action] });
    const invoke = buildActionInvoker({ db: await makeDb(), credentials: new FakeCredentialStore(), actionPluginByService });

    const result = await invoke(
      { service: "demo", action: "ping", params: { msg: "hi" }, invocationId: "workflow:r1:n1" },
      userOwner,
    );

    expect(result).toEqual({ ok: false, error: "denied by upstream" });
  });

  it("dynamic resolveActions is used when the action isn't in the static list", async () => {
    let resolveCalls = 0;
    const dynamicAction = countingAction({ id: "demo.dyn" });
    const actionPlugin: ActionPlugin = {
      service: "demo",
      actions: [],
      resolveActions: async () => {
        resolveCalls += 1;
        return [dynamicAction.action];
      },
    };
    const actionPluginByService = actionPluginByServiceOf("demo", actionPlugin);
    const invoke = buildActionInvoker({ db: await makeDb(), credentials: new FakeCredentialStore(), actionPluginByService });

    const result = await invoke(
      { service: "demo", action: "dyn", params: { msg: "hi" }, invocationId: "workflow:r1:n1" },
      userOwner,
    );

    expect(result).toEqual({ ok: true, result: { echoed: "hi", hasCredential: false } });
    expect(dynamicAction.calls()).toBe(1);
    expect(resolveCalls).toBe(1);
  });

  it("concurrent duplicate invocations converge on one stored result", async () => {
    let seen = 0;
    const fixture = countingAction({
      execute: async (args) => {
        seen += 1;
        return { success: true, data: { call: seen, msg: (args as { msg: string }).msg } };
      },
    });
    const actionPluginByService = actionPluginByServiceOf("demo", { service: "demo", actions: [fixture.action] });
    const invoke = buildActionInvoker({ db: await makeDb(), credentials: new FakeCredentialStore(), actionPluginByService });
    const req = { service: "demo", action: "ping", params: { msg: "race" }, invocationId: "workflow:r1:n1" };

    const [a, b] = await Promise.all([invoke(req, userOwner), invoke(req, userOwner)]);

    expect(a).toEqual(b);
  });
});

/**
 * `github` service resolution (GH-T10) — the `github` credential provider
 * must resolve through `resolveGitHubToken` instead of a raw
 * `CredentialStore.get` read. Exercised against a real `PgCredentialStore`
 * + the shared fake GitHub API server (`test-helpers/github-fixture.ts`),
 * mirroring `services/github-tokens.test.ts`'s own harness rather than the
 * `FakeCredentialStore` the rest of this file uses — `resolveGitHubToken`
 * needs a real `CredentialStore` to persist single-flight refresh
 * rotations against (not exercised here, but keeping one credential-store
 * implementation per file avoids a second, divergent fake).
 */
describe("buildActionInvoker: github service resolution", () => {
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

  let fixture: GithubFixture | undefined;

  afterEach(async () => {
    await fixture?.close();
    fixture = undefined;
  });

  /** A minimal `github`-service action that mirrors how the real
   * plugin-github actions consume the credential (`getOctokit` in
   * `plugin-github/src/actions/actions.ts`): a bare `ctx.credentials.get()`,
   * throwing the exact same connect-hint message on a missing token. */
  function githubWhoamiAction(): PluginAction {
    return {
      id: "github.whoami",
      name: "whoami",
      description: "whoami",
      riskLevel: "low",
      parameters: Type.Object({}),
      execute: async (_args, ctx) => {
        const cred = await ctx.credentials.get();
        const token = cred?.accessToken;
        if (!token) {
          throw new Error("Missing GitHub access token. Connect the GitHub integration in Settings.");
        }
        return { success: true, data: { token } };
      },
    };
  }

  async function harness(): Promise<{ appDb: AppDb; credentials: PgCredentialStore }> {
    const { appDb, pgdb } = await freshTestPgDb();
    return { appDb, credentials: new PgCredentialStore(pgdb, deriveSecretKey("test-key")) };
  }

  /** Same credential consumption as `githubWhoamiAction`, but with the
   * `owner`/`repo` parameters every real repo-scoped plugin-github action
   * declares — the pair an `app`-credential node's installation lookup is
   * derived from. */
  function githubRepoAction(): PluginAction {
    return {
      id: "github.create_comment",
      name: "create_comment",
      description: "create a comment",
      riskLevel: "low",
      parameters: Type.Object({ owner: Type.String(), repo: Type.String() }),
      execute: async (_args, ctx) => {
        const cred = await ctx.credentials.get();
        const token = cred?.accessToken;
        if (!token) {
          throw new Error("Missing GitHub access token. Connect the GitHub integration in Settings.");
        }
        return { success: true, data: { token } };
      },
    };
  }

  function githubActionPluginByService(): Map<string, { plugin: ValetPlugin; actionPlugin: ActionPlugin }> {
    return actionPluginByServiceOf("github", {
      service: "github",
      actions: [githubWhoamiAction(), githubRepoAction()],
    });
  }

  it("user-connected: resolves the user's healthy github credential", async () => {
    const { appDb, credentials } = await harness();
    await credentials.save({ type: "user", id: userId }, "github", {
      type: "oauth2",
      accessToken: "user-tok",
      metadata: { login: "octocat" },
    });
    fixture = startGithubFixture();
    const invoke = buildActionInvoker({
      db: appDb,
      credentials,
      actionPluginByService: githubActionPluginByService(),
      githubTokenDeps: { key: deriveSecretKey("cache-key"), apiUrl: fixture.url, githubUrl: fixture.url, now: () => NOW },
    });

    const result = await invoke(
      { service: "github", action: "whoami", params: {}, invocationId: "workflow:r1:n1" },
      { userId, orgId, owner: { type: "user", id: userId } },
    );

    expect(result).toEqual({ ok: true, result: { token: "user-tok" } });
  });

  it("unconnected + a sole installation: resolves an installation token (anonymous org path)", async () => {
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
    const invoke = buildActionInvoker({
      db: appDb,
      credentials,
      actionPluginByService: githubActionPluginByService(),
      githubTokenDeps: { key: deriveSecretKey("cache-key"), apiUrl: fixture.url, githubUrl: fixture.url, now: () => NOW },
    });

    const result = await invoke(
      { service: "github", action: "whoami", params: {}, invocationId: "workflow:r1:n1" },
      { userId, orgId, owner: { type: "user", id: userId } },
    );

    expect(result).toEqual({ ok: true, result: { token: "inst-999" } });
  });

  it("repo-bound session with explicit binding auth:\"app\": installation token even when the user is connected", async () => {
    const { appDb, credentials } = await harness();
    // A healthy user credential IS connected — must be ignored because the
    // binding's `auth` is the explicit "app" tier, not "auto".
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
    const sessionId = "sess-1";
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
    const invoke = buildActionInvoker({
      db: appDb,
      credentials,
      actionPluginByService: githubActionPluginByService(),
      githubTokenDeps: { key: deriveSecretKey("cache-key"), apiUrl: fixture.url, githubUrl: fixture.url, now: () => NOW },
    });

    const result = await invoke(
      { service: "github", action: "whoami", params: {}, invocationId: "workflow:r1:n1" },
      { userId, orgId, owner: { type: "user", id: userId }, sessionId },
    );

    expect(result).toEqual({ ok: true, result: { token: "inst-111" } });
  });

  it("unbound session, no user credential, no installation, no org PAT: the connect-hint error surfaces as the action's error result", async () => {
    const { appDb, credentials } = await harness();
    fixture = startGithubFixture();
    const invoke = buildActionInvoker({
      db: appDb,
      credentials,
      actionPluginByService: githubActionPluginByService(),
      githubTokenDeps: { key: deriveSecretKey("cache-key"), apiUrl: fixture.url, githubUrl: fixture.url, now: () => NOW },
    });

    const result = await invoke(
      { service: "github", action: "whoami", params: {}, invocationId: "workflow:r1:n1" },
      { userId, orgId, owner: { type: "user", id: userId } },
    );

    expect(result.ok).toBe(false);
    expect(result).toMatchObject({
      error: expect.stringContaining("connect your GitHub account"),
    });
  });

  // ── credential: "app" — the bot identity, or a loud failure ───────────
  //
  // A user-owned review workflow must comment as the GitHub App, not as the
  // person who saved it. `auto` + `api` tries the user's own credential
  // first, so an `app` node MUST bypass that precedence, and MUST fail
  // instead of falling back to a human identity.

  /** App config + one installation on `acme`, plus a healthy user
   * credential that an `app`-credential node must ignore. */
  async function seedAppAndUser(appDb: AppDb, credentials: PgCredentialStore): Promise<void> {
    await credentials.save({ type: "user", id: userId }, "github", {
      type: "oauth2",
      accessToken: "user-tok",
      metadata: { login: "octocat" },
    });
    await saveAppConfig({ credentials }, orgId, appConfig);
    await appDb.insert(githubInstallations).values({
      id: "ghi_222",
      orgId,
      installationId: 222,
      accountLogin: "acme",
      accountType: "Organization",
      repositorySelection: "all",
      suspended: false,
      cachedToken: null,
      cachedTokenExpiresAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
  }

  it('credential "app": resolves the installation for the params owner, ignoring a healthy user credential', async () => {
    const { appDb, credentials } = await harness();
    await seedAppAndUser(appDb, credentials);
    fixture = startGithubFixture({
      createInstallationToken: (id) => ({
        body: { token: `inst-${id}`, expires_at: new Date(NOW + 3600_000).toISOString() },
      }),
    });
    const invoke = buildActionInvoker({
      db: appDb,
      credentials,
      actionPluginByService: githubActionPluginByService(),
      githubTokenDeps: { key: deriveSecretKey("cache-key"), apiUrl: fixture.url, githubUrl: fixture.url, now: () => NOW },
    });

    const result = await invoke(
      {
        service: "github",
        action: "create_comment",
        params: { owner: "acme", repo: "widgets" },
        invocationId: "workflow:r1:n1",
        credential: "app",
      },
      { userId, orgId, owner: { type: "user", id: userId } },
    );

    expect(result).toEqual({ ok: true, result: { token: "inst-222" } });
  });

  it('credential "app": fails loudly when the App is not installed on the params owner', async () => {
    const { appDb, credentials } = await harness();
    // Installed on `acme` only; the action targets `other-org`.
    await seedAppAndUser(appDb, credentials);
    fixture = startGithubFixture({
      createInstallationToken: (id) => ({
        body: { token: `inst-${id}`, expires_at: new Date(NOW + 3600_000).toISOString() },
      }),
    });
    const invoke = buildActionInvoker({
      db: appDb,
      credentials,
      actionPluginByService: githubActionPluginByService(),
      githubTokenDeps: { key: deriveSecretKey("cache-key"), apiUrl: fixture.url, githubUrl: fixture.url, now: () => NOW },
    });

    const result = await invoke(
      {
        service: "github",
        action: "create_comment",
        params: { owner: "other-org", repo: "widgets" },
        invocationId: "workflow:r1:n2",
        credential: "app",
      },
      { userId, orgId, owner: { type: "user", id: userId } },
    );

    // No silent fallback to `user-tok` — the whole point of the strict tier.
    expect(result).toEqual({
      ok: false,
      error: "the GitHub App is not installed on other-org",
    });
  });

  it('credential "app": names the missing owner/repo parameters when the repo cannot be derived', async () => {
    const { appDb, credentials } = await harness();
    await seedAppAndUser(appDb, credentials);
    fixture = startGithubFixture();
    const invoke = buildActionInvoker({
      db: appDb,
      credentials,
      actionPluginByService: githubActionPluginByService(),
      githubTokenDeps: { key: deriveSecretKey("cache-key"), apiUrl: fixture.url, githubUrl: fixture.url, now: () => NOW },
    });

    const result = await invoke(
      { service: "github", action: "whoami", params: {}, invocationId: "workflow:r1:n3", credential: "app" },
      { userId, orgId, owner: { type: "user", id: userId } },
    );

    expect(result.ok).toBe(false);
    expect(result).toMatchObject({
      error: expect.stringContaining('Add "owner" and "repo"'),
    });
  });

  it('credential "auto" keeps the default precedence: the user credential still wins', async () => {
    const { appDb, credentials } = await harness();
    await seedAppAndUser(appDb, credentials);
    fixture = startGithubFixture();
    const invoke = buildActionInvoker({
      db: appDb,
      credentials,
      actionPluginByService: githubActionPluginByService(),
      githubTokenDeps: { key: deriveSecretKey("cache-key"), apiUrl: fixture.url, githubUrl: fixture.url, now: () => NOW },
    });

    const result = await invoke(
      {
        service: "github",
        action: "create_comment",
        params: { owner: "acme", repo: "widgets" },
        invocationId: "workflow:r1:n4",
        credential: "auto",
      },
      { userId, orgId, owner: { type: "user", id: userId } },
    );

    expect(result).toEqual({ ok: true, result: { token: "user-tok" } });
  });

  it('credential "user": fails loudly when the user has no connected GitHub account', async () => {
    const { appDb, credentials } = await harness();
    // App + installation exist, but no user credential — `user` must not
    // fall back to the installation.
    await saveAppConfig({ credentials }, orgId, appConfig);
    await appDb.insert(githubInstallations).values({
      id: "ghi_333",
      orgId,
      installationId: 333,
      accountLogin: "acme",
      accountType: "Organization",
      repositorySelection: "all",
      suspended: false,
      cachedToken: null,
      cachedTokenExpiresAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
    fixture = startGithubFixture();
    const invoke = buildActionInvoker({
      db: appDb,
      credentials,
      actionPluginByService: githubActionPluginByService(),
      githubTokenDeps: { key: deriveSecretKey("cache-key"), apiUrl: fixture.url, githubUrl: fixture.url, now: () => NOW },
    });

    const result = await invoke(
      {
        service: "github",
        action: "create_comment",
        params: { owner: "acme", repo: "widgets" },
        invocationId: "workflow:r1:n5",
        credential: "user",
      },
      { userId, orgId, owner: { type: "user", id: userId } },
    );

    expect(result).toEqual({
      ok: false,
      error: "no GitHub account is connected for this user",
    });
  });

  it("non-github service is untouched: no githubTokenDeps required, resolveGitHubToken never consulted", async () => {
    const store = new FakeCredentialStore();
    store.seed({ type: "user", id: "u1" }, "demo", { type: "api_key", apiKey: "secret-token" });
    const fixture2 = countingAction();
    const actionPluginByService = actionPluginByServiceOf("demo", { service: "demo", actions: [fixture2.action] });
    // githubTokenDeps deliberately omitted — a non-github action must not need it.
    const invoke = buildActionInvoker({ db: await makeDb(), credentials: store, actionPluginByService });

    const result = await invoke(
      { service: "demo", action: "ping", params: { msg: "hi" }, invocationId: "workflow:r1:n1" },
      userOwner,
    );

    expect(result).toEqual({ ok: true, result: { echoed: "hi", hasCredential: true } });
  });

  it("a non-github service refuses an app selection instead of ignoring it", async () => {
    const store = new FakeCredentialStore();
    store.seed({ type: "user", id: "u1" }, "demo", { type: "api_key", apiKey: "secret-token" });
    const fixture2 = countingAction();
    const actionPluginByService = actionPluginByServiceOf("demo", { service: "demo", actions: [fixture2.action] });
    const invoke = buildActionInvoker({ db: await makeDb(), credentials: store, actionPluginByService });

    const result = await invoke(
      { service: "demo", action: "ping", params: { msg: "hi" }, invocationId: "workflow:r1:n1", credential: "app" },
      userOwner,
    );

    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ error: expect.stringContaining("Remove the credential field") });
    // Refused before the action ran — an ignored selection would have let it
    // execute under the workflow owner's own credential.
    expect(fixture2.calls()).toBe(0);
  });
});

describe("buildActionInvoker: workflow policy enforcement (action-policies T3)", () => {
  const ORG = "org1";
  const RUN = "run_wf1";
  // A high-risk action: with no policy it defaults to require_approval.
  function highRiskAction() {
    let deployCount = 0;
    const inner = countingAction({
      id: "demo.deploy",
      execute: async () => {
        deployCount += 1;
        return { success: true as const, data: { deployed: true } };
      },
    });
    return {
      action: inner.action,
      calls: () => deployCount,
      lastArgs: inner.lastArgs,
    };
  }
  const highRiskPlugin = (a: PluginAction) => actionPluginByServiceOf("demo", {
    service: "demo",
    actions: [{ ...a, riskLevel: "critical" }],
  });
  const wfCtx: ActionInvocationContext = {
    userId: "u1", orgId: ORG, owner: { type: "user", id: "u1" }, workflowExecutionId: RUN,
  };

  it("require_approval (high-risk, no grant) returns requiresApproval and parks a pending audit row; action never runs", async () => {
    const db = await makeDb();
    const fixture = highRiskAction();
    const invoke = buildActionInvoker({ db, credentials: new FakeCredentialStore(), actionPluginByService: highRiskPlugin(fixture.action) });
    const res = await invoke({ service: "demo", action: "deploy", params: { msg: "x" }, invocationId: "workflow:run_wf1:n1" }, wfCtx);
    expect(res).toEqual({ ok: false, requiresApproval: true, riskLevel: "critical", provenance: "risk_default" });
    expect(fixture.calls()).toBe(0);
    const audit = await db.select().from(actionInvocations).where(eq(actionInvocations.workflowExecutionId, RUN));
    expect(audit).toHaveLength(1);
    expect(audit[0].status).toBe("pending");
    expect(audit[0].resolvedMode).toBe("require_approval");
  });

  it("an org deny fails the node as blocked; action never runs", async () => {
    const db = await makeDb();
    const fixture = highRiskAction();
    await db.insert(actionPolicies).values({
      id: "pd", orgId: ORG, principalType: "org", principalId: ORG,
      // Action-scope policies target the fully-qualified fqid — the ONE
      // canonical id both invocation paths resolve to (spec T6 #3, fixed).
      service: null, actionId: "demo.deploy", riskLevel: null, mode: "deny",
      paramMatchers: [], appliesIn: "any", origin: "settings", managedBy: null,
      expiresAt: null, revokedAt: null, createdAt: 1, updatedAt: 1,
    });
    const invoke = buildActionInvoker({ db, credentials: new FakeCredentialStore(), actionPluginByService: highRiskPlugin(fixture.action) });
    const res = await invoke({ service: "demo", action: "deploy", params: {}, invocationId: "workflow:run_wf1:n2" }, wfCtx);
    expect(res.ok).toBe(false);
    expect((res as { error: string }).error).toContain("blocked by org policy");
    expect(fixture.calls()).toBe(0);
  });

  it("an exec-scoped grant covers the action → it runs", async () => {
    const db = await makeDb();
    const fixture = highRiskAction();
    await db.insert(runtimeGrants).values({
      id: "gr", orgId: ORG, sessionId: null, workflowExecutionId: RUN,
      policyKey: grantPolicyKey("demo", "deploy"), mode: "allow", grantedBy: "u1", createdAt: 1, revokedAt: null,
    });
    const invoke = buildActionInvoker({ db, credentials: new FakeCredentialStore(), actionPluginByService: highRiskPlugin(fixture.action) });
    const res = await invoke({ service: "demo", action: "deploy", params: { msg: "x" }, invocationId: "workflow:run_wf1:n3" }, wfCtx);
    // The returned data proves the action executed (the grant quieted the gate).
    expect(res).toEqual({ ok: true, result: { deployed: true } });
    const audit = await db.select().from(actionInvocations).where(eq(actionInvocations.invocationId, "pol:wf:workflow:run_wf1:n3"));
    // The decision row is stamped with the execution outcome + full
    // PluginActionResult after execute (spec T6 #6, fixed).
    expect(audit[0].status).toBe("completed");
    expect(audit[0].result).toEqual({ success: true, data: { deployed: true } });
    expect(audit[0].matchedGrantId).toBe("gr");
  });

  it("dedup: a replayed invocationId writes exactly one audit row and never re-runs enforcement", async () => {
    const db = await makeDb();
    const fixture = highRiskAction();
    const invoke = buildActionInvoker({ db, credentials: new FakeCredentialStore(), actionPluginByService: highRiskPlugin(fixture.action) });
    const req = { service: "demo", action: "deploy", params: {}, invocationId: "workflow:run_wf1:n4" };
    const first = await invoke(req, wfCtx);
    const second = await invoke(req, wfCtx);
    expect(second).toEqual(first); // stored result row is authoritative
    const audit = await db.select().from(actionInvocations).where(eq(actionInvocations.invocationId, "pol:wf:workflow:run_wf1:n4"));
    expect(audit).toHaveLength(1);
  });

  // ── requiresApproval gate (Task 4) ──────────────────────────────────────

  it("require_approval with no approval field returns requiresApproval outcome and is NOT stored in the dedup table", async () => {
    const db = await makeDb();
    const fixture = highRiskAction();
    const invoke = buildActionInvoker({ db, credentials: new FakeCredentialStore(), actionPluginByService: highRiskPlugin(fixture.action) });
    const req = { service: "demo", action: "deploy", params: { msg: "x" }, invocationId: "workflow:run_wf1:n5" };
    const res = await invoke(req, wfCtx);
    expect(res).toEqual({ ok: false, requiresApproval: true, riskLevel: "critical", provenance: "risk_default" });
    // Gate outcomes must NOT land in the dedup table — an approved retry must
    // reach enforcement fresh (re-querying the current policy state).
    const rows = await db.select().from(actionInvocations).where(eq(actionInvocations.invocationId, req.invocationId));
    expect(rows).toHaveLength(0);
  });

  it("require_approval WITH the approval field executes and stamps audit row status approved", async () => {
    const db = await makeDb();
    const fixture = highRiskAction();
    const invoke = buildActionInvoker({ db, credentials: new FakeCredentialStore(), actionPluginByService: highRiskPlugin(fixture.action) });
    const req = {
      service: "demo",
      action: "deploy",
      params: { msg: "x" },
      invocationId: "workflow:run_wf1:n6",
      approval: { resolvedBy: "u1", note: "lgtm" },
    };
    const res = await invoke(req, wfCtx);
    expect(res).toEqual({ ok: true, result: { deployed: true } });
    expect(fixture.calls()).toBe(1);
    // The audit row is stamped "approved" on the policy side.
    const audit = await db.select().from(actionInvocations).where(eq(actionInvocations.invocationId, "pol:wf:workflow:run_wf1:n6"));
    expect(audit).toHaveLength(1);
    // persistInvocationAudit writes "approved" but updateInvocationOutcome
    // then stamps the final execution outcome ("completed"). Task 5 will assert
    // resolvedBy once that column lands.
    expect(audit[0].status).toBe("completed");
    // The dedup table holds the computed result so a re-drive returns it without re-running.
    const dedup = await db.select().from(actionInvocations).where(eq(actionInvocations.invocationId, req.invocationId));
    expect(dedup).toHaveLength(1);
  });

  it("resolver throw returns requiresApproval with provenance resolver_error; action never runs", async () => {
    const db = await makeDb();
    const fixture = highRiskAction();
    // Wrap db with a Proxy that throws on the second select call.
    // selectStoredResult (the dedup check) is the first select; policy
    // resolution (resolveActionPolicy) does the subsequent selects. Because
    // requiresApproval is returned without reaching the dedup insert, only two
    // select calls happen (initial dedup check + first policy table select).
    let selectCallCount = 0;
    const origSelect = db.select.bind(db);
    const failingDb: AppDb = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop !== "select") return Reflect.get(target, prop, receiver);
        return function (...args: unknown[]) {
          selectCallCount += 1;
          if (selectCallCount === 1) {
            // First select is selectStoredResult — let it through.
            return (origSelect as (...a: unknown[]) => unknown)(...args);
          }
          throw new Error("simulated db error during policy resolution");
        };
      },
    }) as AppDb;

    const invoke2 = buildActionInvoker({ db: failingDb, credentials: new FakeCredentialStore(), actionPluginByService: highRiskPlugin(fixture.action) });
    const res = await invoke2(
      { service: "demo", action: "deploy", params: { msg: "x" }, invocationId: "workflow:run_wf1:n7" },
      wfCtx,
    );
    expect(res).toEqual({ ok: false, requiresApproval: true, provenance: "resolver_error" });
    expect(fixture.calls()).toBe(0);
  });

  it("resolver_error + approval field executes on the signal's authority", async () => {
    const db = await makeDb();
    const fixture = highRiskAction();
    // Same failing db strategy: second select throws. With approval set,
    // enforceWorkflowPolicy catches the throw and returns null (proceed).
    // The action executes, then the dedup insert and re-select both use the
    // real db. Call order: 1=dedup-pre, 2=policy (throw), 3=dedup-post.
    // We allow calls 1 and 3, throw on 2.
    let selectCallCount = 0;
    const origSelect = db.select.bind(db);
    const failingDb: AppDb = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop !== "select") return Reflect.get(target, prop, receiver);
        return function (...args: unknown[]) {
          selectCallCount += 1;
          if (selectCallCount === 2) {
            throw new Error("simulated db error during policy resolution");
          }
          return (origSelect as (...a: unknown[]) => unknown)(...args);
        };
      },
    }) as AppDb;

    const invoke = buildActionInvoker({ db: failingDb, credentials: new FakeCredentialStore(), actionPluginByService: highRiskPlugin(fixture.action) });
    const res = await invoke(
      {
        service: "demo",
        action: "deploy",
        params: { msg: "x" },
        invocationId: "workflow:run_wf1:n8",
        approval: { resolvedBy: "u1" },
      },
      wfCtx,
    );
    // Resolver error + approval set → human resolution authorizes execution
    expect(res).toEqual({ ok: true, result: { deployed: true } });
    expect(fixture.calls()).toBe(1);
    // The resolver_error path writes a best-effort audit row before returning
    // null. Use the real db (not failingDb) to query — the proxy only
    // intercepts selects, but this verifies the insert/update went through
    // on the real backing store.
    const audit = await db.select().from(actionInvocations).where(eq(actionInvocations.invocationId, "pol:wf:workflow:run_wf1:n8"));
    expect(audit).toHaveLength(1);
    // updateInvocationOutcome stamps the final execution outcome after the
    // action runs, so the row ends as "completed" even though the audit
    // insert wrote "approved".
    expect(audit[0].status).toBe("completed");
    expect(audit[0].resolvedMode).toBe("require_approval");
  });

  it("parseStoredResult rejects a stored requiresApproval row (defensive: such rows must never exist)", async () => {
    const db = await makeDb();
    // Seed a row with { ok: false, requiresApproval: true } directly
    await db.insert(actionInvocations).values({
      invocationId: "corrupt:n9",
      result: { ok: false, requiresApproval: true },
      createdAt: Date.now(),
    });
    const invoke = buildActionInvoker({ db, credentials: new FakeCredentialStore(), actionPluginByService: highRiskPlugin(highRiskAction().action) });
    // A stored requiresApproval result is corrupt — such rows must never be persisted,
    // but if one exists the invoker must throw rather than silently returning it.
    await expect(
      invoke({ service: "demo", action: "deploy", params: { msg: "x" }, invocationId: "corrupt:n9" }, wfCtx),
    ).rejects.toThrow("corrupt stored result");
  });
});
