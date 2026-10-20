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
    // `validateMcpServers` guarantees tokenEnv on bearer entries, but this
    // function also accepts hand-built decls (tests, future callers) — a
    // missing name must say so, not report `env var undefined is not set`.
    if (!entry.tokenEnv) {
      throw new InstanceConfigError(
        `mcpServers "${entry.name}": auth is "bearer" but tokenEnv is missing. Set tokenEnv to the env var that holds the token.`,
      );
    }
    const token = env[entry.tokenEnv]?.trim();
    if (!token) {
      throw new InstanceConfigError(
        `mcpServers "${entry.name}": env var ${entry.tokenEnv} is not set. Set it, or remove the entry.`,
      );
    }
    staticToken = token;
  }

  const displayName = configMcpDisplayName(entry);

  const credentials: CredentialDeclaration[] = [];
  if (entry.auth === "oauth") {
    credentials.push({
      service: entry.name,
      type: "oauth2",
      // Forwarded into the authorize request by the connect route. A
      // scope-gated server (e.g. Metabase) grants a token with no scopes
      // when the request names none, and then lists zero tools.
      ...(entry.scopes ? { scopes: entry.scopes } : {}),
      configKeys: ["accessToken"],
      oauth: { mode: "mcp", serverUrl: entry.url },
      ...(entry.oauthOnly ? { oauthOnly: true as const } : {}),
    });
  } else if (entry.auth === "api_key") {
    credentials.push({
      service: entry.name,
      type: "api_key",
      configKeys: ["accessToken"],
      connectLabel: entry.connectLabel ?? `${displayName} API key`,
    });
  }

  const plugin: ValetPlugin = {
    name: `${CONFIG_MCP_PLUGIN_PREFIX}${entry.name}`,
    version: "0.0.0",
    displayName,
    // The connect UI shows this text, so it carries the display URL: never
    // the userinfo or query string a server URL can hold a secret in.
    description: entry.description ?? `Config-declared MCP server (${configMcpDisplayUrl(entry.url)})`,
    actions: [
      {
        ...mcpActionPlugin({
          mcpUrl: entry.url,
          serviceName: entry.name,
          defaultRiskLevel: entry.riskLevel ?? "medium",
          noAuth: entry.auth === "none",
          staticToken,
          authQueryParam: entry.authQueryParam,
          // An oauth entry's `scopes` come from this file, so a missing
          // scope is fixed by editing the entry.
          scopesInConfig: entry.auth === "oauth",
          description: entry.description,
          // Rejection messages name the server the way the connect UI does.
          displayName,
          oauthOnly: entry.oauthOnly,
        }),
        // Approval cards name the account by this, as the connect UI does.
        displayName,
      },
    ],
  };
  if (credentials.length > 0) plugin.credentials = credentials;
  return plugin;
}

/**
 * The name the connect UI shows as the card title, and the org MCP server
 * list shows too. A missing displayName must still read like a product name,
 * not a slug.
 */
export function configMcpDisplayName(entry: Pick<McpServerDecl, "name" | "displayName">): string {
  return entry.displayName ?? titleCaseSlug(entry.name);
}

/**
 * The entry's URL as the org MCP server list shows it: scheme, host (with
 * port), and path only. Config validation accepts a URL with userinfo, a
 * query, or a fragment, and an operator can put a token in any of them
 * (`?key=...`, `user:token@host`). Those parts never leave the API.
 */
export function configMcpDisplayUrl(url: string): string {
  const parsed = new URL(url);
  return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
}

/** "grafana-cloud" → "Grafana Cloud" — the fallback when the entry names no
 * displayName. Slugs are validated lowercase, so each word just uppercases
 * its first letter. */
function titleCaseSlug(slug: string): string {
  return slug
    .split(/[-_]/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}
