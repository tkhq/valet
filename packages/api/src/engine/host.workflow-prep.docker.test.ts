/**
 * Docker-gated end-to-end check that a workflow session's sandbox can
 * authenticate `git push` (2026-09-21/22 incident). A team-owned workflow's
 * `session` node created a branch through the `github.create_branch` tool,
 * but its in-sandbox `git push` never landed. `buildWorkflowSession` wired no
 * `specProvider`, so the sandbox never ran workspace prep and had no git
 * credential helper.
 *
 * The test boots the API over HTTP with real auth (no `VALET_LOCAL_AUTH`
 * stub) and a real `DockerSandboxProvider`. It builds the session a team run
 * builds and provisions its container. Inside the container it runs
 * `git credential fill`, the request git makes before a push. The installed
 * helper must call `/api/sandbox/git-credential` with the session's sandbox
 * token, and the route must return the org's App installation token, which
 * the token service mints through a fake GitHub. It then asks the route
 * what the `gh` shim asks (`purpose: "api"`), whose coding-session ladder
 * puts a user's own credential first. Both answers must be the installation
 * token, and the git identity must be the generic one, for a scheduled run
 * and for a run a member started by hand, even when that member has a
 * profile and a personal GitHub credential of their own.
 *
 * Skipped when docker is unreachable or `CI` is set, as
 * `workspace-prep.docker.test.ts` requires. The shared GitHub runner does
 * not preload the sandbox image or expose the host-gateway route that the
 * container needs to call the test API. CI still runs the recording-provider
 * prep tests and route tests. Those tests cover helper installation, the
 * exact `tkhq/docs` request, scheduled owners, manual actors, and identity
 * isolation without a Docker daemon. The container here uses the provider's
 * default image (`node:20-bookworm`, which ships git and curl).
 */
import { describe, it, expect, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { rm } from "node:fs/promises";
import { createSandboxWorkspace, DockerSandboxProvider } from "@valet/sandbox-docker";
import type { Sandbox, SandboxCreateOpts } from "@valet/engine";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { startGithubFixture, type GithubFixture } from "../test-helpers/github-fixture.js";
import { seedWorkflowRun } from "../test-helpers/workflow-run.js";
import { saveAppConfig, type GithubAppConfig } from "../services/github-app.js";
import { verifySandboxToken } from "../auth/sandbox-tokens.js";
import { githubInstallations, orgs, teams, users } from "../schema/index.js";

function dockerAvailable(): boolean {
  const r = spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], { stdio: "pipe" });
  return r.status === 0;
}

const dockerHere = dockerAvailable();
// Skip in CI: the GitHub runner's docker daemon lacks the base image and
// the host-gateway setup this test needs. `CI` is set by GitHub Actions.
const describeDocker = dockerHere && !process.env.CI ? describe : describe.skip;

const ORG = "org-wf-prep";
const TEAM = "team-1";
const MEMBER = "local-user";
const INSTALLATION_ID = 4242;
const INSTALLATION_TOKEN = `ghs_fixture_installation_${INSTALLATION_ID}`;
const HELPER_PATH = "/usr/local/bin/git-credential-valet";
const MINT_PATH = `/app/installations/${INSTALLATION_ID}/access_tokens`;

const { privateKey: privateKeyPem } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

const APP_CONFIG: GithubAppConfig = {
  appId: "1",
  appSlug: "valet-app",
  oauthClientId: "Iv1.abc",
  htmlUrl: "https://github.com/apps/valet-app",
  oauthClientSecret: "client-secret",
  webhookSecret: "webhook-secret",
  privateKeyPem,
};

/** Records the id of every sandbox it creates, so `afterEach` can remove a
 * container that a failed run left behind. */
class TrackingDockerProvider extends DockerSandboxProvider {
  readonly createdIds: string[] = [];

  override async create(opts: SandboxCreateOpts): Promise<Sandbox> {
    const sandbox = await super.create(opts);
    this.createdIds.push(sandbox.id);
    return sandbox;
  }
}

