import { type OAuthConfig, refreshTokenPkce, refreshTokenWithClientCredentials } from '@valet/sdk';
import { type Env, getEnvString } from '../env.js';
import { encryptStringPBKDF2, decryptStringPBKDF2 } from '../lib/crypto.js';
import * as credentialDb from '../lib/db/credentials.js';
import * as mcpOAuthDb from '../lib/db/mcp-oauth.js';
import { getDb } from '../lib/drizzle.js';
import { log } from '../lib/log.js';
import { integrationRegistry } from '../integrations/registry.js';
import { getCustomMcpOAuthConfig, getCustomMcpOAuthConnector } from './custom-mcp-connectors.js';
import { createSafeFetchOutbound } from './safe-fetch-outbound.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export type CredentialType = 'oauth2' | 'api_key' | 'bot_token' | 'service_account' | 'app_install';

export interface ResolvedCredential {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: Date;
  scopes?: string[];
  credentialType: CredentialType;
  refreshed: boolean;
  /** Present when this credential is a bot token being used on behalf of a user. */
  attribution?: { name: string; email: string };
}

export interface CredentialResolutionError {
  service: string;
  reason: 'not_found' | 'expired' | 'refresh_failed' | 'decryption_failed' | 'revoked';
  message: string;
}

export type CredentialResult =
  | { ok: true; credential: ResolvedCredential }
  | { ok: false; error: CredentialResolutionError };

/**
 * Build the `credentials` object that action handlers receive, given a
 * successfully-resolved credential. Actions read the token under
 * different keys depending on the credential type (`bot_token` for
 * Slack-style bot tokens, `access_token` for OAuth / API key / etc.),
 * so the mapping has to honour `credentialType` — every call site that
 * bridges the resolver output to an action must go through this helper.
 */
export function buildActionCredentials(
  credResult: CredentialResult & { ok: true },
): Record<string, string> {
  const cred = credResult.credential;
  const credentials: Record<string, string> = cred.credentialType === 'bot_token'
    ? { bot_token: cred.accessToken }
    : { access_token: cred.accessToken };
  if (cred.refreshToken) credentials.refresh_token = cred.refreshToken;
  if (cred.credentialType) credentials._credential_type = cred.credentialType;
  return credentials;
}

// ─── Internal Helpers ───────────────────────────────────────────────────────

interface CredentialData {
  access_token?: string;
  refresh_token?: string;
  api_key?: string;
  bot_token?: string;
  token?: string;
  [key: string]: unknown;
}

async function encryptCredentialData(data: Record<string, unknown>, secret: string): Promise<string> {
  return encryptStringPBKDF2(JSON.stringify(data), secret);
}

async function decryptCredentialData(encrypted: string, secret: string): Promise<CredentialData> {
  const json = await decryptStringPBKDF2(encrypted, secret);
  return JSON.parse(json) as CredentialData;
}

function extractAccessToken(data: CredentialData): string | undefined {
  return data.access_token || data.api_key || data.bot_token || data.token;
}

/** Refreshes fire this long before the real expiry so a token can't die mid-request. */
const EXPIRY_BUFFER_MS = 60_000;

function isExpiringSoon(expiresAt: string | null | undefined): boolean {
  if (!expiresAt) return false;
  const ts = new Date(expiresAt).getTime();
  if (Number.isNaN(ts)) return false;
  return ts - Date.now() < EXPIRY_BUFFER_MS;
}

/**
 * The credential type a provider's refreshable row is stored under. Every
 * refresh path writes 'oauth2', and for GitHub that filter is load-bearing
 * rather than cosmetic, so re-reads have to apply the same one `getCredential`
 * does or they may match a different row than the one being refreshed.
 */
function credentialTypeFilter(provider: string): string | undefined {
  return provider === 'github' ? 'oauth2' : undefined;
}

/**
 * Pull an expiry out of whatever a provider's refresh handler returned.
 * `IntegrationCredentials` is an untyped string bag, so providers report expiry
 * either as an `expires_at` timestamp or an `expires_in` lifetime in seconds.
 */
