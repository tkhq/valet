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
 *   - Explicit `auth: "app"`  → installation token for `repo.owner`, or the
 *     org's SOLE non-suspended App-owner installation when no repo is given, or THROW
 *     (`GitHubAuthError`). Never falls back to a user credential or an org
 *     PAT.
 *   - Explicit `auth: "user"` → the USER's healthy App-OAuth/PAT credential,
 *     or THROW naming the gap. Never falls back to an installation token,
 *     and never matches an org-owned PAT (see below) — "user" means the
 *     signed-in user's own credential, not the org's shared one.
 *     (Both directions pinned: an explicit selection is honored STRICTLY.)
 *   - `auto` + `git`: installation(`repo.owner`) → healthy user credential →
 *     healthy org PAT → `{ token: null, source: "none" }` (tokenless —
 *     public clones proceed bare; a private-repo failure surfaces git's own
 *     error).
 *   - `auto` + `api`: healthy user credential → installation(`repo.owner`)
 *     when a repo is given → the org's SOLE non-suspended App-owner installation when
 *     exactly one exists → healthy org PAT → THROW with a connect hint.
 *
 * ── "Healthy" user credential ───────────────────────────────────────────
 * A user-owned `github` credential is healthy when it is NOT
 * `metadata.identityOnly` (social-login default scopes — not repo-capable),
 * NOT `metadata.refreshFailedAt`-marked, and fresh. A PAT (no `expiresAt`
 * and no `refreshToken`) is always fresh. An App-OAuth credential is fresh
 * when `expiresAt - 5min > now`; otherwise it is refreshed in-place (see
 * below) and the rotated credential is used.
 *
 * ── Org-owned PAT ────────────────────────────────────────────────────────
 * A pasted user/org GitHub PAT participates as a non-expiring OAuth token
 * for the whole org: an org-owned `github` credential (`{type:"org",
 * id:orgId}`, same service name as the per-user row) is the last `auto`
 * tier before tokenless/throw. Health rules mirror the user credential's
 * (not `identityOnly`, not `refreshFailedAt`-marked, fresh) MINUS the
 * refresh path — org credentials have no `refreshToken` flow, so a missing
 * `expiresAt` means non-expiring (fresh), and an `expiresAt` that's stale
 * is simply unhealthy (no attempt to refresh it). Its result source is
 * `"pat"`, with `login` from `metadata.login` when present. Explicit
 * `auth: "user"` never reaches this tier (see above).
 *
 * ── Refresh subsystem ───────────────────────────────────────────────────
 * A stale App-OAuth credential (`expiresAt - 5min <= now`) with a
 * `refreshToken` is refreshed single-flight via
 * `POST {github}/login/oauth/access_token` (the App's client id/secret,
 * `grant_type=refresh_token`). The rotated `{ accessToken, refreshToken,
 * expiresAt }` is persisted, keeping `metadata` (incl. `login`). Refresh
 * failure marks `metadata.refreshFailedAt` only for permanent authorization
 * failures. Transient failures remain retryable. The shared credential module
 * serializes rotation under the credential row lock across pods. It re-reads
 * the row before exchanging a single-use refresh token.
 *
 * No token material ever appears in an error message or log — errors name
 * the missing/unhealthy credential (the GAP), never the secret.
 */
import { and, eq, isNull } from "drizzle-orm";
import type { CredentialOwner, StoredCredential } from "@valet/engine";
import { githubInstallations, orgs } from "../schema/index.js";
import { ensureInstallationAccountIds, requestInstallationDiscovery, installationAccessCondition, loadAppConfig, loadAppOwner, mintInstallationToken, type GithubAppDeps } from "./github-app.js";

export const GITHUB_CREDENTIAL_SERVICE = "github";
/**
 * Virtual credential service a plugin action requests when it needs the
 * org's GitHub App INSTALLATION token specifically, regardless of which
 * credential tier default `github` resolution would pick. `github.list_repos`
 * with `scope: "installation"` is the consumer: `GET /installation/repositories`
 * accepts installation tokens exclusively, so a resolved user token 403s
 * there no matter what the endpoint choice is. The credential resolvers
 * (`engine/host.ts`, `plugins/action-invoker.ts`) answer this service via
 * `resolveInstallationApiToken`; the plugin keeps its own copy of the
 * literal (it cannot import from `@valet/api`).
 */
export const GITHUB_INSTALLATION_CREDENTIAL_SERVICE = "github:installation";
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

function orgOwner(orgId: string): CredentialOwner {
  return { type: "org", id: orgId };
}

function loginOf(metadata: unknown): string | undefined {
  return isRecord(metadata) && typeof metadata.login === "string" ? metadata.login : undefined;
}

export { checkGithubUserRow, isUsableGithubUserRow } from "./github-user-credentials.js";
import { checkGithubUserRow, resolveUserCredential as resolveUserCredentialWithConfig } from "./github-user-credentials.js";

