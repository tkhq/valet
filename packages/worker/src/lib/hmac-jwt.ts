/**
 * Shared Web Crypto primitives for HS256-signed compact-JWT tokens.
 *
 * Two consumers today:
 *   - lib/jwt.ts       — sandbox/session tokens (sub=userId, sid=sessionId)
 *   - lib/oauth-state.ts — per-integration OAuth state tokens
 *
 * They differ in payload shape and verification semantics, but the wire
 * format (`header.payload.sig` with `alg: HS256`) and the primitives
 * (base64url, HMAC-SHA256) are identical — living here so a fix to the
 * encoding or key handling touches both callers at once.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function base64UrlEncode(data: Uint8Array): string {
  let binary = '';
  for (const byte of data) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64UrlDecode(str: string): Uint8Array {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Import a raw string secret as an HMAC-SHA256 CryptoKey (sign+verify). */
export async function getHmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

/** Sign an arbitrary JSON payload as a compact HS256 JWT. */
export async function signHmacJwt<T extends object>(payload: T, secret: string): Promise<string> {
  const header = { alg: 'HS256', typ: 'JWT' };
  const headerB64 = base64UrlEncode(encoder.encode(JSON.stringify(header)));
  const payloadB64 = base64UrlEncode(encoder.encode(JSON.stringify(payload)));
  const signingInput = `${headerB64}.${payloadB64}`;
  const key = await getHmacKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(signingInput));
  return `${signingInput}.${base64UrlEncode(new Uint8Array(sig))}`;
}

/**
 * Verify a compact HS256 JWT signature and return the decoded payload, or
 * null if the token is malformed / the signature is invalid. Does NOT
 * enforce `exp`, `sub`, or any application-level claim — callers layer
 * that check themselves so this module stays payload-agnostic.
 */
export async function verifyHmacJwt<T = Record<string, unknown>>(
  token: string,
  secret: string,
): Promise<T | null> {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, sigB64] = parts;
  const signingInput = `${headerB64}.${payloadB64}`;
  const key = await getHmacKey(secret);
  try {
    const valid = await crypto.subtle.verify(
      'HMAC',
      key,
      base64UrlDecode(sigB64),
      encoder.encode(signingInput),
    );
    if (!valid) return null;
  } catch {
    return null;
  }
  try {
    return JSON.parse(decoder.decode(base64UrlDecode(payloadB64))) as T;
  } catch {
    return null;
  }
}
