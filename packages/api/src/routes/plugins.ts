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
import type { ListPluginsResponse, PluginActionSummary, PluginServiceSummary, PluginSummary } from "../wire/types.js";

export const pluginsRouter = new Hono<AppEnv>();

pluginsRouter.get("/", async (c) => {
  const { plugins, engineCredentials } = c.var.providers;
  const owner: CredentialOwner = { type: "user", id: c.var.user.id };

  const connectedServices = new Set((await engineCredentials.list(owner)).map((cred) => cred.service));

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

    // Actions grouped by their credential-service key (`credentialService ??
    // service`) — matching `dynamicServices` above — so a `PluginServiceSummary`
    // exposes exactly the actions that ran under that connected credential.
    const actionsByService = new Map<string, PluginActionSummary[]>();
    for (const actionPlugin of actionPlugins) {
      const service = actionPlugin.credentialService ?? actionPlugin.service;
      const summaries: PluginActionSummary[] = actionPlugin.actions.map((a) => ({
        id: a.id,
        name: a.name,
        riskLevel: a.riskLevel,
      }));
      actionsByService.set(service, [...(actionsByService.get(service) ?? []), ...summaries]);
    }

    const services: PluginServiceSummary[] = (plugin.credentials ?? []).map((decl) => {
      const service = decl.service ?? plugin.name;
      return {
        service,
        type: decl.type,
        scopes: decl.scopes,
        connectLabel: decl.connectLabel,
        configKeys: decl.configKeys,
        connected: connectedServices.has(service),
        dynamic: dynamicServices.has(service) ? true : undefined,
        actions: actionsByService.get(service) ?? [],
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