/** The key/value lines `git credential fill` prints, as a map. */
function credentialFields(stdout: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const line of stdout.split("\n")) {
    const eq = line.indexOf("=");
    if (eq > 0) fields[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return fields;
}

let api: TestApi | undefined;
let fixture: GithubFixture | undefined;
let provider: TrackingDockerProvider | undefined;
let workspace: string | undefined;
const prevGithubApiUrl = process.env.GITHUB_API_URL;

afterEach(async () => {
  await api?.cleanup();
  api = undefined;
  if (provider) {
    for (const id of provider.createdIds) await provider.destroy(id).catch(() => {});
  }
  provider = undefined;
  await fixture?.close();
  fixture = undefined;
  if (workspace) await rm(workspace, { recursive: true, force: true });
  workspace = undefined;
  if (prevGithubApiUrl === undefined) delete process.env.GITHUB_API_URL;
  else process.env.GITHUB_API_URL = prevGithubApiUrl;
});

/** Boots the API against a real docker provider, with an App installed on
 * `tkhq` in `ORG`, and returns the running API. */
async function bootWithApp(): Promise<TestApi> {
  fixture = startGithubFixture({
    createInstallationToken: () => ({
      body: { token: INSTALLATION_TOKEN, expires_at: new Date(Date.now() + 3600_000).toISOString() },
    }),
  });
  // The credential route builds its token deps from the providers, with no
  // API base override, so the installation mint reads this variable.
  process.env.GITHUB_API_URL = fixture.url;

  provider = new TrackingDockerProvider();
  const booted = await bootTestApi({ auth: true, sandboxProvider: provider, sandboxApiHost: "host.docker.internal" });
  const { db, engineCredentials } = booted.providers;
  const now = Date.now();
  await db.insert(orgs).values({ id: ORG, name: "Workflow Prep Org", createdAt: now });
  await db.insert(teams).values({ id: TEAM, orgId: ORG, name: "DSE", createdAt: now });
  await saveAppConfig({ credentials: engineCredentials }, ORG, APP_CONFIG);
  await db.insert(githubInstallations).values({
    id: `ghi_${INSTALLATION_ID}`,
    orgId: ORG,
    installationId: INSTALLATION_ID,
    accountLogin: "tkhq",
    accountType: "Organization",
    repositorySelection: "all",
    suspended: false,
    cachedToken: null,
    cachedTokenExpiresAt: null,
    createdAt: now,
    updatedAt: now,
  });
  return booted;
}

/** Provisions the workflow session's container and reports what git sees in
 * it, including the answer to the credential request a push makes. */
async function observeSandbox(sessionId: string, actorUserId: string) {
  workspace = await createSandboxWorkspace("valet-wf-prep-");
  const session = await api!.providers.engineHost.workflowSessionFor(sessionId, {
    actorUserId,
    orgId: ORG,
    owner: { type: "team", id: TEAM },
    workspace,
  });
  const { sandbox } = await session.attachment.ensureReady({ timeoutMs: 120_000 });

  const helperPath = await sandbox.exec("command -v git-credential-valet");
  const credentialHelper = await sandbox.exec("git config --global --get credential.helper");
  const useHttpPath = await sandbox.exec("git config --global --get credential.useHttpPath");
  const userName = await sandbox.exec("git config --global user.name");
  const userEmail = await sandbox.exec("git config --global user.email");

  const mintsBefore = fixture!.calls.filter((c) => c.method === "POST" && c.path === MINT_PATH).length;
  // What git asks the credential helpers before it pushes to
  // https://github.com/tkhq/docs.git. With no prompt allowed, git fails
  // unless a helper answers.
  const fill = await sandbox.exec(
    "printf 'protocol=https\\nhost=github.com\\npath=tkhq/docs.git\\n\\n' | GIT_TERMINAL_PROMPT=0 git credential fill",
  );
  const mintsAfter = fixture!.calls.filter((c) => c.method === "POST" && c.path === MINT_PATH).length;
  const fields = credentialFields(fill.stdout);
  const token = await sandbox.exec("cat /etc/valet/creds/token");
  // The request the `gh` shim makes, sent from inside the container with the
  // same sandbox token.
  const ghAsk = await sandbox.exec(
    'curl -fsS -X POST "$VALET_API_URL/api/sandbox/git-credential" ' +
      '-H "x-valet-sandbox: $(cat /etc/valet/creds/token)" -H "Content-Type: application/json" ' +
      `-d '{"host":"github.com","owner":"tkhq","repo":"docs","purpose":"api"}'`,
  );
  let ghPassword: unknown;
  try {
    ghPassword = (JSON.parse(ghAsk.stdout) as { password?: unknown }).password;
  } catch {
    ghPassword = `unparseable: ${ghAsk.stdout.trim()} ${ghAsk.stderr.trim()}`;
  }

  return {
    observed: {
      containers: provider!.createdIds.length,
      helperPath: helperPath.stdout.trim(),
      credentialHelper: credentialHelper.stdout.trim(),
      useHttpPath: useHttpPath.stdout.trim(),
      userName: userName.stdout.trim(),
      userEmail: userEmail.stdout.trim(),
      fillExitCode: fill.exitCode,
      fillStderr: fill.stderr.trim(),
      username: fields.username,
      password: fields.password,
      installationMints: mintsAfter - mintsBefore,
      ghPassword,
    },
    sandboxToken: token.stdout.trim(),
  };
}

/** A team run pushes as the App under the generic identity, whoever started it. */
const EXPECTED = {
  containers: 1,
  helperPath: HELPER_PATH,
  credentialHelper: HELPER_PATH,
  useHttpPath: "true",
  userName: "Valet Agent",
  userEmail: "agent@valet.local",
  fillExitCode: 0,
  fillStderr: "",
  username: "x-access-token",
  password: INSTALLATION_TOKEN,
  installationMints: 1,
  ghPassword: INSTALLATION_TOKEN,
};

describeDocker("workflow session sandbox prep (docker)", () => {
  it(
    "a scheduled team run's sandbox authenticates git through the App installation",
    async () => {
      api = await bootWithApp();
      // A scheduled start records no actor, so `resolveRunContext`
      // synthesizes `team:<id>`.
      const sessionId = await seedWorkflowRun(api.providers.db, {
        runId: "wfrun_e2e_sched", orgId: ORG, owner: { type: "team", id: TEAM },
      });

      const { observed, sandboxToken } = await observeSandbox(sessionId, `team:${TEAM}`);
      // One comparison, so a failure prints every observation at once.
      expect(observed).toEqual(EXPECTED);

      // The helper reads its sandbox token from the creds mount. That token
      // resolves to this workflow session and the synthesized team actor.
      expect(await verifySandboxToken(api.providers.db, sandboxToken)).toEqual({
        sessionId,
        userId: `team:${TEAM}`,
        orgId: ORG,
      });

      // Real auth is on, so the route answers nothing without that token.
      const anonymous = await fetch(`${api.baseUrl}/api/sandbox/git-credential`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ host: "github.com", owner: "tkhq", repo: "docs" }),
      });
      expect(anonymous.status).toBe(401);
    },
    240_000,
  );

  it(
    "a team run a member started pushes as the App under the generic identity, not as the member",
    async () => {
      api = await bootWithApp();
      // The member has a profile and a personal GitHub credential. Neither
      // may reach a team-owned run's sandbox. (`auth: true` seeds no user,
      // so the profile row is written here.)
      await api.providers.db.insert(users).values({
        id: MEMBER, name: "Team Member", email: "member@example.test", role: "member",
      });
      await api.providers.engineCredentials.save({ type: "user", id: MEMBER }, "github", {
        type: "oauth2",
        accessToken: "ghp_member_personal",
        metadata: { login: "member" },
      });
      const sessionId = await seedWorkflowRun(api.providers.db, {
        runId: "wfrun_e2e_manual", orgId: ORG, owner: { type: "team", id: TEAM }, actorUserId: MEMBER,
      });

      const { observed, sandboxToken } = await observeSandbox(sessionId, MEMBER);
      expect(observed).toEqual(EXPECTED);
      // The token still names the member (it is the run context's actor);
      // the route resolves by the run's owner instead.
      expect((await verifySandboxToken(api.providers.db, sandboxToken))?.userId).toBe(MEMBER);
    },
    240_000,
  );
});
