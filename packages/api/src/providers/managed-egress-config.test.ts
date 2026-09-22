import { describe, expect, it } from "vitest";
import { MANAGED_EGRESS_CONTRACT_VERSION } from "@valet/engine";
import { managedEgressCapability, readManagedEgressOperatorConfig } from "./managed-egress-config.js";

const artifact = `ghcr.io/tkhq/hematite@sha256:${"a".repeat(64)}`;
const configured = {
  enabled: true,
  contractVersion: MANAGED_EGRESS_CONTRACT_VERSION,
  proxyArtifact: artifact,
  callbackUrl: "https://valet/v1/authorize",
};

describe("managed egress operator configuration", () => {
  it("is disabled and unsupported by default", () => {
    expect(managedEgressCapability(readManagedEgressOperatorConfig({}))).toMatchObject({ supported: false, configured: false, ready: false });
  });

  it("does not consume operator readiness assertions", () => {
    expect(readManagedEgressOperatorConfig({
      VALET_MANAGED_EGRESS_ENABLED: "1",
      UNRELATED_OPERATOR_READINESS_ASSERTION: "1",
    })).toEqual({ enabled: true, contractVersion: undefined, proxyArtifact: undefined, callbackUrl: undefined });
  });

  it("fails closed for partial configuration", () => {
    expect(managedEgressCapability({ enabled: true })).toMatchObject({ configured: false, ready: false });
    expect(managedEgressCapability({ ...configured, callbackUrl: "http://valet/v1/authorize" })).toMatchObject({ configured: false, ready: false });
  });

  it("cannot turn configuration intent into readiness or support", () => {
    expect(managedEgressCapability(configured)).toMatchObject({ supported: false, configured: true, ready: false, proxyArtifact: artifact });
    expect(Reflect.apply(managedEgressCapability, undefined, [configured, true])).toMatchObject({ supported: false, ready: false });
  });
});
