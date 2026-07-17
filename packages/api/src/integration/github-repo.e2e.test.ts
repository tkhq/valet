/**
 * GitHub/repo integration plan — Task 12 e2e. One coherent scenario driving
 * the full API loop through the fixture GitHub server
 * (`test-helpers/github-fixture.ts`), proving the SEAMS documented across
 * Tasks 2-11 compose correctly end to end. This suite does NOT re-test every
 * precedence matrix cell — `services/github-tokens.test.ts` and
 * `routes/github-app.test.ts`/`routes/github-connect.test.ts` own that. It
 * proves the pieces fit together:
 *
 *   1. App-manifest mint → setup callback (fixture conversion) saves the org
 *      App config with no secrets ever surfaced.
 *   2. Discovery (`GET /api/org/github-app`) shows the installation the setup
 *      callback discovered.
 *   3. `GET /api/repos` unions the installation's repos with the (still
 *      unconnected) personal tier.
 *   4. `POST /api/sessions` binds a repo (`auth: "auto"`), and the DB write
 *      is visible to every downstream consumer.
 *   5. The sandbox credential-helper route (`POST /api/sandbox/git-credential`,
 *      `purpose: "git"`) mints a token for the bound owner and 403s an
 *      unbound one.
 *   6. The action-invoke-level seam — a REAL `EngineHost.sessionFor(...)`
 *      build's `session.credentialProvider().get("github")`
 *      (`purpose: "api"`) — resolves through the SAME binding, proving the
 *      `credentialResolver` seam (`engine/host.ts`) reads the same
 *      `session_repos` row the credential-helper route does, but with a
 *      DIFFERENT precedence order (`api` checks the user before the
 *      installation; `git` checks the installation before the user — see
 *      `services/github-tokens.ts`'s module doc comment). This is the
 *      "anonymous-org" state: no personal connection, so both purposes
 *      resolve to the installation token today.
 *   7. The connect flow (`POST /api/me/github/connect` → fixture OAuth
 *      exchange → `GET /api/me/github/callback`) upgrades attribution: the
 *      `api`-purpose (action-invoke) resolution flips to the user's own
 *      token, while the `git`-purpose (clone) resolution is UNCHANGED — it
 *      still prefers the installation for a repo the App is installed on.
 *   8. `DELETE /api/me/github` disconnects; the action-invoke-level
 *      resolution reverts to the anonymous-org (installation) path.
 *
 * A live-gated variant (skipped by default) is documented at the bottom —
 * see its own header comment for the required env vars.
 */
import { afterEach, describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { bootTestApi, type TestApi } from "./_setup.js";
import { startGithubFixture, type GithubFixture } from "../test-helpers/github-fixture.js";
import { mintSandboxToken } from "../auth/sandbox-tokens.js";
import { deriveSecretKey } from "../lib/secret-crypto.js";
import { mintAppJwt, type GithubAppConfig } from "../services/github-app.js";
import type {
  CreateSessionResponse,
  GetGithubAppResponse,
  GetReposResponse,
  ListCredentialsResponse,
  PostGithubAppManifestResponse,
  PostGithubConnectResponse,
  SandboxGitCredential,
} from "../wire/types.js";

const HEADERS = { "Content-Type": "application/json" };

const { privateKey: TEST_PEM } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

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

function rawRepo(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 1,
    name: "widgets",
    full_name: "acme/widgets",
    html_url: "https://github.com/acme/widgets",
    clone_url: "https://github.com/acme/widgets.git",
    default_branch: "main",
    private: true,
    description: null,
    updated_at: "2026-01-01T00:00:00Z",
    language: null,
    ...overrides,
  };
}

