import { describe, expect, it } from "vitest";
import { ed25519PublicKeyFromHex, opensshEd25519PublicKey } from "./ssh.js";

// Generated with `ssh-keygen -t ed25519`; the raw key is the last 32 bytes of
// the decoded blob, the fingerprint is what `ssh-keygen -lf` printed.
const RAW_HEX = "2796666bc15775e2842aad75c07349961cda3f6a8fde5b2ccc5badff8d54e746";
const LINE = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICeWZmvBV3XihCqtdcBzSZYc2j9qj95bLMxbrf+NVOdG";
const FINGERPRINT = "SHA256:jAssneK/jlwaFI1LvXlWonG1n/EGYDTbTCp2lXzm1Xs";

describe("opensshEd25519PublicKey", () => {
  it("matches ssh-keygen's line and fingerprint", () => {
    const key = opensshEd25519PublicKey(RAW_HEX);
    expect(key.line).toBe(LINE);
    expect(key.fingerprint).toBe(FINGERPRINT);
  });

  it("accepts a 0x prefix and upper case hex", () => {
    expect(opensshEd25519PublicKey(`0x${RAW_HEX.toUpperCase()}`).line).toBe(LINE);
  });

  it("refuses a key of the wrong length", () => {
    expect(() => ed25519PublicKeyFromHex(RAW_HEX.slice(2))).toThrow(/32 bytes/);
    expect(() => ed25519PublicKeyFromHex("zz")).toThrow(/hex/);
  });
});
