/**
 * CredentialStore decorator: lazily refreshes near-expiry oauth2
 * credentials on read (integration-OAuth design). Refresh routes by the
 * service's manifest declaration — mcp mode via the client that issued the
 * credential's tokens (recorded on its metadata at connect; the stored
 * mcp_oauth_clients row for a credential with no record) +
 * refreshTokenPkce, authorization_code mode
 * via the declaration's tokenUrl + env client id/secret. GitHub never
 * routes through here (its refresh lives in services/github-tokens.ts) —
 * findOAuthDeclaration excludes it. Refresh failure stamps
 * metadata.refreshFailedAt (the health field the credential summary
 * already whitelists) and metadata.refreshError (the provider's redacted
 * refusal text) and returns the stamped credential: the caller gets
 * the provider's own 401, the UI shows the unhealthy badge, and a team read
 * can pass over the row on the same read (`isDeadConnection`).
 *
 * A failed refresh is not retried on every read. A refused row (400 or 401)
 * is never retried: only a reconnect, which replaces the row, revives it.
 * Any other failure (429, 5xx, network) waits `RETRY_AFTER_FAILURE_MS`.
 * A 429 also holds every refresh for that service, on every account, for the
 * response's `Retry-After` or `RATE_LIMIT_HOLD_MS`: a provider that limits
 * token requests limits the whole client, so one account's retry renews the
 * lockout for all. Without these waits, each read of an expired credential
 * made another token request, and Metabase locked every connection out.
 */
import { eq } from "drizzle-orm";
import type { CredentialOwner, CredentialStore, StoredCredential, ValetPlugin } from "@valet/engine";
import { OAuthTokenError, refreshTokenPkce, type TokenResponse } from "@valet/sdk";
import type { AppQueryable } from "../lib/drizzle.js";
import { mcpOauthClients } from "../schema/index.js";
import {
  findOAuthDeclaration,
  type IssuingClient,
  issuingClientMetadata,
  readIssuingClient,
  refreshAuthorizationCodeToken,
} from "../services/integration-oauth.js";
import { reportError } from "@valet/engine";

const REFRESH_BUFFER_MS = 60_000;
/** After a failed refresh, reads return the stored row without calling the
 * provider until this window passes. */
export const RETRY_AFTER_FAILURE_MS = 5 * 60 * 1000;
/** After a 429 with no `Retry-After`, how long no account refreshes that
 * service. Metabase answered with hour-long lockouts. */
export const RATE_LIMIT_HOLD_MS = 60 * 60 * 1000;
/** The longest `Retry-After` the hold obeys. */
const RATE_LIMIT_HOLD_MAX_MS = 6 * 60 * 60 * 1000;
/** The longest refusal text kept on a credential. */
const REFRESH_ERROR_MAX = 300;
/** The shortest cut-off start of a secret that is still masked. */
const SECRET_PREFIX_MIN = 8;
/** A token field and its value: `refresh_token=x`, `"access_token": "x`,
 * `client_secret=\"x\"`. The value may have no closing quote, because the
 * upstream error keeps only the first 200 characters of the body. */
