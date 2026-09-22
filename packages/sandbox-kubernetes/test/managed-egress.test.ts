import { describe, expect, it } from "vitest";
import { MANAGED_EGRESS_CONTRACT_VERSION } from "@valet/engine";
import {
  buildKubernetesManagedEgressResources,
  deriveKubernetesManagedEgressWorkloadSelector,
  evaluateKubernetesManagedEgressReadiness,
} from "../src/managed-egress.js";
import {
  buildSandboxManifest,
  sandboxCrName,
  SANDBOX_CR_API_VERSION,
  SESSION_LABEL_KEY,
} from "../src/index.js";

const request = {
  requested: true as const,
  proxyToken: "s".repeat(48),
  identity: {
    orgId: "o",
    sessionId: "session",
    workloadId: "callback/workload:id",
    proxyId: "proxy/id:from-callback",
    contractVersion: MANAGED_EGRESS_CONTRACT_VERSION,
  },
};
const config = {
  namespace: "valet-sandboxes",
  proxyArtifact: `ghcr.io/tkhq/hematite@sha256:${"a".repeat(64)}`,
  callbackUrl: "https://valet.example/v1/authorize",
  callbackCidrs: ["10.1.0.10/32", "2001:db8:1::10/128"],
  upstreamCidrs: ["0.0.0.0/0", "::/0"],
  dnsNamespaceSelector: { "kubernetes.io/metadata.name": "kube-system" },
  dnsPodSelector: { "k8s-app": "kube-dns" },
  listenerPort: 3128,
  httpsListenerPort: 8443,
  tunnelListenerPort: 8080,
  allowlistDomains: ["api.example.com"],
  allowlistCidrs: [],
  caCert: "-----BEGIN CERTIFICATE-----\ntest\n-----END CERTIFICATE-----",
  caKey: "-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----",
  callbackPort: 443,
  controlPlaneCidrs: ["10.2.0.20/32", "2001:db8:2::20/128"],
  controlPlanePorts: [443],
};
const providerConfig = {
  namespace: config.namespace,
  defaultImage: "valet-sandbox:latest",
  apiVersion: SANDBOX_CR_API_VERSION,
};

function build(sessionKey = "wf:run/with.callback-identity-mismatch") {
  const selector = deriveKubernetesManagedEgressWorkloadSelector(sessionKey);
  return { selector, resources: buildKubernetesManagedEgressResources(config, request, selector) };
}

