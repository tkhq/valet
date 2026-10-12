/**
 * GitHub App core service (GitHub/repo integration plan, Task 3): App JWT
 * minting, installation discovery, and THE one cached installation-token
 * minting path. Tasks 4-7 (OAuth app-manifest flow, repo listing, sandbox
 * clone auth, webhooks) all build on this file — do not add a second
 * token-minting implementation anywhere else.
 *
 * ── App config storage (deliberate `StoredCredential` field reuse) ────────
 * The GitHub App's config (three distinct secrets + four plain fields) is
 * stored as ONE row in `credentials`, owner `{type:"org", id:orgId}`,
 * service `"github_app"` — no new table. Field mapping, centralized here
 * and nowhere else:
 *
 *   - `type`          = `"service_account"`
 *   - `apiKey`        = the App's PEM private key
 *   - `accessToken`   = the OAuth client secret
 *   - `refreshToken`  = the webhook secret
 *   - `metadata`      = `{ appId, appSlug, oauthClientId, htmlUrl }`
 *
 * `apiKey`/`accessToken`/`refreshToken` are encrypted at rest by
 * `PgCredentialStore` (AES-256-GCM, see `lib/secret-crypto.ts`); `metadata`
 * is plain jsonb (matches every other credential row — see
 * `plugins/credential-store.ts`). `loadAppConfig`/`saveAppConfig` are the
 * only functions that know this mapping; every other caller goes through
 * `GithubAppConfig`.
 *
 * ── Installation token caching ─────────────────────────────────────────
 * `mintInstallationToken` is the ONLY place that calls
 * `POST /app/installations/{id}/access_tokens`. It caches the encrypted
 * token + expiry on the `github_installations` row (`cachedToken`/
 * `cachedTokenExpiresAt` — see that table's doc comment in
 * `schema/index.ts`) and re-mints only once the cached token is within 5
 * minutes of expiring.
 *
 * ── Linked identity ────────────────────────────────────────────────────
 * Discovery joins org membership to GitHub credential rows. Only candidate
 * personal installations require identity checks, with concurrency of one.
 * GitHub account IDs establish authority; logins are mutable display names.
 * Verified member IDs are persisted with a token-bound HMAC. App-owner IDs
 * are persisted separately, bound to the App config, for transient outages.
 */
import { githubIdentityProof, verifiedGithubUserId, resolveUserCredential, checkGithubUserRow } from "./github-user-credentials.js";
import { invalidateWorkflowSources } from "./content-sync/invalidation.js";
import { createHash, createPrivateKey, randomUUID, sign } from "node:crypto";
import { and, eq, or, sql } from "drizzle-orm";
import type { CredentialOwner, CredentialStore } from "@valet/engine";
import type { AppQueryable } from "../lib/drizzle.js";
import {
  credentials, githubInstallations, orgMembers, orgs, type GithubInstallationRow,
} from "../schema/index.js";
import { decryptSecret, encryptSecret } from "../lib/secret-crypto.js";
import { resolveGithubApiUrl, resolveGithubUrl } from "./github-env.js";
import { GITHUB_APP_WEBHOOK_PATH, parsePrivateKeyPem } from "@valet/plugin-github/http";

const GITHUB_APP_SERVICE = "github_app";
const CACHED_TOKEN_MARGIN_MS = 5 * 60 * 1000;

export interface GithubAppConfig {
  appId: string;
  appSlug: string;
  oauthClientId: string;
  htmlUrl: string;
  /** OAuth client secret — stored in `credentials.accessToken`. */
  oauthClientSecret: string;
  /** Webhook secret — stored in `credentials.refreshToken`. */
  webhookSecret: string;
  /** PEM private key — stored in `credentials.apiKey`. */
  privateKeyPem: string;
}

