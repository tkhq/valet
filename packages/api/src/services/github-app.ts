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
 * ── Who may use an installation ────────────────────────────────────────
 * The App is public, as the legacy stack made it, so any GitHub account can
 * install it, and discovery files every installation under the org. Use is
 * narrower, and `usableInstallation` is the one rule:
 *
 *   - An installation on the App owner's own account serves every member,
 *     also when that account is a personal one (`app_owner`).
 *   - An installation on another GitHub organization (any `accountType`
 *     other than "User") serves every member only when it is approved
 *     (`org_approved`): an org admin approved it, or a member with a
 *     verified GitHub connection installed it (`sender.id` on
 *     `installation.created`). A stranger's organization serves nobody.
 *   - An installation on a personal GitHub account serves only the member
 *     it is bound to (`linkedUserId`). A personal installation with no
 *     binding, such as a stranger's, serves nobody.
 *   - A caller with no user (a team, the org, an unattended run) gets the
 *     organization installations only.
 *
 * ── Binding a personal installation (the legacy rule) ──────────────────
 * The installation's GitHub account id must equal the GitHub account id
 * that an org member proved through the App OAuth connect (`GET /user`, saved
 * as the credential's `metadata.githubId`). A login match is not enough,
 * because a PAT row or a renamed account can carry any login. When two
 * members connected the same GitHub account, nobody is bound. Discovery,
 * `relinkInstallations`, and `reconcileUserInstallations` all bind through
 * `loadMemberGithubIds`.
 *
 * `CredentialStore.get`/`list` are owner-scoped, so `loadMemberGithubIds`
 * reads the `credentials` table directly (`owner_type = 'user' AND service =
 * 'github'`), joined to `org_members`. `metadata` is unencrypted jsonb, so no
 * decryption is needed.
 */
import { invalidateWorkflowSources } from "./content-sync/invalidation.js";
import { createPrivateKey, randomUUID, sign } from "node:crypto";
import { and, eq, isNotNull, isNull, ne, or, sql, type SQL } from "drizzle-orm";
import type { CredentialOwner, CredentialStore } from "@valet/engine";
import type { AppQueryable } from "../lib/drizzle.js";
import { credentials, githubInstallations, orgMembers, orgs, type GithubInstallationRow } from "../schema/index.js";
import { decryptSecret, encryptSecret } from "../lib/secret-crypto.js";
import { isOrgAdmin } from "./org.js";
import { githubHostKey, resolveGithubApiUrl, resolveGithubUrl } from "./github-env.js";
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
  accountType: string;
  /** GitHub's numeric account id, as a string. */
  accountId: string | null;
  repositorySelection: string | null;
  suspended: boolean;
}

function parseInstallationsResponse(payload: unknown, source = "GET /app/installations"): ParsedInstallation[] {
  if (!Array.isArray(payload)) {
    throw new Error(`GitHub API ${source}: expected an array response`);
  }
  return payload.map((item, i) => {
    if (!isRecord(item)) throw new Error(`installations[${i}]: expected an object`);
    const { id, account, repository_selection: repositorySelection, suspended_at: suspendedAt } = item;
    if (typeof id !== "number") throw new Error(`installations[${i}].id: expected a number`);
    if (!isRecord(account)) throw new Error(`installations[${i}].account: expected an object`);
    const { login, type, id: accountId } = account;
    if (typeof login !== "string") throw new Error(`installations[${i}].account.login: expected a string`);
    if (typeof type !== "string") throw new Error(`installations[${i}].account.type: expected a string`);
    return {
      installationId: id,
      accountLogin: login,
      accountType: type,
      accountId: typeof accountId === "number" || typeof accountId === "string" ? String(accountId) : null,
      repositorySelection: typeof repositorySelection === "string" ? repositorySelection : null,
      suspended: suspendedAt !== null && suspendedAt !== undefined,
    };
  });
}

/** The account type GitHub reports for a personal account. */
const PERSONAL_ACCOUNT_TYPE = "User";

