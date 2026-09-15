/**
 * Deployment configuration for commit signing: the Turnkey parent
 * organization and the API key Valet uses to create and manage the per-user
 * sub-organizations. Read from the environment, like the GitHub App and
 * Google OAuth credentials in `.env.example`.
 */

export interface TurnkeyDeploymentConfig {
  /** Parent organization that owns every `valet-signer-*` sub-organization. */
  organizationId: string;
  /** P-256 API key of a parent user allowed to create sub-organizations. */
  apiPublicKey: string;
  apiPrivateKey: string;
  /** `https://api.turnkey.com`, or a dev host. */
  apiBaseUrl: string;
}

export const TURNKEY_ENV = {
  organizationId: "VALET_TURNKEY_ORGANIZATION_ID",
  apiPublicKey: "VALET_TURNKEY_API_PUBLIC_KEY",
  apiPrivateKey: "VALET_TURNKEY_API_PRIVATE_KEY",
  apiBaseUrl: "VALET_TURNKEY_API_BASE_URL",
} as const;

export const DEFAULT_TURNKEY_API_BASE_URL = "https://api.turnkey.com";

export const NOT_CONFIGURED_MESSAGE =
  "Commit signing is not configured for this deployment. " +
  `Ask an admin to set ${TURNKEY_ENV.organizationId}, ${TURNKEY_ENV.apiPublicKey}, and ${TURNKEY_ENV.apiPrivateKey}.`;

/**
 * Reads the deployment config. Returns `null` when none of the variables is
 * set, so a deployment without signing loads the plugin and its actions
 * answer with `NOT_CONFIGURED_MESSAGE`. Throws when the set is partial: a
 * half-configured deployment is a mistake to surface at boot, not a feature
 * to hide.
 */
export function loadTurnkeyConfig(env: Record<string, string | undefined>): TurnkeyDeploymentConfig | null {
  const organizationId = env[TURNKEY_ENV.organizationId]?.trim() ?? "";
  const apiPublicKey = env[TURNKEY_ENV.apiPublicKey]?.trim() ?? "";
  const apiPrivateKey = env[TURNKEY_ENV.apiPrivateKey]?.trim() ?? "";
  const apiBaseUrl = env[TURNKEY_ENV.apiBaseUrl]?.trim() || DEFAULT_TURNKEY_API_BASE_URL;

  const required: Array<[string, string]> = [
    [TURNKEY_ENV.organizationId, organizationId],
    [TURNKEY_ENV.apiPublicKey, apiPublicKey],
    [TURNKEY_ENV.apiPrivateKey, apiPrivateKey],
  ];
  const missing = required.filter(([, value]) => value === "").map(([name]) => name);
  if (missing.length === required.length) return null;
  if (missing.length > 0) {
    throw new Error(`Commit signing is half configured. Set ${missing.join(", ")} or unset every VALET_TURNKEY_* variable.`);
  }
  return { organizationId, apiPublicKey, apiPrivateKey, apiBaseUrl };
}
