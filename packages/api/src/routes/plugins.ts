/**
 * `/api/plugins` — read-only manifest surface for the connect UI
 * (plugin-system-v2 plan Task 15). Reflects `providers.plugins` (the
 * assembled `ValetPlugin[]` — see `plugins/assemble.ts`) merged with the
 * caller's own connected-service set from `providers.engineCredentials`.
 *
 * Never returns secret material — only which services are connected, not
 * their tokens. See `routes/credentials.ts` for the mutation surface.
 *
 * A connected service also reports `health`, read from the same four
 * whitelisted credential fields `GET /api/credentials` returns
 * (`expiresAt`, `metadata.login`, `metadata.identityOnly`,
 * `metadata.refreshFailedAt`). `connected` alone is set membership in the
 * credential store, so an expired or revoked token reads as connected while
 * `list_tools` hides the service. Health says otherwise, from what the
 * credential row already knows — this route calls no vendor.
 */
import { Hono } from "hono";
import { approvalModeForAction, type CredentialOwner, type StoredCredential } from "@valet/engine";
import type { AppEnv } from "../env.js";
import type {
  ListPluginsResponse,
  PluginActionSummary,
  PluginServiceSummary,
  PluginSummary,
} from "../wire/types.js";
import { connectModeFor } from "../services/integration-availability.js";
import { pluginIconSlugs } from "../plugins/registry.gen.js";

export const pluginsRouter = new Hono<AppEnv>();

/**
 * What the stored credential says about itself. Mirrors
 * `services/github-tokens.ts`'s health rules, minus the parts that need a
 * token exchange: this is a read of the row, not a probe of the vendor.
 * Absent fields mean "the grant reports nothing here", NOT "healthy" — a
 * PAT carries no `expiresAt` and never expires.
 */
function credentialHealth(stored: StoredCredential): PluginServiceSummary["health"] {
  const metadata = stored.metadata;
  return {
    expiresAt: stored.expiresAt,
    login: typeof metadata?.login === "string" ? metadata.login : undefined,
    refreshFailed: typeof metadata?.refreshFailedAt === "number" ? true : undefined,
    identityOnly: metadata?.identityOnly === true ? true : undefined,
  };
}

pluginsRouter.get("/", async (c) => {
  const { plugins, engineCredentials, actionPluginByService, dynamicToolCounts } = c.var.providers;
  const owner: CredentialOwner = { type: "user", id: c.var.user.id };

  const connectedServices = new Set((await engineCredentials.list(owner)).map((cred) => cred.service));

  // `list()` carries neither `expiresAt` nor `metadata`, so each connected
  // service is read back through `get()` for its health fields — the same
  // N+1 over a small per-user list `routes/credentials.ts` accepts, rather
  // than widening the `CredentialStore` port's `list` return shape.
  const health = new Map<string, PluginServiceSummary["health"]>();
  await Promise.all(
    [...connectedServices].map(async (service) => {
      const stored = await engineCredentials.get(owner, service);
      if (stored) health.set(service, credentialHealth(stored));
    }),
  );

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

  const summaries: PluginSummary[] = await Promise.all(plugins.map(async (plugin) => {
    const actionPlugins = plugin.actions ?? [];
    const actionCount = actionPlugins.reduce((sum, actionPlugin) => sum + actionPlugin.actions.length, 0);

    // Actions keyed by the credential they actually read. `invokeAction`
    // scopes a plugin's credential lookups to `credentialService ?? service`,
    // so that same expression is the only correct join between a credential
    // declaration and the tools connecting it unlocks. Anything looser (say,
    // grouping by plugin) would let a row advertise tools its token cannot
    // reach — google-calendar declares the credential as "google-calendar"
    // and reads "google_calendar", so it must resolve to nothing here.
    const actionsByCredentialKey = new Map<string, PluginActionSummary[]>();
    for (const actionPlugin of actionPlugins) {
      const key = actionPlugin.credentialService ?? actionPlugin.service;
      const unlocked = actionsByCredentialKey.get(key) ?? [];
      for (const action of actionPlugin.actions) {
        unlocked.push({
          // `id` is the fully-qualified fqid (`{plugin service}.{action}`, the
          // plugin-catalog convention) — the canonical policy-facing id both
          // invocation paths resolve to, so the Policies UI creates
          // action-scope rows that actually match at resolution time.
          id: action.id.includes(".") ? action.id : `${actionPlugin.service}.${action.id}`,
          name: action.name,
          riskLevel: action.riskLevel,
          requiresApproval:
            approvalModeForAction(action.riskLevel, actionPlugin.defaultApprovalMode) ===
            "require_approval",
        });
      }
      actionsByCredentialKey.set(key, unlocked);
    }
    // Service → whether any ActionPlugin claiming it declares `resolveActions`
    // (dynamic action discovery, e.g. an MCP-proxy-style plugin).
    const dynamicServices = new Set(
      actionPlugins
        .filter((actionPlugin) => actionPlugin.resolveActions !== undefined)
        .map((actionPlugin) => actionPlugin.credentialService ?? actionPlugin.service),
    );

    const services: PluginServiceSummary[] = await Promise.all((plugin.credentials ?? []).map(async (decl) => {
      const service = decl.service ?? plugin.name;
      // Tri-state availability (integration-availability design): "oauth",
      // "manual", or "unconfigured" when the deployment/org prerequisite is
      // missing. Same resolver the save/session/workflow gates use.
      const connect = await connectModeFor({
        plugins,
        decl,
        service,
        orgId: c.var.user.orgId,
        credentials: engineCredentials,
        env: process.env,
      });
      return {
        service,
        type: decl.type,
        scopes: decl.scopes,
        connectLabel: decl.connectLabel,
        configKeys: decl.configKeys,
        connected: connectedServices.has(service),
        dynamic: dynamicServices.has(service) ? true : undefined,
        connect,
        toolCount: toolCounts.get(service),
        // The slug is declared per plugin (`plugin.yaml`), so every service a
        // plugin declares shares its plugin's mark. A service that names
        // itself takes its own slug when one exists.
        iconSlug: pluginIconSlugs[service] ?? pluginIconSlugs[plugin.name],
        health: health.get(service),
        actions: actionsByCredentialKey.get(service) ?? [],
      };
    }));

    return {
      name: plugin.name,
      version: plugin.version,
      description: plugin.description,
      actionCount,
      dynamic: dynamicServices.size > 0 ? true : undefined,
      services,
    };
  }));

  const resp: ListPluginsResponse = { plugins: summaries };
  return c.json(resp);
});