/**
 * The installations a caller may use, as a `WHERE` condition on
 * `github_installations`. See "Who may use an installation" in the module
 * comment. Suspension is a separate filter: callers that count installations
 * still want suspended rows.
 */
export function usableInstallation(orgId: string, userId: string | undefined): SQL {
  const orgWide = or(
    eq(githubInstallations.appOwner, true),
    and(ne(githubInstallations.accountType, PERSONAL_ACCOUNT_TYPE), eq(githubInstallations.orgApproved, true)),
  );
  // A binding counts only with a verified account id, and only when the
  // bound member's own credential carries that verified id. Rows bound
  // before the column existed were matched by login (see the `account_id`
  // repair), and an older pod mid rolling deploy may still bind by login.
  const visible = userId
    ? or(
        orgWide,
        and(
          eq(githubInstallations.accountType, PERSONAL_ACCOUNT_TYPE),
          isNotNull(githubInstallations.accountId),
          eq(githubInstallations.linkedUserId, userId),
          sql`EXISTS (SELECT 1 FROM ${credentials} WHERE ${credentials.ownerType} = 'user'
            AND ${credentials.ownerId} = ${githubInstallations.linkedUserId}
            AND ${credentials.service} = 'github'
            AND ${credentials.metadata}->>'githubId' = ${githubInstallations.accountId}
            AND ${credentials.metadata}->>'source' = ${GITHUB_APP_OAUTH_SOURCE})`,
        ),
      )
    : orgWide;
  return and(eq(githubInstallations.orgId, orgId), visible) ?? sql`false`;
}

/** What a webhook delivery's installation gives the organization:
 * `organization` (the App owner's account or an approved organization),
 * `member` (a personal installation bound to one member), or `none` (a
 * stranger's, an unbound, or an unknown installation). The webhook applies
 * every event only for `organization` (see `GithubDeliveryEffects`). */
export async function installationEventAccess(
  deps: Pick<GithubAppDeps, "db">,
  orgId: string,
  installationId: number,
): Promise<"organization" | "member" | "none"> {
  const [row] = await deps.db
    .select()
    .from(githubInstallations)
    .where(and(eq(githubInstallations.orgId, orgId), eq(githubInstallations.installationId, installationId)))
    .limit(1);
  if (!row) return "none";
  const access = installationAccess(row);
  return access === "organization" || access === "member" ? access : "none";
}

/** What an installation row gives the organization, for display. */
export type InstallationAccess = "organization" | "member" | "pending" | "none";

export function installationAccess(
  row: Pick<GithubInstallationRow, "accountType" | "accountId" | "linkedUserId" | "orgApproved" | "appOwner">,
): InstallationAccess {
  if (row.appOwner) return "organization";
  if (row.accountType !== PERSONAL_ACCOUNT_TYPE) return row.orgApproved ? "organization" : "pending";
  return row.accountId !== null && row.linkedUserId !== null ? "member" : "none";
}

/** The installations every member may use: the organization installations.
 * The no-owner fallback ("the org's sole installation") counts only these,
 * so a member's personal installation never makes it ambiguous. */
export function orgWideInstallation(orgId: string): SQL {
  return usableInstallation(orgId, undefined);
}

/**
 * The member's verified GitHub account id, when it was verified on the
 * GitHub host this instance talks to (`metadata.githubHost`). Null
 * otherwise. The connect callback writes both fields.
 */
export function verifiedGithubId(metadata: unknown, apiUrl: string): string | null {
  if (!isRecord(metadata)) return null;
  const { githubId, githubHost, source } = metadata;
  // Only the connect callback and the token-check backfill mark an id as
  // verified. The member can write any other metadata, and the upgrade
  // repair strips identity fields written before this release.
  if (source !== GITHUB_APP_OAUTH_SOURCE) return null;
  if (typeof githubId !== "string" || githubId.length === 0) return null;
  if (typeof githubHost !== "string" || githubHostKey(githubHost) !== githubHostKey(apiUrl)) return null;
  return githubId;
}