function resolveUserCredential(deps: GitHubTokenDeps, orgId: string, userId: string | undefined, identityOnly = false) {
  return resolveUserCredentialWithConfig(deps, orgId, userId, (id) => loadAppConfig(deps, id), identityOnly);
}

// ── Org-owned PAT ────────────────────────────────────────────────────────

type OrgPatResult = { ok: true; token: string; login?: string } | { ok: false };

/** Resolves the org-owned `github` credential (a pasted PAT, see the module
 * doc comment) to a healthy token. Same health checks as
 * `resolveUserCredential` minus the refresh path — org credentials never
 * carry a `refreshToken`, so a stale `expiresAt` is simply unhealthy rather
 * than triggering a refresh attempt. Non-throwing: `auto` treats
 * `{ ok: false }` as a fallthrough to the next tier. */
async function resolveOrgPatCredential(deps: GitHubTokenDeps, orgId: string): Promise<OrgPatResult> {
  const cred = await deps.credentials.get(orgOwner(orgId), GITHUB_CREDENTIAL_SERVICE);
  if (!cred || !cred.accessToken) return { ok: false };

  const metadata = cred.metadata;
  if (isRecord(metadata) && metadata.identityOnly === true) return { ok: false };
  if (isRecord(metadata) && metadata.refreshFailedAt !== undefined && metadata.refreshFailedAt !== null) {
    return { ok: false };
  }

  // No expiresAt → non-expiring (fresh). An expiresAt that's stale is
  // unhealthy outright — there is no refresh path for an org credential.
  if (cred.expiresAt !== undefined && cred.expiresAt - STALE_MARGIN_MS <= nowOf(deps)) {
    return { ok: false };
  }

  return { ok: true, token: cred.accessToken, login: loginOf(metadata) };
}

export interface ApiListToken {
  token: string;
  login?: string;
}

/** Narrow read-only wrapper over `resolveUserCredential`'s health check, for
 * callers (Task 7's repo listing) that only want "does this user have a
 * healthy API-capable credential" without the STRICT-throw behavior
 * `resolveGitHubToken({ auth: "user" })` has. `null` on any unhealthy/absent
 * reason — reuses the exact same health rules, does not duplicate them. */
export async function resolveUserApiToken(
  deps: GitHubTokenDeps,
  orgId: string,
  userId: string | undefined,
): Promise<ApiListToken | null> {
  const result = await resolveUserCredential(deps, orgId, userId);
  return result.ok ? { token: result.token, login: result.login } : null;
}

/** Refresh-aware identity token. It does not grant direct repository access. */
export async function resolveUserIdentityToken(
  deps: GitHubTokenDeps,
  orgId: string,
  userId: string,
): Promise<string | null> {
  const result = await resolveUserCredential(deps, orgId, userId, true);
  return result.ok ? result.token : null;
}

/** Narrow read-only wrapper over `resolveOrgPatCredential`, for the same
 * reason as `resolveUserApiToken` above — the org-PAT tier of listing needs
 * the health check without the `auto`/`app`/`user` selection machinery
 * `resolveGitHubToken` wraps it in. */
export async function resolveOrgPatApiToken(deps: GitHubTokenDeps, orgId: string): Promise<ApiListToken | null> {
  const result = await resolveOrgPatCredential(deps, orgId);
  return result.ok ? { token: result.token, login: result.login } : null;
}

// ── Installation helpers ───────────────────────────────────────────────

/** Wraps `mintInstallationToken` so every consumer of this module sees one
 * error type (`GitHubAuthError`) rather than the plain `Error`s
 * `mintInstallationToken`/`loadAppConfig` throw on a bad HTTP response or a
 * malformed `github_app` row. The wrapped message names the failure class
 * and carries the underlying message (which itself never includes secret or
 * response-body material — only a status code at most). */
async function mintInstallation(deps: GitHubTokenDeps, orgId: string, accountLogin: string, userId?: string): Promise<string | null> {
  try {
    return await mintInstallationToken(deps, orgId, accountLogin, userId);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new GitHubAuthError(`installation token minting failed for ${accountLogin}: ${detail}`);
  }
}

/** The org's SOLE non-suspended App-owner installation token, regardless of
 * GitHub account type. `null` when there are zero or more than one — the
 * anonymous org-token path only auto-applies when the choice is
 * unambiguous. */
