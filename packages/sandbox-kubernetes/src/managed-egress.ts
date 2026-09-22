import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { MANAGED_EGRESS_CONTRACT_VERSION, ManagedEgressPrerequisiteError, validateManagedEgressRequest, type ManagedEgressRequest } from "@valet/engine";

export interface KubernetesManagedEgressConfig {
  namespace: string;
  proxyArtifact: string;
  callbackUrl: string;
  callbackCidrs: string[];
  upstreamCidrs: string[];
  dnsNamespaceSelector: Record<string, string>;
  dnsPodSelector: Record<string, string>;
  listenerPort: number;
  callbackPort: number;
  controlPlaneCidrs: string[];
  controlPlanePorts: number[];
}

export interface KubernetesManagedEgressResources {
  proxySecret: Record<string, unknown>;
  proxyPod: Record<string, unknown>;
  proxyService: Record<string, unknown>;
  workloadPolicy: Record<string, unknown>;
  proxyPolicy: Record<string, unknown>;
}

function name(proxyId: string): string {
  return `valet-egress-${createHash("sha256").update(proxyId).digest("hex").slice(0, 16)}`;
}

function ports(values: number[]): { protocol: "TCP"; port: number }[] {
  return values.map((port) => ({ protocol: "TCP", port }));
}

function validCidr(value: string): boolean {
  const separator = value.lastIndexOf("/");
  if (separator < 1) return false;
  const address = value.slice(0, separator);
  const prefix = Number(value.slice(separator + 1));
  const version = isIP(address);
  return Number.isInteger(prefix) && ((version === 4 && prefix >= 0 && prefix <= 32) || (version === 6 && prefix >= 0 && prefix <= 128));
}

function validPort(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= 65535;
}

export function validateKubernetesManagedEgressConfig(config: KubernetesManagedEgressConfig): void {
  if (!/^[-./a-zA-Z0-9_:]+@sha256:[a-f0-9]{64}$/.test(config.proxyArtifact)) throw new ManagedEgressPrerequisiteError("configuration", "Managed egress proxy artifact is not digest-pinned. Set an OCI image with @sha256:<64 hex>.");
  let callback: URL;
  try { callback = new URL(config.callbackUrl); } catch { throw new ManagedEgressPrerequisiteError("callback", "Managed egress callback URL is invalid. Configure an HTTPS /v1/authorize URL."); }
  if (callback.protocol !== "https:" || callback.pathname !== "/v1/authorize" || callback.search || callback.hash || callback.username || callback.password) throw new ManagedEgressPrerequisiteError("callback", "Managed egress callback must use HTTPS at exactly /v1/authorize.");
  if (config.callbackCidrs.length === 0 || config.upstreamCidrs.length === 0) throw new ManagedEgressPrerequisiteError("network_isolation", "Managed egress needs explicit callback and upstream CIDRs. Configure both allowlists.");
  if (config.controlPlaneCidrs.length === 0 || config.controlPlanePorts.length === 0) throw new ManagedEgressPrerequisiteError("network_isolation", "Managed egress needs explicit workload control-plane CIDRs and ports. Configure the minimum required paths.");
  if (![...config.callbackCidrs, ...config.upstreamCidrs, ...config.controlPlaneCidrs].every(validCidr)) throw new ManagedEgressPrerequisiteError("network_isolation", "Managed egress CIDR configuration is invalid.");
  if (![config.listenerPort, config.callbackPort, ...config.controlPlanePorts].every(validPort)) throw new ManagedEgressPrerequisiteError("network_isolation", "Managed egress port configuration is invalid.");
  if (Object.keys(config.dnsNamespaceSelector).length === 0 || Object.keys(config.dnsPodSelector).length === 0) throw new ManagedEgressPrerequisiteError("network_isolation", "Managed egress DNS selectors must be explicit and non-empty.");
}

