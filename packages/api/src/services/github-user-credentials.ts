/** Shared GitHub OAuth health and serialized refresh. No installation authorization lives here. */
import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import type { CredentialOwner, CredentialStore, StoredCredential } from "@valet/engine";
import type { GitHubTokenDeps } from "./github-tokens.js";
import { resolveGithubUrl } from "./github-env.js";

const GITHUB_CREDENTIAL_SERVICE = "github";
const STALE_MARGIN_MS = 5 * 60 * 1000;
type OAuthConfig = { oauthClientId: string; oauthClientSecret: string };
export type OAuthConfigLoader = (orgId: string) => Promise<OAuthConfig | null>;
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
function nowOf(deps: GitHubTokenDeps): number { return (deps.now ?? Date.now)(); }
function githubBaseUrl(deps: GitHubTokenDeps): string { return deps.githubUrl ?? resolveGithubUrl(process.env); }
function githubFetchOf(deps: GitHubTokenDeps): typeof fetch { return deps.fetchImpl ?? fetch; }
function userOwner(userId: string): CredentialOwner { return { type: "user", id: userId }; }
function loginOf(metadata: unknown): string | undefined {
  return isRecord(metadata) && typeof metadata.login === "string" ? metadata.login : undefined;
}
const IDENTITY_DOMAIN = "valet/github-identity/v1";

/** Separate signing from AES encryption and bind proofs to the Valet user. */
export function githubIdentityProof(
  key: Buffer, userId: string, id: number, credential: Pick<StoredCredential, "accessToken" | "apiKey">,
): string {
  const signingKey = hkdfSync("sha256", key, Buffer.alloc(0), IDENTITY_DOMAIN, 32);
  return createHmac("sha256", Buffer.from(signingKey))
    .update(JSON.stringify([IDENTITY_DOMAIN, userId, id, credential.accessToken ?? credential.apiKey ?? ""]))
    .digest("hex");
}

export function verifiedGithubUserId(key: Buffer, userId: string, credential: StoredCredential): number | null {
  const meta = credential.metadata;
  if (!isRecord(meta) || typeof meta.githubUserId !== "number" || !Number.isSafeInteger(meta.githubUserId) ||
      typeof meta.githubIdentityProof !== "string" || !/^[a-f0-9]{64}$/.test(meta.githubIdentityProof)) return null;
  const expected = Buffer.from(githubIdentityProof(key, userId, meta.githubUserId, credential), "hex");
  return timingSafeEqual(Buffer.from(meta.githubIdentityProof, "hex"), expected) ? meta.githubUserId : null;
}

// ── Single-flight refresh ──────────────────────────────────────────────

/** In-module single-flight registry, keyed by `${orgId}:${userId}:${service}`
 * — the org id is part of the key because the refresh hits that org's App
 * config (`loadAppConfig(deps, orgId)`); without it, concurrent refreshes
 * for the same user across two different orgs would collapse onto whichever
 * org's config happened to win the race. A second concurrent resolve of the
 * same stale credential joins the in-flight refresh rather than issuing a
 * duplicate token exchange. Cleared in `finally`, so the next resolve after
 * completion refreshes anew if needed. */
const refreshInFlight = new Map<string, Promise<StoredCredential | null>>();

function refreshSingleFlight(
  deps: GitHubTokenDeps,
  orgId: string,
  userId: string,
  cred: StoredCredential,
  loadConfig: OAuthConfigLoader,
): Promise<StoredCredential | null> {
  const key = `${orgId}:${userId}:${GITHUB_CREDENTIAL_SERVICE}`;
  const existing = refreshInFlight.get(key);
  if (existing) return existing;
  const promise = lockedRefresh(deps, orgId, userId, cred, loadConfig).finally(() => refreshInFlight.delete(key));
  refreshInFlight.set(key, promise);
  return promise;
}

