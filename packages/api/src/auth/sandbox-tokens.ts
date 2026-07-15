/**
 * Sandbox tokens — long-lived (default 24h) bearer tokens minted for a
 * session's sandbox to call back into the API. A token is `"st_" +
 * randomBytes(24).toString("hex")` (48 hex chars); only its sha256 hex
 * digest is ever persisted (`sandbox_tokens.token_hash`). The plaintext
 * token is returned to the caller exactly once, at mint time.
 *
 * Also hosts the per-session service-JWT primitives used for short-lived
 * (default 10 min) sandbox-internal auth: a per-session HMAC secret derived
 * from a master key via `deriveSandboxJwtSecret`, and a minimal HS256 JWT
 * sign/verify pair ported from v1's `packages/worker/src/lib/jwt.ts`.
 */
import { randomBytes, randomUUID, createHash, createHmac, timingSafeEqual } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import type { AppDb } from "../lib/drizzle.js";
import { sandboxTokens } from "../schema/index.js";

const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const JWT_TTL_MS = 10 * 60 * 1000;

export interface SandboxPrincipal {
  sessionId: string;
  userId: string;
  orgId: string;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Mints a new sandbox token for a session, revoking any prior live tokens
 * for that session. Returns the plaintext token — the only place it's ever
 * available; only its hash is stored. */
export function mintSandboxToken(
  db: AppDb,
  opts: { sessionId: string; userId: string; orgId: string; ttlMs?: number },
): { token: string; expiresAt: number } {
  revokeSandboxTokens(db, opts.sessionId);

  const token = `st_${randomBytes(24).toString("hex")}`;
  const now = Date.now();
  const ttlMs = opts.ttlMs ?? TOKEN_TTL_MS;
  const expiresAt = now + ttlMs;

  db.insert(sandboxTokens)
    .values({
      id: `sbtok_${randomUUID()}`,
      tokenHash: hashToken(token),
      sessionId: opts.sessionId,
      userId: opts.userId,
      orgId: opts.orgId,
      createdAt: new Date(now),
      expiresAt: new Date(expiresAt),
      revokedAt: null,
    })
    .run();

  return { token, expiresAt };
}

/** Looks up an unexpired, unrevoked sandbox token by its plaintext value
 * (hashed before the lookup — the plaintext is never stored or compared
 * directly). Returns the principal it was minted for, or null. */
export function verifySandboxToken(db: AppDb, token: string): SandboxPrincipal | null {
  const now = new Date();
  const row = db
    .select()
    .from(sandboxTokens)
    .where(and(eq(sandboxTokens.tokenHash, hashToken(token)), isNull(sandboxTokens.revokedAt)))
    .get();
  if (!row || row.expiresAt <= now) return null;
  return { sessionId: row.sessionId, userId: row.userId, orgId: row.orgId };
}

/** Sets `revoked_at` on every live (unrevoked) sandbox token for a session. */
export function revokeSandboxTokens(db: AppDb, sessionId: string): void {
  db.update(sandboxTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(sandboxTokens.sessionId, sessionId), isNull(sandboxTokens.revokedAt)))
    .run();
}

/**
 * Derive a per-session JWT signing key from the master key.
 *
 * The sandbox only needs an HMAC key to verify/mint its own service JWTs —
 * it does not need the raw master key. Deriving a deterministic per-session
 * key via HMAC-SHA256 ensures a compromised sandbox cannot forge tokens for
 * other sessions.
 */
export function deriveSandboxJwtSecret(master: string, sessionId: string): string {
  return createHmac("sha256", master).update(sessionId).digest("hex");
}

interface SandboxJwtPayload {
  sub: string; // userId
  sid: string; // sessionId
  iat: number; // issued at (unix seconds)
  exp: number; // expiry (unix seconds)
}

function base64UrlEncode(data: Buffer): string {
  return data.toString("base64url");
}

function base64UrlDecodeToBuffer(str: string): Buffer {
  return Buffer.from(str, "base64url");
}

function sign(signingInput: string, secret: string): string {
  const sig = createHmac("sha256", secret).update(signingInput).digest();
  return base64UrlEncode(sig);
}

/** Mints an HS256 JWT `{ sub: userId, sid: sessionId, iat, exp }`, signed
 * with `deriveSandboxJwtSecret(master, sessionId)`. */
export function mintSandboxJwt(
  master: string,
  opts: { sessionId: string; userId: string; ttlMs?: number },
): { token: string; expiresAt: number } {
  const secret = deriveSandboxJwtSecret(master, opts.sessionId);
  const now = Date.now();
  const ttlMs = opts.ttlMs ?? JWT_TTL_MS;
  const expiresAt = now + ttlMs;

  const header = { alg: "HS256", typ: "JWT" };
  const payload: SandboxJwtPayload = {
    sub: opts.userId,
    sid: opts.sessionId,
    iat: Math.floor(now / 1000),
    exp: Math.floor(expiresAt / 1000),
  };

  const headerB64 = base64UrlEncode(Buffer.from(JSON.stringify(header)));
  const payloadB64 = base64UrlEncode(Buffer.from(JSON.stringify(payload)));
  const signingInput = `${headerB64}.${payloadB64}`;
  const signatureB64 = sign(signingInput, secret);

  return { token: `${signingInput}.${signatureB64}`, expiresAt };
}

/** Verifies signature and expiry of a sandbox JWT against the given
 * (already-derived) secret. Returns `{ sub, sid }` on success, null on any
 * failure (malformed, bad signature, expired). */
export function verifySandboxJwt(secret: string, token: string): { sub: string; sid: string } | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, signatureB64] = parts;
  const signingInput = `${headerB64}.${payloadB64}`;

  const expectedSignature = base64UrlDecodeToBuffer(sign(signingInput, secret));
  const actualSignature = base64UrlDecodeToBuffer(signatureB64);
  if (expectedSignature.length !== actualSignature.length) return null;
  if (!timingSafeEqual(expectedSignature, actualSignature)) return null;

  let payload: SandboxJwtPayload;
  try {
    payload = JSON.parse(base64UrlDecodeToBuffer(payloadB64).toString("utf8")) as SandboxJwtPayload;
  } catch {
    return null;
  }

  if (typeof payload.exp !== "number" || payload.exp <= Math.floor(Date.now() / 1000)) return null;
  if (typeof payload.sub !== "string" || typeof payload.sid !== "string") return null;

  return { sub: payload.sub, sid: payload.sid };
}
