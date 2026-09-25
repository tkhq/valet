import { describe, expect, it } from "vitest";
import { mintBrowserTicket, verifyBrowserTicket } from "./browser-ticket.js";
import { verifyGatewayJwt } from "@valet/sandbox-gateway";

describe("browser viewer tickets", () => {
  const claims = {
    sessionId: "s",
    actorId: "u",
    runtimeId: "r",
    policyVersion: "p",
    scope: "view" as const,
  };
  it("binds a ticket to the actor, session, runtime, policy and scope", () => {
    const { ticket } = mintBrowserTicket("secret", claims, 1000);
    expect(verifyBrowserTicket("secret", ticket, claims, 1001)).toBe(true);
    for (const changed of [
      { actorId: "other" },
      { sessionId: "other" },
      { runtimeId: "other" },
      { policyVersion: "other" },
      { scope: "control" as const },
    ]) {
      expect(
        verifyBrowserTicket("secret", ticket, { ...claims, ...changed }, 1001),
      ).toBe(false);
    }
    expect(verifyBrowserTicket("secret", ticket, claims, 400_000)).toBe(false);
    expect(verifyGatewayJwt("secret", ticket, "s")).toBeNull();
  });
  it("rejects malformed and tampered tickets", () => {
    const { ticket } = mintBrowserTicket("secret", claims);
    expect(verifyBrowserTicket("other", ticket, claims)).toBe(false);
    expect(verifyBrowserTicket("secret", "bad", claims)).toBe(false);
  });
});
