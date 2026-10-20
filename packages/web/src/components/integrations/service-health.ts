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
 * Most states come from what the credential row records: an expiry the
 * grant reported, a refresh that failed, a grant that carries identity
 * only. Two come from the server's live tool listing of an MCP service
 * (`plugins/service-probe.ts`): the service refused the connection, or the
 * grant lacks scopes some tools need. A token the vendor revoked early on a
 * service that is not listed live still reads as `connected` until a
 * refresh fails. See the health doc comment on `PluginServiceSummary`.
 */
import type { CredentialSummary, PluginServiceSummary } from "@valet/api/wire";

export type ServiceHealth =
  | "disconnected"
  | "connected"
  | "expired"
  | "refresh-failed"
  | "rejected"
  | "identity-only"
  | "missing-scope";

/**
 * A refresh failure outranks an expiry, and both outrank the service's own
 * refusal, which outranks a scope problem: a token that cannot refresh will
 * not recover on its own, an expired token is refused for that reason, and
 * a token you cannot use makes its scopes moot.
 */
export function serviceHealth(service: PluginServiceSummary, now: number = Date.now()): ServiceHealth {
  if (!service.connected) return "disconnected";
  const health = service.health;
  if (!health) return "connected";
  if (health.refreshFailed) return "refresh-failed";
  if (typeof health.expiresAt === "number" && health.expiresAt <= now) return "expired";
  if (health.rejected) return "rejected";
  if (health.identityOnly) return "identity-only";
  if (health.missingScopes && health.missingScopes.length > 0) return "missing-scope";
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
 * True for the team's own connection in a team list: not a member's share,
 * and not a row that no run uses (`CredentialSummary.unusable`).
 * The delegate route refuses a new share of a service that has one.
 */
export function isTeamOwnConnection(row: Pick<CredentialSummary, "delegatedFrom" | "unusable">): boolean {
  return !row.delegatedFrom && row.unusable !== true;
}

/** True when the connection is present but unusable, so the card must offer
 * a repair and not only a disconnect. */
export function needsReauth(health: ServiceHealth): boolean {
  return (
    health === "expired" ||
    health === "refresh-failed" ||
    health === "rejected" ||
    health === "identity-only" ||
    health === "missing-scope"
  );
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
    case "rejected":
      return { label: "Rejected", variant: "danger" };
    case "identity-only":
      return { label: "Sign-in only", variant: "warning" };
    case "missing-scope":
      return { label: "Missing scopes", variant: "warning" };
    case "disconnected":
      return null;
  }
}

/** The corrective action, in the words the reader acts on. `probe` names
 * the scopes for `missing-scope`. */
export function healthNote(
  health: ServiceHealth,
  probe?: Pick<NonNullable<PluginServiceSummary["health"]>, "missingScopes" | "blockedTools">,
): string | null {
  switch (health) {
    case "expired":
      return "The access token expired. Select Reconnect to sign in again.";
    case "refresh-failed":
      return "The last token refresh failed. Select Reconnect to sign in again.";
    case "rejected":
      return "The service refused this connection when Valet listed its tools. Select Reconnect to sign in again.";
    case "identity-only":
      return "This connection gives sign-in only. Select Reconnect to add the permissions the tools need.";
    case "missing-scope":
      return missingScopeNote(probe?.missingScopes ?? [], probe?.blockedTools);
    case "connected":
    case "disconnected":
      return null;
  }
}

/**
 * A reconnect requests the same declared scopes, so the note sends the
 * reader to an admin first. `blockedTools` is absent when the service
 * refused the tool listing itself.
 */
function missingScopeNote(scopes: string[], blockedTools: number | undefined): string {
  if (scopes.length === 0) {
    return "This connection lacks scopes that some tools need. Ask an admin to add them to this integration's scopes. Then select Reconnect.";
  }
  const list = scopes.join(", ");
  const noun = scopes.length === 1 ? "scope" : "scopes";
  const need =
    blockedTools === undefined
      ? "which the service needs to list its tools"
      : `which ${blockedTools} ${blockedTools === 1 ? "tool needs" : "tools need"}`;
  return (
    `This connection does not hold the ${list} ${noun}, ${need}. ` +
    `Ask an admin to add ${list} to this integration's scopes. Then select Reconnect.`
  );
}
