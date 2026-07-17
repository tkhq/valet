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
 * ── `linkedUserId` matching (honest cheap path) ────────────────────────
 * `CredentialStore.get`/`list` are owner-scoped — there is no "find the
 * owner whose credential metadata matches X" method on the port. Rather
 * than invent one, `discoverInstallations` reads the `credentials` table
 * directly (`owner_type = 'user' AND service = 'github'`) via the shared
 * `AppQueryable` and matches `metadata.login` case-insensitively in JS.
 * `metadata` is unencrypted jsonb, so no decryption is needed. This is a
 * full table scan of user-owned `github` credential rows; fine at today's
 * scale (one query, small row count), and confined to this one function.
 */
import { createPrivateKey, randomUUID, sign } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { CredentialOwner, CredentialStore } from "@valet/engine";
import type { AppQueryable } from "../lib/drizzle.js";
import { credentials, githubInstallations, type GithubInstallationRow } from "../schema/index.js";
import { decryptSecret, encryptSecret } from "../lib/secret-crypto.js";
import { resolveGithubApiUrl } from "./github-env.js";

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
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function appConfigOwner(orgId: string): CredentialOwner {
  return { type: "org", id: orgId };
}

/** Reads the org's GitHub App config. `null` when no app is configured yet.
 * Throws if a `github_app` credential row exists but is malformed (missing
 * a required field) — that should never happen outside a bug in
 * `saveAppConfig` or a hand-edited row. */
export async function loadAppConfig(
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
export function mintAppJwt(config: GithubAppConfig): string {
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

interface ParsedInstallation {
  installationId: number;
  accountLogin: string;
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
    const { login, type } = account;
    if (typeof login !== "string") throw new Error(`installations[${i}].account.login: expected a string`);
    if (typeof type !== "string") throw new Error(`installations[${i}].account.type: expected a string`);
    return {
      installationId: id,
      accountLogin: login,
      accountType: type,
      repositorySelection: typeof repositorySelection === "string" ? repositorySelection : null,
      suspended: suspendedAt !== null && suspendedAt !== undefined,
    };
  });
}

/** Direct `credentials` table scan for user-owned `github` rows — see the
 * module doc comment ("honest cheap path") for why this bypasses the
 * owner-scoped `CredentialStore` port. Returns a `login.toLowerCase() ->
 * userId` map. */
async function loadLinkedUserLoginMap(db: AppQueryable): Promise<Map<string, string>> {
  const rows = await db
    .select({ ownerId: credentials.ownerId, metadata: credentials.metadata })
    .from(credentials)
    .where(and(eq(credentials.ownerType, "user"), eq(credentials.service, "github")));
  const map = new Map<string, string>();
  for (const row of rows) {
    if (!isRecord(row.metadata)) continue;
    const login = row.metadata.login;
    if (typeof login !== "string") continue;
    map.set(login.toLowerCase(), row.ownerId);
  }
  return map;
}

/**
 * Cheap DB-only re-match of `github_installations.linkedUserId` for one org
 * — re-derives `loadLinkedUserLoginMap` and updates any row whose
 * `linkedUserId` disagrees with the fresh match. No GitHub API round trip
 * (unlike `discoverInstallations`, which re-fetches installations too);
 * this is what Task 6's user-connect callback calls after saving a new
 * user `github` credential, so a fresh `login` gets matched against
 * already-known installations without paying for a live App JWT + API
 * call on every connect. */
export async function relinkInstallations(deps: Pick<GithubAppDeps, "db">, orgId: string): Promise<void> {
  const [existingRows, linkedByLogin] = await Promise.all([
    deps.db.select().from(githubInstallations).where(eq(githubInstallations.orgId, orgId)),
    loadLinkedUserLoginMap(deps.db),
  ]);
  const nowMs = Date.now();
  for (const row of existingRows) {
    const linkedUserId = linkedByLogin.get(row.accountLogin.toLowerCase()) ?? null;
    if (linkedUserId === row.linkedUserId) continue;
    await deps.db
      .update(githubInstallations)
      .set({ linkedUserId, updatedAt: nowMs })
      .where(eq(githubInstallations.id, row.id));
  }
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
async function fetchAllInstallations(deps: GithubAppDeps, jwt: string): Promise<ParsedInstallation[]> {
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

  return installations;
}

/** Discovers the org's GitHub App installations via `GET /app/installations`
 * (App JWT auth, paginated — see `fetchAllInstallations`), upserts
 * `github_installations` by `(orgId, installationId)`, deletes rows absent
 * from the response, and sets `linkedUserId` for installations whose account
 * login matches a connected user's GitHub login. Returns the org's
 * installation rows (post-sync). `[]` when no app is configured for the
 * org. */
export async function discoverInstallations(deps: GithubAppDeps, orgId: string): Promise<GithubInstallationRow[]> {
  const config = await loadAppConfig(deps, orgId);
  if (!config) return [];

  const jwt = mintAppJwt(config);
  const installations = await fetchAllInstallations(deps, jwt);

  const [existingRows, linkedByLogin] = await Promise.all([
    deps.db.select().from(githubInstallations).where(eq(githubInstallations.orgId, orgId)),
    loadLinkedUserLoginMap(deps.db),
  ]);
  const existingByInstallationId = new Map(existingRows.map((row) => [row.installationId, row]));

  const nowMs = (deps.now ?? Date.now)();
  const seenIds = new Set<number>();
  const rows: GithubInstallationRow[] = [];

  for (const inst of installations) {
    seenIds.add(inst.installationId);
    const existing = existingByInstallationId.get(inst.installationId);
    const id = existing?.id ?? `ghi_${randomUUID()}`;
    const linkedUserId = linkedByLogin.get(inst.accountLogin.toLowerCase()) ?? null;

    const [row] = await deps.db
      .insert(githubInstallations)
      .values({
        id,
        orgId,
        installationId: inst.installationId,
        accountLogin: inst.accountLogin,
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
    if (!seenIds.has(row.installationId)) {
      await deps.db.delete(githubInstallations).where(eq(githubInstallations.id, row.id));
    }
  }

  return rows;
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
 * non-suspended installation for `(orgId, accountLogin)` (case-insensitive);
 * returns `null` when there is none. Returns the cached token when it has
 * more than 5 minutes left before expiry; otherwise mints a fresh one via
 * `POST /app/installations/{id}/access_tokens`, caches it (encrypted) on
 * the row, and returns it. Never call the GitHub mint endpoint from
 * anywhere else. */
export async function mintInstallationToken(
  deps: GithubAppDeps,
  orgId: string,
  accountLogin: string,
): Promise<string | null> {
  const nowMs = (deps.now ?? Date.now)();

  const rows = await deps.db
    .select()
    .from(githubInstallations)
    .where(
      and(
        eq(githubInstallations.orgId, orgId),
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
