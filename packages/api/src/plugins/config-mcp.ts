/**
 * Config-declared MCP servers → synthesized `ValetPlugin`s.
 *
 * The instance config's `mcpServers` list names remote MCP servers the
 * operator wants as action services without shipping a plugin package
 * (docs/specs/2026-08-14-instance-config-design.md). Each entry becomes one
 * plugin wrapping `mcpActionPlugin`, so it rides every existing seam:
 * dynamic action discovery, the connect UI (`/api/plugins`), MCP OAuth
 * dynamic registration, tool policies, and approvals.
 *
 * Plugin names carry a `mcp-config:` prefix so a config entry can never
 * silently dedupe against a bundled plugin's name in `assemblePlugins`
 * (first source wins on name). A SERVICE collision with a bundled plugin
 * still throws there, naming both plugins — that is the wanted failure for
 * an entry that shadows e.g. `linear`.
 */
import { mcpActionPlugin } from "@valet/sdk/mcp";
import type { CredentialDeclaration, ValetPlugin } from "@valet/engine";
import { InstanceConfigError, type McpServerDecl } from "../config/instance-config.js";

/** `name:` prefix for synthesized plugins; keeps them apart from packages. */
export const CONFIG_MCP_PLUGIN_PREFIX = "mcp-config:";

/**
 * Builds one plugin per enabled entry. Fail-fast at boot: a `bearer` entry
 * whose env var is unset throws `InstanceConfigError` with the fix, because
 * the alternative is a service that lists no tools with nothing in the log.
 */
export function configMcpPlugins(
  entries: readonly McpServerDecl[] | undefined,
  env: NodeJS.ProcessEnv,
): ValetPlugin[] {
  if (!entries) return [];
  return entries.filter((entry) => entry.enabled !== false).map((entry) => buildPlugin(entry, env));
}

function buildPlugin(entry: McpServerDecl, env: NodeJS.ProcessEnv): ValetPlugin {
  let staticToken: string | undefined;
  if (entry.auth === "bearer") {
    const token = env[entry.tokenEnv ?? ""]?.trim();
    if (!token) {
      throw new InstanceConfigError(
        `mcpServers "${entry.name}": env var ${entry.tokenEnv} is not set. Set it, or remove the entry.`,
      );
    }
    staticToken = token;
  }

  const credentials: CredentialDeclaration[] = [];
  if (entry.auth === "oauth") {
    credentials.push({
      service: entry.name,
      type: "oauth2",
      configKeys: ["accessToken"],
      oauth: { mode: "mcp", serverUrl: entry.url },
    });
  } else if (entry.auth === "api_key") {
    credentials.push({
      service: entry.name,
      type: "api_key",
      configKeys: ["accessToken"],
      connectLabel: entry.connectLabel ?? `${entry.name} API key`,
    });
  }

  const plugin: ValetPlugin = {
    name: `${CONFIG_MCP_PLUGIN_PREFIX}${entry.name}`,
    version: "0.0.0",
    description: entry.description ?? `Config-declared MCP server (${entry.url})`,
    actions: [
      mcpActionPlugin({
        mcpUrl: entry.url,
        serviceName: entry.name,
        defaultRiskLevel: entry.riskLevel ?? "medium",
        noAuth: entry.auth === "none",
        staticToken,
        authQueryParam: entry.authQueryParam,
        description: entry.description,
      }),
    ],
  };
  if (credentials.length > 0) plugin.credentials = credentials;
  return plugin;
}
