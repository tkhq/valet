/** `/integrations`, personal and team: long service names, many shares of one
 * service, and every broken state (expired, refresh failed, sign-in only,
 * dead, broken share, needs setup). */
import type {
  CredentialSummary,
  ListCredentialsResponse,
  ListPluginsResponse,
  ListToolPermissionsResponse,
  OrgDirectoryResponse,
  PluginActionSummary,
  PluginServiceSummary,
  PluginSummary,
  WorkspaceIntegrationLimitResponse,
} from "@valet/api/wire";
import { DAY, EMOJI, HEX_300, HOUR, LONG_ACTION, LONG_SERVICE, NOW, TITLE_400, URL_300, memberId, teamId, unbroken } from "./common";

/** The team the team integrations list shows. */
export const INTEGRATIONS_TEAM_ID = teamId(5);

function actions(service: string, count: number): PluginActionSummary[] {
  return Array.from({ length: count }, (_, i) => ({
    id: i === 0 ? LONG_ACTION : `action_${i}`,
    name: i === 0 ? `${service}: ${TITLE_400.slice(0, 120)}` : `Action ${i}`,
    riskLevel: (["low", "medium", "high", "critical"] as const)[i % 4]!,
    requiresApproval: i % 2 === 0,
  }));
}

function service(name: string, overrides: Partial<PluginServiceSummary> = {}): PluginServiceSummary {
  return {
    service: name,
    type: "oauth2",
    configKeys: ["client_id", "client_secret"],
    connected: true,
    connect: "oauth",
    actions: actions(name, 6),
    toolCount: 6,
    ...overrides,
  };
}

function plugin(name: string, services: PluginServiceSummary[], overrides: Partial<PluginSummary> = {}): PluginSummary {
  return {
    name,
    version: "1.0.0",
    description: `${TITLE_400.slice(0, 200)} ${URL_300}`,
    actionCount: services.reduce((sum, s) => sum + s.actions.length, 0),
    services,
    ...overrides,
  };
}

/** Each plugin shows one row state. */
export const stressPlugins: ListPluginsResponse = {
  plugins: [
    plugin(LONG_SERVICE, [service(LONG_SERVICE, { health: { login: `finance-bot@${unbroken("subsidiary", 40)}.example.com` } })], {
      displayName: `Enterprise Resource Planning Connector for Regional Finance and Procurement Teams ${EMOJI}`,
    }),
    plugin("expired-service", [service("expired-service", { health: { expiresAt: NOW - DAY, login: "member-00" } })]),
    plugin("refresh-failed", [service("refresh-failed", { health: { refreshFailed: true, login: HEX_300 } })]),
    plugin("identity-only", [service("identity-only", { health: { identityOnly: true } })]),
    plugin("needs-setup", [service("needs-setup", { connect: "unconfigured", connected: true, connectBlockedBy: "org" })]),
    plugin("org-provided", [service("org-provided", { connect: "org", connected: false })]),
    plugin("missing-env", [service("missing-env", {
      connect: "unconfigured", connected: false, connectBlockedBy: "deployment",
      missingEnv: Array.from({ length: 6 }, (_, i) => `VALET_${unbroken("VERY_LONG_ENVIRONMENT_VARIABLE_NAME_", 70)}${i}`),
    })]),
    plugin(`${unbroken("unbrokenservicename", 120)}`, [service(unbroken("unbrokenservicename", 120), { connected: false })]),
    plugin("mcp:remote-server-with-a-colon-name-that-shows-as-is", [service("mcp:remote-server-with-a-colon-name-that-shows-as-is", {
      connected: false, dynamic: true, connect: "manual", type: "api_key",
    })], { dynamic: true }),
    plugin("many-services", Array.from({ length: 8 }, (_, i) => service(`many-services-${i}`, {
      connected: i % 2 === 0,
      health: i === 2 ? { refreshFailed: true } : i === 4 ? { expiresAt: NOW - HOUR } : undefined,
    }))),
    ...Array.from({ length: 10 }, (_, i) => plugin(`available-${i}`, [service(`available-${i}`, { connected: false })], {
      displayName: i % 2 === 0 ? `Available integration ${i} ${TITLE_400.slice(0, 80)}` : undefined,
    })),
  ],
};

