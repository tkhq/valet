/**
 * The use service client (sandbox secret broker design, "Using a secret
 * without exporting it"). The use service runs in an attested enclave: it
 * fetches a use-only secret from the secret store, puts it in one header of
 * an HTTPS call its sealed rules allow, and returns the response with the
 * secret removed. Valet stamps each request with its deployment key and never
 * holds the value.
 *
 * `VALET_SECRET_USE_URL` and `VALET_SECRET_USE_CLIENT_KEY` (P-256 private key,
 * 32 bytes hex) turn it on. Either one alone is a configuration error.
 */
import { createECDH, createPrivateKey, sign, type KeyObject } from "node:crypto";

/** The outbound request the agent asked for. Header names are lower case. */
export interface SecretUseRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  /** Base64. */
  body: string;
}

/** The secret, as the provider stores it, and whose it is. */
export interface SecretUseTarget {
  /** The provider's space id: a Turnkey organization id. */
  spaceId: string;
  /** The provider's secret id. */
  secretId: string;
  /** Must equal the owner sealed in the secret. */
  owner: string;
  /** Request context the provider's export policy checks. */
  context: Record<string, string>;
}

export interface SecretUseReceipt {
  payload: string;
  publicKey: string;
  signature: string;
}

export type SecretUseResult =
  | { ok: true; status: number; headers: Array<[string, string]>; body: string; receipt: SecretUseReceipt }
  | { ok: false; httpStatus: number; error: string; message: string };

export interface SecretUseService {
  /** Compressed P-256 public key, hex: the `client` a use-only secret names. */
  readonly clientPublicKey: string;
  /** True only when Valet verified the use service's attestation, so its
   * receipts are signed by an enclave. Valet does not verify attestation
   * yet, so receipts read "signed by use service". */
  readonly attested: boolean;
  use(target: SecretUseTarget, request: SecretUseRequest): Promise<SecretUseResult>;
}

/** Imports a raw P-256 scalar as a signing key. */
export function p256KeyPair(privateHex: string): { key: KeyObject; compressedPublicHex: string } {
  if (!/^[0-9a-fA-F]{64}$/.test(privateHex)) throw new Error("VALET_SECRET_USE_CLIENT_KEY must be a 32-byte P-256 private key in hex");
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(Buffer.from(privateHex, "hex"));
  const uncompressed = ecdh.getPublicKey();
  const b64url = (b: Buffer) => b.toString("base64url");
  const key = createPrivateKey({
    key: {
      kty: "EC",
      crv: "P-256",
      d: b64url(Buffer.from(privateHex, "hex")),
      x: b64url(uncompressed.subarray(1, 33)),
      y: b64url(uncompressed.subarray(33, 65)),
    },
    format: "jwk",
  });
  return { key, compressedPublicHex: ecdh.getPublicKey("hex", "compressed") };
}

/** A Turnkey-format API key stamp: base64url JSON of the public key, the
 * scheme, and a DER ECDSA signature over SHA-256 of the body. */
export function stampBody(body: string, key: KeyObject, compressedPublicHex: string): string {
  const signature = sign("sha256", Buffer.from(body, "utf8"), { key, dsaEncoding: "der" }).toString("hex");
  const stamp = { publicKey: compressedPublicHex, scheme: "SIGNATURE_SCHEME_TK_API_P256", signature };
  return Buffer.from(JSON.stringify(stamp), "utf8").toString("base64url");
}

const TIMEOUT_MS = 60_000;

export function createSecretUseService(opts: {
  url: string;
  clientKeyHex: string;
  fetch?: typeof fetch;
}): SecretUseService {
  const { key, compressedPublicHex } = p256KeyPair(opts.clientKeyHex);
  const doFetch = opts.fetch ?? fetch;
  const base = opts.url.replace(/\/+$/, "");
  return {
    clientPublicKey: compressedPublicHex,
    attested: false,
    async use(target, request) {
      const body = JSON.stringify({
        organizationId: target.spaceId,
        secretId: target.secretId,
        owner: target.owner,
        context: target.context,
        request,
      });
      let res: Response;
      try {
        res = await doFetch(`${base}/v1/use`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-stamp": stampBody(body, key, compressedPublicHex) },
          body,
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch {
        return { ok: false, httpStatus: 502, error: "use_service_unreachable", message: "The secret use service did not answer. Try again; if it repeats, ask an operator to check it." };
      }
      const text = await res.text();
      let json: Record<string, unknown> = {};
      try {
        json = JSON.parse(text) as Record<string, unknown>;
      } catch {
        // Fall through: a non-JSON answer is reported by status below.
      }
      if (!res.ok) {
        const message = typeof json.message === "string" ? json.message : `The secret use service answered HTTP ${res.status}.`;
        const error = typeof json.error === "string" ? json.error : "use_service_error";
        return { ok: false, httpStatus: res.status, error, message };
      }
      if (typeof json.status !== "number" || typeof json.body !== "string" || !Array.isArray(json.headers) || typeof json.receipt !== "object" || json.receipt === null) {
        return { ok: false, httpStatus: 502, error: "use_service_bad_response", message: "The secret use service sent an answer Valet cannot read." };
      }
      return {
        ok: true,
        status: json.status,
        headers: (json.headers as unknown[]).filter((h): h is [string, string] => Array.isArray(h) && h.length === 2 && h.every((v) => typeof v === "string")),
        body: json.body,
        receipt: json.receipt as SecretUseReceipt,
      };
    },
  };
}

/** Reads the configuration. Null when off; throws when half set. */
export function secretUseServiceFromEnv(env: NodeJS.ProcessEnv): SecretUseService | null {
  const url = env.VALET_SECRET_USE_URL?.trim();
  const keyHex = env.VALET_SECRET_USE_CLIENT_KEY?.trim();
  if (!url && !keyHex) return null;
  if (!url || !keyHex) throw new Error("Set both VALET_SECRET_USE_URL and VALET_SECRET_USE_CLIENT_KEY, or neither.");
  if (!/^https?:\/\//.test(url)) throw new Error("VALET_SECRET_USE_URL must be an http(s) URL");
  return createSecretUseService({ url, clientKeyHex: keyHex });
}
