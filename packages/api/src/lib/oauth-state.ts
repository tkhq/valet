/**
 * HMAC-signed `state` string helpers, shared by every GitHub App flow that
 * needs to hand a browser-redirect callback a tamper/expiry-checked payload
 * without server-side session storage: the app-manifest setup callback
 * (GitHub/repo integration plan Task 5, `routes/github-app.ts`) and the
 * user App-OAuth connect callback (Task 6, `routes/github-connect.ts`).
 * Extracted here once a second caller needed the identical
 * sign-a-small-JSON-payload/verify-signature-and-expiry shape — a third
 * caller should reuse this too rather than hand-rolling a fourth copy.
 *
 * The signing key is always `deriveSecretKey(providers.encryptionKey)` at
 * the call site (same passphrase-derivation idiom used for
 * `PgCredentialStore`'s encryption key) — this module doesn't know or care
 * where the key comes from, it just signs/verifies with whatever `Buffer`
 * it's given.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

/** Default TTL every state payload in this codebase uses (15 minutes). */
export const STATE_TTL_MS = 15 * 60 * 1000;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Signs `payload` (any JSON-serializable object) as `base64url(json).base64url(hmac)`. */
export function signState<T extends object>(payload: T, key: Buffer): string {
  const payloadB64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const sig = createHmac("sha256", key).update(payloadB64).digest("base64url");
  return `${payloadB64}.${sig}`;
}

/**
 * Verifies the HMAC signature (constant-time, never throws) and hands the
 * parsed JSON payload to `guard` for shape-narrowing and any payload-
 * specific checks (e.g. `exp` expiry, which field the caller requires) —
 * different callers sign different shapes, so expiry/shape validation
 * lives in the caller-supplied `guard`, not here. Returns `null` for a
 * malformed `state` string, a signature mismatch, unparsable JSON, or
 * whatever `guard` itself rejects.
 */
export function verifyState<T>(state: string, key: Buffer, guard: (payload: unknown) => T | null): T | null {
  const parts = state.split(".");
  if (parts.length !== 2) return null;
  const [payloadB64, sig] = parts;
  const expectedSig = createHmac("sha256", key).update(payloadB64).digest("base64url");
  const a = Buffer.from(sig, "utf8");
  const b = Buffer.from(expectedSig, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  return guard(payload);
}