function resolveRefreshedExpiry(creds: Record<string, string>): string | undefined {
  if (creds.expires_at) {
    const at = new Date(creds.expires_at);
    if (!Number.isNaN(at.getTime())) return at.toISOString();
  }
  if (creds.expires_in) {
    const seconds = Number(creds.expires_in);
    if (Number.isFinite(seconds) && seconds > 0) {
      return new Date(Date.now() + seconds * 1000).toISOString();
    }
  }
  return undefined;
}

/**
 * Build a "somebody else rotated it" success result from a freshly read row and
 * its already-decrypted data. Returns null when the stored pair is not actually
 * usable (missing access token, or already expiring), so the caller falls back
 * to its own outcome.
 */
function rotatedResultFromRow(
  row: credentialDb.CredentialRow,
  data: CredentialData,
): CredentialResult | null {
  const accessToken = extractAccessToken(data);
  if (!accessToken || isExpiringSoon(row.expiresAt)) return null;

  return {
    ok: true,
    credential: {
      accessToken,
      refreshToken: data.refresh_token,
      expiresAt: row.expiresAt ? new Date(row.expiresAt) : undefined,
      scopes: row.scopes?.split(' ') ?? undefined,
      credentialType: row.credentialType as CredentialType,
      // Reported as refreshed because it is: the caller asked for a token newer
      // than the one it held and is getting exactly that, just rotated by
      // somebody else. The refresh cron counts this flag to tell a working
      // sweep from a failing one, so a race it benefits from must not read as
      // a failure.
      refreshed: true,
    },
  };
}

/**
 * Decide whether a caught refresh error is GitHub telling us the refresh token
 * itself is invalid, as opposed to a transient transport failure.
 *
 * The OAuth refresh endpoint surfaces a dead token as a 400 whose message
 * carries the error code (`bad_refresh_token` / `invalid_grant`); a 5xx, a 429
 * or a thrown network error is transient and the stored credential may still be
 * good. Only the former justifies dropping the row, and an unrecognised failure
 * is treated as transient so a valid credential is never deleted on a guess.
 */
function isDefinitiveRefreshFailure(err: unknown): boolean {
  const status = (err as { status?: unknown } | null | undefined)?.status;
  if (typeof status === 'number' && (status >= 500 || status === 429)) return false;
  const message = err instanceof Error ? err.message : String(err ?? '');
  // The OAuth refresh error codes are definitive wherever they surface —
  // providers rethrow them in plain Errors with no HTTP status attached, and
  // the strings do not occur in network-level failures.
  if (/invalid_grant|bad_refresh_token|bad_verification_code/i.test(message)) return true;
  // The generic phrases are only trustworthy on a real HTTP response. A thrown
  // network error carries no status, and "unauthorized" appearing in its
  // message must not delete a credential that may still be good.
  if (typeof status !== 'number') return false;
  return /unauthorized|bad credentials/i.test(message);
}

/**
 * Re-read the stored credential and report whether somebody else has already
 * rotated it away from the refresh token this caller set out to spend.
 *
 * GitHub and most MCP providers issue single-use refresh tokens, so two callers
 * that read the same row end up racing to spend the same token: one wins and
 * writes a fresh pair, and the other is told its token was already consumed.
 * The loser must not read that as a broken connection, because the row it would
 * report on — or delete — now holds the winner's working credential. Comparing
 * what is stored against what we spent separates the two cases. A different
 * token means somebody refreshed underneath us and their credential is the
 * right answer to return; an unchanged token means nothing moved and the
 * failure is real.
 *
 * Returns null when the caller should treat its own outcome as authoritative.
 */
async function readRotatedCredential(
  env: Env,
  ownerType: string,
  ownerId: string,
  provider: string,
  refreshedFrom: string | undefined,
): Promise<CredentialResult | null> {
  if (!refreshedFrom) return null;

  const db = getDb(env.DB);
  let row: credentialDb.CredentialRow | null;
  try {
    row = await credentialDb.getCredentialRow(
      db,
      ownerType,
      ownerId,
      provider,
      credentialTypeFilter(provider),
    );
  } catch {
    // A failed re-read cannot prove anything moved, so degrade to "not rotated"
    // rather than throwing out of the refresh path.
    return null;
  }
  if (!row) return null;

  let data: CredentialData;
  try {
    data = await decryptCredentialData(row.encryptedData, env.ENCRYPTION_KEY);
  } catch {
    return null;
  }

  if (data.refresh_token === refreshedFrom) return null;

  return rotatedResultFromRow(row, data);
}