async function lockedRefresh(
  deps: GitHubTokenDeps, orgId: string, userId: string,
  cred: StoredCredential, loadConfig: OAuthConfigLoader,
): Promise<StoredCredential | null> {
  try {
    // Load the App before taking the credential lock: PGlite has one connection.
    const config = await loadConfig(orgId);
    if (!config) return null;
    // The existing CredentialStore port has no fenced conditional-write lease.
    // Keep the row lock until token persistence to prevent single-use token races.
    // Only the supplied transactional store may access the DB inside this lock.
    // No non-transactional DB calls are allowed here; the HTTP timeout bounds the hold.
    const operation = async (store: CredentialStore) => {
      const current = await store.get(userOwner(userId), GITHUB_CREDENTIAL_SERVICE);
      if (!current || current.metadata?.refreshFailedAt) return null;
      if (current.accessToken !== cred.accessToken || current.refreshToken !== cred.refreshToken) return current;
      return performRefresh({ ...deps, credentials: store }, userId, current, config);
    };
    return deps.credentials.withLock
      ? await deps.credentials.withLock(userOwner(userId), GITHUB_CREDENTIAL_SERVICE, operation)
      : await operation(deps.credentials);
  } catch {
    return null;
  }
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
 * liveness lives entirely here. Persisting the marker is itself best-effort
 * — if `credentials.save` throws (store outage, etc.) this still resolves to
 * `null` rather than rejecting, so a failed refresh NEVER propagates as an
 * unhandled rejection out of the single-flight promise. */
async function markRefreshFailed(
  deps: GitHubTokenDeps,
  owner: CredentialOwner,
  cred: StoredCredential,
): Promise<null> {
  try {
    const metadata = { ...(isRecord(cred.metadata) ? cred.metadata : {}), refreshFailedAt: nowOf(deps) };
    await deps.credentials.save(owner, GITHUB_CREDENTIAL_SERVICE, { ...cred, metadata });
  } catch {
    // Best-effort marker — see doc comment above.
  }
  return null;
}

/** Only permanent authorization failures mark a credential unhealthy.
 * Timeouts, network errors, rate limits, malformed replies and 5xx are retryable.
 * A failed refresh returns null so auto resolution can try another tier. */
async function performRefresh(
  deps: GitHubTokenDeps,
  userId: string,
  cred: StoredCredential,
  config: OAuthConfig,
): Promise<StoredCredential | null> {
  const owner = userOwner(userId);
  try {
    if (!cred.refreshToken) return null;

    let res: Response;
    try {
      res = await githubFetchOf(deps)(`${githubBaseUrl(deps)}/login/oauth/access_token`, {
        method: "POST",
        signal: AbortSignal.timeout(10_000),
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
      return null;
    }
    if (res.status >= 500 || res.status === 429 || res.status === 408) return null;
    if (!res.ok) return markRefreshFailed(deps, owner, cred);

    let payload: unknown;
    try {
      payload = await res.json();
    } catch {
      return null;
    }
    const parsed = parseRefreshResponse(payload);
    if (!parsed) {
      return isRecord(payload) && (payload.error === "bad_refresh_token" || payload.error === "invalid_grant")
        ? markRefreshFailed(deps, owner, cred) : null;
    }

    const now = nowOf(deps);
    const rotated: StoredCredential = {
      ...cred,
      accessToken: parsed.accessToken,
      refreshToken: parsed.refreshToken ?? cred.refreshToken,
      expiresAt: parsed.expiresInMs !== undefined ? now + parsed.expiresInMs : undefined,
    };
    // `refreshFailedAt` is intentionally never cleared here: a credential
    // already marked unhealthy is rejected by `resolveUserCredential` before
    // it ever reaches a refresh attempt, so recovery is a reconnect (which
    // overwrites the row), not a successful refresh.
    if (isRecord(rotated.metadata) && typeof rotated.metadata.githubUserId === "number" &&
        verifiedGithubUserId(deps.key, userId, cred) === rotated.metadata.githubUserId) {
      rotated.metadata = {
        ...rotated.metadata,
        githubIdentityProof: githubIdentityProof(deps.key, userId, rotated.metadata.githubUserId, rotated),
      };
    }
    await deps.credentials.save(owner, GITHUB_CREDENTIAL_SERVICE, rotated);
    return rotated;
  } catch {
    return null;
  }
}

// ── User-credential health ─────────────────────────────────────────────

/** The fields the health rules read. `StoredCredential` and the engine's
 * `Credential` both satisfy it, so a row read through any store shape can
 * be checked. */
export interface GithubUserRowLike {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  metadata?: unknown;
}

export type GithubUserRowHealth =
  | { ok: true; token: string; state: "pat" | "fresh" | "stale-refreshable" }
  | { ok: false; reason: string };

/**
 * The ONE definition of a usable user `github` row, with no I/O: it must
 * hold a token, must not be identity-only (sign-in scopes cannot reach
 * repositories), must not be marked by a failed refresh, and must be fresh
 * or refreshable. `resolveUserCredential` applies it before it refreshes;
 * the delegate route and the workflow invoker's team branch apply it so a
 * row a user's own runs would refuse is never shared with, or acted on by,
 * a team. `reason` names the gap for a caller that reports it.
 */
export function checkGithubUserRow(cred: GithubUserRowLike, now: number): GithubUserRowHealth {
  if (!cred.accessToken) {
    return { ok: false, reason: "no GitHub account is connected for this user" };
  }
  const metadata = cred.metadata;
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
    return { ok: true, token: cred.accessToken, state: "pat" };
  }
  const stale = cred.expiresAt !== undefined && cred.expiresAt - STALE_MARGIN_MS <= now;
  if (!stale) {
    return { ok: true, token: cred.accessToken, state: "fresh" };
  }
  if (!cred.refreshToken) {
    return { ok: false, reason: "the connected GitHub credential has expired and cannot be refreshed; reconnect GitHub" };
  }
  return { ok: true, token: cred.accessToken, state: "stale-refreshable" };
}

/** `checkGithubUserRow` as a boolean, for callers that only branch on it. */
export function isUsableGithubUserRow(cred: GithubUserRowLike, now: number): boolean {
  return checkGithubUserRow(cred, now).ok;
}

export type UserCredResult =
  | { ok: true; token: string; source: "user" | "pat"; login?: string }
  | { ok: false; reason: string };

/** Resolves the user's `github` credential to a healthy token, refreshing a
 * stale App-OAuth credential in-place. Returns `{ ok: false, reason }` (the
 * reason names the gap for a STRICT `auth: "user"` throw) rather than
 * throwing, so `auto` can treat an absent/unhealthy credential as a
 * fallthrough. */
export async function resolveUserCredential(
  deps: GitHubTokenDeps,
  orgId: string,
  userId: string | undefined,
  loadConfig: OAuthConfigLoader,
  allowIdentityOnly = false,
): Promise<UserCredResult> {
  if (!userId) {
    return { ok: false, reason: "no user is associated with this request to resolve a user GitHub credential" };
  }
  const cred = await deps.credentials.get(userOwner(userId), GITHUB_CREDENTIAL_SERVICE);
  if (!cred) {
    return { ok: false, reason: "no GitHub account is connected for this user" };
  }
  // Sign-in scopes can prove identity for an installation, but cannot read repos.
  const health = checkGithubUserRow(allowIdentityOnly && isRecord(cred.metadata)
    ? { ...cred, metadata: { ...cred.metadata, identityOnly: false } } : cred, nowOf(deps));
  if (!health.ok) return health;
  const login = loginOf(cred.metadata);
  if (health.state === "pat") {
    return { ok: true, token: health.token, source: "pat", login };
  }
  if (health.state === "fresh") {
    return { ok: true, token: health.token, source: "user", login };
  }

  // Stale App-OAuth credential with a refresh token.
  const rotated = await refreshSingleFlight(deps, orgId, userId, cred, loadConfig);
  if (!rotated || !rotated.accessToken) {
    return { ok: false, reason: "GitHub token refresh is temporarily unavailable. Try again, or reconnect GitHub if the failure continues." };
  }
  return { ok: true, token: rotated.accessToken, source: "user", login: loginOf(rotated.metadata) ?? login };
}