export interface GithubAppDeps {
  db: AppQueryable;
  credentials: CredentialStore;
  /** AES-256-GCM key for `github_installations.cachedToken` (same wiring as
   * `PgCredentialStore`'s key — see `providers/node.ts`). */
  key: Buffer;
  /** Overrides `resolveGithubApiUrl(process.env)` — tests point this at
   * `startGithubFixture()`'s `url`. */
  apiUrl?: string;
  /** OAuth base URL for refreshing linked GitHub credentials. */
  githubUrl?: string;
  /** Injectable `fetch` for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Injectable clock; defaults to `Date.now`. */
  now?: () => number;
  /** Environment for the `GITHUB_APP_*` fallback config — defaults to
   * `process.env`. Tests inject a plain object instead of mutating the
   * global environment. */
  env?: NodeJS.ProcessEnv;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function appConfigOwner(orgId: string): CredentialOwner {
  return { type: "org", id: orgId };
}

// ── Environment fallback (`GITHUB_APP_*`) ────────────────────────────────
// A deployment can bring its own pre-existing GitHub App through the
// environment instead of the manifest flow. The env is the config: nothing
// is written to the DB, and an org that later completes the manifest flow
// gets its own credential row, which shadows the fallback (see
// `loadAppConfigWithSource`).

const ENV_REQUIRED_VARS = [
  "GITHUB_APP_ID",
  "GITHUB_APP_SLUG",
  "GITHUB_APP_CLIENT_ID",
  "GITHUB_APP_CLIENT_SECRET",
  "GITHUB_APP_PRIVATE_KEY",
] as const;
const ENV_ALL_VARS = [...ENV_REQUIRED_VARS, "GITHUB_APP_WEBHOOK_SECRET"] as const;

/** Accepts a raw or base64-encoded PEM. The GitHub plugin owns the parser,
 * because its credential route validates the same field. The caller writes
 * the error, because the corrective action names a different field on each
 * path: an environment variable or a form field. */
export { parsePrivateKeyPem };

/** Parts a caller supplies to `buildAppConfig`. The two secrets are optional
 * because an app works without them: the OAuth client secret is needed only
 * for per-user GitHub sign-in, and the webhook secret only for event
 * delivery. */
export interface AppConfigInput {
  appId: string;
  appSlug: string;
  oauthClientId: string;
  privateKeyPem: string;
  oauthClientSecret?: string;
  webhookSecret?: string;
  /** The app's page on GitHub. Derived from `appSlug` when absent. */
  htmlUrl?: string;
}

/** THE one place that turns supplied parts into the stored config shape.
 * Both config paths call it — the `GITHUB_APP_*` environment fallback and
 * the admin route that connects an app which already exists — so neither can
 * store a shape the other cannot read. An absent secret becomes `""`, which
 * is what `loadStoredAppConfig` expects and what `verifyWebhookSignature`
 * treats as "never verifies". */
export function buildAppConfig(input: AppConfigInput, env: NodeJS.ProcessEnv): GithubAppConfig {
  return {
    appId: input.appId,
    appSlug: input.appSlug,
    oauthClientId: input.oauthClientId,
    htmlUrl: input.htmlUrl ?? `${resolveGithubUrl(env)}/apps/${input.appSlug}`,
    oauthClientSecret: input.oauthClientSecret ?? "",
    webhookSecret: input.webhookSecret ?? "",
    privateKeyPem: input.privateKeyPem,
  };
}

/** Reads the `GITHUB_APP_*` fallback config from `env`. Returns `null` when
 * no `GITHUB_APP_*` variable is set. Throws when the config is partial —
 * a half-set fallback is a deployment mistake, and failing loudly beats a
 * deployment that silently behaves as if no app exists. */
export function resolveGithubAppEnvConfig(env: NodeJS.ProcessEnv): GithubAppConfig | null {
  if (ENV_ALL_VARS.every((name) => !env[name])) return null;
  const {
    GITHUB_APP_ID: appId,
    GITHUB_APP_SLUG: appSlug,
    GITHUB_APP_CLIENT_ID: oauthClientId,
    GITHUB_APP_CLIENT_SECRET: oauthClientSecret,
    GITHUB_APP_PRIVATE_KEY: privateKey,
  } = env;
  if (!appId || !appSlug || !oauthClientId || !oauthClientSecret || !privateKey) {
    const missing = ENV_REQUIRED_VARS.filter((name) => !env[name]);
    throw new Error(
      `Partial GITHUB_APP_* config: missing ${missing.join(", ")}. Set all of ${ENV_REQUIRED_VARS.join(", ")} (GITHUB_APP_WEBHOOK_SECRET is optional), or unset them all.`,
    );
  }
  const privateKeyPem = parsePrivateKeyPem(privateKey);
  if (!privateKeyPem) {
    throw new Error(
      "GITHUB_APP_PRIVATE_KEY is not a PEM private key. Set it to the app's PEM, raw or base64-encoded.",
    );
  }
  return buildAppConfig(
    { appId, appSlug, oauthClientId, oauthClientSecret, webhookSecret: env.GITHUB_APP_WEBHOOK_SECRET, privateKeyPem },
    env,
  );
}

export type GithubAppConfigSource = "org" | "environment";

/** `loadAppConfig` plus where the config came from: `"org"` for the org's
 * own `github_app` credential row, `"environment"` for the `GITHUB_APP_*`
 * fallback. The row always shadows the fallback. */
export async function loadAppConfigWithSource(
  deps: Pick<GithubAppDeps, "credentials" | "env">,
  orgId: string,
): Promise<{ config: GithubAppConfig; source: GithubAppConfigSource } | null> {
  const stored = await loadStoredAppConfig(deps, orgId);
  if (stored) return { config: stored, source: "org" };
  const fromEnv = resolveGithubAppEnvConfig(deps.env ?? process.env);
  return fromEnv ? { config: fromEnv, source: "environment" } : null;
}

/** Reads the org's GitHub App config: the org's `github_app` credential
 * row, or the `GITHUB_APP_*` environment fallback when there is no row.
 * `null` when neither is configured. Throws if a `github_app` credential
 * row exists but is malformed (missing a required field) — that should
 * never happen outside a bug in `saveAppConfig` or a hand-edited row. */
export async function loadAppConfig(
  deps: Pick<GithubAppDeps, "credentials" | "env">,
  orgId: string,
): Promise<GithubAppConfig | null> {
  const result = await loadAppConfigWithSource(deps, orgId);
  return result?.config ?? null;
}

/** The credential-row half of `loadAppConfig` — see the module doc comment
 * for the field mapping. */
async function loadStoredAppConfig(
  deps: Pick<GithubAppDeps, "credentials">,
  orgId: string,
): Promise<GithubAppConfig | null> {
  const credential = await deps.credentials.get(appConfigOwner(orgId), GITHUB_APP_SERVICE);
  if (!credential) return null;

  const metadata = credential.metadata;
  if (!isRecord(metadata)) throw new Error("github_app credential: metadata missing or malformed");
  const { appId, appSlug, oauthClientId, htmlUrl } = metadata;
  if (typeof appId !== "string") throw new Error("github_app credential: metadata.appId must be a string");
  if (typeof appSlug !== "string") throw new Error("github_app credential: metadata.appSlug must be a string");
  if (typeof oauthClientId !== "string") {
    throw new Error("github_app credential: metadata.oauthClientId must be a string");
  }
  if (typeof htmlUrl !== "string") throw new Error("github_app credential: metadata.htmlUrl must be a string");
  if (typeof credential.apiKey !== "string") {
    throw new Error("github_app credential: apiKey (private key PEM) is missing");
  }
  if (typeof credential.accessToken !== "string") {
    throw new Error("github_app credential: accessToken (OAuth client secret) is missing");
  }
  if (typeof credential.refreshToken !== "string") {
    throw new Error("github_app credential: refreshToken (webhook secret) is missing");
  }

  return {
    appId,
    appSlug,
    oauthClientId,
    htmlUrl,
    privateKeyPem: credential.apiKey,
    oauthClientSecret: credential.accessToken,
    webhookSecret: credential.refreshToken,
  };
}

/** Writes the org's GitHub App config (see the module doc comment for the
 * field mapping). Upserts the single `github_app` credential row. */
export async function saveAppConfig(
  deps: Pick<GithubAppDeps, "credentials">,
  orgId: string,
  config: GithubAppConfig,
): Promise<void> {
  await deps.credentials.save(appConfigOwner(orgId), GITHUB_APP_SERVICE, {
    type: "service_account",
    apiKey: config.privateKeyPem,
    accessToken: config.oauthClientSecret,
    refreshToken: config.webhookSecret,
    metadata: {
      appId: config.appId,
      appSlug: config.appSlug,
      oauthClientId: config.oauthClientId,
      htmlUrl: config.htmlUrl,
    },
  });
}

function base64url(input: Buffer | string): string {
  const buf = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Mints a short-lived GitHub App JWT (RS256, `node:crypto` only — no new
 * dependency). `createPrivateKey` accepts both PKCS#1 (`RSA PRIVATE KEY`)
 * and PKCS#8 (`PRIVATE KEY`) PEMs, so this works with whatever format
 * GitHub's app-manifest conversion (Task 4) hands back. Claims per GitHub's
 * docs: `iat` backdated 60s (clock drift tolerance), `exp` 9 minutes out
 * (under GitHub's 10-minute max), `iss` = the numeric app id (as a string,
 * matching GitHub's own examples). */
export function mintAppJwt(config: Pick<GithubAppConfig, "appId" | "privateKeyPem">): string {
  const nowSec = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = { iat: nowSec - 60, exp: nowSec + 540, iss: config.appId };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const privateKey = createPrivateKey(config.privateKeyPem);
  const signature = sign("RSA-SHA256", Buffer.from(signingInput, "utf8"), privateKey);
  return `${signingInput}.${base64url(signature)}`;
}

function githubApiUrl(deps: Pick<GithubAppDeps, "apiUrl">): string {
  return deps.apiUrl ?? resolveGithubApiUrl(process.env);
}

function githubFetch(deps: Pick<GithubAppDeps, "fetchImpl">): typeof fetch {
  return deps.fetchImpl ?? fetch;
}

function appJwtHeaders(jwt: string): Record<string, string> {
  return {
    Authorization: `Bearer ${jwt}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "Valet-App",
  };
}

/** Verify the App is installed on this exact repository, not merely able to
 * read its public metadata. No user token or anonymous fallback is allowed. */
export async function githubAppRepositoryAccess(
  deps: Pick<GithubAppDeps, "credentials" | "env" | "apiUrl" | "fetchImpl">,
  orgId: string,
  repository: string,
): Promise<boolean> {
  if (!/^[^/\s]+\/[^/\s]+$/.test(repository)) return false;
  const config = await loadAppConfig(deps, orgId);
  if (!config) return false;
  const response = await githubFetch(deps)(
    `${githubApiUrl(deps)}/repos/${repository.split("/").map(encodeURIComponent).join("/")}/installation`,
    { headers: appJwtHeaders(mintAppJwt(config)), signal: AbortSignal.timeout(5_000) },
  );
  if (response.status === 404) return false;
  if (!response.ok) throw new Error("GitHub App repository access could not be verified.");
  const body: unknown = await response.json();
  if (typeof body !== "object" || body === null || !("id" in body) ||
      typeof body.id !== "number" || !("suspended_at" in body)) {
    throw new Error("GitHub App repository access could not be verified.");
  }
  return body.suspended_at === null;
}

// ── Credential verification (`GET /app`) ─────────────────────────────────
// The admin route that connects an app which already exists checks the app
// id and the private key against GitHub BEFORE it stores them. Without the
// check, a wrong credential is accepted here and fails much later, at the
// first tool call, where nothing points back at the paste that caused it.
//
// `GET /app` is the cheapest proof: it is the App-JWT identity endpoint, so
// a 200 means GitHub matched the id to the key. It also reports the app's
// slug, page URL and OAuth client id, which saves the admin from copying
// three more fields by hand. It never reports the OAuth client secret, so
// that one stays a paste.

const VERIFY_TIMEOUT_MS = 10_000;

/** What `GET /app` tells us about the app behind a credential. Only `appId`
 * is guaranteed: GitHub marks the rest optional in its schema, so a caller
 * falls back to what the admin supplied. */
export interface VerifiedApp {
  appId: string;
  appSlug?: string;
  htmlUrl?: string;
  oauthClientId?: string;
  installationsCount?: number;
}

export type AppCredentialCheck = { ok: true; app: VerifiedApp } | { ok: false; error: string };

function parseAppResponse(payload: unknown): VerifiedApp | null {
  if (!isRecord(payload)) return null;
  const { id, slug, html_url: htmlUrl, client_id: clientId, installations_count: count } = payload;
  if (typeof id !== "number" && typeof id !== "string") return null;
  return {
    appId: String(id),
    ...(typeof slug === "string" ? { appSlug: slug } : {}),
    ...(typeof htmlUrl === "string" ? { htmlUrl } : {}),
    ...(typeof clientId === "string" ? { oauthClientId: clientId } : {}),
    ...(typeof count === "number" ? { installationsCount: count } : {}),
  };
}

/** Asks GitHub whether an app id and a private key belong together, without
 * storing anything. NEVER throws — every failure comes back as an `error`
 * string the admin can act on, because this runs while somebody waits on a
 * form. */
export async function verifyAppCredential(
  deps: Pick<GithubAppDeps, "apiUrl" | "fetchImpl">,
  credential: Pick<GithubAppConfig, "appId" | "privateKeyPem">,
): Promise<AppCredentialCheck> {
  let jwt: string;
  try {
    jwt = mintAppJwt(credential);
  } catch {
    return {
      ok: false,
      error:
        "The private key is a PEM, but not a key GitHub apps use. Generate a new private key on the app's settings page, then paste the whole file it downloads.",
    };
  }

  let res: Response;
  try {
    res = await githubFetch(deps)(`${githubApiUrl(deps)}/app`, {
      headers: appJwtHeaders(jwt),
      signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Could not reach GitHub to check the credential: ${detail}. Check network access, then try again.` };
  }

  // 401 is the answer this check exists for: GitHub read the JWT and refused
  // it, so the id and the key disagree, or the key was revoked.
  if (res.status === 401) {
    return {
      ok: false,
      error:
        "GitHub rejected this App ID and private key. Check the App ID on the app's settings page. If the key is lost, generate a new private key there.",
    };
  }
  if (!res.ok) {
    return { ok: false, error: `GitHub returned ${res.status} for this credential. Wait for GitHub to recover, then try again.` };
  }

  let payload: unknown;
  try {
    payload = await res.json();
  } catch {
    return { ok: false, error: "GitHub sent a reply that is not JSON. Check https://www.githubstatus.com, then try again." };
  }
  const app = parseAppResponse(payload);
  if (!app) {
    return { ok: false, error: "GitHub sent an app record with no app id. Check https://www.githubstatus.com, then try again." };
  }
  return { ok: true, app };
}

interface ParsedInstallation {
  installationId: number;
  accountLogin: string;
  accountId: number;
  accountType: string;
  repositorySelection: string | null;
  suspended: boolean;
}

function parseInstallationsResponse(payload: unknown): ParsedInstallation[] {
  if (!Array.isArray(payload)) {
    throw new Error("GitHub API GET /app/installations: expected an array response");
  }
  return payload.map((item, i) => {
    if (!isRecord(item)) throw new Error(`installations[${i}]: expected an object`);
    const { id, account, repository_selection: repositorySelection, suspended_at: suspendedAt } = item;
    if (typeof id !== "number") throw new Error(`installations[${i}].id: expected a number`);
    if (!isRecord(account)) throw new Error(`installations[${i}].account: expected an object`);
    const { login, type, id: accountId } = account;
    if (typeof accountId !== "number" || !Number.isSafeInteger(accountId) || accountId <= 0) {
      throw new Error(`installations[${i}].account.id: expected a positive account ID`);
    }
    if (typeof login !== "string") throw new Error(`installations[${i}].account.login: expected a string`);
    if (typeof type !== "string") throw new Error(`installations[${i}].account.type: expected a string`);
    return {
      installationId: id,
      accountLogin: login,
      accountId,
      accountType: type,
      repositorySelection: typeof repositorySelection === "string" ? repositorySelection : null,
      suspended: suspendedAt !== null && suspendedAt !== undefined,
    };
  });
}

export interface GithubAccountIdentity { id: number; login: string }

type PersonalIdentityResult =
  | { state: "verified"; identity: GithubAccountIdentity }
  | { state: "unlinked" | "unavailable" };

function githubRateLimited(response: Response): boolean {
  return response.status === 429 || (response.status === 403 &&
    (response.headers.get("x-ratelimit-remaining") === "0" || response.headers.has("retry-after")));
}

/** This is the sole signing boundary: /user must confirm this exact token.
 * The token is rechecked under lock before its identity proof is stored. */
async function verifyAndSaveGithubIdentity(
  deps: Pick<GithubAppDeps, "credentials" | "key" | "apiUrl" | "fetchImpl">,
  userId: string, token: string, expectedId?: number,
): Promise<PersonalIdentityResult> {
  if (!token) return { state: "unlinked" };
  try {
    const response = await githubFetch(deps)(`${githubApiUrl(deps)}/user`, {
      headers: appJwtHeaders(token), signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
    });
    if (!response.ok) {
      if (response.status === 401) return { state: "unlinked" };
      if (response.status === 403 && !githubRateLimited(response)) {
        const error: unknown = await response.json();
        const message = isRecord(error) && typeof error.message === "string" ? error.message.trim().toLowerCase() : "";
        if (message === "bad credentials" || message === "requires authentication" ||
            message === "invalid authentication credentials") return { state: "unlinked" };
      }
      // Ambiguous 4xx responses can be throttling or provider faults, not revoked authority.
      return { state: "unavailable" };
    }
    const body: unknown = await response.json();
    if (!isRecord(body) || typeof body.id !== "number" || !Number.isSafeInteger(body.id) || body.id <= 0 ||
        typeof body.login !== "string" || !body.login) return { state: "unavailable" };
    if (expectedId !== undefined && body.id !== expectedId) return { state: "unlinked" };
    const identity = { id: body.id, login: body.login };
    const owner: CredentialOwner = { type: "user", id: userId };
    const operation = async (store: CredentialStore): Promise<PersonalIdentityResult> => {
      const current = await store.get(owner, "github");
      if (!current) return { state: "unlinked" };
      if ((current.accessToken ?? current.apiKey) !== token) return { state: "unavailable" };
      await store.save(owner, "github", { ...current, metadata: {
        ...current.metadata, login: identity.login, githubUserId: identity.id,
        githubIdentityProof: githubIdentityProof(deps.key, userId, identity.id, current),
      } });
      return { state: "verified", identity };
    };
    return await (deps.credentials.withLock
      ? deps.credentials.withLock(owner, "github", operation) : operation(deps.credentials));
  } catch {
    return { state: "unavailable" };
  }
}

/** Caller-supplied identities can never bypass the /user signing boundary. */
export async function saveVerifiedGithubIdentity(
  deps: Pick<GithubAppDeps, "credentials" | "key" | "apiUrl" | "fetchImpl">,
  userId: string, profile: GithubAccountIdentity, token: string,
): Promise<boolean> {
  return (await verifyAndSaveGithubIdentity(deps, userId, token, profile.id)).state === "verified";
}

/** Permanent credential loss is distinct from a retryable provider outage. */
async function checkPersonalIdentity(
  deps: GithubAppDeps, orgId: string, userId: string,
): Promise<PersonalIdentityResult> {
  try {
    const stored = await deps.credentials.get({ type: "user", id: userId }, "github");
    if (!stored) return { state: "unlinked" };
    const health = checkGithubUserRow({ ...stored,
      metadata: { ...stored.metadata, identityOnly: false },
    }, (deps.now ?? Date.now)());
    if (!health.ok) return { state: "unlinked" };
    const verifiedId = verifiedGithubUserId(deps.key, userId, stored);
    if (health.state !== "stale-refreshable" && verifiedId !== null && typeof stored.metadata?.login === "string") {
      return { state: "verified", identity: { id: verifiedId, login: stored.metadata.login } };
    }
    const result = await resolveUserCredential(deps, orgId, userId, (id) => loadAppConfig(deps, id), true);
    if (!result.ok) {
      const current = await deps.credentials.get({ type: "user", id: userId }, "github");
      return { state: !current || current.metadata?.refreshFailedAt ? "unlinked" : "unavailable" };
    }
    return await verifyAndSaveGithubIdentity(deps, userId, result.token);
  } catch {
    return { state: "unavailable" };
  }
}

export async function personalInstallationLinkState(
  deps: GithubAppDeps, orgId: string, userId: string, accountId: number,
): Promise<"linked" | "unlinked" | "unavailable"> {
  const result = await checkPersonalIdentity(deps, orgId, userId);
  return result.state === "verified" ? result.identity.id === accountId ? "linked" : "unlinked" : result.state;
}

export async function personalInstallationIsLinked(
  deps: GithubAppDeps, orgId: string, userId: string, accountId: number,
): Promise<boolean> {
  return await personalInstallationLinkState(deps, orgId, userId, accountId) === "linked";
}

/** Scan only this org's members who have a candidate non-owner User install.
 * Verification is serial (one request at a time), outside the discovery transaction.
 * Verified IDs survive renames; logins select only unverified legacy candidates. */
async function loadLinkedUserIdentityMap(
  deps: GithubAppDeps, orgId: string, candidates: ParsedInstallation[],
): Promise<{ linked: Map<number, string>; unavailable: Set<string> }> {
  const linked = new Map<number, string>();
  const unavailable = new Set<string>();
  if (candidates.length === 0) return { linked, unavailable };
  const rows = await deps.db.select({ ownerId: credentials.ownerId, metadata: credentials.metadata })
    .from(credentials)
    .innerJoin(orgMembers, and(eq(orgMembers.userId, credentials.ownerId), eq(orgMembers.orgId, orgId)))
    .where(and(eq(credentials.ownerType, "user"), eq(credentials.service, "github")));
  const existing = await deps.db.select().from(githubInstallations).where(eq(githubInstallations.orgId, orgId));
  for (const row of rows) {
    if (!isRecord(row.metadata)) continue;
    const metadata = row.metadata;
    if (!candidates.some((candidate) => metadata.githubUserId === candidate.accountId ||
        (typeof metadata.login === "string" &&
          metadata.login.toLowerCase() === candidate.accountLogin.toLowerCase()) ||
        existing.some((install) => install.linkedUserId === row.ownerId &&
          (install.accountId === candidate.accountId ||
            (install.accountId === null && install.installationId === candidate.installationId))))) continue;
    const result = await checkPersonalIdentity(deps, orgId, row.ownerId);
    if (result.state !== "verified") {
      if (result.state === "unavailable") unavailable.add(row.ownerId);
      continue;
    }
    const profile = result.identity;
    linked.set(profile.id, row.ownerId);
    const candidate = candidates.find((install) => install.accountId === profile.id);
    // A verified ID can update a display login, but must never be re-signed from an installation record.
    try {
      if (candidate) {
        const owner: CredentialOwner = { type: "user", id: row.ownerId };
        const updateLogin = async (store: CredentialStore) => {
          const current = await store.get(owner, "github");
          if (current && verifiedGithubUserId(deps.key, row.ownerId, current) === candidate.accountId &&
              current.metadata?.login !== candidate.accountLogin) {
            await store.save(owner, "github", { ...current,
              metadata: { ...current.metadata, login: candidate.accountLogin },
            });
          }
        };
        if (deps.credentials.withLock) await deps.credentials.withLock(owner, "github", updateLogin);
        else await updateLogin(deps.credentials);
      }
    } catch {
      linked.delete(profile.id);
      unavailable.add(row.ownerId);
    }
  }
  return { linked, unavailable };
}

export async function relinkInstallations(deps: GithubAppDeps, orgId: string): Promise<void> {
  if (await discoverInstallations(deps, orgId) === "stale") throw new Error("GitHub installations changed during discovery. Retry after the webhook completes.");
}

const appOwnerCache = new WeakMap<CredentialStore, Map<string, {
  binding: string; owner: GithubAccountIdentity; expiresAt: number;
}>>();

/** Last-known owners are bound to App ID, private key and API URL. Transient
 * failures retain that authority; authentication failures never use the fallback. */
export async function loadAppOwner(
  deps: Pick<GithubAppDeps, "db" | "credentials" | "apiUrl" | "fetchImpl" | "now">,
  orgId: string, config: GithubAppConfig, jwt?: string,
): Promise<GithubAccountIdentity> {
  const now = (deps.now ?? Date.now)();
  const apiUrl = githubApiUrl(deps);
  const binding = createHash("sha256").update(`${config.appId}:${config.privateKeyPem}:${apiUrl}`).digest("hex");
  const cache = appOwnerCache.get(deps.credentials) ?? new Map();
  appOwnerCache.set(deps.credentials, cache);
  const cached = cache.get(orgId);
  if (cached?.binding === binding && cached.expiresAt > now) return cached.owner;
  const [org] = await deps.db.select({ owner: orgs.githubAppOwner }).from(orgs).where(eq(orgs.id, orgId));
  const savedOwner = org?.owner;
  const fallback = cached?.binding === binding ? cached.owner :
    savedOwner?.binding === binding ? { id: savedOwner.id, login: savedOwner.login } : null;
  let res: Response;
  try {
    res = await githubFetch(deps)(`${apiUrl}/app`, {
      headers: appJwtHeaders(jwt ?? mintAppJwt(config)), signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
    });
  } catch {
    if (fallback) return fallback;
    throw new Error("GitHub App owner is unavailable. Refresh installations when GitHub recovers.");
  }
  if (!res.ok) {
    const rateLimited = res.status === 403 &&
      (res.headers.get("x-ratelimit-remaining") === "0" || res.headers.has("retry-after"));
    if ((rateLimited || (res.status !== 401 && res.status !== 403)) && fallback) return fallback;
    throw new Error(`GitHub API GET /app returned ${res.status}. Check the App credential in Settings.`);
  }
  let body: unknown;
  try { body = await res.json(); } catch { body = null; }
  if (!isRecord(body) || !isRecord(body.owner) || typeof body.owner.login !== "string" ||
      !body.owner.login || typeof body.owner.id !== "number" || !Number.isSafeInteger(body.owner.id) || body.owner.id <= 0) {
    if (fallback) return fallback;
    throw new Error("GitHub did not report the App owner. Refresh installations when GitHub recovers.");
  }
  const owner = { id: body.owner.id, login: body.owner.login };
  if (savedOwner?.binding !== binding || savedOwner.id !== owner.id || savedOwner.login !== owner.login) {
    await deps.db.update(orgs).set({ githubAppOwner: { binding, ...owner } }).where(eq(orgs.id, orgId));
  }
  cache.set(orgId, { binding, owner, expiresAt: now + 300_000 });
  return owner;
}

export function appOwnerInstallationCondition(owner: GithubAccountIdentity) {
  return eq(githubInstallations.accountId, owner.id);
}

export function installationAccessCondition(owner: GithubAccountIdentity, userId: string | undefined) {
  return or(appOwnerInstallationCondition(owner), userId ? and(
    eq(githubInstallations.accountType, "User"), eq(githubInstallations.linkedUserId, userId),
    personalInstallationEligibilityCondition(),
  ) : sql`false`);
}

/** Membership and policy are always live. Credential IDs require HMAC verification
 * before minting or webhook dispatch; SQL is only a candidate prefilter. */
export function personalInstallationEligibilityCondition() {
  return sql`exists (select 1 from ${orgMembers} join ${orgs} on ${orgs.id} = ${orgMembers.orgId}
    where ${orgMembers.orgId} = ${githubInstallations.orgId}
      and ${orgMembers.userId} = ${githubInstallations.linkedUserId}
      and ${orgs.allowPersonalInstallations} = true)
    and exists (select 1 from ${credentials}
      where ${credentials.ownerType} = 'user' and ${credentials.service} = 'github'
        and ${credentials.ownerId} = ${githubInstallations.linkedUserId})`;
}

/** Shared admission view for UI counts and repo listing. No stale or foreign rows. */
export async function admittedInstallations(
  deps: GithubAppDeps, orgId: string, actor?: string, allMembers = false,
): Promise<GithubInstallationRow[]> {
  const config = await loadAppConfig(deps, orgId);
  if (!config) return [];
  const [held] = await deps.db.select({ id: githubInstallations.id }).from(githubInstallations)
    .where(eq(githubInstallations.orgId, orgId)).limit(1);
  if (!held) return [];
  const owner = await loadAppOwner(deps, orgId, config);
  await ensureInstallationAccountIds(deps, orgId);
  const rows = await deps.db.select().from(githubInstallations).where(and(
    eq(githubInstallations.orgId, orgId), or(appOwnerInstallationCondition(owner), and(
      eq(githubInstallations.accountType, "User"), personalInstallationEligibilityCondition(),
      allMembers ? sql`true` : actor ? eq(githubInstallations.linkedUserId, actor) : sql`false`,
    )),
  ));
  const admitted: GithubInstallationRow[] = [];
  for (const row of rows) {
    if (row.accountId === owner.id || (row.accountId !== null && row.linkedUserId &&
        await personalInstallationIsLinked(deps, orgId, row.linkedUserId, row.accountId))) admitted.push(row);
  }
  return admitted;
}

/** Candidate selection accepts legacy logins, but only /user can establish authority. */
export async function installationAccountCandidateState(
  deps: GithubAppDeps, orgId: string, accountId: number, owner: GithubAccountIdentity, accountLogin?: string,
): Promise<"candidate" | "excluded" | "unavailable"> {
  if (accountId === owner.id) return "candidate";
  const [org] = await deps.db.select({ allowed: orgs.allowPersonalInstallations }).from(orgs).where(eq(orgs.id, orgId));
  if (org?.allowed !== true) return "excluded";
  const members = await deps.db.select({ userId: credentials.ownerId }).from(credentials)
    .innerJoin(orgMembers, and(eq(orgMembers.userId, credentials.ownerId), eq(orgMembers.orgId, orgId)))
    .where(and(eq(credentials.ownerType, "user"), eq(credentials.service, "github"), or(
      sql`${credentials.metadata}->>'githubUserId' = ${String(accountId)}`,
      accountLogin ? and(sql`${credentials.metadata}->>'githubUserId' IS NULL`,
        sql`lower(${credentials.metadata}->>'login') = lower(${accountLogin})`) : sql`false`,
    )));
  let unavailable = false;
  for (const member of members) {
    const state = await personalInstallationLinkState(deps, orgId, member.userId, accountId);
    if (state === "linked") return "candidate";
    if (state === "unavailable") unavailable = true;
  }
  return unavailable ? "unavailable" : "excluded";
}

const MAX_INSTALLATION_PAGES = 10;

/** Parses the `next` URL out of a GitHub `Link` response header (RFC 8288
 * `<url>; rel="next", <url>; rel="last"` format). `null` when there's no
 * `rel="next"` entry (i.e. the last page). */
function parseNextLink(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(",")) {
    const match = part.match(/<([^>]+)>\s*;\s*rel="next"/);
    if (match) return match[1];
  }
  return null;
}

/** Fetches every page of `GET /app/installations` (App JWT auth), following
 * the `Link: rel="next"` header rather than assuming `per_page=100` fits
 * everything — an org with >100 installations would otherwise silently look
 * like page-2+ installations were removed. Capped at
 * `MAX_INSTALLATION_PAGES` pages as a sanity bound against a misbehaving or
 * malicious upstream looping forever. */
async function fetchAllInstallations(deps: GithubAppDeps, jwt: string): Promise<{ installations: ParsedInstallation[]; complete: boolean }> {
  const installations: ParsedInstallation[] = [];
  let url: string | null = `${githubApiUrl(deps)}/app/installations?per_page=100`;
  let pages = 0;

  while (url && pages < MAX_INSTALLATION_PAGES) {
    pages++;
    const res: Response = await githubFetch(deps)(url, {
      signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "Valet-App",
      },
    });
    if (!res.ok) {
      throw new Error(`GitHub API GET /app/installations returned ${res.status}`);
    }
    installations.push(...parseInstallationsResponse(await res.json()));
    url = parseNextLink(res.headers.get("link"));
  }

