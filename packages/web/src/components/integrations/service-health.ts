/**
 * What a connected service's credential is worth, read from the health
 * fields `GET /api/plugins` ships (`PluginServiceSummary.health`).
 *
 * `connected` alone is set membership in the credential store: a revoked or
 * expired token keeps the row, so the card said "Connected" while the agent
 * dropped the service from `list_tools` and skipped the work. These states
 * name the difference, and each broken state names the action that fixes
 * it.
 *
 * The server reads the credential row and calls no vendor, so this covers
 * what the row records — an expiry the grant reported, a refresh that
 * failed, a grant that carries identity only. A token the vendor revoked
 * early still reads as `connected` until a refresh fails. See the health
 * doc comment on `PluginServiceSummary`.
 */
import type { CredentialSummary, PluginServiceSummary } from "@valet/api/wire";

export type ServiceHealth =
  | "disconnected"
  | "connected"
  | "expired"
  | "refresh-failed"
  | "identity-only";

/**
 * A refresh failure outranks an expiry, and both outrank a scope problem: a
 * token that cannot refresh will not recover on its own, and a token you
 * cannot use makes its scopes moot.
 */
export function serviceHealth(service: PluginServiceSummary, now: number = Date.now()): ServiceHealth {
  if (!service.connected) return "disconnected";
  const health = service.health;
  if (!health) return "connected";
  if (health.refreshFailed) return "refresh-failed";
  if (typeof health.expiresAt === "number" && health.expiresAt <= now) return "expired";
  if (health.identityOnly) return "identity-only";
  return "connected";
}

/**
 * The health of one stored credential row, for lists that read
 * `CredentialSummary` and not the plugin catalog. A past `expiresAt` is no
 * failure here: an OAuth row with a refresh token renews when it is used,
 * so only a failed refresh or a sign-in-only grant needs a repair.
 */
export function credentialRowHealth(row: Pick<CredentialSummary, "refreshFailedAt" | "identityOnly">): ServiceHealth {
  if (typeof row.refreshFailedAt === "number") return "refresh-failed";
  if (row.identityOnly) return "identity-only";
  return "connected";
}

/**
 * A row Valet has stopped using: its last refresh failed and its token is
 * past expiry. Any team member may reconnect a team connection in this state
 * (the server's `isDeadConnection`).
 */
export function isDeadConnection(row: Pick<CredentialSummary, "refreshFailedAt" | "expiresAt">, now: number = Date.now()): boolean {
  return typeof row.refreshFailedAt === "number" && typeof row.expiresAt === "number" && row.expiresAt <= now;
}

/** True when the connection is present but unusable, so the card must offer
 * a repair and not only a disconnect. */
export function needsReauth(health: ServiceHealth): boolean {
  return health === "expired" || health === "refresh-failed" || health === "identity-only";
}

export interface HealthBadge {
  label: string;
  variant: "success" | "warning" | "danger";
}

export function healthBadge(health: ServiceHealth): HealthBadge | null {
  switch (health) {
    case "connected":
      return { label: "Connected", variant: "success" };
    case "expired":
      return { label: "Expired", variant: "danger" };
    case "refresh-failed":
      return { label: "Refresh failed", variant: "danger" };
    case "identity-only":
      return { label: "Sign-in only", variant: "warning" };
    case "disconnected":
      return null;
  }
}

/** The corrective action, in the words the reader acts on. */
export function healthNote(health: ServiceHealth): string | null {
  switch (health) {
    case "expired":
      return "The access token expired. Select Reconnect to sign in again.";
    case "refresh-failed":
      return "The last token refresh failed. Select Reconnect to sign in again.";
    case "identity-only":
      return "This connection gives sign-in only. Select Reconnect to add the permissions the tools need.";
    case "connected":
    case "disconnected":
      return null;
  }
}
