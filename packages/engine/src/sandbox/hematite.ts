import type { ManagedEgressIdentity } from "./managed-egress.js";

export const HEMATITE_COMPATIBLE_SOURCE_COMMIT = "35cdd0bc8816afefb4012ba2f9ca66b927c1aa00" as const;
export const HEMATITE_COMPATIBLE_CONFIG_CONTRACT = "v1" as const;

export interface HematiteManagedEgressConfig {
  callbackUrl: string;
  listenerPort: number;
  httpsListenerPort: number;
  tunnelListenerPort: number;
  allowlistDomains: string[];
  allowlistCidrs: string[];
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function yamlStringList(values: string[]): string {
  return `[${values.map(yamlString).join(", ")}]`;
}

/** Renders the closed Hematite v1 contract for the compatible source commit. */
export function renderHematiteManagedEgressConfig(config: HematiteManagedEgressConfig, identity: ManagedEgressIdentity): string {
  return [
    "proxy:",
    `  http_listen: ${yamlString(`0.0.0.0:${config.listenerPort}`)}`,
    `  https_listen: ${yamlString(`0.0.0.0:${config.httpsListenerPort}`)}`,
    `  tunnel_listen: ${yamlString(`0.0.0.0:${config.tunnelListenerPort}`)}`,
    "tls:",
    '  ca_cert: "/etc/hematite/certs/ca.crt"',
    '  ca_key: "/etc/hematite/certs/ca.key"',
    "dns:",
    "  enabled: false",
    "  passthrough: []",
    "  records: []",
    "transforms:",
    "  - name: allowlist",
    "    config:",
    `      domains: ${yamlStringList(config.allowlistDomains)}`,
    `      cidrs: ${yamlStringList(config.allowlistCidrs)}`,
    "external_authorization:",
    `  endpoint: ${yamlString(config.callbackUrl)}`,
    '  token_file: "/run/valet-egress/token"',
    `  session_id: ${yamlString(identity.sessionId)}`,
    `  workload_id: ${yamlString(identity.workloadId)}`,
    '  timeout: "250ms"',
    "",
  ].join("\n");
}