  return { installations, complete: url === null };
}

type InstallationLookupDeps = Pick<GithubAppDeps, "db" | "credentials" | "apiUrl" | "fetchImpl" | "now" | "env">;

/** An authenticated targeted lookup avoids capped-listing gaps for signed creation. */
async function fetchInstallation(
  deps: InstallationLookupDeps, jwt: string, installationId: number,
): Promise<ParsedInstallation> {
  const response = await githubFetch(deps)(`${githubApiUrl(deps)}/app/installations/${installationId}`, {
    headers: appJwtHeaders(jwt), signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
  });
  if (response.status === 404) throw new InstallationNotFoundError();
  if (!response.ok) throw new Error(`GitHub installation lookup returned ${response.status}. Refresh installations after GitHub recovers.`);
  const [installation] = parseInstallationsResponse([await response.json()]);
  if (installation.installationId !== installationId) throw new Error("GitHub returned a different installation. Refresh installations after GitHub recovers.");
  return installation;
}

class InstallationNotFoundError extends Error {}

export const WEBHOOK_INSTALLATION_RECOVERY_BUDGET = 64;
const WEBHOOK_RECOVERY_MAX_ENTRIES = 128;
type WebhookRecoveryResult = "admitted" | "excluded" | "unavailable" | "budget_exhausted";
interface WebhookRecoveryEntry {
  active: boolean;
  expiresAt: number;
  promise: Promise<WebhookRecoveryResult>;
}
interface WebhookRecoveryState {
  windowAt: number;
  used: number;
  entries: Map<number, WebhookRecoveryEntry>;
}
const webhookRecoveries = new WeakMap<AppQueryable, Map<string, WebhookRecoveryState>>();

