/**
 * Canonical GitHub credential resolution (GitHub/repo integration plan,
 * Task 4). `resolveGitHubToken` is THE one function every consumer (repo
 * listing, clone prep, the sandbox credential-helper route, the 28 actions'
 * `CredentialProvider`, later prebuild clones) goes through — do not add a
 * second resolution path anywhere else.
 *
 * ── Resolution contract (spec decision 3, verbatim) ─────────────────────
 * `resolveGitHubToken(deps, { orgId, userId?, purpose, repo?, auth? })`:
 *
 *   - Explicit `auth: "app"`  → installation token for `repo.owner`, or THROW
 *     (`GitHubAuthError`). Never falls back to a user credential.
 *   - Explicit `auth: "user"` → the user's healthy App-OAuth/PAT credential,
 *     or THROW naming the gap. Never falls back to an installation token.
 *     (Both directions pinned: an explicit selection is honored STRICTLY.)
 *   - `auto` + `git`: installation(`repo.owner`) → healthy user credential →
 *     `{ token: null, source: "none" }` (tokenless — public clones proceed
 *     bare; a private-repo failure surfaces git's own error).
 *   - `auto` + `api`: healthy user credential → installation(`repo.owner`)
 *     when a repo is given → the org's SOLE non-suspended installation when
 *     exactly one exists → THROW with a connect hint.
 *
 * ── "Healthy" user credential ───────────────────────────────────────────
 * A user-owned `github` credential is healthy when it is NOT
 * `metadata.identityOnly` (social-login default scopes — not repo-capable),
 * NOT `metadata.refreshFailedAt`-marked, and fresh. A PAT (no `expiresAt`
 * and no `refreshToken`) is always fresh. An App-OAuth credential is fresh
 * when `expiresAt - 5min > now`; otherwise it is refreshed in-place (see
 * below) and the rotated credential is used.
 *
 * ── Refresh subsystem ───────────────────────────────────────────────────
 * A stale App-OAuth credential (`expiresAt - 5min <= now`) with a
 * `refreshToken` is refreshed single-flight via
 * `POST {github}/login/oauth/access_token` (the App's client id/secret,
 * `grant_type=refresh_token`). The rotated `{ accessToken, refreshToken,
 * expiresAt }` is persisted, keeping `metadata` (incl. `login`). Refresh
 * failure marks `metadata.refreshFailedAt` (keeping the credential) and the
 * credential is then treated as absent for `auto` / a STRICT throw for
 * explicit `auth: "user"`. Single-flight is an in-module map keyed by
 * user+service, cleared in `finally` — two concurrent resolves of the same
 * stale credential hit the refresh endpoint exactly once.
 *
 * No token material ever appears in an error message or log — errors name
 * the missing/unhealthy credential (the GAP), never the secret.
 */
import { and, eq } from "drizzle-orm";
import type { CredentialOwner, CredentialStore, StoredCredential } from "@valet/engine";
import { githubInstallations } from "../schema/index.js";
import { resolveGithubUrl } from "./github-env.js";
import { loadAppConfig, mintInstallationToken, type GithubAppDeps } from "./github-app.js";

const GITHUB_CREDENTIAL_SERVICE = "github";
/** Same 5-minute liveness margin the installation-token cache uses. */
const STALE_MARGIN_MS = 5 * 60 * 1000;

/** Thrown when resolution cannot produce the requested credential. The
 * message always names the GAP (missing installation, unconnected user,
 * unhealthy credential) — never token material. Consumers (Tasks 5-10) map
 * this to a 401/403 with a connect hint. */
export class GitHubAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitHubAuthError";
  }
}

export type GitHubAuthMode = "auto" | "app" | "user";
export type GitHubTokenSource = "installation" | "user" | "pat" | "none";

export interface ResolveGitHubTokenRequest {
  orgId: string;
  userId?: string;
  purpose: "git" | "api";
  repo?: { owner: string; name: string };
  /** Explicit credential selection. Defaults to `"auto"`. `"app"`/`"user"`
   * are honored STRICTLY (no silent fallback across the selection). */
  auth?: GitHubAuthMode;
}

export interface ResolvedGitHubToken {
  token: string | null;
  source: GitHubTokenSource;
  /** The user login for a user/PAT credential (from `metadata.login`), when
   * known. Absent for installation and tokenless results. */
  login?: string;
}

/** Superset of `GithubAppDeps` (so `mintInstallationToken`/`loadAppConfig`
 * take it directly) plus the OAuth base URL used by the refresh endpoint. */
