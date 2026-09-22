import { describe, expect, it } from "vitest";
import { MANAGED_EGRESS_CONTRACT_VERSION } from "@valet/engine";
import { managedEgressCapability, readManagedEgressOperatorConfig } from "./managed-egress-config.js";

const artifact = `ghcr.io/tkhq/hematite@sha256:${"a".repeat(64)}`;
describe("managed egress operator configuration", () => {
  it("is disabled and unsupported by default", () => {
    expect(managedEgressCapability(readManagedEgressOperatorConfig({}))).toMatchObject({ supported: false, configured: false, ready: false });
  });
  it("fails closed for partial configuration and stays inactive without observed lifecycle readiness", () => {
    expect(managedEgressCapability({ enabled: true, callbackReady: true, networkIsolationReady: true })).toMatchObject({ configured: false, ready: false });
    expect(managedEgressCapability({ enabled: true, contractVersion: MANAGED_EGRESS_CONTRACT_VERSION, proxyArtifact: artifact, callbackUrl: "http://valet/v1/authorize", callbackReady: true, networkIsolationReady: true }, true)).toMatchObject({ configured: false, ready: false });
    expect(managedEgressCapability({ enabled: true, contractVersion: MANAGED_EGRESS_CONTRACT_VERSION, proxyArtifact: artifact, callbackUrl: "https://valet/v1/authorize", callbackReady: true, networkIsolationReady: true })).toMatchObject({ supported: false, configured: true, ready: false });
  });
  it("requires all readiness inputs before advertising support", () => {
    expect(managedEgressCapability({ enabled: true, contractVersion: MANAGED_EGRESS_CONTRACT_VERSION, proxyArtifact: artifact, callbackUrl: "https://valet/v1/authorize", callbackReady: true, networkIsolationReady: true }, true)).toMatchObject({ supported: true, configured: true, ready: true, proxyArtifact: artifact });
  });
});