// ─── Google OAuth Refresh ───────────────────────────────────────────────────

async function refreshGoogleToken(
  env: Env,
  ownerType: string,
  ownerId: string,
  provider: string,
  data: CredentialData,
): Promise<CredentialResult> {
  if (!data.refresh_token) {
    return {
      ok: false,
      error: { service: provider, reason: 'refresh_failed', message: 'No refresh token available' },
    };
  }

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: data.refresh_token,
      grant_type: 'refresh_token',
    }),
  });

  if (!res.ok) {
    return {
      ok: false,
      error: { service: provider, reason: 'refresh_failed', message: `Google refresh failed: ${res.status}` },
    };
  }

  const refreshed = (await res.json()) as {
    access_token: string;
    expires_in: number;
    token_type: string;
  };

  const newData: CredentialData = {
    access_token: refreshed.access_token,
    refresh_token: data.refresh_token, // refresh token doesn't change
  };

  const expiresAt = new Date(Date.now() + refreshed.expires_in * 1000).toISOString();
  const encrypted = await encryptCredentialData(newData, env.ENCRYPTION_KEY);

  const db = getDb(env.DB);
  await credentialDb.upsertCredential(db, {
    id: crypto.randomUUID(),
    ownerType,
    ownerId,
    provider,
    credentialType: 'oauth2',
    encryptedData: encrypted,
    expiresAt,
  });

  return {
    ok: true,
    credential: {
      accessToken: refreshed.access_token,
      refreshToken: data.refresh_token,
      expiresAt: new Date(expiresAt),
      credentialType: 'oauth2',
      refreshed: true,
    },
  };
}

// ─── GitHub OAuth Refresh ───────────────────────────────────────────────────

async function refreshGitHubToken(
  env: Env,
  ownerType: string,
  ownerId: string,
  provider: string,
  data: CredentialData,
): Promise<CredentialResult> {
  if (!data.refresh_token) {
    return {
      ok: false,
      error: { service: provider, reason: 'refresh_failed', message: 'No refresh token available' },
    };
  }

  // Dynamic import to avoid circular dependency: credentials.ts → github-app.ts → credentials.ts
  const { loadGitHubApp } = await import('./github-app.js');
  const db = getDb(env.DB);
  const app = await loadGitHubApp(env, db);
  if (!app) {
    return {
      ok: false,
      error: { service: provider, reason: 'refresh_failed', message: 'GitHub App not configured' },
    };
  }

  try {
    const { authentication } = await app.oauth.refreshToken({
      refreshToken: data.refresh_token as string,
    });

    const newData: CredentialData = {
      access_token: authentication.token,
      refresh_token: authentication.refreshToken,
    };
    const expiresAt = authentication.expiresAt;
    const encrypted = await encryptCredentialData(newData, env.ENCRYPTION_KEY);

    await credentialDb.upsertCredential(db, {
      id: crypto.randomUUID(),
      ownerType,
      ownerId,
      provider,
      credentialType: 'oauth2',
      encryptedData: encrypted,
      expiresAt,
    });

    return {
      ok: true,
      credential: {
        accessToken: authentication.token,
        refreshToken: authentication.refreshToken,
        expiresAt: expiresAt ? new Date(expiresAt) : undefined,
        credentialType: 'oauth2',
        refreshed: true,
      },
    };
  } catch (err) {
    // Losing a race to spend a single-use refresh token lands here just like a
    // genuinely dead connection does. Re-read the row once and let that single
    // snapshot drive both decisions: hand back the winner's credential if the
    // token rotated underneath us, and delete only when the row still holds the
    // exact token we tried to spend AND GitHub says that token is invalid. A
    // transient 5xx or network error leaves the row intact so a later attempt
    // can still use it.
    let currentRow: credentialDb.CredentialRow | null = null;
    try {
      currentRow = await credentialDb.getCredentialRow(db, ownerType, ownerId, provider, 'oauth2');
    } catch {
      currentRow = null;
    }

    let currentData: CredentialData | null = null;
    if (currentRow) {
      try {
        currentData = await decryptCredentialData(currentRow.encryptedData, env.ENCRYPTION_KEY);
      } catch {
        currentData = null;
      }
    }

    if (currentRow && currentData && currentData.refresh_token !== data.refresh_token) {
      // Somebody rotated the token; their stored pair is the right answer.
      const rotated = rotatedResultFromRow(currentRow, currentData);
      if (rotated) return rotated;
    } else if (currentRow && currentData && isDefinitiveRefreshFailure(err)) {
      // Token unchanged and GitHub says it is invalid, so the refresh token
      // really is spent. Compare-and-delete on the exact blob we just read so a
      // refresh that rotates the token inside this window is never clobbered.
      await credentialDb.deleteCredentialIfDataMatches(
        db,
        ownerType,
        ownerId,
        provider,
        'oauth2',
        currentRow.encryptedData,
      );
    }

    return {
      ok: false,
      error: {
        service: provider,
        reason: 'refresh_failed',
        message: isDefinitiveRefreshFailure(err)
          ? 'GitHub connection expired, please reconnect'
          : 'GitHub token refresh failed, please try again',
      },
    };
  }
}