const unheldWebhookDrops = new WeakMap<AppQueryable, Map<string, Map<number, number>>>();

/** Claim at most one unheld drop record per installation recovery window.
 * The claim cache never evicts live claims to make room for new stranger IDs. */
export function claimUnheldWebhookDrop(
  deps: Pick<GithubAppDeps, "db" | "now">, orgId: string, installationId: number,
): boolean {
  const now = (deps.now ?? Date.now)();
  const orgClaims = unheldWebhookDrops.get(deps.db) ?? new Map<string, Map<number, number>>();
  unheldWebhookDrops.set(deps.db, orgClaims);
  const claims = orgClaims.get(orgId) ?? new Map<number, number>();
  orgClaims.set(orgId, claims);
  for (const [id, expiresAt] of claims) if (expiresAt <= now) claims.delete(id);
  if (claims.has(installationId) || claims.size >= WEBHOOK_RECOVERY_MAX_ENTRIES) return false;
  const recovery = webhookRecoveries.get(deps.db)?.get(orgId)?.entries.get(installationId);
  claims.set(installationId, Math.max(now + 60_000, recovery?.expiresAt ?? 0));
  return true;
}

/** Signed deliveries recover a missed creation using targeted lookups, never a full listing.
 * Budget, cache and single-flight apply even when the webhook URL is live. */
