import { describe, expect, it } from "vitest";
import { discardedP256PublicKeyHex } from "./p256.js";

describe("discardedP256PublicKeyHex", () => {
  it("produces a 33-byte compressed point, fresh each time", () => {
    const a = discardedP256PublicKeyHex();
    const b = discardedP256PublicKeyHex();
    expect(a).toMatch(/^0[23][0-9a-f]{64}$/);
    expect(b).toMatch(/^0[23][0-9a-f]{64}$/);
    expect(a).not.toBe(b);
  });
});
