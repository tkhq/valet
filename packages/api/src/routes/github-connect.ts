/**
 * `/api/me/github` — a signed-in user's own GitHub connection via the org's
 * configured GitHub App (GitHub/repo integration plan, Task 6). Builds on
 * Task 5's App config (`services/github-app.ts`'s `loadAppConfig`) and
 * feeds Task 4's token resolution (`services/github-tokens.ts`): a
 * successful connect here saves a user `github` credential shaped exactly
 * like that module's "healthy App-OAuth credential" — `{ type: "oauth2",
 * accessToken, refreshToken?, expiresAt?, metadata: { login } }`, no
 * `identityOnly` (this flow is repo-capable, unlike a bare social-login
 * connection).
 *
 * ── State signing ─────────────────────────────────────────────────────
 * Reuses `lib/oauth-state.ts` (extracted from Task 5's `routes/github-app.ts`
 * once this became the second caller needing the same
 * sign-payload/verify-signature-and-expiry shape). This flow's payload is
 * `{ userId, orgId, nonce, exp }` — `userId` is the addition over the
 * manifest flow's `{ orgId, nonce, exp }`, since the callback needs to
 * reject a state minted for a different signed-in user (session-fixation:
 * someone else's `state` value replayed against your session).
 *
 * ── Callback auth model ──────────────────────────────────────────────
 * Unlike `GET /api/org/github-app/setup` (GitHub's manifest redirect, which
 * has no Valet session and relies on the signed state alone), this
 * callback IS mounted behind the normal `/api/*` auth gate: the user
 * started the flow from an authenticated browser tab, and the same browser
 * (with the same session cookie) lands back on this route after GitHub
 * redirects. The signed state is still checked — including that its
 * `userId` matches the authenticated caller — as defense in depth against
 * a stolen/replayed `state` value.
 */
import { eq } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { Hono, type Context } from "hono";
import type { AppEnv } from "../env.js";
import { deriveSecretKey } from "../lib/secret-crypto.js";
import { isRecord, signState, verifyState, STATE_TTL_MS } from "../lib/oauth-state.js";
import { resolveReturnOrigin } from "./credential-connect.js";
import { resolveGithubApiUrl, resolveGithubUrl } from "../services/github-env.js";
import { loadAppConfig, relinkInstallations, type GithubAppDeps } from "../services/github-app.js";
import { githubInstallations } from "../schema/index.js";
import type { GetGithubOrgStatusResponse, PostGithubConnectResponse } from "../wire/types.js";

export const githubConnectRouter = new Hono<AppEnv>();

const GITHUB_CREDENTIAL_SERVICE = "github";

interface ConnectState {
  userId: string;
  orgId: string;
  nonce: string;
  exp: number;
  /** Origin to return the browser to. Captured when the state is minted,
   * because at the callback the referer is GitHub. Empty when the caller is
   * same-origin, which is the deployed shape — there the api serves the
   * client and a relative redirect already lands in the right place. */
  returnTo?: string;
}

function verifyConnectState(state: string, key: Buffer, nowMs: number): ConnectState | null {
  return verifyState<ConnectState>(state, key, (payload) => {
    if (!isRecord(payload)) return null;
    const { userId, orgId, nonce, exp, returnTo } = payload;
    if (typeof userId !== "string" || typeof orgId !== "string") return null;
    if (typeof nonce !== "string" || typeof exp !== "number") return null;
    if (exp < nowMs) return null;
    // Allow-listed before signing, so trusting it here trusts our own
    // signature rather than anything GitHub sent back.
    return { userId, orgId, nonce, exp, returnTo: typeof returnTo === "string" ? returnTo : "" };
  });
}

function appDeps(c: Context<AppEnv>): GithubAppDeps {
  const { db, engineCredentials, encryptionKey } = c.var.providers;
  return { db, credentials: engineCredentials, key: deriveSecretKey(encryptionKey) };
}