async function resolveSoleInstallationToken(deps: GitHubTokenDeps, orgId: string): Promise<string | null> {
  await ensureInstallationAccountIds(deps, orgId);
  const candidates = await deps.db.select().from(githubInstallations)
    .where(and(eq(githubInstallations.orgId, orgId), eq(githubInstallations.suspended, false)));
  if (candidates.length === 0) return null;
  let owner: import("./github-app.js").GithubAccountIdentity;
  try {
    const config = await loadAppConfig(deps, orgId);
    if (!config) return null;
    owner = await loadAppOwner(deps, orgId, config);
  } catch {
    return null;
  }
  const rows = candidates.filter((row) => row.accountId === owner.id);
  if (rows.length !== 1) return null;
  return mintInstallation(deps, orgId, rows[0].accountLogin);
}

/**
 * Resolves the org's installation token for an explicit installation-tier
 * request (`GITHUB_INSTALLATION_CREDENTIAL_SERVICE`). Prefers `repoOwner`'s
 * installation when one is given (the session's primary repo binding, or a
 * workflow action's own `owner` parameter), then the org's sole
 * non-suspended installation. `null` when neither resolves — the caller
 * (the plugin action) names the corrective step; a minting failure still
 * throws `GitHubAuthError` via `mintInstallation`.
 */
export async function resolveInstallationApiToken(
  deps: GitHubTokenDeps,
  orgId: string,
  repoOwner?: string,
  userId?: string,
): Promise<string | null> {
  if (!repoOwner) await ensureInstallationsSynced(deps, orgId);
  if (repoOwner) {
    const token = await mintInstallation(deps, orgId, repoOwner, userId);
    // `null` alone means "no installation for this owner" — the one case
    // the sole-installation fallback is for. Any other value, even an
    // empty string, is a mint result and must surface, not be masked by
    // silently trying a different installation.
    if (token !== null) return token;
  }
  return resolveSoleInstallationToken(deps, orgId);
}

/** Why an App installation would not answer a team `auto` read. */
export type InstallationResolution =
  | { ok: true }
  | { ok: false; gap: "no_app" }
  | { ok: false; gap: "app_unavailable" }
  | { ok: false; gap: "no_installations" }
  | { ok: false; gap: "no_installation_for_owner"; owner: string }
  | { ok: false; gap: "ambiguous"; count: number };

/**
 * Whether `resolveInstallationApiToken` would find an installation, without
 * minting a token: the App is configured, and either `repoOwner` has a
 * non-suspended installation or the org has exactly one. This is the
 * readiness predicate's view of a team-owned `auto` github node
 * (`workflows/team-service-readiness.ts`), so the two stay one rule.
 *
 * `strictOwner` is for App-pinned nodes: a known owner must match.
 * `dynamicOwner` defers an expression's owner match until install or run time.
 * The template installer checks the exact repository before arming events.
 *
 * Reads the installations table as it stands and verifies the App owner.
 * Transient failures use persisted owner authority; absent authority is unavailable. Readiness does not run lazy discovery;
 * a manual installation reads as `no_installations` until a run or
 * "Refresh installations" fills the table.
 */
export async function installationResolvesFor(
  deps: Pick<GithubAppDeps, "db" | "credentials" | "env" | "apiUrl" | "fetchImpl" | "now">,
  orgId: string,
  repoOwner: string | undefined,
  options: { strictOwner?: boolean; dynamicOwner?: boolean; userId?: string } = {},
): Promise<InstallationResolution> {
  const config = await loadAppConfig(deps, orgId);
  if (!config) return { ok: false, gap: "no_app" };
  let owner: import("./github-app.js").GithubAccountIdentity;
  try {
    owner = await loadAppOwner(deps, orgId, config);
  } catch {
    return { ok: false, gap: "app_unavailable" };
  }
  await ensureInstallationAccountIds(deps, orgId);
  const [unverified] = await deps.db.select({ id: githubInstallations.id }).from(githubInstallations)
    .where(and(eq(githubInstallations.orgId, orgId), eq(githubInstallations.suspended, false),
      isNull(githubInstallations.accountId))).limit(1);
  if (unverified) return { ok: false, gap: "app_unavailable" };
  const rows = await deps.db
    .select({ accountLogin: githubInstallations.accountLogin, accountId: githubInstallations.accountId })
    .from(githubInstallations)
    .where(and(eq(githubInstallations.orgId, orgId), eq(githubInstallations.suspended, false),
      installationAccessCondition(owner, options.userId)));
  if (rows.length === 0) return { ok: false, gap: "no_installations" };
  if (options.dynamicOwner && !repoOwner) return { ok: true };
  // Same case-insensitive match as `mintInstallationToken`.
  if (repoOwner && rows.some((row) => row.accountLogin.toLowerCase() === repoOwner.toLowerCase())) {
    return { ok: true };
  }
  const orgRows = rows.filter((row) => row.accountId === owner.id);
  if (orgRows.length === 1 && !(options.strictOwner && repoOwner)) return { ok: true };
  if (repoOwner) return { ok: false, gap: "no_installation_for_owner", owner: repoOwner };
  return { ok: false, gap: "ambiguous", count: orgRows.length };
}

