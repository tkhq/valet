import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyGatewayJwt } from "./jwt.js";

function mint(secret: string, payload: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const signingInput = `${b64({ alg: "HS256", typ: "JWT" })}.${b64(payload)}`;
  const sig = createHmac("sha256", secret).update(signingInput).digest("base64url");
  return `${signingInput}.${sig}`;
}

const SECRET = "deadbeef";
const now = Math.floor(Date.now() / 1000);

describe("verifyGatewayJwt", () => {
  it("accepts a valid token whose sid matches", () => {
    const t = mint(SECRET, { sub: "u1", sid: "s1", iat: now, exp: now + 600 });
    expect(verifyGatewayJwt(SECRET, t, "s1")).toEqual({ sub: "u1", sid: "s1" });
  });
  it("rejects a cross-session sid", () => {
    const t = mint(SECRET, { sub: "u1", sid: "OTHER", iat: now, exp: now + 600 });
    expect(verifyGatewayJwt(SECRET, t, "s1")).toBeNull();
  });
  it("rejects an expired token", () => {
    const t = mint(SECRET, { sub: "u1", sid: "s1", iat: now - 1200, exp: now - 600 });
    expect(verifyGatewayJwt(SECRET, t, "s1")).toBeNull();
  });
  it("rejects a bad signature", () => {
    const t = mint("WRONG", { sub: "u1", sid: "s1", iat: now, exp: now + 600 });
    expect(verifyGatewayJwt(SECRET, t, "s1")).toBeNull();
  });
  it("rejects malformed input", () => {
    expect(verifyGatewayJwt(SECRET, "not.a.jwt.x", "s1")).toBeNull();
    expect(verifyGatewayJwt(SECRET, "onlyonepart", "s1")).toBeNull();
  });
});