/** Separate proxy pod plus paired default-deny policies. No DNS egress exists on the workload policy. */
export function buildKubernetesManagedEgressResources(config: KubernetesManagedEgressConfig, request: ManagedEgressRequest): KubernetesManagedEgressResources {
  validateKubernetesManagedEgressConfig(config);
  validateManagedEgressRequest(request);
  const resourceName = name(request.identity.proxyId);
  const workloadSelector = { "valet.dev/session-id": request.identity.workloadId };
  const proxySelector = { "valet.dev/managed-egress-proxy": request.identity.proxyId };
  const cidrPeers = (cidrs: string[]) => cidrs.map((cidr) => ({ ipBlock: { cidr } }));
  const proxySecret = {
    apiVersion: "v1", kind: "Secret", metadata: { name: `${resourceName}-token`, namespace: config.namespace },
    immutable: true, stringData: { token: request.proxyToken },
  };
  const proxyPod = {
    apiVersion: "v1", kind: "Pod", metadata: { name: resourceName, namespace: config.namespace, labels: proxySelector },
    spec: {
      hostUsers: false, hostNetwork: false, automountServiceAccountToken: false,
      securityContext: { seccompProfile: { type: "RuntimeDefault" } },
      containers: [{
        name: "proxy", image: config.proxyArtifact,
        securityContext: { allowPrivilegeEscalation: false, privileged: false, readOnlyRootFilesystem: true, capabilities: { drop: ["ALL"] } },
        ports: [{ name: "proxy", containerPort: config.listenerPort }],
        env: [
          { name: "HEMATITE_EXTERNAL_AUTHORIZATION_ENDPOINT", value: config.callbackUrl },
          { name: "HEMATITE_EXTERNAL_AUTHORIZATION_TOKEN_FILE", value: "/run/valet-egress/token" },
          { name: "HEMATITE_EXTERNAL_AUTHORIZATION_SESSION_ID", value: request.identity.sessionId },
          { name: "HEMATITE_EXTERNAL_AUTHORIZATION_WORKLOAD_ID", value: request.identity.workloadId },
        ],
        volumeMounts: [{ name: "token", mountPath: "/run/valet-egress", readOnly: true }],
        readinessProbe: { tcpSocket: { port: "proxy" }, periodSeconds: 2, failureThreshold: 3 },
      }],
      volumes: [{ name: "token", secret: { secretName: `${resourceName}-token`, defaultMode: 0o400 } }],
    },
  };
  const proxyService = {
    apiVersion: "v1", kind: "Service", metadata: { name: resourceName, namespace: config.namespace },
    spec: { selector: proxySelector, ports: [{ name: "proxy", port: config.listenerPort, targetPort: "proxy" }] },
  };
  const workloadPolicy = {
    apiVersion: "networking.k8s.io/v1", kind: "NetworkPolicy", metadata: { name: `${resourceName}-workload`, namespace: config.namespace },
    spec: { podSelector: { matchLabels: workloadSelector }, policyTypes: ["Ingress", "Egress"], ingress: [], egress: [
      { to: [{ podSelector: { matchLabels: proxySelector } }], ports: [{ protocol: "TCP", port: config.listenerPort }] },
      { to: cidrPeers(config.controlPlaneCidrs), ports: ports(config.controlPlanePorts) },
    ] },
  };
  const proxyPolicy = {
    apiVersion: "networking.k8s.io/v1", kind: "NetworkPolicy", metadata: { name: `${resourceName}-proxy`, namespace: config.namespace },
    spec: { podSelector: { matchLabels: proxySelector }, policyTypes: ["Ingress", "Egress"], ingress: [
      { from: [{ podSelector: { matchLabels: workloadSelector } }], ports: [{ protocol: "TCP", port: config.listenerPort }] },
    ], egress: [
      { to: [{ namespaceSelector: { matchLabels: config.dnsNamespaceSelector }, podSelector: { matchLabels: config.dnsPodSelector } }], ports: [{ protocol: "UDP", port: 53 }, { protocol: "TCP", port: 53 }] },
      { to: cidrPeers(config.callbackCidrs), ports: [{ protocol: "TCP", port: config.callbackPort }] },
      { to: cidrPeers(config.upstreamCidrs) },
    ] },
  };
  return { proxySecret, proxyPod, proxyService, workloadPolicy, proxyPolicy };
}
