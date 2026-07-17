/**
 * OAuth state token helpers (HMAC-SHA256, no external deps).
 *
 * Thin wrapper on the shared HS256 primitives in `./hmac-jwt.ts`. Where
 * `signJWT`/`verifyJWT` in `./jwt.ts` are pinned to sandbox/session
 * semantics (sub=userId, sid=sessionId), this module signs arbitrary
 * claims for per-integration OAuth flows and pins `sub` to the provider
 * id — a state minted for provider A must never validate for provider B.
 *
 * Use this for per-user integration OAuth (e.g. slack-user). The
 * login-side OAuth flow in `routes/oauth.ts` has its own state envelope
 * and continues to use `signJWT`/`verifyJWT` directly.
 */

import { signHmacJwt, verifyHmacJwt } from './hmac-jwt.js';

export interface OAuthStateClaims {
  /** Arbitrary claims to embed in the state token (e.g. { userId }). */
  [key: string]: unknown;
}

export interface OAuthStatePayload extends OAuthStateClaims {
  /** Provider id the state was minted for (enforced on verify). */
  sub: string;
  /** Random nonce — reserved for future replay defence (persist+consume). */
  jti: string;
  /** Issued-at (unix seconds). */
  iat: number;
  /** Expiry (unix seconds). */
  exp: number;
}

/**
 * Sign an OAuth state token for `provider` with arbitrary `claims`.
 *
 * @param secret HMAC secret (the worker ENCRYPTION_KEY).
 * @param provider Provider id (becomes `sub`; required on verify).
 * @param claims  Additional claims to embed (e.g. `{ userId, nonceHash }`).
 * @param ttlSeconds State lifetime in seconds (default 600 = 10 min).
 */
export async function signOAuthState(
  secret: string,
  provider: string,
  claims: OAuthStateClaims,
  ttlSeconds: number = 600,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const payload: OAuthStatePayload = {
    ...claims,
    sub: provider,
    jti: crypto.randomUUID(),
    iat: now,
    exp: now + ttlSeconds,
  };
  return signHmacJwt(payload, secret);
}

/**
 * Verify an OAuth state token. Returns the payload on success, or `null` if:
 *   - the token is malformed
 *   - the signature is invalid
 *   - the token is expired
 *   - `sub` does not match the expected `provider` (cross-provider confusion guard)
 */
export async function verifyOAuthState(
  secret: string,
  provider: string,
  token: string,
): Promise<OAuthStatePayload | null> {
  const payload = await verifyHmacJwt<OAuthStatePayload>(token, secret);
  if (!payload) return null;
  if (typeof payload.exp !== 'number' || payload.exp < Math.floor(Date.now() / 1000)) return null;
  if (payload.sub !== provider) return null;
  return payload;
}