/** `githubId -> userId` for the members of `orgId` who connected GitHub
 * through the App OAuth on this GitHub host. A GitHub id that two members
 * connected maps to `null`: nobody is bound. See the module comment for why
 * this reads the `credentials` table directly. */
async function loadMemberGithubIds(
  deps: Pick<GithubAppDeps, "db" | "apiUrl">,
  orgId: string,
): Promise<Map<string, string | null>> {
  const db = deps.db;
  const rows = await db
    .select({ ownerId: credentials.ownerId, metadata: credentials.metadata })
    .from(credentials)
    .innerJoin(orgMembers, and(eq(orgMembers.userId, credentials.ownerId), eq(orgMembers.orgId, orgId)))
    .where(and(eq(credentials.ownerType, "user"), eq(credentials.service, "github")));
  const map = new Map<string, string | null>();
  const apiUrl = githubApiUrl(deps);
  for (const row of rows) {
    const githubId = verifiedGithubId(row.metadata, apiUrl);
    if (githubId === null) continue;
    const prior = map.get(githubId);
    map.set(githubId, prior === undefined || prior === row.ownerId ? row.ownerId : null);
  }
  return map;
}

/** Marks a credential that GitHub issued through this App's OAuth: the
 * connect callback writes it, and so does `backfillMemberGithubIds` after
 * GitHub's token check. `PUT /api/credentials/:service` rejects it. */
export const GITHUB_APP_OAUTH_SOURCE = "github-app-oauth";

/**
 * Saves the verified GitHub account id of each org member who connected
 * through the App OAuth before the connect callback saved one. Without it,
 * the first discovery after the upgrade unbinds every personal
 * installation until its owner reconnects.
 *
 * The proof is GitHub's token check (`POST /applications/{client_id}/token`
 * with the App's client id and secret as Basic auth). It answers 200 with
 * the token's `user` only for a token this App issued. A pasted token, even
 * with a made-up refresh token, gets 404 and is left alone: a credential's
 * own fields prove nothing. The update merges `githubId`, `githubHost`, and
 * the `source` marker into `metadata` alone, so it never writes a token
 * that a concurrent refresh may have rotated. Best effort: a failure is
 * logged and retried at the next discovery.
 */
async function backfillMemberGithubIds(deps: GithubAppDeps, orgId: string, config: GithubAppConfig): Promise<void> {
  const apiUrl = githubApiUrl(deps);
  const rows = await deps.db
    .select({ ownerId: credentials.ownerId, metadata: credentials.metadata, accessTokenEnc: credentials.accessTokenEnc })
    .from(credentials)
    .innerJoin(orgMembers, and(eq(orgMembers.userId, credentials.ownerId), eq(orgMembers.orgId, orgId)))
    .where(and(eq(credentials.ownerType, "user"), eq(credentials.service, "github")));
  const basic = Buffer.from(`${config.oauthClientId}:${config.oauthClientSecret}`).toString("base64");
  for (const row of rows) {
    if (verifiedGithubId(row.metadata, apiUrl) !== null) continue;
    try {
      if (row.accessTokenEnc === null) continue;
      const cred = await deps.credentials.get({ type: "user", id: row.ownerId }, "github");
      if (!cred?.accessToken) continue;
      const res = await githubFetch(deps)(`${apiUrl}/applications/${encodeURIComponent(config.oauthClientId)}/token`, {
        method: "POST",
        headers: {
          Authorization: `Basic ${basic}`,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
          "User-Agent": "Valet-App",
        },
        body: JSON.stringify({ access_token: cred.accessToken }),
      });
      if (!res.ok) continue;
      const payload: unknown = await res.json();
      const user = isRecord(payload) ? payload.user : undefined;
      if (!isRecord(user) || typeof user.id !== "number") continue;
      const patch = JSON.stringify({ githubId: String(user.id), githubHost: apiUrl, source: GITHUB_APP_OAUTH_SOURCE });
      await deps.db
        .update(credentials)
        .set({ metadata: sql`coalesce(${credentials.metadata}, '{}'::jsonb) || ${patch}::jsonb` })
        .where(
          and(
            eq(credentials.ownerType, "user"),
            eq(credentials.ownerId, row.ownerId),
            eq(credentials.service, "github"),
            // Only the credential that was checked. A credential the member
            // replaced during the check (new ciphertext) gets nothing.
            eq(credentials.accessTokenEnc, row.accessTokenEnc),
          ),
        );
    } catch (err) {
      console.error(`github-app: verifying the GitHub account of user ${row.ownerId} failed:`, err);
    }
  }
}

