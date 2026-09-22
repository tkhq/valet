import { describe, expect, it } from "vitest";
import { applySandboxCapabilityObligations, SandboxCapabilityDeniedError } from "./sandbox-capability-provider.js";

describe("sandbox capability obligations", () => {
  it("leaves provider options unchanged without an obligation", () => {
    const options = { profile: "full" as const, docker: true, env: { CANARY: "secret" } };
    expect(applySandboxCapabilityObligations(options, undefined)).toBe(options);
  });

  it("can reduce full profile and Docker access", () => {
    const options = applySandboxCapabilityObligations({ profile: "full", docker: true }, []);
    expect(options).toMatchObject({ profile: "headless", docker: false });
  });

  it("preserves only capabilities named by the obligation", () => {
    expect(applySandboxCapabilityObligations({ profile: "full", docker: true }, ["sandbox.full"]))
      .toMatchObject({ profile: "full", docker: false });
    expect(applySandboxCapabilityObligations({ profile: "full", docker: true }, ["sandbox.docker"]))
      .toMatchObject({ profile: "headless", docker: true });
  });

  it("fails closed for unknown capability obligations", () => {
    expect(() => applySandboxCapabilityObligations({ profile: "headless" }, ["sandbox.root"]))
      .toThrow(SandboxCapabilityDeniedError);
  });
});