describe("Kubernetes managed egress topology", () => {
  it("derives the workload selector from the server session key and manifest contract", () => {
    const sessionKey = `workflow:${"x".repeat(100)}:step-a`;
    const name = sandboxCrName(sessionKey);
    const manifest = buildSandboxManifest(providerConfig, name, {});
    const { selector, resources } = build(sessionKey);

    expect(selector).toEqual({ matchLabels: { [SESSION_LABEL_KEY]: name } });
    expect(resources.workloadPolicy).toMatchObject({
      spec: { podSelector: selector },
    });
    expect(manifest.spec.podTemplate.metadata?.labels).toMatchObject(selector.matchLabels);
    expect(JSON.stringify(resources.workloadPolicy)).not.toContain(request.identity.workloadId);

    const prefix = `workflow:${"z".repeat(100)}`;
    expect(deriveKubernetesManagedEgressWorkloadSelector(`${prefix}:a`)).not.toEqual(
      deriveKubernetesManagedEgressWorkloadSelector(`${prefix}:b`),
    );
  });

  it("uses collision-resistant provider identities and preserves workload ingress", () => {
    const { resources } = build();

    expect(resources.workloadPolicy).toMatchObject({
      spec: {
        policyTypes: ["Egress"],
        egress: expect.any(Array),
      },
    });
    expect(resources.workloadPolicy).not.toHaveProperty("spec.ingress");
    expect(JSON.stringify(resources.workloadPolicy)).not.toContain('"port":53');
    expect(JSON.stringify(resources.workloadPolicy)).not.toContain(config.callbackCidrs[0]);
    expect(JSON.stringify(resources.proxyPolicy)).toContain('"port":53');
    expect(JSON.stringify(resources.proxyPolicy)).toContain("10.1.0.10/32");
    expect(JSON.stringify(resources.proxyPolicy)).toContain("2001:db8:1::10/128");
    expect(JSON.stringify(resources.proxyPolicy)).not.toContain(request.identity.proxyId);
  });

  it("hardens the proxy pod and exposes the listener consistently", () => {
    const { resources } = build();

    expect(resources.proxyPod).toMatchObject({
      spec: {
        hostUsers: false,
        hostNetwork: false,
        automountServiceAccountToken: false,
        securityContext: {
          runAsNonRoot: true,
          runAsUser: 65532,
          runAsGroup: 65532,
          fsGroup: 65532,
          seccompProfile: { type: "RuntimeDefault" },
        },
        containers: [{
          ports: [
            { name: "proxy", containerPort: config.listenerPort, protocol: "TCP" },
            { name: "https", containerPort: config.httpsListenerPort, protocol: "TCP" },
            { name: "tunnel", containerPort: config.tunnelListenerPort, protocol: "TCP" },
          ],
          resources: {
            requests: { cpu: "25m", memory: "32Mi" },
            limits: { cpu: "250m", memory: "128Mi" },
          },
          securityContext: {
            allowPrivilegeEscalation: false,
            privileged: false,
            readOnlyRootFilesystem: true,
            runAsNonRoot: true,
            runAsUser: 65532,
            runAsGroup: 65532,
            capabilities: { drop: ["ALL"] },
          },
        }],
      },
    });
    expect(resources.proxyService).toMatchObject({
      spec: { ports: [
        { name: "proxy", port: config.listenerPort, targetPort: "proxy", protocol: "TCP" },
        { name: "https", port: config.httpsListenerPort, targetPort: "https", protocol: "TCP" },
        { name: "tunnel", port: config.tunnelListenerPort, targetPort: "tunnel", protocol: "TCP" },
      ] },
    });
    const podJson = JSON.stringify(resources.proxyPod);
    const configJson = JSON.stringify(resources.proxyConfigSecret);
    expect(podJson).not.toContain(request.proxyToken);
    expect(podJson).not.toContain(request.identity.sessionId);
    expect(podJson).toContain("chmod 0400 /runtime/token /runtime/certs/ca.key");
    expect(JSON.stringify(resources.proxySecret)).toContain(request.proxyToken);
    expect(configJson).toContain("passthrough: []");
    expect(configJson).toContain("- name: allowlist");
    expect(configJson).toContain(request.identity.sessionId);
    expect(configJson).not.toContain(request.proxyToken);
  });

  it("requires one workload match and exact ready resources with enforced policy", () => {
    const { resources } = build();
    const observation = {
      workloadPodNames: ["sandbox-pod"],
      proxyPodNames: [resources.identity.proxyPodName],
      readyProxyPodNames: [resources.identity.proxyPodName],
      listeningProxyPodNames: [resources.identity.proxyPodName],
      secretNames: [resources.identity.proxySecretName, resources.identity.proxyConfigSecretName],
      serviceNames: [resources.identity.proxyServiceName],
      proxyServiceClusterIps: ["10.96.12.34", "2001:db8::34"],
      networkPolicyNames: [resources.identity.workloadPolicyName, resources.identity.proxyPolicyName],
      networkPolicyEnforcement: "enforced" as const,
    };

    expect(evaluateKubernetesManagedEgressReadiness(resources.identity, observation)).toEqual({
      ready: true,
      workloadProxyEndpoints: ["http://10.96.12.34:3128", "http://[2001:db8::34]:3128"],
    });
    expect(evaluateKubernetesManagedEgressReadiness(resources.identity, { ...observation, workloadPodNames: [] })).toMatchObject({ ready: false });
    expect(evaluateKubernetesManagedEgressReadiness(resources.identity, { ...observation, workloadPodNames: ["a", "b"] })).toMatchObject({ ready: false });
    expect(evaluateKubernetesManagedEgressReadiness(resources.identity, { ...observation, networkPolicyEnforcement: "unknown" })).toMatchObject({ ready: false });
    expect(evaluateKubernetesManagedEgressReadiness(resources.identity, { ...observation, proxyServiceClusterIps: [] })).toMatchObject({ ready: false });
    expect(evaluateKubernetesManagedEgressReadiness(resources.identity, { ...observation, networkPolicyNames: [resources.identity.workloadPolicyName] })).toMatchObject({ ready: false });
  });

  it("fails closed on partial or malformed network configuration", () => {
    const selector = deriveKubernetesManagedEgressWorkloadSelector("session-key");
    expect(() => buildKubernetesManagedEgressResources({ ...config, callbackCidrs: [] }, request, selector)).toThrow(/explicit callback/);
    expect(() => buildKubernetesManagedEgressResources({ ...config, callbackCidrs: ["not-a-cidr"] }, request, selector)).toThrow(/CIDR/);
    expect(() => buildKubernetesManagedEgressResources({ ...config, listenerPort: 0 }, request, selector)).toThrow(/port/);
    expect(() => buildKubernetesManagedEgressResources({ ...config, dnsPodSelector: {} }, request, selector)).toThrow(/DNS selectors/);
    expect(() => buildKubernetesManagedEgressResources({ ...config, dnsPodSelector: { "bad key": "dns" } }, request, selector)).toThrow(/label/);
    expect(() => buildKubernetesManagedEgressResources({ ...config, dnsPodSelector: { app: "x".repeat(64) } }, request, selector)).toThrow(/label/);
  });
});
