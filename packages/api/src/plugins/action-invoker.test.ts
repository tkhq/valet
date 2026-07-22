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
import { sessionRepos, githubInstallations } from "../schema/index.js";
import { startGithubFixture, type GithubFixture } from "../test-helpers/github-fixture.js";
import { PgCredentialStore } from "./credential-store.js";
import { saveAppConfig, type GithubAppConfig } from "../services/github-app.js";
import type { OnePasswordCtx, OnePasswordService } from "../services/onepassword.js";
import { buildActionInvoker, type ActionInvocationContext } from "./action-invoker.js";

/** Fake `OnePasswordService` — only `resolveCredential` is exercised by the invoker's credential providers. */
function fakeOnePassword(
  resolveCredential: OnePasswordService["resolveCredential"],
): OnePasswordService {
  const unused = () => {
    throw new Error("not exercised by this suite");
  };
  return {
    tokenConnected: unused,
    listVaults: unused,
    listItems: unused,
    getItem: unused,
    resolveReference: unused,
    resolveCredential,
  };
}

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

  it("owner-precedence contract (Task 6): a user-owned run resolves a 1Password reference row through onePassword", async () => {
    const store = new FakeCredentialStore();
    store.seed({ type: "user", id: "u1" }, "demo", {
      type: "api_key",
      metadata: { onepassword: { reference: "op://vault/item/field", tokenScope: "org" } },
    });
    let sawCtx: OnePasswordCtx | undefined;
    const onePassword = fakeOnePassword(async (row, ctx) => {
      sawCtx = ctx;
      return { type: row.type, metadata: row.metadata, apiKey: "resolved-user-secret" };
    });
    const fixture = countingAction();
    const actionPluginByService = actionPluginByServiceOf("demo", { service: "demo", actions: [fixture.action] });
    const invoke = buildActionInvoker({ db: await makeDb(), credentials: store, actionPluginByService, onePassword });

    const result = await invoke(
      { service: "demo", action: "ping", params: { msg: "hi" }, invocationId: "workflow:r1:n1" },
      userOwner,
    );

    expect(result).toEqual({ ok: true, result: { echoed: "hi", hasCredential: true } });
    expect(sawCtx).toEqual({ orgId: "org1", userId: "u1" });
  });

  it("owner-precedence contract (Task 6): an org-owned run resolves the org row's 1Password reference through onePassword", async () => {
    const store = new FakeCredentialStore();
    store.seed({ type: "org", id: "org1" }, "demo", {
      type: "api_key",
      metadata: { onepassword: { reference: "op://Shared/Acme/credential", tokenScope: "org" } },
    });
    let sawCtx: OnePasswordCtx | undefined;
    const onePassword = fakeOnePassword(async (row, ctx) => {
      sawCtx = ctx;
      return { type: row.type, metadata: row.metadata, apiKey: "resolved-org-secret" };
    });
    const fixture = countingAction();
    const actionPluginByService = actionPluginByServiceOf("demo", { service: "demo", actions: [fixture.action] });
    const invoke = buildActionInvoker({ db: await makeDb(), credentials: store, actionPluginByService, onePassword });

    const result = await invoke(
      { service: "demo", action: "ping", params: { msg: "hi" }, invocationId: "workflow:r1:n1" },
      { userId: "u1", orgId: "org1", owner: { type: "org", id: "org1" } },
    );

    expect(result).toEqual({ ok: true, result: { echoed: "hi", hasCredential: true } });
    expect(sawCtx).toEqual({ orgId: "org1", userId: "u1" });
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

  function githubActionPluginByService(): Map<string, { plugin: ValetPlugin; actionPlugin: ActionPlugin }> {
    return actionPluginByServiceOf("github", { service: "github", actions: [githubWhoamiAction()] });
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
});
