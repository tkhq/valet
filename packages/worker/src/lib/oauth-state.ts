/**
 * OAuth state token helpers (HMAC-SHA256, no external deps).
 *
 * Thin domain-typed wrappers around the base64url-JWT primitives in `./jwt.ts`.
 * Where the SandboxJWTPayload shape used by signJWT/verifyJWT is tied to
 * sandbox/session semantics (sub=userId, sid=sessionId), this module signs
 * arbitrary state for per-integration OAuth flows and enforces a matching
 * provider id on verify to prevent cross-provider state confusion (i.e. a
 * state minted for provider A must never validate for provider B).
 *
 * Use this for per-user integration OAuth (e.g. slack-user). The login-side
 * OAuth flow in routes/oauth.ts has its own state envelope and continues to
 * use signJWT/verifyJWT directly — this module is intentionally NOT a
 * drop-in replacement for that.
 */

const encoder = new TextEncoder();

function base64UrlEncode(data: Uint8Array): string {
  let binary = '';
  for (const byte of data) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(str: string): Uint8Array {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function getKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

export interface OAuthStateClaims {
  /** Arbitrary claims to embed in the state token (e.g. { userId }). */
  [key: string]: unknown;
}

export interface OAuthStatePayload extends OAuthStateClaims {
  /** Provider id the state was minted for (enforced on verify). */
  sub: string;
  /** Random nonce — defends against replay across concurrent flows. */
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
 * @param claims  Additional claims to embed (e.g. `{ userId }`).
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

  const header = { alg: 'HS256', typ: 'JWT' };
  const headerB64 = base64UrlEncode(encoder.encode(JSON.stringify(header)));
  const payloadB64 = base64UrlEncode(encoder.encode(JSON.stringify(payload)));
  const signingInput = `${headerB64}.${payloadB64}`;
  const key = await getKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(signingInput));
  return `${signingInput}.${base64UrlEncode(new Uint8Array(sig))}`;
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
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, sigB64] = parts;
  const signingInput = `${headerB64}.${payloadB64}`;
  const key = await getKey(secret);
  let valid: boolean;
  try {
    valid = await crypto.subtle.verify(
      'HMAC',
      key,
      base64UrlDecode(sigB64),
      encoder.encode(signingInput),
    );
  } catch {
    return null;
  }
  if (!valid) return null;

  let payload: OAuthStatePayload;
  try {
    payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(payloadB64))) as OAuthStatePayload;
  } catch {
    return null;
  }

  if (typeof payload.exp !== 'number' || payload.exp < Math.floor(Date.now() / 1000)) return null;
  if (payload.sub !== provider) return null; // cross-provider state confusion guard
  return payload;
}