export async function recoverWebhookInstallation(
  deps: GithubAppDeps, orgId: string, installationId: number,
): Promise<WebhookRecoveryResult> {
  if (!Number.isSafeInteger(installationId) || installationId <= 0) return "excluded";
  const now = (deps.now ?? Date.now)();
  const orgStates = webhookRecoveries.get(deps.db) ?? new Map<string, WebhookRecoveryState>();
  webhookRecoveries.set(deps.db, orgStates);
  const state = orgStates.get(orgId) ?? { windowAt: now, used: 0, entries: new Map<number, WebhookRecoveryEntry>() };
  orgStates.set(orgId, state);
  for (const [id, entry] of state.entries) if (!entry.active && entry.expiresAt <= now) state.entries.delete(id);
  const cached = state.entries.get(installationId);
  if (cached) return cached.promise;
  if (now - state.windowAt >= 60_000) { state.windowAt = now; state.used = 0; }
  if (state.used >= WEBHOOK_INSTALLATION_RECOVERY_BUDGET) return "budget_exhausted";
  if (state.entries.size >= WEBHOOK_RECOVERY_MAX_ENTRIES) {
    const oldest = [...state.entries].find(([, entry]) => !entry.active);
    if (!oldest) return "budget_exhausted";
    state.entries.delete(oldest[0]);
  }
  state.used++;
  const entry = { active: true, expiresAt: now + 60_000, promise: Promise.resolve<WebhookRecoveryResult>("unavailable") };
  state.entries.set(installationId, entry);
  entry.promise = (async (): Promise<WebhookRecoveryResult> => {
    const config = await loadAppConfig(deps, orgId);
    if (!config) return "excluded";
    const installation = await fetchInstallation(deps, mintAppJwt(config), installationId);
    const owner = await loadAppOwner(deps, orgId, config);
    const candidate = await installationAccountCandidateState(deps, orgId, installation.accountId, owner, installation.accountLogin);
    if (candidate !== "candidate") return candidate;
    const rows = await discoverInstallations(deps, orgId, installationId);
    if (rows === "stale") return "unavailable";
    return rows.some((row) => row.installationId === installationId) ? "admitted" : "excluded";
  })().catch((error): WebhookRecoveryResult => {
    if (error instanceof InstallationNotFoundError) return "excluded";
    console.error("GitHub targeted webhook recovery unavailable:", error);
    return "unavailable";
  }).then((result) => {
    entry.active = false;
    entry.expiresAt = (deps.now ?? Date.now)() + (result === "excluded" ? 300_000 : 60_000);
    return result;
  });
  return entry.promise;
}

