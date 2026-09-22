import { MANAGED_EGRESS_CONTRACT_VERSION, type ManagedEgressCapability } from "@valet/engine";

export interface ManagedEgressOperatorConfig {
  enabled: boolean;
  contractVersion?: string;
  proxyArtifact?: string;
  callbackUrl?: string;
}

export function readManagedEgressOperatorConfig(env: NodeJS.ProcessEnv): ManagedEgressOperatorConfig {
  return {
    enabled: env.VALET_MANAGED_EGRESS_ENABLED === "1",
    contractVersion: env.VALET_MANAGED_EGRESS_CONTRACT_VERSION,
    proxyArtifact: env.VALET_MANAGED_EGRESS_PROXY_ARTIFACT,
    callbackUrl: env.VALET_MANAGED_EGRESS_CALLBACK_URL,
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

/** Reports configuration intent only. Provider observations own readiness and support. */
export function managedEgressCapability(config: ManagedEgressOperatorConfig): ManagedEgressCapability {
  if (!config.enabled) return { supported: false, configured: false, ready: false, reason: "Managed egress is disabled." };
  if (config.contractVersion !== MANAGED_EGRESS_CONTRACT_VERSION) return { supported: false, configured: false, ready: false, reason: `Set VALET_MANAGED_EGRESS_CONTRACT_VERSION=${MANAGED_EGRESS_CONTRACT_VERSION}.` };
  if (!config.proxyArtifact || !/@sha256:[a-f0-9]{64}$/.test(config.proxyArtifact)) return { supported: false, configured: false, ready: false, reason: "Set VALET_MANAGED_EGRESS_PROXY_ARTIFACT to a digest-pinned OCI image." };
  if (!supportedCallbackUrl(config.callbackUrl)) return { supported: false, configured: false, ready: false, reason: "Configure the HTTPS callback at exactly /v1/authorize." };
  return {
    supported: false,
    configured: true,
    ready: false,
    contractVersion: MANAGED_EGRESS_CONTRACT_VERSION,
    proxyArtifact: config.proxyArtifact,
    reason: "Provider lifecycle observations are not connected. Keep managed egress inactive.",
  };
}
