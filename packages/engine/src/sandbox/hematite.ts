import type { ManagedEgressIdentity } from "./managed-egress.js";

export const HEMATITE_COMPATIBLE_SOURCE_COMMIT = "35cdd0bc8816afefb4012ba2f9ca66b927c1aa00" as const;
export const HEMATITE_COMPATIBLE_CONFIG_CONTRACT = "v1" as const;
/** The pinned source formats request IDs as 32 lowercase hex time digits, a dash, and 16 lowercase hex counter digits. */
export const HEMATITE_REQUEST_ID_PATTERN = /^[0-9a-f]{32}-[0-9a-f]{16}$/;

export function isHematiteRequestId(value: unknown): value is string {
  return typeof value === "string" && HEMATITE_REQUEST_ID_PATTERN.test(value);
}

export interface HematiteMaterialPaths {
  token: string;
  caCert: string;
  caKey: string;
}

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
export function renderHematiteManagedEgressConfig(
  config: HematiteManagedEgressConfig,
  identity: ManagedEgressIdentity,
  paths: HematiteMaterialPaths = {
    token: "/run/valet-egress/token",
    caCert: "/etc/hematite/certs/ca.crt",
    caKey: "/etc/hematite/certs/ca.key",
  },
): string {
  return [
    "proxy:",
    `  http_listen: ${yamlString(`0.0.0.0:${config.listenerPort}`)}`,
    `  https_listen: ${yamlString(`0.0.0.0:${config.httpsListenerPort}`)}`,
    `  tunnel_listen: ${yamlString(`0.0.0.0:${config.tunnelListenerPort}`)}`,
    "tls:",
    `  ca_cert: ${yamlString(paths.caCert)}`,
    `  ca_key: ${yamlString(paths.caKey)}`,
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
    `  token_file: ${yamlString(paths.token)}`,
    `  session_id: ${yamlString(identity.sessionId)}`,
    `  workload_id: ${yamlString(identity.workloadId)}`,
    '  timeout: "250ms"',
    "",
  ].join("\n");
}
