import { describe, expect, it } from "vitest";
import type { SigningKeyIndexDoc } from "@valet/plugin-turnkey/store";
import { parseEnrollBody, renderAllowedSigners } from "./commit-signing.js";

const attestation = {
  credentialId: "cred",
  clientDataJson: "{}",
  attestationObject: "ao",
  transports: ["AUTHENTICATOR_TRANSPORT_INTERNAL"],
};

describe("parseEnrollBody", () => {
  it("accepts the shape the browser posts", () => {
    expect(parseEnrollBody({ challenge: "c", attestation, authenticatorName: "My key" })).toEqual({
      authenticatorName: "My key",
      challenge: "c",
      attestation,
    });
  });

  it("refuses a missing field or an unknown transport", () => {
    expect(parseEnrollBody({ challenge: "c" })).toBeNull();
    expect(parseEnrollBody({ challenge: "c", attestation: { ...attestation, transports: ["usb"] } })).toBeNull();
    expect(parseEnrollBody({ challenge: 1, attestation })).toBeNull();
    expect(parseEnrollBody(null)).toBeNull();
  });
});

describe("renderAllowedSigners", () => {
  const row: SigningKeyIndexDoc = {
    userId: "u1",
    userEmail: "dev@example.com",
    orgId: "o1",
    sessionId: "s1",
    userKey: "k",
    fingerprint: "SHA256:x",
    publicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICeWZmvBV3XihCqtdcBzSZYc2j9qj95bLMxbrf+NVOdG",
    githubKeyId: 1,
    notBefore: Date.parse("2026-09-12T10:00:00Z"),
    notAfter: Date.parse("2026-09-12T12:00:00Z"),
    status: "closed",
  };

  it("renders one line per key with its window, and the email as principal", () => {
    expect(renderAllowedSigners([row])).toBe(
      'dev@example.com valid-after="2026-09-12T10:00:00Z" valid-before="2026-09-12T12:00:00Z" ' +
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICeWZmvBV3XihCqtdcBzSZYc2j9qj95bLMxbrf+NVOdG\n",
    );
  });

  it("falls back to a user principal and renders nothing for no keys", () => {
    const { userEmail: _drop, ...noEmail } = row;
    expect(renderAllowedSigners([noEmail]).startsWith("user:u1@valet ")).toBe(true);
    expect(renderAllowedSigners([])).toBe("");
  });
});
