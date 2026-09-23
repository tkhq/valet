/**
 * `POST /api/sandbox/git-credential` (GitHub/repo integration plan, Task 8).
 * Route-level: real Hono app via `bootTestApi`, a minted sandbox token for
 * auth, and `session_repos` bindings seeded directly. The credential path
 * uses a seeded PAT-shaped user credential so no GitHub fixture/network is
 * involved (a no-expiry/no-refresh credential resolves without a health call
 * — see `services/github-tokens.ts`'s `resolveUserCredential`).
 *
 * Security pins here: garbage/missing sandbox token 401; token appears ONLY
 * in the response body (never any console call); an explicit-auth binding
 * with no credential 409s rather than silently downgrading to anonymous;
 * case-insensitive owner match; an unbound owner falls back to ORG-LEVEL
 * `auto` resolution (never a binding's explicit auth), degrading to
 * anonymous when nothing resolves; unrecognized hosts 403.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { mintSandboxToken } from "../auth/sandbox-tokens.js";
import { agentSessions, gitPushOperations, githubInstallations, orgs, sessionGitBranches, sessionPullRequests, sessionRepos, teams, workflowDefinitions, workflowRuns } from "../schema/index.js";
import { saveAppConfig } from "../services/github-app.js";
import { startGithubFixture, type GithubFixture } from "../test-helpers/github-fixture.js";
import { seedWorkflowRun } from "../test-helpers/workflow-run.js";
import type { PostSandboxGitCredentialResponse, SandboxGitCredential } from "../wire/types.js";

const HEADERS = { "Content-Type": "application/json" };
const SESSION_ID = "sess-git-cred-1";

let api: TestApi | undefined;

afterEach(async () => {
  await api?.cleanup();
  api = undefined;
  vi.restoreAllMocks();
});

async function mintToken(sessionId = SESSION_ID): Promise<string> {
  const { token } = await mintSandboxToken(api!.providers.db, {
    sessionId,
    userId: "local-user",
    orgId: "local-org",
  });
  return token;
}

async function bindRepo(
  overrides: Partial<typeof sessionRepos.$inferInsert> = {},
): Promise<void> {
  await api!.providers.db.insert(sessionRepos).values({
    sessionId: SESSION_ID,
    host: "github",
    fullName: "acme/widgets",
    cloneUrl: "https://github.com/acme/widgets.git",
    ref: null,
    auth: "auto",
    position: 0,
    ...overrides,
  });
}

async function saveUserCredential(accessToken: string, login = "octocat"): Promise<void> {
  // No expiresAt / refreshToken → PAT-shaped, resolves without a network call.
  await api!.providers.engineCredentials.save({ type: "user", id: "local-user" }, "github", {
    type: "oauth2",
    accessToken,
    metadata: { login },
  });
}

function post(token: string | undefined, body: unknown): Promise<Response> {
  const headers: Record<string, string> = { ...HEADERS };
  if (token !== undefined) headers["x-valet-sandbox"] = token;
  return fetch(`${api!.baseUrl}/api/sandbox/git-credential`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

describe("POST /api/sandbox/git-credential", () => {
  it("returns {username, password} for a bound owner with a usable credential", async () => {
    api = await bootTestApi();
    await bindRepo();
    await saveUserCredential("ghp_super_secret_token");
    const token = await mintToken();

    const res = await post(token, { host: "github.com", owner: "acme" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as SandboxGitCredential;
    // git purpose → GitHub's documented Basic-Auth username convention.
    expect(body.username).toBe("x-access-token");
    expect(body.password).toBe("ghp_super_secret_token");
  });

  it("matches the bound owner case-insensitively", async () => {
    api = await bootTestApi();
    await bindRepo({ fullName: "Acme/Widgets", cloneUrl: "https://github.com/Acme/Widgets.git" });
    await saveUserCredential("ghp_case_token");
    const token = await mintToken();

    const res = await post(token, { host: "github.com", owner: "acme" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as SandboxGitCredential;
    expect(body.password).toBe("ghp_case_token");
  });

  it("passes through anonymous when auto binding has no credential", async () => {
    api = await bootTestApi();
    await bindRepo({ auth: "auto" });
    const token = await mintToken();

    const res = await post(token, { host: "github.com", owner: "acme" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as PostSandboxGitCredentialResponse;
    expect(body).toEqual({ anonymous: true });
  });

  it("two same-owner bindings with different auth each resolve with THEIR binding (matched by repo)", async () => {
    api = await bootTestApi();
    // Same owner, DIFFERENT auth. Position-0 is `auto` (would win an owner-only
    // match); position-1 is explicit `user`. No user credential is connected,
    // so the two bindings must diverge: `auto` → anonymous, `user` → 409.
    await api.providers.db.insert(sessionRepos).values([
      {
        sessionId: SESSION_ID,
        host: "github",
        fullName: "acme/alpha",
        cloneUrl: "https://github.com/acme/alpha.git",
        ref: null,
        auth: "auto",
        position: 0,
      },
      {
        sessionId: SESSION_ID,
        host: "github",
        fullName: "acme/beta",
        cloneUrl: "https://github.com/acme/beta.git",
        ref: null,
        auth: "user",
        position: 1,
      },
    ]);
    const token = await mintToken();

    // repo=beta must select the position-1 `user` binding → 409, NOT the
    // position-0 `auto` binding an owner-only match would have picked.
    const betaRes = await post(token, { host: "github.com", owner: "acme", repo: "beta" });
    expect(betaRes.status).toBe(409);

    // repo=alpha selects the `auto` binding → anonymous passthrough.
    const alphaRes = await post(token, { host: "github.com", owner: "acme", repo: "alpha" });
    expect(alphaRes.status).toBe(200);
    expect((await alphaRes.json()) as PostSandboxGitCredentialResponse).toEqual({ anonymous: true });

    // repo absent → falls back to the first owner match (position-0 `auto`).
    const noRepoRes = await post(token, { host: "github.com", owner: "acme" });
    expect(noRepoRes.status).toBe(200);
    expect((await noRepoRes.json()) as PostSandboxGitCredentialResponse).toEqual({ anonymous: true });

    // repo present but unmatched → same owner-only fallback (position-0 `auto`).
    const unmatchedRes = await post(token, { host: "github.com", owner: "acme", repo: "ghost" });
    expect(unmatchedRes.status).toBe(200);
    expect((await unmatchedRes.json()) as PostSandboxGitCredentialResponse).toEqual({ anonymous: true });
  });

  it("unbound owner falls back to org-level auto resolution (user credential tier)", async () => {
    api = await bootTestApi();
    await bindRepo();
    await saveUserCredential("ghp_org_fallback_token");
    const token = await mintToken();

    // "someone-else" matches no binding — pre-fallback this 403'd. Now it
    // resolves through the org-level auto ladder (no installation for that
    // owner → the user's own credential), so an orchestrator sandbox can
    // clone repos its session never bound.
    const res = await post(token, { host: "github.com", owner: "someone-else" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as SandboxGitCredential;
    expect(body.username).toBe("x-access-token");
    expect(body.password).toBe("ghp_org_fallback_token");
  });

  it("unbound owner with nothing configured degrades to anonymous (public clone proceeds)", async () => {
    api = await bootTestApi();
    const token = await mintToken();

    const res = await post(token, { host: "github.com", owner: "someone-else" });
    expect(res.status).toBe(200);
    expect((await res.json()) as PostSandboxGitCredentialResponse).toEqual({ anonymous: true });
  });

  it("ownerless request (gh shim outside a repo, purpose=api) resolves org-level", async () => {
    api = await bootTestApi();
    await saveUserCredential("ghp_gh_shim_token", "octocat");
    const token = await mintToken();

    const res = await post(token, { host: "github.com", purpose: "api" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as SandboxGitCredential;
    // api purpose surfaces the credential's own login as the username.
    expect(body.username).toBe("octocat");
    expect(body.password).toBe("ghp_gh_shim_token");
  });

  it("403s for an unrecognized host with no binding", async () => {
    api = await bootTestApi();
    await saveUserCredential("ghp_wrong_host");
    const token = await mintToken();

    const res = await post(token, { host: "gitlab.example.com", owner: "someone" });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("no credential host for this repo");
  });

  it("409s (not anonymous) when an explicit-auth binding has no eligible credential", async () => {
    api = await bootTestApi();
    // `auth: "user"` with no user credential connected → the port returns
    // null (GitHubAuthError), which must surface as a visible 409 rather
    // than silently degrading to a tokenless clone.
    await bindRepo({ auth: "user" });
    const token = await mintToken();

    const res = await post(token, { host: "github.com", owner: "acme" });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("acme");
  });

  it("401s on a garbage sandbox token", async () => {
    api = await bootTestApi();
    await bindRepo();
    const res = await post("st_not_a_real_token", { host: "github.com", owner: "acme" });
    expect(res.status).toBe(401);
  });

  it("401s when the sandbox token header is missing", async () => {
    api = await bootTestApi();
    await bindRepo();
    const res = await post(undefined, { host: "github.com", owner: "acme" });
    expect(res.status).toBe(401);
  });

  it("emits the token only in the response body — never to any console call", async () => {
    api = await bootTestApi();
    await bindRepo();
    const secret = "ghp_never_logged_ABC123";
    await saveUserCredential(secret);
    const token = await mintToken();

    const spies = [
      vi.spyOn(console, "log").mockImplementation(() => {}),
      vi.spyOn(console, "info").mockImplementation(() => {}),
      vi.spyOn(console, "warn").mockImplementation(() => {}),
      vi.spyOn(console, "error").mockImplementation(() => {}),
      vi.spyOn(console, "debug").mockImplementation(() => {}),
    ];

    const res = await post(token, { host: "github.com", owner: "acme" });
    const text = await res.text();
    expect(text).toContain(secret);

    for (const spy of spies) {
      for (const call of spy.mock.calls) {
        for (const arg of call) {
          expect(String(arg)).not.toContain(secret);
        }
      }
    }
  });

  it("400s on a body missing host (owner is optional now)", async () => {
    api = await bootTestApi();
    await bindRepo();
    const token = await mintToken();
    const res = await post(token, { owner: "acme" });
    expect(res.status).toBe(400);
  });
});


// ── Workflow sessions act as their run's owner ─────────────────────────────
//
// A `session` node's sandbox token carries the run actor: the member who
// clicked Run, or a synthetic `team:{id}` for a scheduled start. Credential
// resolution must follow the run's owner instead (`workflow_runs.actor_user_id`
// is display and audit only), and a team or org owner must resolve the way
// that session's own `github.*` tools do: the team's row, then the App
// installation, never a member credential and never the org PAT.
describe("POST /api/sandbox/git-credential for workflow sessions", () => {
  const ORG = "local-org";
  const TEAM = { type: "team" as const, id: "team-1" };
  const INSTALLATION_TOKEN = "ghs_fixture_installation_77";
  let fixture: GithubFixture | undefined;
  const prevGithubApiUrl = process.env.GITHUB_API_URL;

  afterEach(async () => {
    await fixture?.close();
    fixture = undefined;
    if (prevGithubApiUrl === undefined) delete process.env.GITHUB_API_URL;
    else process.env.GITHUB_API_URL = prevGithubApiUrl;
  });

  async function tokenFor(sessionId: string, userId: string): Promise<string> {
    await api!.providers.db.insert(teams).values({
      id: TEAM.id,
      orgId: ORG,
      name: "Test team",
      createdAt: Date.now(),
    }).onConflictDoNothing();
    const { token } = await mintSandboxToken(api!.providers.db, { sessionId, userId, orgId: ORG });
    return token;
  }

  async function saveSyntheticUserCredential(userId: string, accessToken: string): Promise<void> {
    await api!.providers.engineCredentials.save({ type: "user", id: userId }, "github", {
      type: "oauth2",
      accessToken,
    });
  }

  async function saveOrgPat(accessToken: string): Promise<void> {
    await api!.providers.engineCredentials.save({ type: "org", id: ORG }, "github", {
      type: "oauth2",
      accessToken,
      metadata: { login: "org-pat-bot" },
    });
  }

  /** An App with one installation, on `accountLogin`, that mints `INSTALLATION_TOKEN`. */
  async function installApp(accountLogin: string): Promise<void> {
    fixture = startGithubFixture({
      createInstallationToken: () => ({
        body: { token: INSTALLATION_TOKEN, expires_at: new Date(Date.now() + 3_600_000).toISOString() },
      }),
    });
    // The route builds its token deps from the providers, with no API base
    // override, so the installation mint reads this variable.
    process.env.GITHUB_API_URL = fixture.url;
    const { privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    await saveAppConfig({ credentials: api!.providers.engineCredentials }, ORG, {
      appId: "1",
      appSlug: "valet-app",
      oauthClientId: "Iv1.abc",
      htmlUrl: "https://github.com/apps/valet-app",
      oauthClientSecret: "client-secret",
      webhookSecret: "webhook-secret",
      privateKeyPem: privateKey,
    });
    const now = Date.now();
    await api!.providers.db.insert(githubInstallations).values({
      id: "ghi_77",
      orgId: ORG,
      installationId: 77,
      accountLogin,
      accountType: "Organization",
      repositorySelection: "all",
      suspended: false,
      cachedToken: null,
      cachedTokenExpiresAt: null,
      createdAt: now,
      updatedAt: now,
    });
  }

  it("a team run a member started never resolves that member's credential or the org PAT", async () => {
    api = await bootTestApi();
    await saveUserCredential("ghp_member_personal");
    await saveOrgPat("ghp_org_pat");
    const sessionId = await seedWorkflowRun(api.providers.db, {
      runId: "wfrun_manual", orgId: ORG, owner: TEAM, actorUserId: "local-user",
    });
    const token = await tokenFor(sessionId, "local-user");

    const git = await post(token, { host: "github.com", owner: "someone-else", repo: "docs" });
    expect(git.status).toBe(200);
    expect(await git.json()).toEqual({ anonymous: true });
    const gh = await post(token, { host: "github.com", owner: "someone-else", repo: "docs", purpose: "api" });
    expect(await gh.json()).toEqual({ anonymous: true });
  });

  it("a scheduled team run never reaches a synthetic user credential or the org PAT", async () => {
    api = await bootTestApi();
    await saveSyntheticUserCredential(`team:${TEAM.id}`, "ghp_synthetic_team_user");
    await saveOrgPat("ghp_org_pat");
    const sessionId = await seedWorkflowRun(api.providers.db, { runId: "wfrun_sched", orgId: ORG, owner: TEAM });
    const token = await tokenFor(sessionId, "team:team-1");

    const res = await post(token, { host: "github.com", owner: "someone-else", repo: "docs" });
    expect(await res.json()).toEqual({ anonymous: true });
  });

  it("a team owner outside the sandbox org fails closed", async () => {
    api = await bootTestApi();
    await api.providers.db.insert(orgs).values({ id: "other-org", name: "Other org", createdAt: Date.now() });
    await api.providers.db.insert(teams).values({
      id: "team-foreign",
      orgId: "other-org",
      name: "Foreign team",
      createdAt: Date.now(),
    });
    await api.providers.engineCredentials.save({ type: "team", id: "team-foreign" }, "github", {
      type: "oauth2",
      accessToken: "ghp_foreign_team",
    });
    const sessionId = await seedWorkflowRun(api.providers.db, {
      runId: "wfrun_foreign_team",
      orgId: ORG,
      owner: { type: "team", id: "team-foreign" },
    });
    const token = await tokenFor(sessionId, "team:team-foreign");

    const res = await post(token, { host: "github.com", owner: "tkhq", repo: "docs" });
    expect(await res.json()).toEqual({ anonymous: true });
  });

  it("an org-owned run never reaches a synthetic user credential or the org PAT", async () => {
    api = await bootTestApi();
    await saveSyntheticUserCredential(`org:${ORG}`, "ghp_synthetic_org_user");
    await saveOrgPat("ghp_org_pat");
    const sessionId = await seedWorkflowRun(api.providers.db, {
      runId: "wfrun_org", orgId: ORG, owner: { type: "org", id: ORG },
    });
    const token = await tokenFor(sessionId, `org:${ORG}`);

    const res = await post(token, { host: "github.com", owner: "someone-else", repo: "docs", purpose: "api" });
    expect(await res.json()).toEqual({ anonymous: true });
  });

  it("a team run uses the team's own github row first", async () => {
    api = await bootTestApi();
    await saveUserCredential("ghp_member_personal");
    await api.providers.engineCredentials.save(TEAM, "github", {
      type: "oauth2",
      accessToken: "ghp_team_row",
      metadata: { login: "team-bot" },
    });
    const sessionId = await seedWorkflowRun(api.providers.db, {
      runId: "wfrun_teamrow", orgId: ORG, owner: TEAM, actorUserId: "local-user",
    });
    const token = await tokenFor(sessionId, "local-user");

    const git = await post(token, { host: "github.com", owner: "someone-else", repo: "docs" });
    expect(await git.json()).toEqual({ username: "x-access-token", password: "ghp_team_row" });
    const gh = await post(token, { host: "github.com", purpose: "api" });
    expect(await gh.json()).toEqual({ username: "team-bot", password: "ghp_team_row" });
  });

  it("a team run a member started pushes with the App installation for the repository owner", async () => {
    api = await bootTestApi();
    await saveUserCredential("ghp_member_personal");
    await installApp("tkhq");
    const sessionId = await seedWorkflowRun(api.providers.db, {
      runId: "wfrun_install", orgId: ORG, owner: TEAM, actorUserId: "local-user",
    });
    const token = await tokenFor(sessionId, "local-user");

    const git = await post(token, { host: "github.com", owner: "tkhq", repo: "docs" });
    expect(await git.json()).toEqual({ username: "x-access-token", password: INSTALLATION_TOKEN });
    // `gh` would put the member's credential first on the coding-session
    // ladder. A team run's `gh` gets the installation too.
    const gh = await post(token, { host: "github.com", owner: "tkhq", repo: "docs", purpose: "api" });
    expect(await gh.json()).toEqual({ username: "x-access-token", password: INSTALLATION_TOKEN });
  });

  it("a team run's gh outside a repository gets the org's sole installation", async () => {
    api = await bootTestApi();
    await installApp("tkhq");
    const sessionId = await seedWorkflowRun(api.providers.db, { runId: "wfrun_ghsole", orgId: ORG, owner: TEAM });
    const token = await tokenFor(sessionId, "team:team-1");

    const res = await post(token, { host: "github.com", purpose: "api" });
    expect(await res.json()).toEqual({ username: "x-access-token", password: INSTALLATION_TOKEN });
  });

  it("a user-owned run resolves its owner's own credentials", async () => {
    api = await bootTestApi();
    await saveUserCredential("ghp_owner_personal");
    const sessionId = await seedWorkflowRun(api.providers.db, {
      runId: "wfrun_user", orgId: ORG, owner: { type: "user", id: "local-user" }, actorUserId: "local-user",
    });
    const token = await tokenFor(sessionId, "local-user");

    const res = await post(token, { host: "github.com", owner: "someone-else", repo: "docs" });
    expect(await res.json()).toEqual({ username: "x-access-token", password: "ghp_owner_personal" });
  });

  it("a user-owned run resolves its owner's credentials, not the token holder's", async () => {
    api = await bootTestApi();
    await saveUserCredential("ghp_token_holder");
    await api.providers.engineCredentials.save({ type: "user", id: "user-b" }, "github", {
      type: "oauth2",
      accessToken: "ghp_run_owner",
      metadata: { login: "owner-b" },
    });
    const sessionId = await seedWorkflowRun(api.providers.db, {
      runId: "wfrun_owner_b", orgId: ORG, owner: { type: "user", id: "user-b" },
    });
    const token = await tokenFor(sessionId, "local-user");

    const res = await post(token, { host: "github.com", owner: "someone-else", repo: "docs" });
    expect(await res.json()).toEqual({ username: "x-access-token", password: "ghp_run_owner" });
  });

  it("an org-owned run pushes with the App installation", async () => {
    api = await bootTestApi();
    await saveOrgPat("ghp_org_pat");
    await installApp("tkhq");
    const sessionId = await seedWorkflowRun(api.providers.db, {
      runId: "wfrun_org_app", orgId: ORG, owner: { type: "org", id: ORG },
    });
    const token = await tokenFor(sessionId, `org:${ORG}`);

    const res = await post(token, { host: "github.com", owner: "tkhq", repo: "docs" });
    expect(await res.json()).toEqual({ username: "x-access-token", password: INSTALLATION_TOKEN });
  });

  it("a synthetic team:{id} user owner resolves as the team, never as a user or org PAT", async () => {
    api = await bootTestApi();
    await saveSyntheticUserCredential(`team:${TEAM.id}`, "ghp_synthetic_team_user");
    await api.providers.engineCredentials.save(TEAM, "github", {
      type: "oauth2",
      accessToken: "ghp_team_row",
    });
    await saveOrgPat("ghp_org_pat");
    const sessionId = await seedWorkflowRun(api.providers.db, {
      runId: "wfrun_synthetic_team",
      orgId: ORG,
      owner: { type: "user", id: `team:${TEAM.id}` },
    });
    const token = await tokenFor(sessionId, `team:${TEAM.id}`);

    const res = await post(token, { host: "github.com", owner: "tkhq", repo: "docs", purpose: "api" });
    expect(await res.json()).toEqual({ username: "x-access-token", password: "ghp_team_row" });
  });

  it("a synthetic org:{id} user owner resolves as the org, never as a user or org PAT", async () => {
    api = await bootTestApi();
    await saveSyntheticUserCredential(`org:${ORG}`, "ghp_synthetic_org_user");
    await saveOrgPat("ghp_org_pat");
    // `workflows.start_run` inside an unattended org run stamps the child
    // run as owned by a user named after the parent's synthetic actor.
    const sessionId = await seedWorkflowRun(api.providers.db, {
      runId: "wfrun_synthetic", orgId: ORG, owner: { type: "user", id: `org:${ORG}` },
    });
    const token = await tokenFor(sessionId, `org:${ORG}`);

    const res = await post(token, { host: "github.com", owner: "someone-else", repo: "docs", purpose: "api" });
    expect(await res.json()).toEqual({ anonymous: true });
  });

  it("a run whose workflow belongs to another org answers anonymous", async () => {
    api = await bootTestApi();
    await saveUserCredential("ghp_member_personal");
    const sessionId = await seedWorkflowRun(api.providers.db, {
      runId: "wfrun_other_org", orgId: "other-org", owner: { type: "user", id: "local-user" },
    });
    const token = await tokenFor(sessionId, "local-user");

    const res = await post(token, { host: "github.com", owner: "someone-else", repo: "docs" });
    expect(await res.json()).toEqual({ anonymous: true });
  });

  it("a malformed workflow session id answers anonymous", async () => {
    api = await bootTestApi();
    await saveUserCredential("ghp_member_personal");
    const token = await tokenFor("wf:not-a-valid-id", "local-user");

    const res = await post(token, { host: "github.com", owner: "someone-else", repo: "docs" });
    expect(await res.json()).toEqual({ anonymous: true });
  });

  it("a run with no recognizable stored owner answers anonymous", async () => {
    api = await bootTestApi();
    await saveUserCredential("ghp_member_personal");
    const now = Date.now();
    const definition = { version: "dag/v1", nodes: [], edges: [] };
    await api.providers.db.insert(workflowDefinitions).values({
      id: "wf_def_noowner", orgId: ORG, ownerType: "user", ownerId: "local-user",
      name: "no owner", definition, createdAt: now, updatedAt: now,
    });
    // The column defaults a run gets when its start path never stamped an owner.
    await api.providers.db.insert(workflowRuns).values({
      id: "wfrun_noowner", workflowId: "wf_def_noowner", definitionVersionId: "v1", definition,
      params: { workflowId: "wf_def_noowner", definitionVersionId: "v1" }, createdAt: now, updatedAt: now,
    });
    const token = await tokenFor("wf:wfrun_noowner:sync", "local-user");

    const res = await post(token, { host: "github.com", owner: "someone-else", repo: "docs" });
    expect(await res.json()).toEqual({ anonymous: true });
  });

  it("403s an unrecognized host for a workflow session", async () => {
    api = await bootTestApi();
    const sessionId = await seedWorkflowRun(api.providers.db, { runId: "wfrun_host", orgId: ORG, owner: TEAM });
    const token = await tokenFor(sessionId, "team:team-1");

    const res = await post(token, { host: "gitlab.example", owner: "acme", repo: "widgets" });
    expect(res.status).toBe(403);
  });

  it("a wf:-prefixed session with an app row is not treated as a workflow session", async () => {
    api = await bootTestApi();
    await saveUserCredential("ghp_member_personal");
    // A run owned by a team whose row the session must not borrow.
    await api.providers.engineCredentials.save(TEAM, "github", { type: "oauth2", accessToken: "ghp_team_row" });
    const sessionId = await seedWorkflowRun(api.providers.db, { runId: "wfrun_spoof", orgId: ORG, owner: TEAM });
    const now = Date.now();
    await api.providers.db.insert(agentSessions).values({
      id: sessionId, userId: "local-user", orgId: ORG, workspace: "/workspace",
      ownerType: "user", ownerId: "local-user", createdAt: now, updatedAt: now,
    });
    const token = await tokenFor(sessionId, "local-user");

    // It resolves as the coding session it is: its own user's credential.
    const res = await post(token, { host: "github.com", owner: "someone-else", repo: "docs" });
    expect(await res.json()).toEqual({ username: "x-access-token", password: "ghp_member_personal" });
  });

  it("a workflow session whose run is gone answers anonymous, never the token's actor", async () => {
    api = await bootTestApi();
    await saveUserCredential("ghp_member_personal");
    const token = await tokenFor("wf:wfrun_missing:sync", "local-user");

    const res = await post(token, { host: "github.com", owner: "someone-else", repo: "docs" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ anonymous: true });

  });
});