/** The member a personal installation is bound to, or null. An organization
 * installation is never bound: it serves every member. */
function bindingFor(
  install: { accountType: string; accountId: string | null },
  memberGithubIds: Map<string, string | null>,
): string | null {
  if (install.accountType !== PERSONAL_ACCOUNT_TYPE || install.accountId === null) return null;
  return memberGithubIds.get(install.accountId) ?? null;
}

/**
 * DB-only re-binding of the org's installations. No GitHub API round trip
 * (unlike `discoverInstallations`). The connect callback calls it after it
 * saves a member's credential, so that member's personal installation is
 * bound at once.
 */
export async function relinkInstallations(deps: Pick<GithubAppDeps, "db" | "apiUrl">, orgId: string): Promise<void> {
  const [existingRows, memberGithubIds] = await Promise.all([
    deps.db.select().from(githubInstallations).where(eq(githubInstallations.orgId, orgId)),
    loadMemberGithubIds(deps, orgId),
  ]);
  const nowMs = Date.now();
  for (const row of existingRows) {
    const linkedUserId = bindingFor(row, memberGithubIds);
    if (linkedUserId === row.linkedUserId) continue;
    await deps.db
      .update(githubInstallations)
      .set({ linkedUserId, updatedAt: nowMs })
      .where(eq(githubInstallations.id, row.id));
  }
}

/** The account that owns the App, from `GET /app` (App JWT auth). Null when
 * GitHub does not answer: then no new row is treated as the owner's, and
 * existing rows keep their flag. */
interface AppOwner {
  id: string | null;
  login: string;
}

async function fetchAppOwner(deps: Pick<GithubAppDeps, "apiUrl" | "fetchImpl">, jwt: string): Promise<AppOwner | null> {
  try {
    const res = await githubFetch(deps)(`${githubApiUrl(deps)}/app`, { headers: appJwtHeaders(jwt) });
    if (!res.ok) throw new Error(`GitHub API GET /app returned ${res.status}`);
    const payload: unknown = await res.json();
    const owner = isRecord(payload) ? payload.owner : undefined;
    if (!isRecord(owner) || typeof owner.login !== "string") return null;
    const id = typeof owner.id === "number" || typeof owner.id === "string" ? String(owner.id) : null;
    return { id, login: owner.login };
  } catch (err) {
    console.error("github-app: reading the App owner failed:", err);
    return null;
  }
}

/** True when the installation is on the App owner's account. GitHub reports
 * both at the same time, so a login match is safe when an id is missing.
 * Null when the owner is unknown. */
function isAppOwnerAccount(inst: ParsedInstallation, owner: AppOwner | null): boolean | null {
  if (!owner) return null;
  if (inst.accountId !== null && owner.id !== null) return inst.accountId === owner.id;
  return inst.accountLogin.toLowerCase() === owner.login.toLowerCase();
}

/** Inserts or updates one installation row and binds it. Shared by discovery
 * and by `reconcileUserInstallations`. This is the only writer of
 * `github_installations` rows, so every new row gets an explicit
 * `org_approved` (see the schema comment). An update never changes
 * `org_approved`: that is an admin's decision, or the installer's. */