const TOKEN_FIELD = /(\b(?:refresh_token|access_token|id_token|client_secret)(?:\\?["'])?\s*[:=]\s*(?:\\?["'])?)(?:\\.|[^\s"'\\&,;}])*/gi;
/** An authorization code, in form shape only: prose such as "error code: 400" stays. */
const CODE_FIELD = /\b(code=)[^\s"'\\&,;}]*/gi;

/** The forms a provider may echo a secret in: raw, JSON-escaped (with and
 * without `\/`), and URL-encoded. Longest first, so no form masks part of
 * another. */
function secretForms(secret: string): string[] {
  const json = JSON.stringify(secret).slice(1, -1);
  const forms = new Set([secret, json, json.replace(/\//g, "\\/"), encodeURIComponent(secret), new URLSearchParams({ v: secret }).toString().slice(2)]);
  return [...forms].sort((a, b) => b.length - a.length);
}

/** Masks every form of `secret` wherever it appears, and a cut-off start of a
 * form at the end of the text, where the upstream 200-character cap can split it. */
function maskSecret(text: string, secret: string): string {
  const forms = secretForms(secret);
  let masked = text;
  for (const form of forms) masked = masked.split(form).join("[redacted]");
  for (const form of forms) {
    for (let k = Math.min(form.length - 1, masked.length); k >= SECRET_PREFIX_MIN; k--) {
      if (masked.endsWith(form.slice(0, k))) return `${masked.slice(0, -k)}[redacted]`;
    }
  }
  return masked;
}

/**
 * The provider's refusal, safe to store on the credential and to log. It masks
 * the credential's tokens and the app's client secret, and any token field's
 * value, because a provider may echo the request: Greenhouse answers a
 * malformed refresh token with that token in its message.
 */
export function refreshErrorText(err: unknown, secrets: Array<string | undefined>): string {
  let text = err instanceof Error ? err.message : String(err);
  for (const secret of secrets) {
    if (secret) text = maskSecret(text, secret);
  }
  text = text.replace(TOKEN_FIELD, "$1[redacted]").replace(CODE_FIELD, "$1[redacted]");
  return text.length > REFRESH_ERROR_MAX ? `${text.slice(0, REFRESH_ERROR_MAX)}…` : text;
}

/** True when an earlier failure means this read must not call the provider. */
function refreshOnHold(stored: StoredCredential, now: number): boolean {
  if (stored.metadata?.refreshRefused === true) return true;
  const failedAt = stored.metadata?.refreshFailedAt;
  return typeof failedAt === "number" && now - failedAt < RETRY_AFTER_FAILURE_MS;
}

interface Deps {
  db: AppQueryable;
  plugins: ValetPlugin[];
  env: Record<string, string | undefined>;
  now?: () => number;
}

export class OAuthRefreshingCredentialStore implements CredentialStore {
  private readonly inFlightRefreshes = new Map<string, Promise<StoredCredential | null>>();
  /** Service -> time before which no account refreshes it (after a 429). */
  private readonly rateLimitedUntil = new Map<string, number>();

  constructor(
    private readonly inner: CredentialStore,
    private readonly deps: Deps,
  ) {}

  async get(owner: CredentialOwner, service: string): Promise<StoredCredential | null> {
    const stored = await this.inner.get(owner, service);
    if (!stored) return null;
    if (stored.type !== "oauth2" || !stored.refreshToken || stored.expiresAt === undefined) return stored;
    const now = (this.deps.now ?? Date.now)();
    if (stored.expiresAt - now >= REFRESH_BUFFER_MS) return stored;
    if (refreshOnHold(stored, now) || (this.rateLimitedUntil.get(service) ?? 0) > now) return stored;
    const found = findOAuthDeclaration(this.deps.plugins, service);
    if (!found) return stored;

    const key = `${owner.type}:${owner.id}:${service}`;
    const existing = this.inFlightRefreshes.get(key);
    if (existing) return existing;

    const refreshPromise = this.doRefresh(owner, service, now).finally(() => {
      this.inFlightRefreshes.delete(key);
    });
    this.inFlightRefreshes.set(key, refreshPromise);
    return refreshPromise;
  }

  private async doRefresh(owner: CredentialOwner, service: string, now: number): Promise<StoredCredential | null> {
    // Re-read + re-check: another caller may have already refreshed (or the
    // credential may have changed) while we were queued behind the map lookup.
    const stored = await this.inner.get(owner, service);
    if (!stored) return null;
    if (stored.type !== "oauth2" || !stored.refreshToken || stored.expiresAt === undefined) return stored;
    if (stored.expiresAt - now >= REFRESH_BUFFER_MS) return stored;
    if (refreshOnHold(stored, now) || (this.rateLimitedUntil.get(service) ?? 0) > now) return stored;
    const found = findOAuthDeclaration(this.deps.plugins, service);
    if (!found) return stored;

    let tokens: TokenResponse;
    // The client this refresh used, when the credential had no record of it.
    // A good refresh proves that client issued the tokens, so it is recorded.
    let adopted: IssuingClient | undefined;
    try {
      if (found.oauth.mode === "mcp") {
        // A refresh token belongs to the client it was issued to. The stored
        // client changes when the declared scopes change, so a credential
        // refreshes with the client it recorded at connect.
        let client = readIssuingClient(stored.metadata);
        if (!client) {
          const rows = await this.deps.db.select().from(mcpOauthClients).where(eq(mcpOauthClients.service, service));
          if (!rows[0]) throw new Error(`no registered MCP client for ${service}`);
          client = { clientId: rows[0].clientId, tokenEndpoint: rows[0].tokenEndpoint };
          adopted = client;
        }
        tokens = await refreshTokenPkce({
          tokenEndpoint: client.tokenEndpoint,
          clientId: client.clientId,
          refreshToken: stored.refreshToken,
        });
      } else {
        tokens = await refreshAuthorizationCodeToken({
          oauth: found.oauth,
          env: this.deps.env,
          refreshToken: stored.refreshToken,
        });
      }
    } catch (err) {
      // The provider's own words name the cause (expired, revoked, already
      // used), so the credential keeps them for the Integrations page.
      // Only a token endpoint's answer is the provider's reply. Its body can
      // echo the request, and an authorization_code refresh sends the app's
      // client secret, so the stored and logged text is masked. Any other
      // error (DNS, TLS, missing config) is logged whole with its cause.
      const clientSecret = found.oauth.mode === "mcp" ? undefined : this.deps.env[found.oauth.clientSecretEnv];
      const reason = err instanceof OAuthTokenError
        ? refreshErrorText(err, [stored.refreshToken, stored.accessToken, clientSecret])
        : undefined;
      if (reason !== undefined) reportError({ area: "plugins", reason: "credential_refresh", provider: service }, `credential refresh failed for ${service}: ${reason}`);
      else reportError({ area: "plugins", reason: "credential_refresh", provider: service }, `credential refresh failed for ${service}`, err);
      // Only the provider refusing the grant (400 or 401) makes the row dead
      // (`isDeadConnection`). A 5xx, a 429, or a network error stamps the
      // failure, and a read after `RETRY_AFTER_FAILURE_MS` tries again.
      const refused = err instanceof OAuthTokenError && (err.status === 400 || err.status === 401);
      if (err instanceof OAuthTokenError && err.status === 429) {
        const hold = Math.min(err.retryAfterMs ?? RATE_LIMIT_HOLD_MS, RATE_LIMIT_HOLD_MAX_MS);
        this.rateLimitedUntil.set(service, now + hold);
      }
      const stamped: StoredCredential = {
        ...stored,
        metadata: {
          ...stored.metadata, refreshFailedAt: now,
          ...(reason !== undefined ? { refreshError: reason } : {}),
          ...(refused ? { refreshRefused: true } : {}),
        },
      };
      return this.saveIfUnchanged(owner, service, stored, stamped);
    }

    const { refreshFailedAt: _cleared, refreshRefused: _refused, refreshError: _error, ...restMetadata } = stored.metadata ?? {};
    const fresh: StoredCredential = {
      ...stored,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token ?? stored.refreshToken,
      expiresAt: typeof tokens.expires_in === "number" ? now + tokens.expires_in * 1000 : undefined,
      metadata: adopted
        ? { ...restMetadata, ...issuingClientMetadata(adopted) }
        : Object.keys(restMetadata).length > 0 ? restMetadata : undefined,
    };
    return this.saveIfUnchanged(owner, service, stored, fresh);
  }

  /** Keep a reconnect or deletion that commits while the refresh is in flight. */
  private async saveIfUnchanged(
    owner: CredentialOwner, service: string, expected: StoredCredential, next: StoredCredential,
  ): Promise<StoredCredential | null> {
    if (await this.inner.compareAndSwap(owner, service, expected, next)) return next;
    return this.inner.get(owner, service);
  }

  save(owner: CredentialOwner, service: string, credential: StoredCredential): Promise<void> {
    return this.inner.save(owner, service, credential);
  }
  compareAndSwap(owner: CredentialOwner, service: string, expected: StoredCredential, next: StoredCredential): Promise<boolean> {
    return this.inner.compareAndSwap(owner, service, expected, next);
  }
  delete(owner: CredentialOwner, service: string): Promise<void> {
    return this.inner.delete(owner, service);
  }
  list(owner: CredentialOwner): Promise<{ service: string; scopes?: string[]; connectedAt: string }[]> {
    return this.inner.list(owner);
  }
}