export interface GitHubTokenDeps extends GithubAppDeps {
  /** Overrides `resolveGithubUrl(process.env)` — the OAuth base (github.com),
   * distinct from `apiUrl` (api.github.com). Tests point both at the
   * fixture. */
  githubUrl?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function nowOf(deps: GitHubTokenDeps): number {
  return (deps.now ?? Date.now)();
}

function githubBaseUrl(deps: GitHubTokenDeps): string {
  return deps.githubUrl ?? resolveGithubUrl(process.env);
}

function githubFetchOf(deps: GitHubTokenDeps): typeof fetch {
  return deps.fetchImpl ?? fetch;
}

function userOwner(userId: string): CredentialOwner {
  return { type: "user", id: userId };
}

function loginOf(metadata: unknown): string | undefined {
  return isRecord(metadata) && typeof metadata.login === "string" ? metadata.login : undefined;
}

// ── Single-flight refresh ──────────────────────────────────────────────

/** In-module single-flight registry, keyed by `${userId}:${service}`. A
 * second concurrent resolve of the same stale credential joins the in-flight
 * refresh rather than issuing a duplicate token exchange. Cleared in
 * `finally`, so the next resolve after completion refreshes anew if needed. */
const refreshInFlight = new Map<string, Promise<StoredCredential | null>>();

function refreshSingleFlight(
  deps: GitHubTokenDeps,
  orgId: string,
  userId: string,
  cred: StoredCredential,
): Promise<StoredCredential | null> {
  const key = `${userId}:${GITHUB_CREDENTIAL_SERVICE}`;
  const existing = refreshInFlight.get(key);
  if (existing) return existing;
  const promise = performRefresh(deps, orgId, userId, cred).finally(() => refreshInFlight.delete(key));
  refreshInFlight.set(key, promise);
  return promise;
}

interface ParsedRefresh {
  accessToken: string;
  refreshToken?: string;
  expiresInMs?: number;
}

/** GitHub's `POST /login/oauth/access_token` returns HTTP 200 even on error
 * (the error rides an `{ error, error_description }` body), so a missing
 * `access_token` — not just a non-2xx status — is a refresh failure. */
function parseRefreshResponse(payload: unknown): ParsedRefresh | null {
  if (!isRecord(payload)) return null;
  const accessToken = payload.access_token;
  if (typeof accessToken !== "string" || accessToken.length === 0) return null;
  const refreshToken = typeof payload.refresh_token === "string" ? payload.refresh_token : undefined;
  const expiresIn = payload.expires_in;
  const expiresInMs = typeof expiresIn === "number" ? expiresIn * 1000 : undefined;
  return { accessToken, refreshToken, expiresInMs };
}

/** Marks the credential unhealthy (`metadata.refreshFailedAt`) while keeping
 * it otherwise intact, then returns `null`. The credential store stays dumb:
 * liveness lives entirely here. */
async function markRefreshFailed(
  deps: GitHubTokenDeps,
  owner: CredentialOwner,
  cred: StoredCredential,
): Promise<null> {
  const metadata = { ...(isRecord(cred.metadata) ? cred.metadata : {}), refreshFailedAt: nowOf(deps) };
  await deps.credentials.save(owner, GITHUB_CREDENTIAL_SERVICE, { ...cred, metadata });
  return null;
}

async function performRefresh(
  deps: GitHubTokenDeps,
  orgId: string,
  userId: string,
  cred: StoredCredential,
): Promise<StoredCredential | null> {
  const owner = userOwner(userId);
  const config = await loadAppConfig(deps, orgId);
  if (!config || !cred.refreshToken) return markRefreshFailed(deps, owner, cred);

  let res: Response;
  try {
    res = await githubFetchOf(deps)(`${githubBaseUrl(deps)}/login/oauth/access_token`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "User-Agent": "Valet-App",
      },
      body: JSON.stringify({
        client_id: config.oauthClientId,
        client_secret: config.oauthClientSecret,
        grant_type: "refresh_token",
        refresh_token: cred.refreshToken,
      }),
    });
  } catch {
    return markRefreshFailed(deps, owner, cred);
  }
  if (!res.ok) return markRefreshFailed(deps, owner, cred);

  let payload: unknown;
  try {
    payload = await res.json();
  } catch {
    return markRefreshFailed(deps, owner, cred);
  }
  const parsed = parseRefreshResponse(payload);
  if (!parsed) return markRefreshFailed(deps, owner, cred);

  const now = nowOf(deps);
  const rotated: StoredCredential = {
    ...cred,
    accessToken: parsed.accessToken,
    refreshToken: parsed.refreshToken ?? cred.refreshToken,
    expiresAt: parsed.expiresInMs !== undefined ? now + parsed.expiresInMs : undefined,
  };
  await deps.credentials.save(owner, GITHUB_CREDENTIAL_SERVICE, rotated);
  return rotated;
}

// ── User-credential health ─────────────────────────────────────────────

type UserCredResult =
  | { ok: true; token: string; source: "user" | "pat"; login?: string }
  | { ok: false; reason: string };

/** Resolves the user's `github` credential to a healthy token, refreshing a
 * stale App-OAuth credential in-place. Returns `{ ok: false, reason }` (the
 * reason names the gap for a STRICT `auth: "user"` throw) rather than
 * throwing, so `auto` can treat an absent/unhealthy credential as a
 * fallthrough. */