async function upsertInstallation(
  db: AppQueryable,
  orgId: string,
  inst: ParsedInstallation,
  linkedUserId: string | null,
  nowMs: number,
  appOwner: boolean | null,
  id: string = `ghi_${randomUUID()}`,
): Promise<GithubInstallationRow> {
  const [row] = await db
    .insert(githubInstallations)
    .values({
      id,
      orgId,
      installationId: inst.installationId,
      accountLogin: inst.accountLogin,
      accountType: inst.accountType,
      accountId: inst.accountId,
      repositorySelection: inst.repositorySelection,
      suspended: inst.suspended,
      linkedUserId,
      orgApproved: appOwner === true,
      appOwner: appOwner === true,
      createdAt: nowMs,
      updatedAt: nowMs,
    })
    .onConflictDoUpdate({
      target: [githubInstallations.orgId, githubInstallations.installationId],
      set: {
        accountLogin: inst.accountLogin,
        accountType: inst.accountType,
        accountId: inst.accountId,
        repositorySelection: inst.repositorySelection,
        suspended: inst.suspended,
        linkedUserId,
        ...(appOwner !== null ? { appOwner } : {}),
        updatedAt: nowMs,
      },
    })
    .returning();
  return row;
}

/**
 * Records a member's own personal installations at connect time, the way the
 * legacy stack did after its OAuth link. `GET /user/installations` with the
 * member's App OAuth token lists the installations of this App that the
 * member can reach. Only an installation on the member's own GitHub account
 * (`account.id === githubId`) is recorded. The binding then comes from
 * `relinkInstallations`, so the same rule binds every row.
 *
 * Without this, a member who installs the App while the webhook is off
 * waits for the next discovery sweep.
 */