/** Personal credentials, plus orphans whose plugin is gone. */
export const stressUserCredentials: ListCredentialsResponse = {
  credentials: [
    ...stressPlugins.plugins.flatMap((p) => p.services.filter((s) => s.connected).map((s): CredentialSummary => ({
      service: s.service,
      type: s.type,
      connectedAt: new Date(NOW - 30 * DAY).toISOString(),
      login: s.health?.login,
      expiresAt: s.health?.expiresAt,
      identityOnly: s.health?.identityOnly,
      refreshFailedAt: s.health?.refreshFailed ? NOW - HOUR : undefined,
    }))),
    ...Array.from({ length: 4 }, (_, i): CredentialSummary => ({
      service: `orphaned-${unbroken("removedplugin", 60)}-${i}`,
      type: "api_key",
      connectedAt: new Date(NOW - 90 * DAY).toISOString(),
      refreshFailedAt: i % 2 === 0 ? NOW - DAY : undefined,
      onepasswordRef: i === 1 ? `op://vault/${HEX_300.slice(0, 80)}/credential` : undefined,
    })),
  ],
};

export const SHARE_COUNT = 24;

/** Team credentials: one service shared by 24 members, the team's own dead
 * connection, a broken share, and refresh-failed and sign-in-only rows. */
export const stressTeamCredentials: ListCredentialsResponse = {
  credentials: [
    ...Array.from({ length: SHARE_COUNT }, (_, i): CredentialSummary => ({
      service: LONG_SERVICE,
      type: "oauth2",
      connectedAt: new Date(NOW - i * DAY).toISOString(),
      login: `member-${String(i + 1).padStart(2, "0")}@example.com`,
      delegatedFrom: memberId(i + 1),
      referenceBroken: i === 5 ? true : undefined,
      refreshFailedAt: i === 9 ? NOW - HOUR : undefined,
      identityOnly: i === 13 ? true : undefined,
    })),
    { service: LONG_SERVICE, type: "oauth2", connectedAt: new Date(NOW - 2 * DAY).toISOString(), dead: true, refreshFailedAt: NOW - 2 * HOUR },
    { service: "expired-service", type: "oauth2", connectedAt: new Date(NOW - DAY).toISOString(), dead: true },
    { service: "github", type: "oauth2", connectedAt: new Date(NOW - DAY).toISOString(), delegatedFrom: memberId(28), referenceBroken: true },
    { service: "slack", type: "bot_token", connectedAt: new Date(NOW - DAY).toISOString(), identityOnly: true, login: unbroken("workspace", 90) },
  ],
};

/** Members for "Shared by …". Some share ids are missing on purpose, so a
 * row falls back to the raw id. */
export const stressOrgDirectory: OrgDirectoryResponse = {
  users: Array.from({ length: 20 }, (_, i) => ({
    userId: memberId(i),
    email: `member-${String(i).padStart(2, "0")}@example.com`,
    name: i % 4 === 1 ? `member-${String(i).padStart(2, "0")} ${unbroken("Longdisplayname", 70)}` : memberId(i),
    avatarUrl: null,
  })),
};

export const stressIntegrationLimit: WorkspaceIntegrationLimitResponse = {
  services: [LONG_SERVICE, "github", "slack", ...Array.from({ length: 15 }, (_, i) => `limited-service-${i}`)],
};

export const stressToolPermissions: ListToolPermissionsResponse = {
  tools: stressPlugins.plugins.flatMap((p) => p.services.flatMap((s) => s.actions.map((a) => ({
    service: s.service,
    actionId: a.id,
    name: a.name,
    description: TITLE_400,
    riskLevel: a.riskLevel,
    mode: a.requiresApproval ? "require_approval" as const : "allow" as const,
    source: "plugin" as const,
    overridden: false,
    settable: ["allow" as const, "require_approval" as const, "deny" as const],
  })))),
};
