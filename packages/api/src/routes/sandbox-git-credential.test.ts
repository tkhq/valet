/**
 * `POST /api/sandbox/git-credential` (GitHub/repo integration plan, Task 8).
 * Route-level: real Hono app via `bootTestApi`, a minted sandbox token for
 * auth, and `session_repos` bindings seeded directly. The credential path
 * uses a seeded PAT-shaped user credential so no GitHub fixture/network is
 * involved (a no-expiry/no-refresh credential resolves without a health call
 * — see `services/github-tokens.ts`'s `resolveUserCredential`).
 *
 * Security pins here: unbound owner 403; garbage/missing sandbox token 401;
 * token appears ONLY in the response body (never any console call); an
 * explicit-auth binding with no credential 409s rather than silently
 * downgrading to anonymous; case-insensitive owner match.
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

  it("403s for an owner not bound to the session", async () => {
    api = await bootTestApi();
    await bindRepo();
    await saveUserCredential("ghp_should_not_leak");
    const token = await mintToken();

    const res = await post(token, { host: "github.com", owner: "someone-else" });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("owner not bound to this session");
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

  it("400s on a body missing host/owner", async () => {
    api = await bootTestApi();
    await bindRepo();
    const token = await mintToken();
    const res = await post(token, { host: "github.com" });
    expect(res.status).toBe(400);
  });
});
