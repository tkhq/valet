/**
 * Sandbox / session JWT signing + verification.
 *
 * Payload shape is pinned to `SandboxJWTPayload` (sub=userId, sid=sessionId).
 * The wire-level primitives (base64url encoding, HMAC-SHA256) live in
 * `./hmac-jwt.ts` and are shared with `./oauth-state.ts`.
 */

import { signHmacJwt, verifyHmacJwt } from './hmac-jwt.js';

const encoder = new TextEncoder();

/**
 * Derive a per-session JWT signing key from the worker's encryption key.
 *
 * The sandbox only needs an HMAC key to verify client JWTs and mint tunnel
 * tokens — it does not need the raw `ENCRYPTION_KEY` (which also unlocks all
 * org credential storage). Deriving a deterministic per-session key via
 * HMAC-SHA256 keeps the sandbox compatible with the existing gateway (same
 * algorithm) while ensuring a compromised sandbox cannot decrypt any stored
 * credentials or forge tokens for other sessions.
 */
export async function deriveSandboxJwtSecret(
  encryptionKey: string,
  sessionId: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(encryptionKey),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(sessionId));
  return [...new Uint8Array(sig)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export interface SandboxJWTPayload {
  sub: string; // userId
  sid: string; // sessionId
  exp: number; // expiry (unix seconds)
  iat: number; // issued at (unix seconds)
}

/**
 * Claims used by browser-facing authentication callbacks.
 *
 * The base session claims remain mandatory, while the optional fields carry
 * provider-specific login state without weakening the JWT helper's type safety.
 */
export interface AuthStatePayload extends SandboxJWTPayload {
  invite_code?: string;
  purpose?: 'github-link';
  return_to_origin?: string;
}

/** Validate optional claims used by browser-facing authentication callbacks. */
export function isAuthStatePayload(payload: SandboxJWTPayload): payload is AuthStatePayload {
  const state = payload as AuthStatePayload;
  return (
    (state.invite_code === undefined || typeof state.invite_code === 'string') &&
    (state.purpose === undefined || state.purpose === 'github-link') &&
    (state.return_to_origin === undefined || typeof state.return_to_origin === 'string')
  );
}

/** Sign a sandbox or authentication-state JWT with HMAC-SHA256. */
export async function signJWT<T extends SandboxJWTPayload>(payload: T, secret: string): Promise<string> {
  return signHmacJwt(payload, secret);
}

/**
 * Verify and decode a JWT signed with HMAC-SHA256. Returns null if the
 * signature is invalid, the token is malformed, or `exp` has passed.
 */
export async function verifyJWT<T extends SandboxJWTPayload = SandboxJWTPayload>(
  token: string,
  secret: string,
): Promise<T | null> {
  const payload = await verifyHmacJwt<T>(token, secret);
  if (!payload) return null;
  if (
    typeof payload.sub !== 'string' ||
    typeof payload.sid !== 'string' ||
    typeof payload.iat !== 'number' ||
    typeof payload.exp !== 'number'
  ) {
    return null;
  }
  if (payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}