const installationSyncs = new WeakMap<AppQueryable, Map<string, { at: number; active: boolean; promise: Promise<void> }>>();
const INSTALLATION_SYNC_INTERVAL_MS = 60_000;

/** Join in-flight syncs and throttle failed attempts as well as successful ones. */
async function throttledInstallationSync(
  deps: InstallationLookupDeps, orgId: string, mode: "legacy" | "discovery", operation: () => Promise<void>,
): Promise<void> {
  const entries = installationSyncs.get(deps.db) ?? new Map();
  installationSyncs.set(deps.db, entries);
  const key = `${orgId}:${mode}`;
  const current = entries.get(key);
  const now = (deps.now ?? Date.now)();
  if (current && (current.active || now - current.at < INSTALLATION_SYNC_INTERVAL_MS)) return current.promise;
  const entry = { at: now, active: true, promise: Promise.resolve() };
  entries.set(key, entry);
  const promise = operation().catch((error) => {
    console.error(`GitHub ${mode} sync failed for org ${orgId}:`, error);
  }).finally(() => {
    entry.active = false;
    entry.at = (deps.now ?? Date.now)();
  });
  entry.promise = promise;
  return promise;
}

/** Legacy rows gain IDs only from authenticated GitHub installation records.
 * This narrow backfill needs no member credentials, so readiness can use it too.
 * It never changes suspension: a concurrent revocation must remain effective. */
export async function ensureInstallationAccountIds(deps: InstallationLookupDeps, orgId: string): Promise<void> {
  const held = await deps.db.select().from(githubInstallations)
    .where(and(eq(githubInstallations.orgId, orgId), sql`${githubInstallations.accountId} is null`));
  if (held.length === 0) return;
  await throttledInstallationSync(deps, orgId, "legacy", async () => {
    const config = await loadAppConfig(deps, orgId);
    if (!config) return;
    const jwt = mintAppJwt(config);
    let changed = false;
    for (const row of held) {
      try {
        const installation = await fetchInstallation(deps, jwt, row.installationId);
        const updated = await deps.db.update(githubInstallations).set({
          accountId: installation.accountId, accountLogin: installation.accountLogin,
          accountType: installation.accountType, updatedAt: (deps.now ?? Date.now)(),
        }).where(and(eq(githubInstallations.id, row.id), sql`${githubInstallations.accountId} is null`))
          .returning({ id: githubInstallations.id });
        changed ||= updated.length > 0;
      } catch (error) {
        console.error(`GitHub legacy installation ${row.installationId} backfill failed:`, error);
      }
    }
    if (changed) await invalidateWorkflowSources(deps.db, { orgId });
  });
}

/** Hot-path discovery shares one attempt per org per minute, including failures. */
export async function requestInstallationDiscovery(deps: GithubAppDeps, orgId: string): Promise<void> {
  await throttledInstallationSync(deps, orgId, "discovery", async () => {
    if (await discoverInstallations(deps, orgId) === "stale") throw new Error("GitHub installations changed during discovery. Retry after the webhook completes.");
  });
}

export const GITHUB_LOGIN_RECOVERY_BUDGET = 8;
export const GITHUB_LOGIN_RECOVERY_MAX_ENTRIES = 64;
const LOGIN_RECOVERY_NEGATIVE_TTL_MS = 5 * 60_000;
interface LoginRecoveryEntry { active: boolean; expiresAt: number; promise: Promise<void> }
interface LoginRecoveryState {
  windowAt: number; used: number; entries: Map<string, LoginRecoveryEntry>;
}
const loginRecoveries = new WeakMap<AppQueryable, Map<string, LoginRecoveryState>>();

/** Diagnostic counts only; never expose login text or token material. */
export function githubLoginRecoveryStats(deps: Pick<GithubAppDeps, "db">, orgId: string) {
  const state = loginRecoveries.get(deps.db)?.get(orgId);
  return { entries: state?.entries.size ?? 0, used: state?.used ?? 0 };
}

/** Missing rows never block minting. Manual-webhook deployments can recover
 * renames within a fixed org budget, with bounded LRU entries and negative caching. */
export async function requestInstallationForLogin(
  deps: GithubAppDeps, orgId: string, accountLogin: string,
): Promise<void> {
  const login = accountLogin.toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/.test(login) || login.includes("--")) return;
  // A live webhook URL receives installation_target renames without speculative queries.
  if ((deps.env ?? process.env).VALET_PUBLIC_URL?.trim()) return;
  const now = (deps.now ?? Date.now)();
  const orgs = loginRecoveries.get(deps.db) ?? new Map<string, LoginRecoveryState>();
  loginRecoveries.set(deps.db, orgs);
  const state = orgs.get(orgId) ?? { windowAt: now, used: 0, entries: new Map<string, LoginRecoveryEntry>() };
  orgs.set(orgId, state);
  for (const [key, entry] of state.entries) {
    if (!entry.active && entry.expiresAt <= now) state.entries.delete(key);
  }
  const cached = state.entries.get(login);
  if (cached) {
    state.entries.delete(login);
    state.entries.set(login, cached); // LRU hit.
    return cached.promise;
  }
  if (now - state.windowAt >= INSTALLATION_SYNC_INTERVAL_MS) {
    state.windowAt = now;
    state.used = 0;
  }
  if (state.used >= GITHUB_LOGIN_RECOVERY_BUDGET) return;
  if (state.entries.size >= GITHUB_LOGIN_RECOVERY_MAX_ENTRIES) {
    const oldest = [...state.entries].find(([, entry]) => !entry.active);
    if (!oldest) return;
    state.entries.delete(oldest[0]);
  }
  state.used++;
  const entry: LoginRecoveryEntry = { active: true, expiresAt: now + INSTALLATION_SYNC_INTERVAL_MS,
    promise: Promise.resolve() };
  state.entries.set(login, entry);
  entry.promise = (async () => {
    const config = await loadAppConfig(deps, orgId);
    if (!config) return;
    const jwt = mintAppJwt(config);
    for (const namespace of ["orgs", "users"]) {
      const response = await githubFetch(deps)(
        `${githubApiUrl(deps)}/${namespace}/${encodeURIComponent(login)}/installation`,
        { headers: appJwtHeaders(jwt), signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS) },
      );
      if (response.status === 404) continue;
      if (!response.ok) throw new Error(`GitHub account installation lookup returned ${response.status}. Refresh installations after GitHub recovers.`);
      const [installation] = parseInstallationsResponse([await response.json()]);
      if (installation.accountLogin.toLowerCase() !== login) return;
      if (await discoverInstallations(deps, orgId, installation.installationId) === "stale") {
        throw new Error("GitHub installations changed during discovery. Retry after the webhook completes.");
      }
      return;
    }
    entry.expiresAt = (deps.now ?? Date.now)() + LOGIN_RECOVERY_NEGATIVE_TTL_MS;
  })().catch((error) => {
    console.error(`GitHub login recovery failed for org ${orgId}:`, error);
  }).finally(() => {
    entry.active = false;
    entry.expiresAt = Math.max(entry.expiresAt, (deps.now ?? Date.now)() + INSTALLATION_SYNC_INTERVAL_MS);
  });
  return entry.promise;
}

/** Discovers the org's GitHub App installations via `GET /app/installations`
 * (App JWT auth, paginated — see `fetchAllInstallations`), upserts
 * `github_installations` by `(orgId, installationId)`, deletes rows absent
 * from a complete response, and links installations by verified account ID.
 * Returns admitted rows, [] when no App is configured, or "stale" when a held-row
 * authority change invalidates the snapshot. Stale is retryable, never an empty success. */
