import { MANAGED_EGRESS_CONTRACT_VERSION, type ManagedEgressCapability } from "@valet/engine";

export interface ManagedEgressOperatorConfig {
  enabled: boolean;
  contractVersion?: string;
  proxyArtifact?: string;
  callbackUrl?: string;
  callbackReady: boolean;
  networkIsolationReady: boolean;
}

export function readManagedEgressOperatorConfig(env: NodeJS.ProcessEnv): ManagedEgressOperatorConfig {
  return {
    enabled: env.VALET_MANAGED_EGRESS_ENABLED === "1",
    contractVersion: env.VALET_MANAGED_EGRESS_CONTRACT_VERSION,
    proxyArtifact: env.VALET_MANAGED_EGRESS_PROXY_ARTIFACT,
    callbackUrl: env.VALET_MANAGED_EGRESS_CALLBACK_URL,
    callbackReady: env.VALET_MANAGED_EGRESS_CALLBACK_READY === "1",
    networkIsolationReady: env.VALET_MANAGED_EGRESS_NETWORK_ISOLATION_READY === "1",
  };
}

function supportedCallbackUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.pathname === "/v1/authorize" && !url.search && !url.hash && !url.username && !url.password;
  } catch {
    return false;
  }
}

/**
 * Reports configuration truth without activating the feature. Provider lifecycle code must replace
 * `lifecycleConnected` with an observed resource-health signal before this can become ready.
 */
export function managedEgressCapability(config: ManagedEgressOperatorConfig, lifecycleConnected = false): ManagedEgressCapability {
  if (!config.enabled) return { supported: false, configured: false, ready: false, reason: "Managed egress is disabled." };
  if (config.contractVersion !== MANAGED_EGRESS_CONTRACT_VERSION) return { supported: false, configured: false, ready: false, reason: `Set VALET_MANAGED_EGRESS_CONTRACT_VERSION=${MANAGED_EGRESS_CONTRACT_VERSION}.` };
  if (!config.proxyArtifact || !/@sha256:[a-f0-9]{64}$/.test(config.proxyArtifact)) return { supported: false, configured: false, ready: false, reason: "Set VALET_MANAGED_EGRESS_PROXY_ARTIFACT to a digest-pinned OCI image." };
  if (!supportedCallbackUrl(config.callbackUrl) || !config.callbackReady) return { supported: false, configured: false, ready: false, reason: "Configure the HTTPS callback at exactly /v1/authorize and confirm callback readiness." };
  if (!config.networkIsolationReady || !lifecycleConnected) return {
    supported: false, configured: true, ready: false,
    contractVersion: MANAGED_EGRESS_CONTRACT_VERSION, proxyArtifact: config.proxyArtifact,
    reason: "The forced network lifecycle is not observed. Keep managed egress inactive.",
  };
  return { supported: true, configured: true, ready: true, contractVersion: MANAGED_EGRESS_CONTRACT_VERSION, proxyArtifact: config.proxyArtifact };
}
