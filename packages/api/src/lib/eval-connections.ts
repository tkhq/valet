/**
 * Placeholder connections for product-drive eval cases.
 *
 * A scratch eval stack has no connected integrations, so the assistant's
 * catalog hides most services: Google services need OAuth client settings,
 * Slack needs an org bot token, and GitHub hides its actions until the
 * person connects it. A case that measures how the assistant builds with
 * an integration lists the service in `connected:`, and this module makes
 * the catalog show it as connected, with its action schemas.
 *
 * Every value is a placeholder. A call that reaches the real service fails
 * on authentication, so a case that only drafts work loses nothing.
 */
import type { CredentialStore, StoredCredential, ValetPlugin } from "@valet/engine";
import { bundledPlugins } from "../plugins/registry.gen.js";
import { findCredentialDeclaration } from "../services/integration-availability.js";
import { findOAuthDeclaration } from "../services/integration-oauth.js";

export const EVAL_PLACEHOLDER_SECRET = "eval-placeholder";

/**
 * Makes each action service in `services` look connected for `userId`.
 * Returns the names of the environment variables it set, so the caller can
 * remove them after the case. Refuses a service whose actions come from a
 * live server (an MCP integration): a placeholder token cannot list them.
 */
export async function connectEvalPlaceholders(params: {
  credentials: CredentialStore;
  userId: string;
  orgId: string;
  services: string[];
  env: Record<string, string | undefined>;
  plugins?: ValetPlugin[];
}): Promise<{ envNames: string[] }> {
  const plugins = params.plugins ?? bundledPlugins;
  // Check every service before changing anything, so a refusal leaves no
  // environment variable behind.
  const credentialServices = params.services.map((service) => {
    const actionPlugin = plugins.flatMap((plugin) => plugin.actions ?? []).find((entry) => entry.service === service);
    if (actionPlugin === undefined) {
      throw new Error(`connected: no plugin has the action service "${service}". Use an action service name, such as github or google_workspace.`);
    }
    if (actionPlugin.resolveActions !== undefined) {
      throw new Error(
        `connected: "${service}" lists its actions from a live server, and a placeholder token cannot list them. Remove it from connected.`,
      );
    }
    return actionPlugin.credentialService ?? service;
  });
  const envNames: string[] = [];
  try {
    for (const credentialService of credentialServices) {
      const oauth = findOAuthDeclaration(plugins, credentialService);
      if (oauth !== null && oauth.oauth.mode !== "mcp") {
        for (const name of [oauth.oauth.clientIdEnv, oauth.oauth.clientSecretEnv]) {
          if (params.env[name]) continue;
          params.env[name] = EVAL_PLACEHOLDER_SECRET;
          envNames.push(name);
        }
      }
      const declaration = findCredentialDeclaration(plugins, credentialService);
      if (declaration?.requires?.orgCredential) {
        const bot: StoredCredential = { type: "bot_token", accessToken: EVAL_PLACEHOLDER_SECRET };
        await params.credentials.save({ type: "org", id: params.orgId }, credentialService, bot);
      }
      const own: StoredCredential = { type: declaration?.type ?? "api_key", accessToken: EVAL_PLACEHOLDER_SECRET };
      await params.credentials.save({ type: "user", id: params.userId }, credentialService, own);
    }
  } catch (err) {
    // A failed credential write must not leave placeholder settings behind.
    for (const name of envNames) delete params.env[name];
    throw err;
  }
  return { envNames };
}
