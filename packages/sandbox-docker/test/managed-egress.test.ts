import { describe, expect, it } from "vitest";
import { MANAGED_EGRESS_CONTRACT_VERSION } from "@valet/engine";
import { buildDockerManagedEgressPlan } from "../src/managed-egress.js";

const request = { requested: true as const, proxyToken: "s".repeat(48), identity: { orgId: "o", sessionId: "s", workloadId: "w", proxyId: "p", contractVersion: MANAGED_EGRESS_CONTRACT_VERSION } };
const config = { proxyArtifact: `ghcr.io/tkhq/hematite@sha256:${"a".repeat(64)}`, callbackUrl: "https://valet.example/v1/authorize", listenerPort: 3128 };

describe("Docker managed egress topology", () => {
  it("keeps the workload internal and attaches only the proxy outbound", () => {
    const plan = buildDockerManagedEgressPlan(config, request);
    expect(plan.createInternalNetworkArgs).toContain("--internal");
    expect(plan.workloadNetworkArgs).toEqual(["--network", plan.internalNetwork]);
    expect(plan.connectProxyOutboundArgs).toEqual(["network", "connect", plan.outboundNetwork, plan.proxyContainer]);
    expect(plan.proxyRunArgs.join(" ")).not.toContain(request.proxyToken);
    expect(plan.proxyRunArgs.join(" ")).not.toContain("host-gateway");
    expect(plan.cleanupArgs.flat().join(" ")).toContain(plan.internalNetwork);
    expect(plan.cleanupArgs.flat().join(" ")).toContain(plan.outboundNetwork);
  });

  it("rejects a mutable proxy artifact", () => {
    expect(() => buildDockerManagedEgressPlan({ ...config, proxyArtifact: "hematite:latest" }, request)).toThrow(/digest-pinned/);
  });
});