describe("GitHub/repo integration — full API loop e2e (fixture)", () => {
  it("mint → setup → discover → list → bind → helper mint → action resolve → connect → disconnect → anon-org again", async () => {
    // ── Fixture: both `api.github.com` (App/installation) and `github.com`
    // (OAuth token exchange) point at the same fake server, mirroring
    // `github-connect.test.ts`'s `useFixture`. `listUserRepos`/`getUser`
    // start out as the "nobody connected yet" defaults and are swapped once
    // the connect-flow phase needs a distinct identity.
    let userReposBody: unknown[] = [];
    fixture = startGithubFixture({
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
      listInstallations: () => ({
        body: [{ id: 111, account: { login: "acme", type: "Organization" }, repository_selection: "all", suspended_at: null }],
      }),
      createInstallationToken: (id) => ({
        body: { token: `inst-${id}`, expires_at: new Date(Date.now() + 3600_000).toISOString() },
      }),
      listInstallationRepositories: () => ({
        body: { total_count: 1, repositories: [rawRepo({})] },
      }),
      listUserRepos: () => ({ body: userReposBody }),
      oauthAccessToken: () => ({
        body: { access_token: "connect-access-token", token_type: "bearer" },
      }),
      getUser: () => ({ body: { login: "octouser", id: 99 } }),
    });
    process.env.GITHUB_API_URL = fixture.url;
    process.env.GITHUB_URL = fixture.url;

    // The action-invoke-level seam needs a REAL `credentialResolver` wired
    // through the full API boot — see `_setup.ts`'s `githubTokenDeps` option
    // doc comment.
    api = await bootTestApi({ githubTokenDeps: { key: deriveSecretKey("test-key") } });

    // ── 1. Manifest mint ─────────────────────────────────────────────────
    const manifestRes = await fetch(`${api.baseUrl}/api/org/github-app/manifest`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({}),
    });
    expect(manifestRes.status).toBe(200);
    const { state } = (await manifestRes.json()) as PostGithubAppManifestResponse;

    // ── Setup callback (fixture conversion) ─────────────────────────────
    const setupRes = await fetch(
      `${api.baseUrl}/api/org/github-app/setup?code=some-code&state=${encodeURIComponent(state)}`,
      { redirect: "manual" },
    );
    expect(setupRes.status).toBe(302);
    expect(fixture.calls.some((c) => c.path === "/app-manifests/some-code/conversions")).toBe(true);

    // ── 2. Discovery shows installations ────────────────────────────────
    const appRes = await fetch(`${api.baseUrl}/api/org/github-app`, { headers: HEADERS });
    const appBody = (await appRes.json()) as GetGithubAppResponse;
    expect(appBody.configured).toBe(true);
    expect(appBody.installations).toHaveLength(1);
    expect(appBody.installations[0]).toMatchObject({ accountLogin: "acme", accountType: "Organization" });
    const raw = JSON.stringify(appBody);
    expect(raw).not.toContain("oauth-client-secret");
    expect(raw).not.toContain("the-webhook-secret");
    expect(raw).not.toContain(TEST_PEM);

    // ── 3. GET /api/repos union (no personal connection yet) ───────────
    const reposRes = await fetch(`${api.baseUrl}/api/repos`, { headers: HEADERS });
    const reposBody = (await reposRes.json()) as GetReposResponse;
    expect(reposBody.connected).toBe(false);
    expect(reposBody.installed).toBe(true);
    expect(reposBody.repos.map((r) => r.fullName)).toEqual(["acme/widgets"]);
    expect(reposBody.repos[0]?.installed).toBe(true);

    // ── 4. Create session with a binding (auth auto) ────────────────────
    const createRes = await fetch(`${api.baseUrl}/api/sessions`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({
        workspace: "/tmp/valet-github-e2e-workspace",
        repo: { fullName: "acme/widgets", cloneUrl: "https://github.com/acme/widgets.git", auth: "auto" },
      }),
    });
    expect(createRes.status).toBe(201);
    const session = (await createRes.json()) as CreateSessionResponse;
    expect(session.repos).toEqual([
      { host: "github", fullName: "acme/widgets", cloneUrl: "https://github.com/acme/widgets.git", auth: "auto" },
    ]);

    // ── 5. Sandbox credential-helper route mints for the bound owner ────
    const sandboxToken = (
      await mintSandboxToken(api.providers.db, { sessionId: session.id, userId: "local-user", orgId: "local-org" })
    ).token;
    const helperRes = await fetch(`${api.baseUrl}/api/sandbox/git-credential`, {
      method: "POST",
      headers: { ...HEADERS, "x-valet-sandbox": sandboxToken },
      body: JSON.stringify({ host: "github.com", owner: "acme" }),
    });
    expect(helperRes.status).toBe(200);
    const helperBody = (await helperRes.json()) as SandboxGitCredential;
    // `git` purpose, `auto`, repo owner matches an installation → installation
    // token wins (see `github-tokens.ts` `auto`+`git`: installation first).
    expect(helperBody.username).toBe("x-access-token");
    expect(helperBody.password).toBe("inst-111");

    // 403 for an unbound owner — the sandbox cannot mint credentials for
    // repos its session was never granted.
    const unboundRes = await fetch(`${api.baseUrl}/api/sandbox/git-credential`, {
      method: "POST",
      headers: { ...HEADERS, "x-valet-sandbox": sandboxToken },
      body: JSON.stringify({ host: "github.com", owner: "someone-else" }),
    });
    expect(unboundRes.status).toBe(403);

    // ── 6. Action-invoke-level seam, anonymous-org state ────────────────
    // A real `EngineHost.sessionFor(...)` build reads the SAME
    // `session_repos` binding through `session.credentialProvider()` —
    // this is the exact object a github action's `ctx.credentials.get()`
    // hits inside a live tool call. `api` purpose + `auto`: no personal
    // connection yet → resolves to the installation token too, but through
    // a DIFFERENT precedence order than `git` purpose (user before
    // installation) — it only lands on the installation because there is no
    // user credential to prefer.
    const engineSession = await api.providers.engineHost.sessionFor(session.id, {
      userId: "local-user",
      orgId: "local-org",
      workspace: "/tmp/valet-github-e2e-workspace",
    });
    const anonOrgCred = await engineSession.credentialProvider().get("github");
    expect(anonOrgCred?.accessToken).toBe("inst-111");

    // `sessionFor`'s build minted an ADDITIONAL sandbox token above
    // (`mintSandboxEnv`, once per session BUILD) WITHOUT revoking prior ones
    // (final-review fix wave) — so the PRE-rebuild token a running sandbox is
    // still holding keeps working across the rebuild. Prove it: the same
    // `sandboxToken` from before the build still authenticates the credential
    // helper route rather than 403ing.
    const survivesRebuildRes = await fetch(`${api.baseUrl}/api/sandbox/git-credential`, {
      method: "POST",
      headers: { ...HEADERS, "x-valet-sandbox": sandboxToken },
      body: JSON.stringify({ host: "github.com", owner: "acme" }),
    });
    expect(survivesRebuildRes.status).toBe(200);

    // ── 7. Connect flow (fixture exchange) upgrades attribution ─────────
    userReposBody = [rawRepo({ id: 7, full_name: "octouser/solo", private: false, updated_at: "2026-02-01T00:00:00Z" })];
    const connectRes = await fetch(`${api.baseUrl}/api/me/github/connect`, { method: "POST", headers: HEADERS });
    expect(connectRes.status).toBe(200);
    const { url: connectUrl } = (await connectRes.json()) as PostGithubConnectResponse;
    const connectState = new URL(connectUrl).searchParams.get("state");
    expect(connectState).toBeTruthy();
    const callbackRes = await fetch(
      `${api.baseUrl}/api/me/github/callback?code=abc&state=${encodeURIComponent(connectState ?? "")}`,
      { headers: HEADERS, redirect: "manual" },
    );
    expect(callbackRes.status).toBe(302);

    // `GET /api/repos` now reports the user as connected and unions in
    // their personal repo alongside the installation's.
    const reposAfterConnectRes = await fetch(`${api.baseUrl}/api/repos`, { headers: HEADERS });
    const reposAfterConnect = (await reposAfterConnectRes.json()) as GetReposResponse;
    expect(reposAfterConnect.connected).toBe(true);
    expect(reposAfterConnect.repos.map((r) => r.fullName).sort()).toEqual(["acme/widgets", "octouser/solo"]);

    // `GET /api/credentials` surfaces the connect health with no secret
    // material — same summary shape `github-connect.test.ts` pins.
    const credsRes = await fetch(`${api.baseUrl}/api/credentials`, { headers: HEADERS });
    const { credentials } = (await credsRes.json()) as ListCredentialsResponse;
    const githubSummary = credentials.find((c) => c.service === "github");
    expect(githubSummary).toMatchObject({ login: "octouser" });
    expect(JSON.stringify(credentials)).not.toContain("connect-access-token");

    // The action-invoke-level (`api` purpose) resolution FLIPS to the
    // user's own token — this session's engine object is long-lived and
    // cached on the host, proving the resolver re-reads the credential
    // store on every call rather than snapshotting it at session-build time.
    const userConnectedCred = await engineSession.credentialProvider().get("github");
    expect(userConnectedCred?.accessToken).toBe("connect-access-token");

    // The `git`-purpose (clone) resolution is UNCHANGED — it still prefers
    // the installation for a repo the App is installed on, proving the two
    // purposes are genuinely independent precedence orders, not just two
    // call sites sharing one answer.
    const helperAfterConnectRes = await fetch(`${api.baseUrl}/api/sandbox/git-credential`, {
      method: "POST",
      headers: { ...HEADERS, "x-valet-sandbox": sandboxToken },
      body: JSON.stringify({ host: "github.com", owner: "acme" }),
    });
    const helperAfterConnect = (await helperAfterConnectRes.json()) as SandboxGitCredential;
    expect(helperAfterConnect.password).toBe("inst-111");

    // ── 8. Disconnect → anonymous-org path again ─────────────────────────
    const disconnectRes = await fetch(`${api.baseUrl}/api/me/github`, { method: "DELETE", headers: HEADERS });
    expect(disconnectRes.status).toBe(204);

    const reposAfterDisconnectRes = await fetch(`${api.baseUrl}/api/repos`, { headers: HEADERS });
    const reposAfterDisconnect = (await reposAfterDisconnectRes.json()) as GetReposResponse;
    expect(reposAfterDisconnect.connected).toBe(false);

    const anonOrgAgainCred = await engineSession.credentialProvider().get("github");
    expect(anonOrgAgainCred?.accessToken).toBe("inst-111");
  });
});

