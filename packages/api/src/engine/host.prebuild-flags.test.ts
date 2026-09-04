/**
 * Unit coverage for `prebuildFlagsTarget` — the guard that decides whether
 * `resolveRepoPrebuildFlags` reads `.valet/prebuild.yaml` for a session
 * (TKAI-385).
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
import type {
  ExecResult,
  Sandbox,
  SandboxCapabilities,
  SandboxCreateOpts,
  SandboxProvider,
  SandboxStatus,
} from "@valet/engine";
import type { AppDb } from "../lib/drizzle.js";
import { freshTestPgDb, type TestPgDb } from "../test-helpers/pg-test-db.js";
import { agentSessions, githubInstallations, sessionRepos } from "../schema/index.js";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { startGithubFixture, contentsBody, type GithubFixture } from "../test-helpers/github-fixture.js";
import { clearRepoPrebuildFlagsCache } from "../bakes/source-service.js";
import { saveAppConfig, type GithubAppConfig } from "../services/github-app.js";
import { deriveSecretKey } from "../lib/secret-crypto.js";
import { loadSessionMeta } from "./session-meta.js";
import { prebuildFlagsTarget } from "./host.js";
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

describe("prebuildFlagsTarget", () => {
  it('host "github" (the session_repos schema default) resolves — the TKAI-385 regression', () => {
    const target = prebuildFlagsTarget([binding({ host: "github" })]);
    expect(target).toEqual({ ok: true, owner: "acme", repo: "widgets", ref: "HEAD" });
  });

  it('host "github.com" (hand-built metas) also resolves', () => {
    const target = prebuildFlagsTarget([binding({ host: "github.com" })]);
    expect(target).toEqual({ ok: true, owner: "acme", repo: "widgets", ref: "HEAD" });
  });

  it("absent host defaults to GitHub", () => {
    const target = prebuildFlagsTarget([binding()]);
    expect(target).toEqual({ ok: true, owner: "acme", repo: "widgets", ref: "HEAD" });
  });

  it("a bound ref is passed through", () => {
    const target = prebuildFlagsTarget([binding({ host: "github", ref: "release-1.2" })]);
    expect(target).toEqual({ ok: true, owner: "acme", repo: "widgets", ref: "release-1.2" });
  });

  it("a non-GitHub host is skipped with the host named", () => {
    const target = prebuildFlagsTarget([binding({ host: "gitlab.example.com" })]);
    expect(target).toEqual({ ok: false, reason: "non-github-host", host: "gitlab.example.com" });
  });

  it("no repo bindings → no-repo", () => {
    expect(prebuildFlagsTarget(undefined)).toEqual({ ok: false, reason: "no-repo" });
    expect(prebuildFlagsTarget([])).toEqual({ ok: false, reason: "no-repo" });
  });

  it("a fullName without owner/name parts → bad-full-name", () => {
    const target = prebuildFlagsTarget([binding({ fullName: "widgets" })]);
    expect(target).toEqual({ ok: false, reason: "bad-full-name" });
  });
});

describe("prebuildFlagsTarget over loadSessionMeta (session_repos schema default)", () => {
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
    const target = prebuildFlagsTarget(meta.repos);
    expect(target).toEqual({ ok: true, owner: "tkhq", repo: "mono", ref: "HEAD" });
  });
});

/** Enough of a Sandbox that workspace prep's exec/read/write calls succeed
 * (same shape as `host.prebuild.test.ts`'s PrepFriendlySandbox). */
class PrepFriendlySandbox implements Sandbox {
  constructor(readonly id: string) {}
  async readFile(): Promise<string> {
    return "";
  }
  async readBinary(): Promise<Uint8Array> {
    return new Uint8Array();
  }
  async writeFile(): Promise<void> {}
  async writeBinary(): Promise<void> {}
  async readdir(): Promise<string[]> {
    return [];
  }
  async stat(): Promise<{ isFile: boolean; isDirectory: boolean; size: number }> {
    throw new Error("ENOENT");
  }
  async mkdir(): Promise<void> {}
  async rm(): Promise<void> {}
  async exec(): Promise<ExecResult> {
    return { stdout: "", stderr: "", exitCode: 0 };
  }
  async destroy(): Promise<void> {}
}

class RecordingSandboxProvider implements SandboxProvider {
  readonly backend = "recording-test";
  readonly createCalls: SandboxCreateOpts[] = [];
  private sandboxes = new Map<string, PrepFriendlySandbox>();
  private nextId = 1;

  capabilities(): SandboxCapabilities {
    return {
      snapshot: "none",
      persistentWorkspace: true,
      tunnels: false,
      warmPool: false,
      hibernation: false,
      customImage: true,
    };
  }

  async create(opts: SandboxCreateOpts): Promise<Sandbox> {
    this.createCalls.push(opts);
    const id = `rec-${this.nextId++}`;
    const sb = new PrepFriendlySandbox(id);
    this.sandboxes.set(id, sb);
    return sb;
  }
  async restore(id: string): Promise<Sandbox> {
    const sb = this.sandboxes.get(id);
    if (!sb) throw new Error(`recording sandbox not found: ${id}`);
    return sb;
  }
  async destroy(id: string): Promise<void> {
    this.sandboxes.delete(id);
  }
  async status(id: string): Promise<SandboxStatus> {
    return this.sandboxes.has(id) ? { id, state: "ready", startedAt: Date.now() } : { id, state: "released" };
  }
}

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
  });
});