// ── Lazy installation sync ──────────────────────────────────────────────

/** Manual webhook mode records nothing when the admin installs the App on
 * GitHub — without this, every resolution keeps failing until someone
 * clicks "Refresh installations". When an App config exists but the
 * installations table is empty, sync once (throttled per process+org so a
 * genuinely uninstalled App doesn't hammer GitHub on every tool call). */
async function ensureInstallationsSynced(deps: GitHubTokenDeps, orgId: string): Promise<void> {
  await ensureInstallationAccountIds(deps, orgId);
  const [row] = await deps.db.select({ id: githubInstallations.id }).from(githubInstallations)
    .where(eq(githubInstallations.orgId, orgId)).limit(1);
  if (!row) await requestInstallationDiscovery(deps, orgId);
}

// ── The resolution function ────────────────────────────────────────────

export async function resolveGitHubToken(
  deps: GitHubTokenDeps,
  req: ResolveGitHubTokenRequest,
): Promise<ResolvedGitHubToken> {
  const auth = req.auth ?? "auto";
  // Repo-scoped requests use row-first minting and nonblocking targeted recovery.
  // They must not wait on a full listing before the user/PAT tiers can run.
  if (!req.repo && auth !== "user") await ensureInstallationsSynced(deps, req.orgId);

  // ── Explicit selections are strict — no fallback across them. ──
  if (auth === "app") {
    if (req.repo) {
      const token = await mintInstallation(deps, req.orgId, req.repo.owner, req.userId);
      if (!token) {
        throw new GitHubAuthError(
          `the GitHub App is not installed on ${req.repo.owner} — open Settings → Organization → GitHub and install it on ${req.repo.owner}`,
        );
      }
      return { token, source: "installation" };
    }
    // No repo names an owner: only the org's SOLE installation is
    // unambiguous. Zero or several installations throw, never an org PAT.
    const sole = await resolveSoleInstallationToken(deps, req.orgId);
    if (sole) return { token: sole, source: "installation" };
    throw new GitHubAuthError(
      "the GitHub App has no single installation to use and no repository names an owner — bind a repository to the session, or open Settings → Organization → GitHub and install the App on exactly one account",
    );
  }

  if (auth === "user") {
    // Never falls back to the org PAT tier — "user" means THIS user's own
    // credential (see the module doc comment).
    const result = await resolveUserCredential(deps, req.orgId, req.userId);
    if (!result.ok) throw new GitHubAuthError(result.reason);
    return { token: result.token, source: result.source, login: result.login };
  }

  // ── auto ──
  if (req.purpose === "git") {
    // installation(owner) → user → org PAT → tokenless.
    if (req.repo) {
      const installation = await mintInstallation(deps, req.orgId, req.repo.owner, req.userId);
      if (installation) return { token: installation, source: "installation" };
    }
    const user = await resolveUserCredential(deps, req.orgId, req.userId);
    if (user.ok) return { token: user.token, source: user.source, login: user.login };
    const orgPat = await resolveOrgPatCredential(deps, req.orgId);
    if (orgPat.ok) return { token: orgPat.token, source: "pat", login: orgPat.login };
    return { token: null, source: "none" };
  }

  // auto + api: user → installation(owner) → sole installation → org PAT → throw.
  const user = await resolveUserCredential(deps, req.orgId, req.userId);
  if (user.ok) return { token: user.token, source: user.source, login: user.login };

  if (req.repo) {
    const installation = await mintInstallation(deps, req.orgId, req.repo.owner, req.userId);
    if (installation) return { token: installation, source: "installation" };
  }

  const sole = await resolveSoleInstallationToken(deps, req.orgId);
  if (sole) return { token: sole, source: "installation" };

  const orgPat = await resolveOrgPatCredential(deps, req.orgId);
  if (orgPat.ok) return { token: orgPat.token, source: "pat", login: orgPat.login };

  // Name the actual gap: an App that exists but has no installations is a
  // different fix ("Install on GitHub") than no GitHub setup at all.
  const config = await loadAppConfig(deps, req.orgId).catch(() => null);
  if (config) {
    const orgRows = await deps.db
      .select({ allowPersonalInstallations: orgs.allowPersonalInstallations })
      .from(orgs)
      .where(eq(orgs.id, req.orgId))
      .limit(1);
    if (orgRows[0]?.allowPersonalInstallations === false) {
      throw new GitHubAuthError(
        "the GitHub App has no usable installation. Ask an org admin for GitHub access.",
      );
    }
    throw new GitHubAuthError(
      `the GitHub App "${config.appSlug}" is created but not installed on any account — open Settings → Organization → GitHub and click Install on GitHub`,
    );
  }
  throw new GitHubAuthError(
    "no GitHub credential is available; connect your GitHub account or install the GitHub App for this organization",
  );
}
