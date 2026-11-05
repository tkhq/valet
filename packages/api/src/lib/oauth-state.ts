/**
 * HMAC-signed `state` strings for browser-redirect callbacks. The state
 * carries a tamper- and expiry-checked payload without server-side session
 * storage. Every flow that signs a state names its purpose, and the signature
 * key is derived from the caller's key and that purpose. A state signed for
 * one flow therefore never verifies in another flow, even when the payload
 * shapes overlap.
 *
 * The callers pass `deriveSecretKey(providers.encryptionKey)` as the key.
 * Each flow-specific check (expiry, required fields, the caller the state
 * names) stays in the guard that the caller passes to `verifyState`.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

/** Default TTL every state payload in this codebase uses (15 minutes). */
export const STATE_TTL_MS = 15 * 60 * 1000;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** The flows that sign a state. Add a purpose for each new flow; never reuse one. */
export type StatePurpose =
  /** `POST /api/org/github-app/manifest` → `GET /api/org/github-app/setup`. */
  | "github-app-setup"
  /** `POST /api/me/github/connect` → `GET /api/me/github/callback`. */
  | "github-connect"
  /** `GET /api/credentials/:service/connect` → `GET /api/credentials/oauth/callback`. */
  | "integration-connect";

/** The per-flow signing key. */
function purposeKey(key: Buffer, purpose: StatePurpose): Buffer {
  return createHmac("sha256", key).update(`valet-oauth-state:${purpose}`).digest();
}

function signature(payloadB64: string, key: Buffer, purpose: StatePurpose): string {
  return createHmac("sha256", purposeKey(key, purpose)).update(payloadB64).digest("base64url");
}

/** Signs `payload` (any JSON-serializable object) for one flow as `base64url(json).base64url(hmac)`. */
export function signState<T extends object>(purpose: StatePurpose, payload: T, key: Buffer): string {
  const payloadB64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${payloadB64}.${signature(payloadB64, key, purpose)}`;
}

/**
 * Verifies the HMAC signature for `purpose` (constant-time, never throws) and
 * hands the parsed JSON payload to `guard` for shape-narrowing and any
 * payload-specific checks, such as `exp` expiry and the required fields.
 * Returns `null` for a malformed `state` string, a state signed for another
 * purpose or with another key, unparsable JSON, or whatever `guard` rejects.
 */
export function verifyState<T>(
  purpose: StatePurpose, state: string, key: Buffer, guard: (payload: unknown) => T | null,
): T | null {
  const parts = state.split(".");
  if (parts.length !== 2) return null;
  const [payloadB64, sig] = parts;
  const expectedSig = signature(payloadB64, key, purpose);
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