export async function reconcileUserInstallations(
  deps: Pick<GithubAppDeps, "db" | "apiUrl" | "fetchImpl" | "now">,
  orgId: string,
  member: { userId: string; githubId: string; accessToken: string },
): Promise<void> {
  // Paginated, as the legacy stack did: a member can reach more than 100
  // installations of the App through the GitHub organizations they are in.
  const own: ParsedInstallation[] = [];
  let url: string | null = `${githubApiUrl(deps)}/user/installations?per_page=100`;
  for (let pages = 0; url && pages < MAX_INSTALLATION_PAGES; pages++) {
    const res: Response = await githubFetch(deps)(url, {
      headers: {
        Authorization: `Bearer ${member.accessToken}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "Valet-App",
      },
    });
    if (!res.ok) throw new Error(`GitHub API GET /user/installations returned ${res.status}`);
    const payload: unknown = await res.json();
    const list = isRecord(payload) ? payload.installations : undefined;
    own.push(
      ...parseInstallationsResponse(list, "GET /user/installations").filter(
        (inst) => inst.accountType === PERSONAL_ACCOUNT_TYPE && inst.accountId === member.githubId,
      ),
    );
    url = parseNextLink(res.headers.get("link"));
  }
  const nowMs = (deps.now ?? Date.now)();
  for (const inst of own) await upsertInstallation(deps.db, orgId, inst, null, nowMs, null);
  await relinkInstallations(deps, orgId);
}

/**
 * Records the one installation an `installation.created` delivery names,
 * from the delivery's own `installation` object. Anybody can install the
 * public App, so a delivery never re-reads every installation: a stranger's
 * install costs one row. The row is bound like any other (see the module
 * comment), and another organization's installation is approved when the
 * GitHub user who installed it is an org member with a verified connection.
 */
export async function recordCreatedInstallation(
  deps: GithubAppDeps,
  orgId: string,
  rawInstallation: unknown,
  senderGithubId: string | null,
): Promise<void> {
  const [inst] = parseInstallationsResponse([rawInstallation], "installation.created delivery");
  const config = await loadAppConfig(deps, orgId);
  if (!config || !inst) return;
  const owner = await fetchAppOwner(deps, mintAppJwt(config));
  const memberGithubIds = await loadMemberGithubIds(deps, orgId);
  await deps.db.transaction(async (tx) => {
    await tx.select({ id: orgs.id }).from(orgs).where(eq(orgs.id, orgId)).for("update");
    const row = await upsertInstallation(
      tx, orgId, inst, bindingFor(inst, memberGithubIds), (deps.now ?? Date.now)(), isAppOwnerAccount(inst, owner),
    );
    const access = installationAccess(row);
    if (access === "organization" || access === "member") await invalidateWorkflowSources(tx, { orgId });
  });
  if (senderGithubId && inst.accountType !== PERSONAL_ACCOUNT_TYPE) {
    await approveInstalledByMember(deps, orgId, inst.installationId, senderGithubId);
  }
}

/** Most orgs a boot pass reads installations for. */
const LEGACY_DISCOVERY_ORG_LIMIT = 25;

/**
 * Reads installations again for each org that still has a row without an
 * account id: rows from before the upgrade. The upgrade repair keeps them
 * working on the old assumption (a personal row is the owner's), and this
 * pass replaces that with GitHub's answer: account ids, bindings, and the
 * App owner. Boot calls it once, so no admin has to choose Refresh
 * installations. Bounded to `LEGACY_DISCOVERY_ORG_LIMIT` orgs; the sweep
 * covers the rest. Never throws. Returns the orgs it read.
 */
export async function discoverLegacyInstallations(deps: GithubAppDeps): Promise<string[]> {
  let orgIds: string[];
  try {
    const rows = await deps.db
      .selectDistinct({ orgId: githubInstallations.orgId })
      .from(githubInstallations)
      .where(isNull(githubInstallations.accountId))
      .limit(LEGACY_DISCOVERY_ORG_LIMIT);
    orgIds = rows.map((row) => row.orgId);
  } catch (err) {
    console.error("github-app: listing orgs with legacy installations failed:", err);
    return [];
  }
  const read: string[] = [];
  for (const orgId of orgIds) {
    try {
      await discoverInstallations(deps, orgId);
      read.push(orgId);
    } catch (err) {
      console.error(`github-app: boot discovery for org ${orgId} failed:`, err);
    }
  }
  return read;
}

export type InstallationApprovalResult = "ok" | "not_found" | "personal";

/**
 * An org admin approves (or revokes) another GitHub organization's
 * installation for every member. A personal installation cannot be
 * approved: it serves only the member who owns that GitHub account.
 */
export async function setInstallationApproval(
  deps: Pick<GithubAppDeps, "db">,
  orgId: string,
  installationId: number,
  approved: boolean,
): Promise<InstallationApprovalResult> {
  return deps.db.transaction(async (tx) => {
    await tx.select({ id: orgs.id }).from(orgs).where(eq(orgs.id, orgId)).for("update");
    const [row] = await tx
      .select()
      .from(githubInstallations)
      .where(and(eq(githubInstallations.orgId, orgId), eq(githubInstallations.installationId, installationId)))
      .limit(1);
    if (!row) return "not_found";
    if (row.accountType === PERSONAL_ACCOUNT_TYPE) return "personal";
    if (row.orgApproved !== approved) {
      await tx
        .update(githubInstallations)
        .set({ orgApproved: approved, updatedAt: Date.now() })
        .where(eq(githubInstallations.id, row.id));
      await invalidateWorkflowSources(tx, { orgId });
    }
    return "ok";
  });
}

/**
 * Approves another GitHub organization's installation when the GitHub user
 * who installed it (`sender.id` on `installation.created`) is an org ADMIN
 * with a verified GitHub connection. Approval puts the organization's
 * repositories in every member's picker and changes the sole-installation
 * fallback, which is an admin's decision. An installation by any other
 * member waits for an admin. True when the row is now approved.
 */
export async function approveInstalledByMember(
  deps: Pick<GithubAppDeps, "db" | "apiUrl">,
  orgId: string,
  installationId: number,
  senderGithubId: string,
): Promise<boolean> {
  const memberGithubIds = await loadMemberGithubIds(deps, orgId);
  const installer = memberGithubIds.get(senderGithubId);
  if (!installer || !(await isOrgAdmin(deps.db, orgId, installer))) return false;
  const result = await setInstallationApproval(deps, orgId, installationId, true);
  return result === "ok";
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
async function fetchAllInstallations(
  deps: GithubAppDeps,
  jwt: string,
): Promise<{ installations: ParsedInstallation[]; complete: boolean }> {
  const installations: ParsedInstallation[] = [];
  let url: string | null = `${githubApiUrl(deps)}/app/installations?per_page=100`;
  let pages = 0;

  while (url && pages < MAX_INSTALLATION_PAGES) {
    pages++;
    const res: Response = await githubFetch(deps)(url, {
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

  // A `next` link left over means the cap cut the list off.
  return { installations, complete: url === null };
}

/** Discovers the org's GitHub App installations via `GET /app/installations`
 * (App JWT auth, paginated — see `fetchAllInstallations`), upserts
 * `github_installations` by `(orgId, installationId)`, deletes rows absent
 * from the response, and binds each personal installation to the member who
 * owns that GitHub account (see the module comment). Returns the org's
 * installation rows (post-sync). `[]` when no app is configured for the
 * org. */
export async function discoverInstallations(deps: GithubAppDeps, orgId: string): Promise<GithubInstallationRow[]> {
  const config = await loadAppConfig(deps, orgId);
  if (!config) return [];

  const jwt = mintAppJwt(config);
  const { installations, complete } = await fetchAllInstallations(deps, jwt);
  if (!complete) {
    // Anybody can install the public App, so strangers can push the list
    // past the cap. A row missing from a cut-off list may be on a later
    // page, so nothing is deleted.
    console.warn(`github-app discovery for org ${orgId}: more than ${MAX_INSTALLATION_PAGES} pages of installations; deleting none`);
  }

  await backfillMemberGithubIds(deps, orgId, config);
  const memberGithubIds = await loadMemberGithubIds(deps, orgId);
  const owner = await fetchAppOwner(deps, jwt);
  return deps.db.transaction(async (tx) => {
    await tx.select({ id: orgs.id }).from(orgs).where(eq(orgs.id, orgId)).for("update");
    const existingRows = await tx.select().from(githubInstallations).where(eq(githubInstallations.orgId, orgId));
    const existingByInstallationId = new Map(existingRows.map((row) => [row.installationId, row]));

    const nowMs = (deps.now ?? Date.now)();
    const seenIds = new Set<number>();
    const rows: GithubInstallationRow[] = [];

    for (const inst of installations) {
      seenIds.add(inst.installationId);
      const existing = existingByInstallationId.get(inst.installationId);
      const row = await upsertInstallation(
        tx, orgId, inst, bindingFor(inst, memberGithubIds), nowMs, isAppOwnerAccount(inst, owner), existing?.id,
      );
      rows.push(row);
    }

    for (const row of existingRows) {
      if (complete && !seenIds.has(row.installationId)) {
        await tx.delete(githubInstallations).where(eq(githubInstallations.id, row.id));
      }
    }

    const signature = (items: readonly GithubInstallationRow[]) =>
      JSON.stringify(items.map((row) => [row.installationId, row.accountLogin.toLowerCase(), row.suspended, installationAccess(row)])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
    if (signature(existingRows) !== signature(rows)) await invalidateWorkflowSources(tx, { orgId });
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
 * directly for the same reason `loadMemberGithubIds` does (see the module
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
 * non-suspended installation for `(orgId, accountLogin)` (case-insensitive)
 * that `userId` may use (`usableInstallation`); returns `null` when there is
 * none. Without `userId`, only organization installations qualify. Returns the cached token when it has
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

  const rows = await deps.db
    .select()
    .from(githubInstallations)
    .where(
      and(
        usableInstallation(orgId, userId),
        sql`lower(${githubInstallations.accountLogin}) = lower(${accountLogin})`,
        eq(githubInstallations.suspended, false),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) return null;

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

  const config = await loadAppConfig(deps, orgId);
  if (!config) return null;
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