describe("sandbox Git attribution observations", () => {
  it("records only bound ordinary pushes and pull requests for the authenticated session", async () => {
    api = await bootTestApi();
    await bindRepo();
    const token = await mintToken();
    const otherToken = await mintToken("session-other");
    const request = (path: string, auth: string, body: unknown) => fetch(`${api!.baseUrl}/api/sandbox/${path}`, {
      method: "POST",
      headers: { ...HEADERS, "x-valet-sandbox": auth },
      body: JSON.stringify(body),
    });

    const push = await request("git-push/observe", token, { repoFullName: "ACME/WIDGETS", targetRef: "refs/heads/feature", headSha: "abc123" });
    expect(push.status).toBe(200);
    expect(await api.providers.db.select().from(sessionGitBranches)).toMatchObject([{ sessionId: SESSION_ID, repoFullName: "acme/widgets", ref: "refs/heads/feature", headSha: "abc123" }]);

    const pull = await request("git-pr/observe", token, { repoFullName: "acme/widgets", prNumber: 7, prUrl: "https://github.com/acme/widgets/pull/7", headRef: "feature", headSha: "abc123" });
    expect(pull.status).toBe(200);
    expect(await api.providers.db.select().from(sessionPullRequests)).toMatchObject([{ sessionId: SESSION_ID, repoFullName: "acme/widgets", prNumber: 7, headRef: "feature", headSha: "abc123" }]);

    expect((await request("git-push/observe", otherToken, { repoFullName: "acme/widgets", targetRef: "refs/heads/feature", headSha: "abc123" })).status).toBe(403);
    expect((await request("git-pr/observe", otherToken, { repoFullName: "acme/widgets", prNumber: 8, prUrl: "https://github.com/acme/widgets/pull/8", headRef: "feature", headSha: "abc123" })).status).toBe(403);
  });

  it("rejects reconciliation through a token for another session", async () => {
    api = await bootTestApi();
    const now = Date.now();
    await api.providers.db.insert(gitPushOperations).values({ id: "gpo-test", sessionId: SESSION_ID, generation: 1, repoFullName: "acme/widgets", targetRef: "refs/heads/feature", expectedRemoteSha: "old", localHeadSha: "local", signedHeadSha: "signed", state: "reconciling", createdAt: now, updatedAt: now });
    const wrong = await mintToken("session-other");
    const denied = await fetch(`${api!.baseUrl}/api/sandbox/git-push/gpo-test/reconcile`, { method: "POST", headers: { "x-valet-sandbox": wrong } });
    expect(denied.status).toBe(409);
    const right = await mintToken();
    const accepted = await fetch(`${api!.baseUrl}/api/sandbox/git-push/gpo-test/reconcile`, { method: "POST", headers: { "x-valet-sandbox": right } });
    expect(accepted.status).toBe(200);

  });
});
