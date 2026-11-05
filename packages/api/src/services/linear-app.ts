import type { CredentialStore } from "@valet/engine";

/** The organization's Linear application: client ID (metadata) and client
 * secret (apiKey). The app's webhook signing secret lives on the
 * `LINEAR_CREDENTIAL_SERVICE` row, where the ingress reads it. */
export const LINEAR_APP_SERVICE = "linear_app";

/** The organization's app-actor token row. Its metadata carries the webhook
 * signing secret the ingress verifies with, the workspace ID, and the token
 * expiry (`tokenExpiresAt`). */
export const LINEAR_CREDENTIAL_SERVICE = "linear";

/** Marks an org `linear` row whose token Valet mints with `client_credentials`,
 * so `LinearAppTokenStore` knows it may mint a replacement. */
export const LINEAR_CLIENT_CREDENTIALS_GRANT = "client_credentials";

export interface LinearAppConfig {
  clientId: string;
  clientSecret: string;
  /** Stamped by each connect on the app and on its token, so a token renewal
   * can tell that a reconnect replaced the connection it renewed. Absent on
   * connections saved before the stamp. */
  connectionId?: string;
}

/** Reads the organization's saved Linear application. Deployment environment
 * variables are no longer a fallback: like Slack, the app belongs to the
 * organization and an admin saves it in Organization settings > Linear. */
export async function loadLinearAppConfig(credentials: CredentialStore, orgId: string): Promise<LinearAppConfig | null> {
  const saved = await credentials.get({ type: "org", id: orgId }, LINEAR_APP_SERVICE);
  const clientId = saved?.metadata?.clientId;
  if (typeof clientId !== "string" || !clientId.trim() || !saved?.apiKey?.trim()) return null;
  const connectionId = typeof saved.metadata?.connectionId === "string" ? saved.metadata.connectionId : undefined;
  return { clientId, clientSecret: saved.apiKey, ...(connectionId ? { connectionId } : {}) };
}