/**
 * Live-gated variant — skipped unless BOTH are set:
 *
 *   - `VALET_GITHUB_LIVE_TEST=1`
 *   - `VALET_GITHUB_LIVE_APP_ID` — a real GitHub App id
 *   - `VALET_GITHUB_LIVE_APP_PRIVATE_KEY_PEM` — that App's PEM private key
 *     (full contents, `\n`-escaped or literal newlines both work — Node's
 *     `createPrivateKey` accepts either)
 *
 * The coordinator runs the full human-in-the-loop dogfood (org install,
 * private-repo clone+push, personal connect, fork flow, token refresh past
 * 8h, etc. — see the design spec's exit criteria) separately; this variant
 * is intentionally minimal so it does not rot when nobody runs it: it mints
 * a real App JWT and hits `GET https://api.github.com/app` (the App's own
 * metadata endpoint, safe and side-effect-free) to prove the App
 * id/private-key pair is valid. It does NOT touch the Valet DB/API at all —
 * a narrow, self-contained live check, not a substitute for the dogfood.
 */
describe.skipIf(
  process.env.VALET_GITHUB_LIVE_TEST !== "1" ||
    !process.env.VALET_GITHUB_LIVE_APP_ID ||
    !process.env.VALET_GITHUB_LIVE_APP_PRIVATE_KEY_PEM,
)("GitHub/repo integration — live App JWT check", () => {
  it("mints a real App JWT and GitHub accepts it for GET /app", async () => {
    const config: GithubAppConfig = {
      appId: process.env.VALET_GITHUB_LIVE_APP_ID ?? "",
      appSlug: "",
      oauthClientId: "",
      htmlUrl: "",
      oauthClientSecret: "",
      webhookSecret: "",
      privateKeyPem: (process.env.VALET_GITHUB_LIVE_APP_PRIVATE_KEY_PEM ?? "").replace(/\\n/g, "\n"),
    };
    const jwt = mintAppJwt(config);
    const res = await fetch("https://api.github.com/app", {
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "Valet-App-LiveTest",
      },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: number };
    expect(String(body.id)).toBe(process.env.VALET_GITHUB_LIVE_APP_ID);
  });
});