interface ParsedAccessTokenResponse {
  accessToken: string;
  refreshToken?: string;
  expiresInMs?: number;
}

/** GitHub's `POST /login/oauth/access_token` returns HTTP 200 even on
 * error (the error rides an `{ error, error_description }` body), so a
 * missing `access_token` — not just a non-2xx status — is a rejection. */
function parseAccessTokenResponse(payload: unknown): ParsedAccessTokenResponse | null {
  if (!isRecord(payload)) return null;
  const accessToken = payload.access_token;
  if (typeof accessToken !== "string" || accessToken.length === 0) return null;
  const refreshToken = typeof payload.refresh_token === "string" ? payload.refresh_token : undefined;
  const expiresIn = payload.expires_in;
  const expiresInMs = typeof expiresIn === "number" ? expiresIn * 1000 : undefined;
  return { accessToken, refreshToken, expiresInMs };
}

githubConnectRouter.post("/connect", async (c) => {
  const user = c.var.user;
  const { encryptionKey } = c.var.providers;

  const config = await loadAppConfig(appDeps(c), user.orgId);
  if (!config) {
    return c.json({ error: "no GitHub App is configured for this organization; ask an admin to set it up first" }, 409);
  }

  const key = deriveSecretKey(encryptionKey);
  const returnTo = resolveReturnOrigin(c.req.url, c.req.header("referer"), process.env);
  const statePayload: ConnectState = {
    userId: user.id,
    orgId: user.orgId,
    nonce: randomBytes(16).toString("hex"),
    exp: Date.now() + STATE_TTL_MS,
    ...(returnTo ? { returnTo } : {}),
  };
  const state = signState(statePayload, key);

  const githubUrl = resolveGithubUrl(process.env);
  const url = `${githubUrl}/login/oauth/authorize?client_id=${encodeURIComponent(config.oauthClientId)}&state=${encodeURIComponent(state)}`;

  const resp: PostGithubConnectResponse = { url };
  return c.json(resp);
});

/**
 * The org App's state, for any member.
 *
 * `POST /connect` above hard-fails with a 409 when the org has no App,
 * because the authorize URL is built from the App's own OAuth client. A
 * member could not see that coming: the detailed read
 * (`GET /api/org/github-app`) is admin-gated, so the connect surface had to
 * guess. This answers the two questions that surface asks — does an App
 * exist, and does it reach anything — from the same `loadAppConfig` read
 * `/connect` uses, so the two never disagree.
 *
 * Deliberately no `requireOrgAdmin`: the body carries no app id, no slug,
 * no installation logins and no secret material. Counts only.
 */
githubConnectRouter.get("/org-status", async (c) => {
  const user = c.var.user;
  const { db } = c.var.providers;

  const config = await loadAppConfig(appDeps(c), user.orgId);
  const rows = await db
    .select({ suspended: githubInstallations.suspended })
    .from(githubInstallations)
    .where(eq(githubInstallations.orgId, user.orgId));

  const body: GetGithubOrgStatusResponse = {
    configured: config !== null,
    installationCount: rows.length,
    suspendedCount: rows.filter((row) => row.suspended).length,
  };
  return c.json(body);
});

