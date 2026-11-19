// @vitest-environment node
import { createPublicKey, randomBytes, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createSecretUseService, p256KeyPair, secretUseServiceFromEnv, stampBody } from "./secret-use.js";

const KEY = randomBytes(32).toString("hex");

function verifyStamp(stamp: string, body: string): string {
  const { publicKey, scheme, signature } = JSON.parse(Buffer.from(stamp, "base64url").toString("utf8")) as {
    publicKey: string;
    scheme: string;
    signature: string;
  };
  expect(scheme).toBe("SIGNATURE_SCHEME_TK_API_P256");
  const key = createPublicKey({ key: Buffer.from(spkiForCompressed(publicKey)), format: "der", type: "spki" });
  expect(verify("sha256", Buffer.from(body), { key, dsaEncoding: "der" }, Buffer.from(signature, "hex"))).toBe(true);
  return publicKey;
}

/** SPKI DER for a compressed P-256 point. */
function spkiForCompressed(hex: string): Buffer {
  const prefix = Buffer.from("3039301306072a8648ce3d020106082a8648ce3d030107032200", "hex");
  return Buffer.concat([prefix, Buffer.from(hex, "hex")]);
}

describe("secret use client", () => {
  it("stamps the exact body with the configured key", () => {
    const { key, compressedPublicHex } = p256KeyPair(KEY);
    expect(compressedPublicHex).toMatch(/^0[23][0-9a-f]{64}$/);
    const body = JSON.stringify({ a: 1 });
    expect(verifyStamp(stampBody(body, key, compressedPublicHex), body)).toBe(compressedPublicHex);
  });

  it("sends a stamped use request and returns the response", async () => {
    const seen: { url: string; body: string; stamp: string }[] = [];
    const service = createSecretUseService({
      url: "https://use.example/",
      clientKeyHex: KEY,
      fetch: async (url, init) => {
        const body = String(init?.body);
        seen.push({ url: String(url), body, stamp: new Headers(init?.headers).get("x-stamp") ?? "" });
        return new Response(JSON.stringify({ status: 201, headers: [["x", "y"]], body: "b2s=", receipt: { payload: "{}", publicKey: "04", signature: "30" } }), { status: 200 });
      },
    });
    const result = await service.use(
      { spaceId: "org-1", secretId: "sec-1", owner: "valet:o:user:u", context: { k: "v" } },
      { method: "POST", url: "https://api.example.com/v1", headers: {}, body: "" },
    );
    expect(result).toEqual({ ok: true, status: 201, headers: [["x", "y"]], body: "b2s=", receipt: { payload: "{}", publicKey: "04", signature: "30" } });
    expect(seen[0]!.url).toBe("https://use.example/v1/use");
    expect(JSON.parse(seen[0]!.body)).toEqual({
      organizationId: "org-1",
      secretId: "sec-1",
      owner: "valet:o:user:u",
      context: { k: "v" },
      request: { method: "POST", url: "https://api.example.com/v1", headers: {}, body: "" },
    });
    expect(verifyStamp(seen[0]!.stamp, seen[0]!.body)).toBe(service.clientPublicKey);
  });

  it("passes a refusal through and reports an unreachable service by name", async () => {
    const refusing = createSecretUseService({
      url: "https://use.example",
      clientKeyHex: KEY,
      fetch: async () => new Response(JSON.stringify({ error: "path_not_allowed", message: "Only /v1/." }), { status: 403 }),
    });
    expect(await refusing.use({ spaceId: "o", secretId: "s", owner: "w", context: {} }, { method: "GET", url: "https://a.b/", headers: {}, body: "" })).toEqual({
      ok: false,
      httpStatus: 403,
      error: "path_not_allowed",
      message: "Only /v1/.",
    });
    const down = createSecretUseService({
      url: "https://use.example",
      clientKeyHex: KEY,
      fetch: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    const result = await down.use({ spaceId: "o", secretId: "s", owner: "w", context: {} }, { method: "GET", url: "https://a.b/", headers: {}, body: "" });
    expect(result).toMatchObject({ ok: false, httpStatus: 502, error: "use_service_unreachable" });
  });

  it("is off when unset and refuses half a configuration", () => {
    expect(secretUseServiceFromEnv({})).toBeNull();
    expect(() => secretUseServiceFromEnv({ VALET_SECRET_USE_URL: "https://x" })).toThrow(/both/);
    expect(() => secretUseServiceFromEnv({ VALET_SECRET_USE_URL: "https://x", VALET_SECRET_USE_CLIENT_KEY: "nothex" })).toThrow(/32-byte/);
    expect(secretUseServiceFromEnv({ VALET_SECRET_USE_URL: "https://x", VALET_SECRET_USE_CLIENT_KEY: KEY })?.clientPublicKey).toMatch(/^0[23]/);
  });
});
