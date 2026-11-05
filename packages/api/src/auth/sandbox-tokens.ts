/**
 * Sandbox bearer credentials are stored as SHA-256 hashes. Production uses
 * getOrCreateSandboxToken for recoverable, lifetime credentials. The legacy
 * random mint helper remains for bounded credentials and compatibility tests.
 *
 * Also hosts the per-session service-JWT primitives used for short-lived
 * (default 10 min) sandbox-internal auth: a per-session HMAC secret derived
 * from a master key via `deriveSandboxJwtSecret`, and a minimal HS256 JWT
 * sign/verify pair ported from v1's `packages/worker/src/lib/jwt.ts`.
 */
import { randomBytes, randomUUID, createHash, createHmac, timingSafeEqual } from "node:crypto";
import { and, asc, eq, gt, isNull, lt, sql } from "drizzle-orm";
import type { AppDb } from "../lib/drizzle.js";
import { recordSandboxTokenRejected } from "../observability/sandbox-token-metrics.js";
import { sandboxTokens } from "../schema/index.js";

// A finite sentinel keeps older API verifiers and the existing NOT NULL column
// compatible during rolling upgrades. Only explicit teardown ends this lifetime.
const DURABLE_EXPIRES_AT = new Date("9999-12-31T23:59:59.000Z");

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

/** Mint a legacy random credential. Never revoke another credential here.
 * Production provisioning uses getOrCreateSandboxToken instead. Successful
 * verification adopts still-valid legacy credentials into the durable lifetime.
 */
export async function mintSandboxToken(
  db: AppDb,
  opts: { sessionId: string; userId: string; orgId: string; ttlMs?: number },
): Promise<{ token: string; expiresAt: number }> {
  const token = `st_${randomBytes(24).toString("hex")}`;
  const now = Date.now();
  const ttlMs = opts.ttlMs ?? TOKEN_TTL_MS;
  const expiresAt = now + ttlMs;

  await db.insert(sandboxTokens).values({
    id: `sbtok_${randomUUID()}`,
    tokenHash: hashToken(token),
    sessionId: opts.sessionId,
    userId: opts.userId,
    orgId: opts.orgId,
    createdAt: new Date(now),
    expiresAt: new Date(expiresAt),
    revokedAt: null,
  });

  return { token, expiresAt };
}

/** Adopt a recoverable credential, or mint one without revoking earlier tokens.
 * The stable instance key and random row ID recover the bearer after restart.
 * Domain separation and the full principal bind it to this use and owner.
 * Only its hash is stored; possession of a database row cannot recover it.
 */
export async function getOrCreateSandboxToken(
  db: AppDb,
  principal: SandboxPrincipal,
  master: string,
): Promise<{ token: string; expiresAt: number }> {
  const derive = (id: string) => `st_${createHmac("sha256", master)
    .update(JSON.stringify(["valet:sandbox-token:v1", id, principal.sessionId, principal.userId, principal.orgId]))
    .digest("hex").slice(0, 48)}`;
  const rows = await db.select().from(sandboxTokens).where(and(
    eq(sandboxTokens.sessionId, principal.sessionId),
    eq(sandboxTokens.userId, principal.userId),
    eq(sandboxTokens.orgId, principal.orgId),
    isNull(sandboxTokens.revokedAt),
    gt(sandboxTokens.expiresAt, new Date()),
  )).orderBy(asc(sandboxTokens.createdAt), asc(sandboxTokens.id));
  for (const row of rows) {
    const token = derive(row.id);
    if (hashToken(token) === row.tokenHash) {
      return { token, expiresAt: row.expiresAt.getTime() };
    }
  }

  const id = `sbtok_${randomUUID()}`;
  const token = derive(id);
  await db.insert(sandboxTokens).values({
    id, tokenHash: hashToken(token), ...principal,
    createdAt: new Date(), expiresAt: DURABLE_EXPIRES_AT, revokedAt: null,
  });
  return { token, expiresAt: DURABLE_EXPIRES_AT.getTime() };
}

/** One-time upgrade of still-valid legacy credentials before serving requests.
 * Crash/rolling-update compatibility: keep the bearer already inside a sandbox
 * usable without requiring a credential mount or a live refresh.
 * Expired and revoked rows remain invalid.
 */
export async function preserveLegacySandboxTokens(db: AppDb): Promise<void> {
  await db.update(sandboxTokens).set({ expiresAt: DURABLE_EXPIRES_AT }).where(and(
    isNull(sandboxTokens.revokedAt),
    gt(sandboxTokens.expiresAt, new Date()),
    lt(sandboxTokens.expiresAt, DURABLE_EXPIRES_AT),
  ));
}

/** Looks up an unexpired, unrevoked sandbox token by its plaintext value
 * (hashed before the lookup — the plaintext is never stored or compared
 * directly). Returns the principal it was minted for, or null. */
export async function verifySandboxToken(db: AppDb, token: string): Promise<SandboxPrincipal | null> {
  const now = new Date();
  const rows = await db
    .select()
    .from(sandboxTokens)
    .where(eq(sandboxTokens.tokenHash, hashToken(token)))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  if (row.revokedAt !== null || row.expiresAt <= now) {
    // The persisted attachment covers cold sessions too. Expected rejection
    // after teardown has no attachment and must not page an operator.
    const attached = await db.select({ id: sql<string>`id` }).from(sql`engine_sessions`)
      .where(sql`id = ${row.sessionId} AND sandbox_id IS NOT NULL`).limit(1);
    if (attached.length) recordSandboxTokenRejected(row.revokedAt ? "revoked" : "expired");
    return null;
  }
  if (row.expiresAt < DURABLE_EXPIRES_AT) {
    // An older replica can issue a legacy credential after this process boots.
    // Adopt it on first use, but never clear a concurrent revocation.
    const promoted = await db.update(sandboxTokens).set({ expiresAt: DURABLE_EXPIRES_AT })
      .where(and(eq(sandboxTokens.id, row.id), isNull(sandboxTokens.revokedAt), gt(sandboxTokens.expiresAt, new Date())))
      .returning({ id: sandboxTokens.id });
    if (!promoted.length) return null;
  }
  return { sessionId: row.sessionId, userId: row.userId, orgId: row.orgId };
}

/** Sets `revoked_at` on every live (unrevoked) sandbox token for a session. */
export async function revokeSandboxTokens(db: AppDb, sessionId: string): Promise<void> {
  await db
    .update(sandboxTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(sandboxTokens.sessionId, sessionId), isNull(sandboxTokens.revokedAt)));
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
