/**
 * A P-256 public key in the compressed hex form Turnkey accepts for API
 * keys, from a key pair generated and dropped on the spot. Enrollment uses
 * it as `valet-agent`'s first credential: Turnkey refuses a user with no
 * non-expiring credential, and a key nobody holds satisfies the rule while
 * authenticating nothing.
 */
import { generateKeyPairSync } from "node:crypto";

export function discardedP256PublicKeyHex(): string {
  const { publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  if (typeof jwk.x !== "string" || typeof jwk.y !== "string") {
    throw new Error("P-256 key export produced no coordinates");
  }
  const x = Buffer.from(jwk.x, "base64url");
  const y = Buffer.from(jwk.y, "base64url");
  const prefix = (y[y.length - 1] ?? 0) % 2 === 0 ? "02" : "03";
  return `${prefix}${x.toString("hex").padStart(64, "0")}`;
}