export async function discoverInstallations(deps: GithubAppDeps, orgId: string, installationId?: number): Promise<GithubInstallationRow[] | "stale"> {
  // Capture before network I/O. An authority-changing webhook must win over this snapshot.
  const [snapshot] = await deps.db.select({ revision: orgs.githubInstallationRevision }).from(orgs).where(eq(orgs.id, orgId));
  if (!snapshot) return [];
  const config = await loadAppConfig(deps, orgId);
  if (!config) return [];

  const jwt = mintAppJwt(config);
  const owner = await loadAppOwner(deps, orgId, config, jwt);
  const { installations, complete } = installationId === undefined
    ? await fetchAllInstallations(deps, jwt)
    : { installations: [await fetchInstallation(deps, jwt, installationId)], complete: false };
  // CredentialStore reads use their own DB client. Resolve them before the row lock.
  const [policy] = await deps.db.select({ allowed: orgs.allowPersonalInstallations }).from(orgs).where(eq(orgs.id, orgId));
  const candidates = policy?.allowed === true
    ? installations.filter((inst) => inst.accountId !== owner.id && inst.accountType === "User") : [];
  const { linked: linkedById, unavailable } = await loadLinkedUserIdentityMap(deps, orgId, candidates);
  return deps.db.transaction(async (tx): Promise<GithubInstallationRow[] | "stale"> => {
    const [org] = await tx.select({ allowPersonalInstallations: orgs.allowPersonalInstallations,
      revision: orgs.githubInstallationRevision })
      .from(orgs).where(eq(orgs.id, orgId)).for("update");
    // Conservative org-wide fence: discard an outdated snapshot, including inserts and deletions.
    // A fresh snapshot can reconcile again without retaining locks during identity HTTP calls.
    if (!org || org.revision !== snapshot.revision) return "stale";
    const existingRows = await tx.select().from(githubInstallations).where(eq(githubInstallations.orgId, orgId));
    const existingByInstallationId = new Map(existingRows.map((row) => [row.installationId, row]));

    const nowMs = (deps.now ?? Date.now)();
    const seenIds = new Set<number>();
    const rows: GithubInstallationRow[] = [];
    const retained: GithubInstallationRow[] = [];

    for (const inst of installations) {
      const existing = existingByInstallationId.get(inst.installationId);
      if (inst.accountId !== owner.id && !(org?.allowPersonalInstallations === true &&
          inst.accountType === "User" && linkedById.has(inst.accountId))) {
        // Keep a previously linked row during credential outages, but do not
        // admit it for this call. Minting still verifies identity before cache reads.
        if (org?.allowPersonalInstallations === true && inst.accountType === "User" &&
            existing?.accountType === "User" && (existing.accountId === null || existing.accountId === inst.accountId) &&
            existing.linkedUserId && unavailable.has(existing.linkedUserId)) {
          seenIds.add(inst.installationId);
          const [updated] = await tx.update(githubInstallations).set({
            suspended: inst.suspended, accountLogin: inst.accountLogin,
            repositorySelection: inst.repositorySelection, updatedAt: nowMs,
          }).where(eq(githubInstallations.id, existing.id)).returning();
          retained.push(updated);
        } else if (existing) {
          await tx.delete(githubInstallations).where(eq(githubInstallations.id, existing.id));
        }
        continue;
      }
      seenIds.add(inst.installationId);
      const id = existing?.id ?? `ghi_${randomUUID()}`;
      const linkedUserId = inst.accountType === "User" ? linkedById.get(inst.accountId) ?? null : null;

      const [row] = await tx
        .insert(githubInstallations)
        .values({
          id,
          orgId,
          installationId: inst.installationId,
          accountLogin: inst.accountLogin,
          accountId: inst.accountId,
          accountType: inst.accountType,
          repositorySelection: inst.repositorySelection,
          suspended: inst.suspended,
          linkedUserId,
          createdAt: nowMs,
          updatedAt: nowMs,
        })
        .onConflictDoUpdate({
          target: [githubInstallations.orgId, githubInstallations.installationId],
          set: {
            accountLogin: inst.accountLogin,
            accountId: inst.accountId,
            accountType: inst.accountType,
            repositorySelection: inst.repositorySelection,
            suspended: inst.suspended,
            linkedUserId,
            updatedAt: nowMs,
          },
        })
        .returning();
      rows.push(row);
    }

    for (const row of existingRows) {
      if (complete && !seenIds.has(row.installationId)) {
        await tx.delete(githubInstallations).where(eq(githubInstallations.id, row.id));
      }
    }

    const signature = (items: readonly { installationId: number; accountLogin: string; suspended: boolean; linkedUserId: string | null }[]) =>
      JSON.stringify(items.map((row) => [row.installationId, row.accountLogin.toLowerCase(), row.suspended, row.linkedUserId])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
    const synchronized = await tx.select().from(githubInstallations).where(eq(githubInstallations.orgId, orgId));
    if (signature(existingRows) !== signature(synchronized)) await invalidateWorkflowSources(tx, { orgId });
    return rows;
  });
}

// ── Webhook-URL sync (`PATCH /app/hook/config`) ──────────────────────────
// A GitHub App's webhook URL is fixed at creation. An instance behind an
// ephemeral tunnel (`cloudflared` quick tunnel) gets a new hostname on every
// restart, so the URL baked in at creation goes stale and inbound deliveries
// stop with no error anywhere. These functions assert this instance's public
// URL on the App it owns, at boot and after the manifest flow.

/** The legacy webhook alias the host keeps for the GitHub plugin. The
 * manifest and `syncAppWebhookUrl` both use this constant, so the URL Valet
 * asks for and the URL Valet serves cannot disagree. */
export { GITHUB_APP_WEBHOOK_PATH };

function hookConfigUrl(deps: Pick<GithubAppDeps, "apiUrl">): string {
  return `${githubApiUrl(deps)}/app/hook/config`;
}

/** Reads the App's own webhook URL (`GET /app/hook/config`, App JWT auth).
 * `null` when the App has no URL set — the shape a manifest without
 * `hook_attributes` produces. */
async function readHookConfigUrl(
  deps: Pick<GithubAppDeps, "apiUrl" | "fetchImpl">,
  jwt: string,
): Promise<string | null> {
  const res = await githubFetch(deps)(hookConfigUrl(deps), { headers: appJwtHeaders(jwt) });
  if (!res.ok) throw new Error(`GitHub API GET /app/hook/config returned ${res.status}`);
  const payload: unknown = await res.json();
  if (!isRecord(payload)) throw new Error("GitHub API GET /app/hook/config: expected an object response");
  return typeof payload.url === "string" ? payload.url : null;
}

/** Writes the App's own webhook URL (`PATCH /app/hook/config`, App JWT
 * auth). Sends only `url` — the App's content type and secret must stay as
 * they were set at creation. */
async function writeHookConfigUrl(
  deps: Pick<GithubAppDeps, "apiUrl" | "fetchImpl">,
  jwt: string,
  url: string,
): Promise<void> {
  const res = await githubFetch(deps)(hookConfigUrl(deps), {
    method: "PATCH",
    headers: { ...appJwtHeaders(jwt), "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
  });
  if (!res.ok) throw new Error(`GitHub API PATCH /app/hook/config returned ${res.status}`);
}

/**
 * Points the org's GitHub App at this instance's public webhook URL, when
 * this instance owns that App. Call it at boot and after the manifest flow
 * saves. NEVER throws — see the fail-soft note below.
 *
 * ── The shared-App guard (load-bearing — do not weaken) ──────────────────
 * `loadAppConfigWithSource` reports where the config came from:
 *
 *   - `"org"` — the App's private key lives in this instance's database,
 *     because the manifest flow created the App here, or an admin connected
 *     an existing App through `POST /credential`. Either way this instance
 *     owns the App, so it can move the App's webhook URL. Connecting an
 *     existing App is therefore an ownership claim, and the admin form says
 *     so before the paste.
 *   - `"environment"` — the App arrived through `GITHUB_APP_*`, which is how
 *     a deployment or a team's shared dev App is supplied. A DIFFERENT
 *     instance owns it.
 *
 * Only `"org"` syncs. Without that condition, a developer who starts a local
 * instance would silently move the team's shared App to that developer's own
 * tunnel, and each developer's boot would take the webhook back from the
 * last one.
 *
 * Two more rules hold this safe:
 *
 *   - Idempotent. It reads the current URL first and writes only when the
 *     URL is different. A boot that changes nothing makes no write.
 *   - It never clears. With no public URL (`publicUrl` empty), it does
 *     nothing. A deployment can set the hook URL on purpose, and an empty
 *     URL stops delivery for everyone. This function asserts a URL; it does
 *     not remove one.
 *
 * Fail-soft: this runs at boot and inside the manifest-flow callback. A
 * GitHub outage, a revoked private key, or a 4xx must not stop the API from
 * starting or stop the manifest flow from completing. Every failure is
 * logged and swallowed, the same as the best-effort `discoverInstallations`
 * call in `plugins/http-github.ts`.
 *
 * @param publicUrl This instance's public base URL — `publicUrlFromEnv`.
 */
export async function syncAppWebhookUrl(
  deps: Pick<GithubAppDeps, "credentials" | "env" | "apiUrl" | "fetchImpl">,
  orgId: string,
  publicUrl: string | undefined,
): Promise<void> {
  try {
    const loaded = await loadAppConfigWithSource(deps, orgId);
    if (!loaded) return;
    if (loaded.source !== "org") return;

    if (!publicUrl) {
      console.debug(
        `github-app: no public URL for this instance; left the webhook URL of app ${loaded.config.appSlug} unchanged. Set VALET_PUBLIC_URL to sync it.`,
      );
      return;
    }

    const desired = `${publicUrl.replace(/\/+$/, "")}${GITHUB_APP_WEBHOOK_PATH}`;
    const jwt = mintAppJwt(loaded.config);
    if ((await readHookConfigUrl(deps, jwt)) === desired) return;

    await writeHookConfigUrl(deps, jwt, desired);
    console.log(`github-app: webhook URL of app ${loaded.config.appSlug} set to ${desired}`);
  } catch (err) {
    console.error(
      `github-app: webhook URL sync failed for org ${orgId} (continuing). GitHub keeps delivering to the previous URL. Check GitHub availability and the app's private key, then restart or re-run setup:`,
      err,
    );
  }
}

/** Every org that holds a `github_app` credential row. It reads the
 * `credentials` table directly for the reason the module doc comment gives —
 * the `CredentialStore` port is owner-scoped and cannot answer "which owners
 * hold this service". The boot-time webhook sync and the installation sweep
 * (`github-installation-sweep.ts`) share this one definition of "orgs with an
 * App row". */
export async function listOrgsWithAppCredential(db: AppQueryable): Promise<string[]> {
  const rows = await db
    .select({ ownerId: credentials.ownerId })
    .from(credentials)
    .where(and(eq(credentials.ownerType, "org"), eq(credentials.service, GITHUB_APP_SERVICE)));
  return rows.map((row) => row.ownerId);
}

/**
 * Boot-time counterpart to `syncAppWebhookUrl`: syncs every org that owns a
 * `github_app` credential row. The scan reads the `credentials` table
 * directly for the same reason `loadLinkedUserIdentityMap` does (see the module
 * doc comment) — the `CredentialStore` port is owner-scoped and cannot
 * answer "which owners hold this service". Only credential-row apps can pass
 * the `source === "org"` guard, so the scan already gives the exact
 * candidate set, and `syncAppWebhookUrl` re-checks the source per org.
 * NEVER throws.
 */
export async function syncAllAppWebhookUrls(
  deps: Pick<GithubAppDeps, "db" | "credentials" | "env" | "apiUrl" | "fetchImpl">,
  publicUrl: string | undefined,
): Promise<void> {
  if (!publicUrl) {
    console.debug("github-app: no public URL for this instance; left every app webhook URL unchanged.");
    return;
  }
  let orgIds: string[];
  try {
    orgIds = await listOrgsWithAppCredential(deps.db);
  } catch (err) {
    console.error("github-app: failed to list orgs with a github_app credential (continuing):", err);
    return;
  }
  for (const orgId of orgIds) {
    await syncAppWebhookUrl(deps, orgId, publicUrl);
  }
}

interface ParsedAccessToken {
  token: string;
  expiresAtMs: number;
}

function parseAccessTokenResponse(payload: unknown): ParsedAccessToken {
  if (!isRecord(payload)) throw new Error("access_tokens response: expected an object");
  const { token, expires_at: expiresAt } = payload;
  if (typeof token !== "string") throw new Error("access_tokens response: expected token to be a string");
  if (typeof expiresAt !== "string") throw new Error("access_tokens response: expected expires_at to be a string");
  const expiresAtMs = Date.parse(expiresAt);
  if (Number.isNaN(expiresAtMs)) throw new Error(`access_tokens response: unparseable expires_at "${expiresAt}"`);
  return { token, expiresAtMs };
}

/** THE one cached installation-token minting path. Looks up the
 * non-suspended installation for `(orgId, accountLogin)` (case-insensitive).
 * Personal installations require the linked acting user before cache reads;
 * returns `null` when there is none. Returns the cached token when it has
 * more than 5 minutes left before expiry; otherwise mints a fresh one via
 * `POST /app/installations/{id}/access_tokens`, caches it (encrypted) on
 * the row, and returns it. Never call the GitHub mint endpoint from
 * anywhere else. */
export async function mintInstallationToken(
  deps: GithubAppDeps,
  orgId: string,
  accountLogin: string,
  userId?: string,
): Promise<string | null> {
  const nowMs = (deps.now ?? Date.now)();
  const find = async () => (await deps.db.select().from(githubInstallations).where(and(
    eq(githubInstallations.orgId, orgId),
    sql`lower(${githubInstallations.accountLogin}) = lower(${accountLogin})`,
    eq(githubInstallations.suspended, false),
  )).limit(1))[0];
  let row = await find();
  if (!row) {
    // The throttle handles and records failures; this task never rejects.
    void requestInstallationForLogin(deps, orgId, accountLogin);
    return null;
  }
  let config: GithubAppConfig | null;
  try { config = await loadAppConfig(deps, orgId); } catch { return null; }
  if (!config) return null;
  let owner: GithubAccountIdentity;
  try { owner = await loadAppOwner(deps, orgId, config); } catch { return null; }
  if (row.accountId === null) {
    await ensureInstallationAccountIds(deps, orgId);
    row = await find();
  } else if (row.accountId !== owner.id && row.accountType !== "User") {
    await requestInstallationDiscovery(deps, orgId);
    row = await find();
  }
  if (!row) return null;
  if (row.accountId === null) {
    // Upgrade-only compatibility for tokens cached before account IDs existed.
    // Remove after deployed installation rows have completed their ID backfill.
    // Never mint new authority from a mutable login or use a personal cache here.
    if (row.accountLogin.toLowerCase() === owner.login.toLowerCase() && row.cachedToken &&
        row.cachedTokenExpiresAt && row.cachedTokenExpiresAt - CACHED_TOKEN_MARGIN_MS > nowMs) {
      try { return decryptSecret(row.cachedToken, deps.key); } catch { return null; }
    }
    return null;
  }
  if (row.accountId !== owner.id) {
    const [eligible] = await deps.db.select({ id: githubInstallations.id }).from(githubInstallations)
      .where(and(eq(githubInstallations.id, row.id), installationAccessCondition(owner, userId)));
    if (!eligible || !userId || !(await personalInstallationIsLinked(deps, orgId, userId, row.accountId))) return null;
  }

  if (row.cachedToken !== null && row.cachedTokenExpiresAt !== null) {
    if (row.cachedTokenExpiresAt - CACHED_TOKEN_MARGIN_MS > nowMs) {
      try {
        return decryptSecret(row.cachedToken, deps.key);
      } catch {
        // A rekeyed VALET_ENCRYPTION_KEY or a corrupted row makes the cached
        // token undecryptable — never let that throw and take down every
        // installation-token resolution. Log (no secret material) and fall
        // through to a fresh mint below, which overwrites the bad cache.
        console.error(
          `mintInstallationToken: failed to decrypt cached token for installation ${row.installationId} (org ${orgId}); re-minting`,
        );
      }
    }
  }

  const jwt = mintAppJwt(config);

  const res = await githubFetch(deps)(`${githubApiUrl(deps)}/app/installations/${row.installationId}/access_tokens`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "Valet-App",
    },
  });
  if (!res.ok) {
    throw new Error(`GitHub API POST /app/installations/${row.installationId}/access_tokens returned ${res.status}`);
  }
  const { token, expiresAtMs } = parseAccessTokenResponse(await res.json());

  await deps.db
    .update(githubInstallations)
    .set({ cachedToken: encryptSecret(token, deps.key), cachedTokenExpiresAt: expiresAtMs, updatedAt: nowMs })
    .where(eq(githubInstallations.id, row.id));

  return token;
}
