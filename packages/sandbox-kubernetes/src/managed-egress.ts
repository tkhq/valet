import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { ManagedEgressPrerequisiteError, validateManagedEgressRequest, type ManagedEgressRequest } from "@valet/engine";
import { sandboxCrName, SESSION_LABEL_KEY } from "./manifest.js";

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

export interface KubernetesManagedEgressResourceIdentity {
  proxyPodName: string;
  proxySecretName: string;
  proxyServiceName: string;
  workloadPolicyName: string;
  proxyPolicyName: string;
}

export interface KubernetesManagedEgressResources {
  identity: KubernetesManagedEgressResourceIdentity;
  proxySecret: Record<string, unknown>;
  proxyPod: Record<string, unknown>;
  proxyService: Record<string, unknown>;
  workloadPolicy: Record<string, unknown>;
  proxyPolicy: Record<string, unknown>;
}

/** A selector derived only from the provider's session key and Sandbox CR naming contract. */
export class KubernetesManagedEgressWorkloadSelector {
  readonly matchLabels: Readonly<Record<typeof SESSION_LABEL_KEY, string>>;

  private constructor(sessionKey: string) {
    this.matchLabels = { [SESSION_LABEL_KEY]: sandboxCrName(sessionKey) };
  }

  static derive(sessionKey: string): KubernetesManagedEgressWorkloadSelector {
    return new KubernetesManagedEgressWorkloadSelector(sessionKey);
  }
}

export function deriveKubernetesManagedEgressWorkloadSelector(sessionKey: string): KubernetesManagedEgressWorkloadSelector {
  return KubernetesManagedEgressWorkloadSelector.derive(sessionKey);
}

export interface KubernetesManagedEgressObservation {
  workloadPodNames: string[];
  proxyPodNames: string[];
  readyProxyPodNames: string[];
  listeningProxyPodNames: string[];
  secretNames: string[];
  serviceNames: string[];
  networkPolicyNames: string[];
  networkPolicyEnforcement: "enforced" | "unknown" | "unsupported";
}

export type KubernetesManagedEgressReadiness = { ready: true } | { ready: false; reason: string };

function exactNames(actual: string[], expected: string[]): boolean {
  return actual.length === expected.length && expected.every((name) => actual.includes(name));
}