async function resolveUserCredential(
  deps: GitHubTokenDeps,
  orgId: string,
  userId: string | undefined,
): Promise<UserCredResult> {
  if (!userId) {
    return { ok: false, reason: "no user is associated with this request to resolve a user GitHub credential" };
  }
  const cred = await deps.credentials.get(userOwner(userId), GITHUB_CREDENTIAL_SERVICE);
  if (!cred || !cred.accessToken) {
    return { ok: false, reason: "no GitHub account is connected for this user" };
  }

  const metadata = cred.metadata;
  const login = loginOf(metadata);

  if (isRecord(metadata) && metadata.identityOnly === true) {
    return {
      ok: false,
      reason: "the connected GitHub account is identity-only (sign-in scopes) and cannot access repositories; reconnect GitHub with repo access",
    };
  }
  if (isRecord(metadata) && metadata.refreshFailedAt !== undefined && metadata.refreshFailedAt !== null) {
    return { ok: false, reason: "the connected GitHub credential needs to be reconnected (a previous token refresh failed)" };
  }

  // PAT: no expiry and no refresh token → always fresh.
  if (cred.expiresAt === undefined && cred.refreshToken === undefined) {
    return { ok: true, token: cred.accessToken, source: "pat", login };
  }

  const stale = cred.expiresAt !== undefined && cred.expiresAt - STALE_MARGIN_MS <= nowOf(deps);
  if (!stale) {
    return { ok: true, token: cred.accessToken, source: "user", login };
  }

  // Stale App-OAuth credential.
  if (!cred.refreshToken) {
    return { ok: false, reason: "the connected GitHub credential has expired and cannot be refreshed; reconnect GitHub" };
  }
  const rotated = await refreshSingleFlight(deps, orgId, userId, cred);
  if (!rotated || !rotated.accessToken) {
    return { ok: false, reason: "the connected GitHub credential could not be refreshed; reconnect GitHub" };
  }
  return { ok: true, token: rotated.accessToken, source: "user", login: loginOf(rotated.metadata) ?? login };
}

// ── Installation helpers ───────────────────────────────────────────────

/** The org's SOLE non-suspended installation token, when exactly one
 * installation exists. `null` when there are zero or more than one — the
 * anonymous org-token path only auto-applies when the choice is
 * unambiguous. */
async function resolveSoleInstallationToken(deps: GitHubTokenDeps, orgId: string): Promise<string | null> {
  const rows = await deps.db
    .select()
    .from(githubInstallations)
    .where(and(eq(githubInstallations.orgId, orgId), eq(githubInstallations.suspended, false)));
  if (rows.length !== 1) return null;
  return mintInstallationToken(deps, orgId, rows[0].accountLogin);
}

// ── The resolution function ────────────────────────────────────────────

export async function resolveGitHubToken(
  deps: GitHubTokenDeps,
  req: ResolveGitHubTokenRequest,
): Promise<ResolvedGitHubToken> {
  const auth = req.auth ?? "auto";

  // ── Explicit selections are strict — no fallback across them. ──
  if (auth === "app") {
    if (!req.repo) {
      throw new GitHubAuthError("the GitHub App requires a repository owner but none was provided");
    }
    const token = await mintInstallationToken(deps, req.orgId, req.repo.owner);
    if (!token) throw new GitHubAuthError(`the GitHub App is not installed on ${req.repo.owner}`);
    return { token, source: "installation" };
  }

  if (auth === "user") {
    const result = await resolveUserCredential(deps, req.orgId, req.userId);
    if (!result.ok) throw new GitHubAuthError(result.reason);
    return { token: result.token, source: result.source, login: result.login };
  }

  // ── auto ──
  if (req.purpose === "git") {
    // installation(owner) → user → tokenless.
    if (req.repo) {
      const installation = await mintInstallationToken(deps, req.orgId, req.repo.owner);
      if (installation) return { token: installation, source: "installation" };
    }
    const user = await resolveUserCredential(deps, req.orgId, req.userId);
    if (user.ok) return { token: user.token, source: user.source, login: user.login };
    return { token: null, source: "none" };
  }

  // auto + api: user → installation(owner) → sole installation → throw.
  const user = await resolveUserCredential(deps, req.orgId, req.userId);
  if (user.ok) return { token: user.token, source: user.source, login: user.login };

  if (req.repo) {
    const installation = await mintInstallationToken(deps, req.orgId, req.repo.owner);
    if (installation) return { token: installation, source: "installation" };
  }

  const sole = await resolveSoleInstallationToken(deps, req.orgId);
  if (sole) return { token: sole, source: "installation" };

  throw new GitHubAuthError(
    "no GitHub credential is available; connect your GitHub account or install the GitHub App for this organization",
  );
}