githubConnectRouter.get("/callback", async (c) => {
  const code = c.req.query("code");
  const state = c.req.query("state");
  if (!code || !state) return c.json({ error: "missing code or state" }, 400);

  const user = c.var.user;
  const { engineCredentials, encryptionKey } = c.var.providers;
  const key = deriveSecretKey(encryptionKey);
  const verified = verifyConnectState(state, key, Date.now());
  if (!verified) return c.json({ error: "invalid or expired state" }, 400);
  if (verified.userId !== user.id) {
    return c.json({ error: "this authorization was not started by the signed-in user" }, 400);
  }

  const deps = appDeps(c);
  const config = await loadAppConfig(deps, verified.orgId);
  if (!config) {
    return c.json({ error: "no GitHub App is configured for this organization; ask an admin to set it up first" }, 409);
  }

  const githubUrl = resolveGithubUrl(process.env);
  let tokenRes: Response;
  try {
    tokenRes = await fetch(`${githubUrl}/login/oauth/access_token`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "User-Agent": "Valet-App",
      },
      body: JSON.stringify({ client_id: config.oauthClientId, client_secret: config.oauthClientSecret, code }),
    });
  } catch (err) {
    console.error("github connect callback: token exchange request failed:", err);
    return c.json({ error: "failed to reach GitHub" }, 502);
  }
  if (!tokenRes.ok) {
    if (tokenRes.status >= 500) return c.json({ error: `GitHub returned ${tokenRes.status}` }, 502);
    return c.json({ error: `GitHub rejected the authorization code (status ${tokenRes.status})` }, 400);
  }

  let tokenPayload: unknown;
  try {
    tokenPayload = await tokenRes.json();
  } catch {
    return c.json({ error: "malformed response from GitHub" }, 502);
  }
  const parsedToken = parseAccessTokenResponse(tokenPayload);
  if (!parsedToken) return c.json({ error: "GitHub did not return an access token" }, 400);

  const apiUrl = resolveGithubApiUrl(process.env);
  let userRes: Response;
  try {
    userRes = await fetch(`${apiUrl}/user`, {
      headers: {
        Authorization: `Bearer ${parsedToken.accessToken}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "Valet-App",
      },
    });
  } catch (err) {
    console.error("github connect callback: GET /user request failed:", err);
    return c.json({ error: "failed to reach GitHub" }, 502);
  }
  if (!userRes.ok) {
    return c.json({ error: `GitHub returned ${userRes.status} fetching the account profile` }, 502);
  }

  let userPayload: unknown;
  try {
    userPayload = await userRes.json();
  } catch {
    return c.json({ error: "malformed response from GitHub" }, 502);
  }
  const login = isRecord(userPayload) && typeof userPayload.login === "string" ? userPayload.login : null;
  if (!login) return c.json({ error: "malformed response from GitHub" }, 502);

  const now = Date.now();
  // The user's `github` credential is a SINGLE slot shared with the manual
  // PAT-paste route (PUT /api/credentials/github): last write wins, and
  // DELETE /api/me/github removes whichever token occupies it. Deliberate —
  // the token service treats PATs and App-OAuth tokens uniformly, so one
  // slot keeps resolution single-keyed. The connect UI is expected to warn
  // before replacing an existing repo-capable credential.
  await engineCredentials.save({ type: "user", id: user.id }, GITHUB_CREDENTIAL_SERVICE, {
    type: "oauth2",
    accessToken: parsedToken.accessToken,
    refreshToken: parsedToken.refreshToken,
    expiresAt: parsedToken.expiresInMs !== undefined ? now + parsedToken.expiresInMs : undefined,
    metadata: { login },
  });

  // Best-effort: a transient failure here shouldn't strand the user on an
  // error page after the credential itself saved successfully — the next
  // `discoverInstallations` run (webhook/refresh) will catch up.
  try {
    await relinkInstallations(deps, verified.orgId);
  } catch (err) {
    console.error("github connect callback: post-save relink failed:", err);
  }

  return c.redirect(`${verified.returnTo ?? ""}/settings/connected-accounts?github=connected`, 302);
});

githubConnectRouter.delete("/", async (c) => {
  const user = c.var.user;
  const { db, engineCredentials } = c.var.providers;

  await engineCredentials.delete({ type: "user", id: user.id }, GITHUB_CREDENTIAL_SERVICE);
  await db
    .update(githubInstallations)
    .set({ linkedUserId: null, updatedAt: Date.now() })
    .where(eq(githubInstallations.linkedUserId, user.id));

  return c.body(null, 204);
});
