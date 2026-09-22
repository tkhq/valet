import { createHash } from "node:crypto";
import { MANAGED_EGRESS_CONTRACT_VERSION, ManagedEgressPrerequisiteError, validateManagedEgressRequest, type ManagedEgressRequest } from "@valet/engine";

export interface DockerManagedEgressConfig {
  proxyArtifact: string;
  callbackUrl: string;
  listenerPort: number;
}

export interface DockerManagedEgressPlan {
  internalNetwork: string;
  outboundNetwork: string;
  proxyContainer: string;
  tokenVolume: string;
  createInternalNetworkArgs: string[];
  createOutboundNetworkArgs: string[];
  workloadNetworkArgs: string[];
  proxyRunArgs: string[];
  connectProxyOutboundArgs: string[];
  cleanupArgs: string[][];
}

function pinnedArtifact(value: string): boolean {
  return /^[-./a-zA-Z0-9_:]+@sha256:[a-f0-9]{64}$/.test(value);
}

export function validateDockerManagedEgressConfig(config: DockerManagedEgressConfig): void {
  if (!pinnedArtifact(config.proxyArtifact)) throw new ManagedEgressPrerequisiteError("configuration", "Managed egress proxy artifact is not digest-pinned. Set an OCI image with @sha256:<64 hex>.");
  let callback: URL;
  try { callback = new URL(config.callbackUrl); } catch { throw new ManagedEgressPrerequisiteError("callback", "Managed egress callback URL is invalid. Configure an HTTPS /v1/authorize URL."); }
  if (callback.protocol !== "https:" || callback.pathname !== "/v1/authorize" || callback.search || callback.hash || callback.username || callback.password) {
    throw new ManagedEgressPrerequisiteError("callback", "Managed egress callback must use HTTPS at exactly /v1/authorize with no user info, query, or fragment.");
  }
  if (!Number.isInteger(config.listenerPort) || config.listenerPort < 1 || config.listenerPort > 65535) throw new ManagedEgressPrerequisiteError("configuration", "Managed egress listener port is invalid. Configure a port from 1 through 65535.");
}

function resourceName(prefix: string, proxyId: string): string {
  return `${prefix}-${createHash("sha256").update(proxyId).digest("hex").slice(0, 16)}`;
}

/** Pure, inspectable topology. The provider does not execute it until lifecycle rollback/readiness support lands. */
export function buildDockerManagedEgressPlan(config: DockerManagedEgressConfig, request: ManagedEgressRequest): DockerManagedEgressPlan {
  validateDockerManagedEgressConfig(config);
  validateManagedEgressRequest(request);
  const suffix = request.identity.proxyId;
  const internalNetwork = resourceName("valet-egress-internal", suffix);
  const outboundNetwork = resourceName("valet-egress-outbound", suffix);
  const proxyContainer = resourceName("valet-egress-proxy", suffix);
  const tokenVolume = resourceName("valet-egress-token", suffix);
  const callback = new URL(config.callbackUrl);
  const proxyRunArgs = [
    "run", "-d", "--name", proxyContainer,
    "--network", internalNetwork,
    "--network-alias", "valet-egress-proxy",
    "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
    "--mount", `type=volume,src=${tokenVolume},dst=/run/valet-egress,readonly`,
    "--env", `HEMATITE_EXTERNAL_AUTHORIZATION_ENDPOINT=${config.callbackUrl}`,
    "--env", `HEMATITE_EXTERNAL_AUTHORIZATION_TOKEN_FILE=/run/valet-egress/token`,
    "--env", `HEMATITE_EXTERNAL_AUTHORIZATION_SESSION_ID=${request.identity.sessionId}`,
    "--env", `HEMATITE_EXTERNAL_AUTHORIZATION_WORKLOAD_ID=${request.identity.workloadId}`,
    "--label", `valet.dev/managed-egress-contract=${MANAGED_EGRESS_CONTRACT_VERSION}`,
    "--label", `valet.dev/managed-egress-proxy=${request.identity.proxyId}`,
    config.proxyArtifact,
  ];
  return {
    internalNetwork, outboundNetwork, proxyContainer, tokenVolume,
    createInternalNetworkArgs: ["network", "create", "--internal", internalNetwork],
    createOutboundNetworkArgs: ["network", "create", outboundNetwork],
    workloadNetworkArgs: ["--network", internalNetwork],
    proxyRunArgs,
    connectProxyOutboundArgs: ["network", "connect", outboundNetwork, proxyContainer],
    cleanupArgs: [
      ["rm", "-f", proxyContainer], ["volume", "rm", "-f", tokenVolume],
      ["network", "rm", outboundNetwork], ["network", "rm", internalNetwork],
    ],
  };
}
