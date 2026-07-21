/**
 * `/api/plugins` — read-only manifest surface for the connect UI
 * (plugin-system-v2 plan Task 15). Reflects `providers.plugins` (the
 * assembled `ValetPlugin[]` — see `plugins/assemble.ts`) merged with the
 * caller's own connected-service set from `providers.engineCredentials`.
 *
 * Never returns secret material — only which services are connected, not
 * their tokens. See `routes/credentials.ts` for the mutation surface.
 */
import { Hono } from "hono";
import type { CredentialOwner } from "@valet/engine";
import type { AppEnv } from "../env.js";
import type { ListPluginsResponse, PluginServiceSummary, PluginSummary } from "../wire/types.js";
import { findOAuthDeclaration, authCodeEnvReady } from "../services/integration-oauth.js";

export const pluginsRouter = new Hono<AppEnv>();

pluginsRouter.get("/", async (c) => {
  const { plugins, engineCredentials, actionPluginByService, dynamicToolCounts } = c.var.providers;
  const owner: CredentialOwner = { type: "user", id: c.var.user.id };

  const connectedServices = new Set((await engineCredentials.list(owner)).map((cred) => cred.service));

  // Connected dynamic services get a live-resolved tool count (TTL-cached,
  // fail-soft — see plugins/dynamic-tool-count.ts). Resolved up front and
  // concurrently so a slow MCP server costs one timeout, not one per row.
  const toolCounts = new Map<string, number>();
  await Promise.all(
    [...connectedServices].map(async (service) => {
      const entry = actionPluginByService.get(service);
      if (!entry?.actionPlugin.resolveActions) return;
      const count = await dynamicToolCounts.get(owner, service, entry.actionPlugin);
      if (count !== undefined) toolCounts.set(service, count);
    }),
  );

  const summaries: PluginSummary[] = plugins.map((plugin) => {
    const actionPlugins = plugin.actions ?? [];
    const actionCount = actionPlugins.reduce((sum, actionPlugin) => sum + actionPlugin.actions.length, 0);
    // Service → whether any ActionPlugin claiming it declares `resolveActions`
    // (dynamic action discovery, e.g. an MCP-proxy-style plugin).
    const dynamicServices = new Set(
      actionPlugins
        .filter((actionPlugin) => actionPlugin.resolveActions !== undefined)
        .map((actionPlugin) => actionPlugin.credentialService ?? actionPlugin.service),
    );

    const services: PluginServiceSummary[] = (plugin.credentials ?? []).map((decl) => {
      const service = decl.service ?? plugin.name;
      const found = findOAuthDeclaration(plugins, service);
      const oauthReady =
        found !== null &&
        (found.oauth.mode === "mcp" || authCodeEnvReady(found.oauth, process.env));
      return {
        service,
        type: decl.type,
        scopes: decl.scopes,
        connectLabel: decl.connectLabel,
        configKeys: decl.configKeys,
        connected: connectedServices.has(service),
        dynamic: dynamicServices.has(service) ? true : undefined,
        connect: oauthReady ? "oauth" : "manual",
        toolCount: toolCounts.get(service),
      };
    });

    return {
      name: plugin.name,
      version: plugin.version,
      description: plugin.description,
      actionCount,
      dynamic: dynamicServices.size > 0 ? true : undefined,
      services,
    };
  });

  const resp: ListPluginsResponse = { plugins: summaries };
  return c.json(resp);
});
