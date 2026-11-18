/**
 * OpenSSH encoding for the Ed25519 public keys Turnkey returns.
 *
 * Turnkey returns an Ed25519 public key as 32 bytes of hex. GitHub and git
 * want the OpenSSH line `ssh-ed25519 <base64 blob>` where the blob is
 * `string("ssh-ed25519") || string(key)` (RFC 4253 section 6.6, with the
 * uint32-length-prefixed `string` type). The fingerprint is the SHA-256 of
 * that blob, base64 without padding, prefixed `SHA256:` (the form
 * `ssh-keygen -lf` prints and GitHub shows in Settings).
 */
import { createHash } from "node:crypto";

const KEY_TYPE = "ssh-ed25519";
const ED25519_KEY_BYTES = 32;

export interface OpenSshPublicKey {
  /** `ssh-ed25519 AAAA...` with no comment. */
  line: string;
  /** `SHA256:` followed by unpadded base64. */
  fingerprint: string;
}

function sshString(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + bytes.length);
  new DataView(out.buffer).setUint32(0, bytes.length);
  out.set(bytes, 4);
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/** Decodes Turnkey's hex form of an Ed25519 public key. Accepts a `0x` prefix. */
export function ed25519PublicKeyFromHex(hex: string): Uint8Array {
  const trimmed = hex.trim().replace(/^0x/i, "");
  if (!/^[0-9a-fA-F]+$/.test(trimmed) || trimmed.length !== ED25519_KEY_BYTES * 2) {
    throw new Error(`expected ${ED25519_KEY_BYTES} bytes of hex for an Ed25519 public key, got ${trimmed.length / 2}`);
  }
  return Uint8Array.from(Buffer.from(trimmed, "hex"));
}

export function opensshEd25519PublicKey(rawHex: string): OpenSshPublicKey {
  const key = ed25519PublicKeyFromHex(rawHex);
  const blob = concat([sshString(new TextEncoder().encode(KEY_TYPE)), sshString(key)]);
  const digest = createHash("sha256").update(blob).digest("base64").replace(/=+$/, "");
  return {
    line: `${KEY_TYPE} ${Buffer.from(blob).toString("base64")}`,
    fingerprint: `SHA256:${digest}`,
  };
}

const SSHSIG_MAGIC = new TextEncoder().encode("SSHSIG");
const GIT_NAMESPACE = "git";
const SSHSIG_HASH = "sha512";

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function ed25519PublicKeyBlob(rawHex: string): Uint8Array {
  return concat([sshString(utf8(KEY_TYPE)), sshString(ed25519PublicKeyFromHex(rawHex))]);
}

/**
 * The bytes an SSH signature over `message` covers (PROTOCOL.sshsig):
 * `"SSHSIG" || string(namespace) || string(reserved) || string(hash) || string(H(message))`.
 * Git signs with namespace `git` and SHA-512. Turnkey signs these bytes as a
 * raw Ed25519 payload with no further hashing.
 */
export function sshsigSignedData(message: Uint8Array): Buffer {
  const digest = createHash(SSHSIG_HASH).update(message).digest();
  return Buffer.from(
    concat([SSHSIG_MAGIC, sshString(utf8(GIT_NAMESPACE)), sshString(new Uint8Array()), sshString(utf8(SSHSIG_HASH)), sshString(digest)]),
  );
}

/**
 * The armored `SSH SIGNATURE` block git stores in a commit's `gpgsig` header,
 * for a raw 64-byte Ed25519 signature over `sshsigSignedData(message)`. Base64
 * lines are 70 characters, as `ssh-keygen -Y sign` writes them.
 */
export function armorSshSignature(publicKeyHex: string, signature: Uint8Array): string {
  if (signature.length !== 64) throw new Error(`expected a 64-byte Ed25519 signature, got ${signature.length} bytes`);
  const version = new Uint8Array(4);
  new DataView(version.buffer).setUint32(0, 1);
  const blob = concat([
    SSHSIG_MAGIC,
    version,
    sshString(ed25519PublicKeyBlob(publicKeyHex)),
    sshString(utf8(GIT_NAMESPACE)),
    sshString(new Uint8Array()),
    sshString(utf8(SSHSIG_HASH)),
    sshString(concat([sshString(utf8(KEY_TYPE)), sshString(signature)])),
  ]);
  const b64 = Buffer.from(blob).toString("base64");
  const lines = b64.match(/.{1,70}/g) ?? [];
  return ["-----BEGIN SSH SIGNATURE-----", ...lines, "-----END SSH SIGNATURE-----"].join("\n") + "\n";
}
