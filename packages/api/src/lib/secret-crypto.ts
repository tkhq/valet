/**
 * AES-256-GCM helpers for at-rest encryption of credential secrets
 * (plugin-system-v2 Task 3). Ciphertext format: `v1:{ivB64}:{tagB64}:{ctB64}`.
 *
 * `deriveSecretKey` turns an arbitrary passphrase (e.g. `VALET_ENCRYPTION_KEY`)
 * into a fixed 32-byte AES-256 key via SHA-256 — callers never need to
 * manage key material directly.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const FORMAT_PREFIX = "v1";

/** SHA-256 of `passphrase`, used directly as the 32-byte AES-256 key. */
export function deriveSecretKey(passphrase: string): Buffer {
  return createHash("sha256").update(passphrase, "utf8").digest();
}

/**
 * Short env-stamped identifier of the key material. Every credential vault
 * row stores this; a decrypt refuses when the row's kekId does not match
 * the current environment's kekId (INV-16 in the vault spec). Derived
 * deterministically from the passphrase so no additional env var is
 * needed to identify "which key is this".
 */
export function deriveKekId(passphrase: string): string {
  return createHash("sha256").update(`kek-id:${passphrase}`, "utf8").digest().subarray(0, 8).toString("hex");
}

/** Encrypts `plaintext` with AES-256-GCM under `key`, returning `v1:{iv}:{tag}:{ct}` (base64 parts). */
export function encryptSecret(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [FORMAT_PREFIX, iv.toString("base64"), authTag.toString("base64"), ciphertext.toString("base64")].join(":");
}

/** Decrypts a `v1:{iv}:{tag}:{ct}` string produced by `encryptSecret`. Throws on malformed input or a failed auth-tag check (tampering). */
export function decryptSecret(ciphertext: string, key: Buffer): string {
  const buf = decryptSecretBuffer(ciphertext, key);
  try {
    return buf.toString("utf8");
  } finally {
    buf.fill(0);
  }
}

/**
 * Buffer variant of `decryptSecret` for callers that need to keep the plaintext
 * out of the JS string heap (INV-24 in the credential vault spec). The returned
 * Buffer is the sole heap copy of the plaintext; the caller MUST `.fill(0)` it
 * in a `finally` when done. V8 strings are immutable, so any code path that
 * lands the plaintext in a string leaves a copy in the heap until GC.
 */
export function decryptSecretBuffer(ciphertext: string, key: Buffer): Buffer {
  const parts = ciphertext.split(":");
  if (parts.length !== 4 || parts[0] !== FORMAT_PREFIX) {
    throw new Error("decryptSecret: malformed ciphertext format");
  }
  const [, ivB64, tagB64, ctB64] = parts;
  const iv = Buffer.from(ivB64, "base64");
  const authTag = Buffer.from(tagB64, "base64");
  const ct = Buffer.from(ctB64, "base64");
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

/**
 * Buffer variant of `encryptSecret` for callers that already hold the plaintext
 * as bytes (e.g. from a Buffer read of a file upload). Zeroes NO input; the
 * caller owns the input buffer's lifecycle.
 */
export function encryptSecretBuffer(plaintext: Buffer, key: Buffer): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [FORMAT_PREFIX, iv.toString("base64"), authTag.toString("base64"), ciphertext.toString("base64")].join(":");
}