/** Try to resolve OAuthConfig from the provider's declared env key names. */
function resolveOAuthConfigForProvider(provider: string, env: Env): OAuthConfig | null {
  const prov = integrationRegistry.getProvider(provider);
  const keys = prov?.oauthEnvKeys;
  if (!keys) return null;
  const clientId = getEnvString(env, keys.clientId);
  const clientSecret = getEnvString(env, keys.clientSecret);
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

async function attemptRefresh(
  env: Env,
  ownerType: string,
  ownerId: string,
  provider: string,
  data: CredentialData,
): Promise<CredentialResult> {
  // Hardcoded paths for providers that existed before the generic mechanism
  switch (provider) {
    case 'google':
    case 'gmail':
    case 'google_calendar':
      return refreshGoogleToken(env, ownerType, ownerId, provider, data);
    case 'github':
      return refreshGitHubToken(env, ownerType, ownerId, provider, data);
  }

  // Generic path: use the provider's refreshOAuthTokens if available
  if (!data.refresh_token) {
    return {
      ok: false,
      error: { service: provider, reason: 'refresh_failed', message: 'No refresh token available' },
    };
  }

  // MCP OAuth path: use PKCE refresh with dynamically registered client
  const integrationProvider = integrationRegistry.getProvider(provider);
  if (integrationProvider?.mcpServerUrl) {
    const db = getDb(env.DB);
    const client = await mcpOAuthDb.getMcpOAuthClient(db, provider);
    if (client) {
      try {
        const tokens = await refreshTokenPkce({
          tokenEndpoint: client.tokenEndpoint,
          clientId: client.clientId,
          refreshToken: data.refresh_token,
          resource: integrationProvider.mcpServerUrl,
          fetch: createSafeFetchOutbound({ mode: 'oauth-token' }),
        });
        const newData: CredentialData = {
          access_token: tokens.access_token,
          refresh_token: tokens.refresh_token || data.refresh_token,
        };
        const expiresAt = tokens.expires_in
          ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
          : undefined;
        const encrypted = await encryptCredentialData(newData, env.ENCRYPTION_KEY);
        await credentialDb.upsertCredential(db, {
          id: crypto.randomUUID(),
          ownerType,
          ownerId,
          provider,
          credentialType: 'oauth2',
          encryptedData: encrypted,
          expiresAt,
        });
        return {
          ok: true,
          credential: {
            accessToken: tokens.access_token,
            refreshToken: tokens.refresh_token || data.refresh_token,
            expiresAt: expiresAt ? new Date(expiresAt) : undefined,
            credentialType: 'oauth2',
            refreshed: true,
          },
        };
      } catch (err) {
        return {
          ok: false,
          error: {
            service: provider,
            reason: 'refresh_failed',
            message: `MCP PKCE refresh failed: ${err instanceof Error ? err.message : String(err)}`,
          },
        };
      }
    }
  }

  const db = getDb(env.DB);
  const customOAuthConnector = await getCustomMcpOAuthConnector(env, db, provider, 'default');
  if (customOAuthConnector && !customOAuthConnector.oauthClientId) {
    const client = await mcpOAuthDb.getMcpOAuthClient(db, provider);
    if (client) {
      try {
        const tokens = await refreshTokenPkce({
          tokenEndpoint: client.tokenEndpoint,
          clientId: client.clientId,
          refreshToken: data.refresh_token,
          resource: customOAuthConnector.serverUrl,
          fetch: createSafeFetchOutbound({ mode: 'oauth-token' }),
        });
        const newData: CredentialData = {
          access_token: tokens.access_token,
          refresh_token: tokens.refresh_token || data.refresh_token,
        };
        const expiresAt = tokens.expires_in
          ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
          : undefined;
        const encrypted = await encryptCredentialData(newData, env.ENCRYPTION_KEY);
        await credentialDb.upsertCredential(db, {
          id: crypto.randomUUID(),
          ownerType,
          ownerId,
          provider,
          credentialType: 'oauth2',
          encryptedData: encrypted,
          expiresAt,
        });
        return {
          ok: true,
          credential: {
            accessToken: tokens.access_token,
            refreshToken: tokens.refresh_token || data.refresh_token,
            expiresAt: expiresAt ? new Date(expiresAt) : undefined,
            credentialType: 'oauth2',
            refreshed: true,
          },
        };
      } catch (err) {
        return {
          ok: false,
          error: {
            service: provider,
            reason: 'refresh_failed',
            message: `Custom MCP PKCE refresh failed: ${err instanceof Error ? err.message : String(err)}`,
          },
        };
      }
    }
  }

  const customOAuth = await getCustomMcpOAuthConfig(env, db, provider, 'default');
  if (customOAuth) {
    try {
      const tokens = await refreshTokenWithClientCredentials({
        tokenEndpoint: customOAuth.tokenEndpoint,
        clientId: customOAuth.clientId,
        clientSecret: customOAuth.clientSecret,
        tokenEndpointAuthMethod: customOAuth.tokenEndpointAuthMethod,
        refreshToken: data.refresh_token,
        resource: customOAuth.serverUrl,
        fetch: createSafeFetchOutbound({ mode: 'oauth-token' }),
      });
      const newData: CredentialData = {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token || data.refresh_token,
      };
      const expiresAt = tokens.expires_in
        ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
        : undefined;
      const encrypted = await encryptCredentialData(newData, env.ENCRYPTION_KEY);
      await credentialDb.upsertCredential(db, {
        id: crypto.randomUUID(),
        ownerType,
        ownerId,
        provider,
        credentialType: 'oauth2',
        encryptedData: encrypted,
        expiresAt,
      });
      return {
        ok: true,
        credential: {
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token || data.refresh_token,
          expiresAt: expiresAt ? new Date(expiresAt) : undefined,
          credentialType: 'oauth2',
          refreshed: true,
        },
      };
    } catch (err) {
      return {
        ok: false,
        error: {
          service: provider,
          reason: 'refresh_failed',
          message: `Custom MCP OAuth refresh failed: ${err instanceof Error ? err.message : String(err)}`,
        },
      };
    }
  }

  if (!integrationProvider?.refreshOAuthTokens) {
    return {
      ok: false,
      error: { service: provider, reason: 'refresh_failed', message: `No refresh handler for ${provider}` },
    };
  }

  const oauthConfig = resolveOAuthConfigForProvider(provider, env);
  if (!oauthConfig) {
    return {
      ok: false,
      error: { service: provider, reason: 'refresh_failed', message: `OAuth env vars missing for ${provider}` },
    };
  }

  try {
    const newCreds = await integrationProvider.refreshOAuthTokens(oauthConfig, data.refresh_token);
    const newData: CredentialData = {
      access_token: newCreds.access_token,
      refresh_token: newCreds.refresh_token || data.refresh_token,
    };

    // Providers report the new token's lifetime and this path used to discard
    // it, which did more than lose a column: the upsert writes expires_at
    // unconditionally, so every refresh nulled it. A credential with no expiry
    // never looks like it is expiring, so nothing refreshed it again and the
    // user was silently logged out once the token died for real.
    const expiresAt = resolveRefreshedExpiry(newCreds);
    const encrypted = await encryptCredentialData(newData, env.ENCRYPTION_KEY);
    await credentialDb.upsertCredential(db, {
      id: crypto.randomUUID(),
      ownerType,
      ownerId,
      provider,
      credentialType: 'oauth2',
      encryptedData: encrypted,
      expiresAt,
    });

    return {
      ok: true,
      credential: {
        accessToken: newCreds.access_token,
        refreshToken: newCreds.refresh_token || data.refresh_token,
        expiresAt: expiresAt ? new Date(expiresAt) : undefined,
        credentialType: 'oauth2',
        refreshed: true,
      },
    };
  } catch (err) {
    return {
      ok: false,
      error: {
        service: provider,
        reason: 'refresh_failed',
        message: `Refresh failed: ${err instanceof Error ? err.message : String(err)}`,
      },
    };
  }
}

// ─── Single-Flight Refresh ──────────────────────────────────────────────────

/**
 * Refreshes currently running, keyed by owner and provider.
 *
 * Resolving a credential is a read, an expiry check, a refresh and a write, and
 * nothing about that sequence is atomic. Concurrent callers for the same user
 * therefore read the same row and each try to spend the same single-use refresh
 * token, which leaves the losers holding an error about a token the winner
 * already replaced. Coalescing the refreshes means the second caller waits for
 * the first instead of racing it, and both get the winner's token.
 *
 * A Worker isolate is not the whole world, so this map is a large reduction in
 * the race rather than a lock: two isolates can still refresh the same
 * credential at once. That residual race is what `readRotatedCredential` is
 * for, and correctness rests on it rather than on this map.
 */
const inflightRefreshes = new Map<string, Promise<CredentialResult>>();

/**
 * Refresh a credential, joining an in-flight refresh for the same owner and
 * provider when one exists.
 */
async function refreshCredential(
  env: Env,
  ownerType: string,
  ownerId: string,
  provider: string,
  data: CredentialData,
): Promise<CredentialResult> {
  const key = `${ownerType}:${ownerId}:${provider}`;
  const inflight = inflightRefreshes.get(key);
  if (inflight) return inflight;

  const attempt = (async (): Promise<CredentialResult> => {
    try {
      // Double-checked read: the credential may have been refreshed between the
      // caller's read and this point — by a holder that has already finished, or
      // by another isolate entirely. Spending our copy of the refresh token now
      // would invalidate the token that replaced it, so return theirs instead.
      const alreadyRotated = await readRotatedCredential(env, ownerType, ownerId, provider, data.refresh_token);
      if (alreadyRotated) return alreadyRotated;

      const result = await attemptRefresh(env, ownerType, ownerId, provider, data);
      if (result.ok) return result;

      // The refresh failed, which is also what losing a cross-isolate race looks
      // like from here. If the stored token has moved on, the credential is fine
      // and only this attempt failed.
      return (await readRotatedCredential(env, ownerType, ownerId, provider, data.refresh_token)) ?? result;
    } catch (err) {
      // A raw throw here — a rejecting fetch inside a provider refresh, for
      // instance — would otherwise propagate to every caller that joined this
      // in-flight attempt. Convert it to the structured failure the callers
      // are written to handle; its status-less message also keeps it out of
      // isDefinitiveRefreshFailure's delete path.
      return {
        ok: false,
        error: {
          service: provider,
          reason: 'refresh_failed',
          message: `Credential refresh threw: ${err instanceof Error ? err.message : String(err)}`,
        },
      };
    }
  })();

  const tracked = attempt.finally(() => {
    inflightRefreshes.delete(key);
  });
  inflightRefreshes.set(key, tracked);
  return tracked;
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Resolve a credential with automatic token refresh.
 *
 * This is the canonical way to get a usable token for any provider. It:
 *   1. Loads the encrypted credential row from D1
 *   2. Decrypts it
 *   3. Checks expiry (60-second buffer before actual expiration)
 *   4. Auto-refreshes if expiring (provider-specific: GitHub App OAuth,
 *      Google OAuth, MCP PKCE, or generic provider refresh)
 *   5. Persists the refreshed token back to D1
 *
 * For GitHub specifically: the stored 'oauth2' credential is a user-to-server
 * token from our GitHub App (NOT a classic OAuth App). These expire after 8h
 * and are refreshed via app.oauth.refreshToken().
 *
 * Callers that need a raw token for sandbox/git operations (e.g. assembleRepoEnv)
 * MUST use this function rather than reading credentials directly from the DB,
 * to ensure expired tokens are refreshed before use.
 */
export async function getCredential(
  env: Env,
  ownerType: string,
  ownerId: string,
  provider: string,
  options?: { forceRefresh?: boolean },
): Promise<CredentialResult> {
  const db = getDb(env.DB);
  // Default to 'oauth2' for GitHub as a safety net — only oauth2 rows exist now.
  const effectiveType = provider === 'github' ? 'oauth2' : undefined;
  const row = await credentialDb.getCredentialRow(db, ownerType, ownerId, provider, effectiveType);
  const result = await getCredentialInner(env, ownerType, ownerId, provider, row, options);

  // Edge-triggered failure logging at the one chokepoint all callers share, so a
  // broken integration (expired/revoked token, failed refresh, undecryptable row)
  // surfaces wherever it bites: tool calls, env assembly, webhooks, DOs. Logs only
  // on state TRANSITIONS — first failure, reason change, recovery — so a stuck
  // credential retried by the refresh cron sweep warns once, not once per pass.
  // 'not_found' is just "never connected" (and has no row to track), so it stays
  // quiet, as before.
  const priorFailure = row?.lastFailureReason ?? null;
  if (!result.ok && result.error.reason !== 'not_found') {
    if (row && priorFailure !== result.error.reason) {
      log.warn('integration auth/refresh failed', {
        service: provider,
        ownerType,
        ownerId,
        reason: result.error.reason,
        detail: result.error.message,
        ...(priorFailure ? { previousReason: priorFailure } : {}),
      });
      // Best-effort bookkeeping: a transient D1 write error must not turn a
      // resolution result into a throw at ~20 call sites. Worst case the state
      // doesn't persist and the next attempt re-warns (at-least-once).
      await credentialDb.setCredentialFailureState(db, row.id, result.error.reason).catch((err) => {
        log.warn('failed to persist credential failure state', { service: provider, error: String(err) });
      });
    }
  } else if (result.ok && row && priorFailure) {
    log.info('integration auth recovered', {
      service: provider,
      ownerType,
      ownerId,
      previousReason: priorFailure,
    });
    await credentialDb.setCredentialFailureState(db, row.id, null).catch((err) => {
      log.warn('failed to persist credential failure state', { service: provider, error: String(err) });
    });
  }
  return result;
}

async function getCredentialInner(
  env: Env,
  ownerType: string,
  ownerId: string,
  provider: string,
  row: credentialDb.CredentialRow | null,
  options?: { forceRefresh?: boolean },
): Promise<CredentialResult> {
  if (!row) {
    return {
      ok: false,
      error: { service: provider, reason: 'not_found', message: `No credentials for ${provider}` },
    };
  }

  let data: CredentialData;
  try {
    data = await decryptCredentialData(row.encryptedData, env.ENCRYPTION_KEY);
  } catch {
    return {
      ok: false,
      error: { service: provider, reason: 'decryption_failed', message: `Failed to decrypt credentials for ${provider}` },
    };
  }

  const expiresSoon = isExpiringSoon(row.expiresAt);

  // Force refresh if requested (e.g. after a 401 from the API indicates the token is invalid)
  if (options?.forceRefresh) {
    if (data.refresh_token) {
      const refreshed = await refreshCredential(env, ownerType, ownerId, provider, data);
      if (refreshed.ok) return refreshed;
    }
    return {
      ok: false,
      error: {
        service: provider,
        reason: expiresSoon ? 'expired' : 'refresh_failed',
        message: data.refresh_token ? 'Force refresh failed' : `Credential for ${provider} cannot be refreshed because it has no refresh token`,
      },
    };
  }

  // Check expiration (with 60-second buffer)
  if (expiresSoon) {
    if (data.refresh_token) {
      return refreshCredential(env, ownerType, ownerId, provider, data);
    }
    return {
      ok: false,
      error: { service: provider, reason: 'expired', message: `Credential for ${provider} has expired and cannot be refreshed` },
    };
  }

  const accessToken = extractAccessToken(data);
  if (!accessToken) {
    return {
      ok: false,
      error: { service: provider, reason: 'decryption_failed', message: `Credential data missing token field for ${provider}` },
    };
  }

  return {
    ok: true,
    credential: {
      accessToken,
      refreshToken: data.refresh_token,
      expiresAt: row.expiresAt ? new Date(row.expiresAt) : undefined,
      scopes: row.scopes?.split(' ') ?? undefined,
      credentialType: row.credentialType as CredentialType,
      refreshed: false,
    },
  };
}

export async function storeCredential(
  env: Env,
  ownerType: string,
  ownerId: string,
  provider: string,
  credentialData: Record<string, string>,
  options?: {
    credentialType?: CredentialType;
    scopes?: string;
    expiresAt?: string;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  const encrypted = await encryptCredentialData(credentialData, env.ENCRYPTION_KEY);
  const db = getDb(env.DB);

  await credentialDb.upsertCredential(db, {
    id: crypto.randomUUID(),
    ownerType,
    ownerId,
    provider,
    credentialType: options?.credentialType ?? 'api_key',
    encryptedData: encrypted,
    metadata: options?.metadata ? JSON.stringify(options.metadata) : undefined,
    scopes: options?.scopes,
    expiresAt: options?.expiresAt,
  });
}

export async function revokeCredential(
  env: Env,
  ownerType: string,
  ownerId: string,
  provider: string,
): Promise<void> {
  const db = getDb(env.DB);
  await credentialDb.deleteCredential(db, ownerType, ownerId, provider);
}

export async function listCredentials(
  env: Env,
  ownerType: string,
  ownerId: string,
): Promise<Array<{
  provider: string;
  credentialType: string;
  scopes?: string;
  expiresAt?: string;
  createdAt: string;
}>> {
  const db = getDb(env.DB);
  const rows = await credentialDb.listCredentialsByOwner(db, ownerType, ownerId);
  return rows.map((row) => ({
    provider: row.provider,
    credentialType: row.credentialType,
    scopes: row.scopes ?? undefined,
    expiresAt: row.expiresAt ?? undefined,
    createdAt: row.createdAt,
  }));
}

export async function resolveCredentials(
  env: Env,
  ownerType: string,
  ownerId: string,
  providers: string[],
): Promise<Map<string, CredentialResult>> {
  const results = new Map<string, CredentialResult>();
  await Promise.all(
    providers.map(async (provider) => {
      results.set(provider, await getCredential(env, ownerType, ownerId, provider));
    }),
  );
  return results;
}

export async function hasCredential(
  env: Env,
  ownerType: string,
  ownerId: string,
  provider: string,
): Promise<boolean> {
  const db = getDb(env.DB);
  return credentialDb.hasCredential(db, ownerType, ownerId, provider);
}

/**
 * Proactively refresh credentials that are expiring soon.
 * Called from the scheduled cron to keep tokens alive even when no user interaction occurs.
 * Returns the number of credentials successfully refreshed.
 */
export async function refreshExpiringCredentials(
  env: Env,
  windowSeconds: number = 15 * 60, // default: refresh anything expiring within 15 minutes
): Promise<{ refreshed: number; failed: number }> {
  const db = getDb(env.DB);
  const expiring = await credentialDb.getExpiringCredentials(db, windowSeconds);
  if (expiring.length === 0) return { refreshed: 0, failed: 0 };

  let refreshed = 0;
  let failed = 0;

  for (const row of expiring) {
    try {
      const result = await getCredential(env, row.ownerType, row.ownerId, row.provider, { forceRefresh: true });
      if (result.ok && result.credential.refreshed) {
        refreshed++;
      } else {
        failed++;
      }
    } catch (err) {
      console.warn(`[CredentialRefresh] Failed to refresh ${row.provider} for ${row.ownerType}:${row.ownerId}:`, err);
      failed++;
    }
  }

  return { refreshed, failed };
}
