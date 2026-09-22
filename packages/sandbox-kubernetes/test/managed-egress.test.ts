import { describe, expect, it } from "vitest";
import { MANAGED_EGRESS_CONTRACT_VERSION } from "@valet/engine";
import { buildKubernetesManagedEgressResources } from "../src/managed-egress.js";

const request = { requested: true as const, proxyToken: "s".repeat(48), identity: { orgId: "o", sessionId: "session", workloadId: "workload", proxyId: "proxy", contractVersion: MANAGED_EGRESS_CONTRACT_VERSION } };
const config = {
  namespace: "valet-sandboxes", proxyArtifact: `ghcr.io/tkhq/hematite@sha256:${"a".repeat(64)}`,
  callbackUrl: "https://valet.example/v1/authorize", callbackCidrs: ["10.1.0.10/32"], upstreamCidrs: ["0.0.0.0/0"],
  dnsNamespaceSelector: { "kubernetes.io/metadata.name": "kube-system" }, dnsPodSelector: { "k8s-app": "kube-dns" },
  listenerPort: 3128, callbackPort: 443, controlPlaneCidrs: ["10.2.0.20/32"], controlPlanePorts: [443],
};

describe("Kubernetes managed egress topology", () => {
  it("uses a separate proxy pod and paired default-deny policies", () => {
    const resources = buildKubernetesManagedEgressResources(config, request);
    const pod = resources.proxyPod as { spec: { hostUsers: boolean; hostNetwork: boolean; containers: Array<{ env: Array<{ name: string; value: string }> }> } };
    expect(pod.spec.hostUsers).toBe(false); expect(pod.spec.hostNetwork).toBe(false);
    expect(JSON.stringify(pod)).not.toContain(request.proxyToken);
    expect(JSON.stringify(resources.proxySecret)).toContain(request.proxyToken);
    const workload = JSON.stringify(resources.workloadPolicy);
    expect(workload).toContain("Ingress"); expect(workload).toContain("Egress");
    expect(workload).not.toContain('"port":53');
    expect(workload).not.toContain("callback");
    const proxy = JSON.stringify(resources.proxyPolicy);
    expect(proxy).toContain('"port":53'); expect(proxy).toContain("10.1.0.10/32");
    expect(proxy).not.toContain("9000");
    expect(resources.proxyPod).not.toBe(resources.workloadPolicy);
  });

  it("fails closed on partial or malformed network configuration", () => {
    expect(() => buildKubernetesManagedEgressResources({ ...config, callbackCidrs: [] }, request)).toThrow(/explicit callback/);
    expect(() => buildKubernetesManagedEgressResources({ ...config, callbackCidrs: ["not-a-cidr"] }, request)).toThrow(/CIDR/);
    expect(() => buildKubernetesManagedEgressResources({ ...config, listenerPort: 0 }, request)).toThrow(/port/);
    expect(() => buildKubernetesManagedEgressResources({ ...config, dnsPodSelector: {} }, request)).toThrow(/DNS selectors/);
  });
});
