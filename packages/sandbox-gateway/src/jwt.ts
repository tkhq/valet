/**
 * Verification for the per-session sandbox gateway JWT.
 *
 * Contract (mirrors `packages/api/src/auth/sandbox-tokens.ts`'s
 * `verifySandboxJwt`, verbatim, plus an additional `sid === expectedSid`
 * gate): the token is signed with `deriveSandboxJwtSecret(master, sessionId)`
 * — an HS256 JWT `{ sub, sid, iat, exp }`, base64url-encoded, `exp` in unix
 * seconds. This module only verifies; it never mints (minting is the API's
 * job, via `mintSandboxJwt`).
 */
import { createHmac, timingSafeEqual } from "node:crypto";

interface GatewayJwtPayload {
  sub?: string;
  sid?: string;
  exp?: number;
}

function sign(signingInput: string, secret: string): Buffer {
  return createHmac("sha256", secret).update(signingInput).digest();
}

/**
 * Verifies signature, expiry, and session binding of a gateway JWT.
 * Returns `{ sub, sid }` on success, `null` on any failure (malformed, bad
 * signature, expired, or `sid` not matching `expectedSid`).
 */
export function verifyGatewayJwt(
  secret: string,
  token: string,
  expectedSid: string,
): { sub: string; sid: string } | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, signatureB64] = parts;
  const signingInput = `${headerB64}.${payloadB64}`;

  const expectedSignature = sign(signingInput, secret);
  let actualSignature: Buffer;
  try {
    actualSignature = Buffer.from(signatureB64, "base64url");
  } catch {
    return null;
  }
  if (expectedSignature.length !== actualSignature.length) return null;
  if (!timingSafeEqual(expectedSignature, actualSignature)) return null;

  let payload: GatewayJwtPayload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8")) as GatewayJwtPayload;
  } catch {
    return null;
  }

  if (typeof payload.sub !== "string" || typeof payload.sid !== "string") return null;
  if (typeof payload.exp !== "number" || payload.exp <= Math.floor(Date.now() / 1000)) return null;
  if (payload.sid !== expectedSid) return null;

  return { sub: payload.sub, sid: payload.sid };
}