/** Evaluates observed state only. Configuration intent cannot make this result ready. */
export function evaluateKubernetesManagedEgressReadiness(
  identity: KubernetesManagedEgressResourceIdentity,
  observation: KubernetesManagedEgressObservation,
): KubernetesManagedEgressReadiness {
  if (observation.workloadPodNames.length !== 1) {
    return { ready: false, reason: "The workload selector must match exactly one pod." };
  }
  if (!exactNames(observation.proxyPodNames, [identity.proxyPodName]) ||
      !exactNames(observation.readyProxyPodNames, [identity.proxyPodName]) ||
      !exactNames(observation.listeningProxyPodNames, [identity.proxyPodName])) {
    return { ready: false, reason: "The exact managed proxy pod must be ready and listening." };
  }
  if (!exactNames(observation.secretNames, [identity.proxySecretName]) ||
      !exactNames(observation.serviceNames, [identity.proxyServiceName]) ||
      !exactNames(observation.networkPolicyNames, [identity.workloadPolicyName, identity.proxyPolicyName])) {
    return { ready: false, reason: "The exact managed proxy resources and policies must exist." };
  }
  if (observation.networkPolicyEnforcement !== "enforced") {
    return { ready: false, reason: "The cluster must prove NetworkPolicy enforcement. Unknown or unsupported enforcement fails closed." };
  }
  return { ready: true };
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

const LABEL_NAME = /^[A-Za-z0-9]([-_.A-Za-z0-9]*[A-Za-z0-9])?$/;
const DNS_LABEL = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;

function validLabelName(value: string): boolean {
  return value.length >= 1 && value.length <= 63 && LABEL_NAME.test(value);
}

function validDnsPrefix(value: string): boolean {
  return value.length <= 253 && value.split(".").every((part) => part.length <= 63 && DNS_LABEL.test(part));
}

function validLabelKey(key: string): boolean {
  const pieces = key.split("/");
  if (pieces.length === 1) return validLabelName(key);
  return pieces.length === 2 && validDnsPrefix(pieces[0] ?? "") && validLabelName(pieces[1] ?? "");
}

function validLabelValue(value: string): boolean {
  return value.length === 0 || validLabelName(value);
}

function validSelector(selector: Readonly<Record<string, string>>): boolean {
  return Object.entries(selector).every(([key, value]) => validLabelKey(key) && validLabelValue(value));
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
  if (!validSelector(config.dnsNamespaceSelector) || !validSelector(config.dnsPodSelector)) throw new ManagedEgressPrerequisiteError("network_isolation", "Managed egress DNS selectors must use valid Kubernetes label keys and values.");
}

function validateWorkloadSelector(selector: KubernetesManagedEgressWorkloadSelector): void {
  if (!(selector instanceof KubernetesManagedEgressWorkloadSelector) ||
      Object.keys(selector.matchLabels).length !== 1 ||
      !validSelector(selector.matchLabels) ||
      !selector.matchLabels[SESSION_LABEL_KEY]) {
    throw new ManagedEgressPrerequisiteError("identity", "Managed egress requires a valid server-derived Kubernetes workload selector.");
  }
}

/** Separate proxy pod plus paired egress policies. The workload has no DNS egress rule. */
export function buildKubernetesManagedEgressResources(
  config: KubernetesManagedEgressConfig,
  request: ManagedEgressRequest,
  workloadSelector: KubernetesManagedEgressWorkloadSelector,
): KubernetesManagedEgressResources {
  validateKubernetesManagedEgressConfig(config);
  validateManagedEgressRequest(request);
  validateWorkloadSelector(workloadSelector);
  const resourceName = name(request.identity.proxyId);
  const proxySelector = { "valet.dev/managed-egress-proxy": resourceName };
  const cidrPeers = (cidrs: string[]) => cidrs.map((cidr) => ({ ipBlock: { cidr } }));
  const identity = {
    proxyPodName: resourceName,
    proxySecretName: `${resourceName}-token`,
    proxyServiceName: resourceName,
    workloadPolicyName: `${resourceName}-workload`,
    proxyPolicyName: `${resourceName}-proxy`,
  };
  const proxySecret = {
    apiVersion: "v1", kind: "Secret", metadata: { name: identity.proxySecretName, namespace: config.namespace },
    immutable: true, stringData: { token: request.proxyToken },
  };
  const proxyPod = {
    apiVersion: "v1", kind: "Pod", metadata: { name: identity.proxyPodName, namespace: config.namespace, labels: proxySelector },
    spec: {
      hostUsers: false, hostNetwork: false, automountServiceAccountToken: false,
      securityContext: { runAsNonRoot: true, runAsUser: 65532, runAsGroup: 65532, fsGroup: 65532, seccompProfile: { type: "RuntimeDefault" } },
      containers: [{
        name: "proxy", image: config.proxyArtifact,
        resources: { requests: { cpu: "25m", memory: "32Mi" }, limits: { cpu: "250m", memory: "128Mi" } },
        securityContext: { allowPrivilegeEscalation: false, privileged: false, readOnlyRootFilesystem: true, runAsNonRoot: true, runAsUser: 65532, runAsGroup: 65532, capabilities: { drop: ["ALL"] } },
        ports: [{ name: "proxy", containerPort: config.listenerPort, protocol: "TCP" }],
        env: [
          { name: "HEMATITE_EXTERNAL_AUTHORIZATION_ENDPOINT", value: config.callbackUrl },
          { name: "HEMATITE_EXTERNAL_AUTHORIZATION_TOKEN_FILE", value: "/run/valet-egress/token" },
          { name: "HEMATITE_EXTERNAL_AUTHORIZATION_SESSION_ID", value: request.identity.sessionId },
          { name: "HEMATITE_EXTERNAL_AUTHORIZATION_WORKLOAD_ID", value: request.identity.workloadId },
        ],
        volumeMounts: [{ name: "token", mountPath: "/run/valet-egress", readOnly: true }],
        readinessProbe: { tcpSocket: { port: "proxy" }, periodSeconds: 2, failureThreshold: 3 },
      }],
      volumes: [{ name: "token", secret: { secretName: identity.proxySecretName, defaultMode: 0o400 } }],
    },
  };
  const proxyService = {
    apiVersion: "v1", kind: "Service", metadata: { name: identity.proxyServiceName, namespace: config.namespace },
    spec: { selector: proxySelector, ports: [{ name: "proxy", port: config.listenerPort, targetPort: "proxy", protocol: "TCP" }] },
  };
  const workloadPolicy = {
    apiVersion: "networking.k8s.io/v1", kind: "NetworkPolicy", metadata: { name: identity.workloadPolicyName, namespace: config.namespace },
    spec: { podSelector: workloadSelector, policyTypes: ["Egress"], egress: [
      { to: [{ podSelector: { matchLabels: proxySelector } }], ports: [{ protocol: "TCP", port: config.listenerPort }] },
      { to: cidrPeers(config.controlPlaneCidrs), ports: ports(config.controlPlanePorts) },
    ] },
  };
  const proxyPolicy = {
    apiVersion: "networking.k8s.io/v1", kind: "NetworkPolicy", metadata: { name: identity.proxyPolicyName, namespace: config.namespace },
    spec: { podSelector: { matchLabels: proxySelector }, policyTypes: ["Ingress", "Egress"], ingress: [
      { from: [{ podSelector: workloadSelector }], ports: [{ protocol: "TCP", port: config.listenerPort }] },
    ], egress: [
      { to: [{ namespaceSelector: { matchLabels: config.dnsNamespaceSelector }, podSelector: { matchLabels: config.dnsPodSelector } }], ports: [{ protocol: "UDP", port: 53 }, { protocol: "TCP", port: 53 }] },
      { to: cidrPeers(config.callbackCidrs), ports: [{ protocol: "TCP", port: config.callbackPort }] },
      { to: cidrPeers(config.upstreamCidrs) },
    ] },
  };
  return { identity, proxySecret, proxyPod, proxyService, workloadPolicy, proxyPolicy };
}
