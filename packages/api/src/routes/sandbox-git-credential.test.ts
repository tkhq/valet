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
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { mintSandboxToken } from "../auth/sandbox-tokens.js";
import { sessionRepos } from "../schema/index.js";
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
