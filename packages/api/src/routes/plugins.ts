/**
 * `/api/plugins` — read-only manifest surface for the connect UI
 * (plugin-system-v2 plan Task 15). Reflects `providers.plugins` (the
 * assembled `ValetPlugin[]` — see `plugins/assemble.ts`) merged with the
 * caller's own connected-service set from `providers.engineCredentials`.
 *
 * Never returns secret material — only which services are connected, not
 * their tokens. See `routes/credentials.ts` for the mutation surface. The
 * same rule holds for `missingEnv`, which carries deployment variable
 * NAMES read off the plugin manifest so an org admin learns what to set;
 * the values behind those names are read only as a presence test and never
 * enter the response.
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
import {
  approvalModeForAction,
  type ActionPlugin,
  type CredentialOwner,
  type PluginAction,
  type StoredCredential,
} from "@valet/engine";
import { qualifiedActionId } from "../plugins/action-id.js";
import type { AppEnv } from "../env.js";
import type {
  ListPluginsResponse,
  PluginActionServiceSummary,
  PluginActionSummary,
  PluginServiceSummary,
  PluginSummary,
} from "../wire/types.js";
import { connectModeFor, missingClientEnv } from "../services/integration-availability.js";
import { isOrgAdmin } from "../services/org.js";
import { pluginIconSlugs } from "../plugins/registry.gen.js";

export const pluginsRouter = new Hono<AppEnv>();

/**
 * One action's wire summary — the ONE place the fqid and requiresApproval
 * derivations live. Both response blocks (`services[].actions`, grouped by
 * credential key, and `actionServices[].actions`, grouped by routing
 * service) map through this, so the Policies UI and the assistant editor
 * can never disagree on an action's id or approval flag.
 */
function toActionSummary(actionPlugin: ActionPlugin, action: PluginAction): PluginActionSummary {
  return {
    // `id` is the fully-qualified fqid (`{plugin service}.{action}`, the
    // plugin-catalog convention) — the canonical policy-facing id both
    // invocation paths resolve to, so the Policies UI creates action-scope
    // rows that actually match at resolution time.
    id: qualifiedActionId(actionPlugin.service, action),
    name: action.name,
    riskLevel: action.riskLevel,
    requiresApproval:
      approvalModeForAction(action.riskLevel, actionPlugin.defaultApprovalMode) ===
      "require_approval",
  };
}

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
  const { plugins, engineCredentials, actionPluginByService, dynamicToolCounts, db } = c.var.providers;
  const owner: CredentialOwner = { type: "user", id: c.var.user.id };

  // Who may read WHY a service is unconfigured. `org_members.role` is the
  // authority (`services/org.ts`), not the global JWT role. Read once per
  // request, not per service: it is a database row, and every service in
  // the response asks the same question about the same caller.
  const callerIsOrgAdmin = await isOrgAdmin(db, c.var.user.orgId, c.var.user.id);

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
    // reach: a plugin whose credential declaration names a key none of its
    // actions read must resolve to nothing here, not to that plugin's
    // whole action list.
    const actionsByCredentialKey = new Map<string, PluginActionSummary[]>();
    for (const actionPlugin of actionPlugins) {
      const key = actionPlugin.credentialService ?? actionPlugin.service;
      const unlocked = actionsByCredentialKey.get(key) ?? [];
      for (const action of actionPlugin.actions) {
        unlocked.push(toActionSummary(actionPlugin, action));
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
      // Availability (integration-availability design): "oauth", "manual",
      // "org" when the org credential provides the service with nothing for
      // the user to connect, or "unconfigured" when the deployment/org
      // prerequisite is missing. Same resolver the save/session/workflow
      // gates use.
      const connect = await connectModeFor({
        plugins,
        decl,
        service,
        orgId: c.var.user.orgId,
        credentials: engineCredentials,
        env: process.env,
      });
      // Two things about an unconfigured service, with two audiences.
      //
      // The CAUSE goes to everybody, because the note each reader sees must
      // send them to the right place. Rule 3 (no OAuth client in this
      // deployment) is the only unconfigured arm with an environment
      // variable behind it, so a name in `missing` is what separates it
      // from rule 4's org credential.
      //
      // The variable NAMES go to an org admin only. Everybody else gets no
      // key at all, and the client hides the tile as before. The gate is
      // here rather than in the browser so a member cannot read the names
      // out of the response.
      const missing =
        connect === "unconfigured" ? missingClientEnv(plugins, service, process.env) : [];
      const connectBlockedBy: PluginServiceSummary["connectBlockedBy"] =
        connect !== "unconfigured" ? undefined : missing.length > 0 ? "deployment" : "org";
      const missingEnv = callerIsOrgAdmin ? missing : [];
      return {
        service,
        type: decl.type,
        scopes: decl.scopes,
        connectLabel: decl.connectLabel,
        configKeys: decl.configKeys,
        connected: connectedServices.has(service),
        dynamic: dynamicServices.has(service) ? true : undefined,
        connect,
        connectBlockedBy,
        missingEnv: missingEnv.length > 0 ? missingEnv : undefined,
        toolCount: toolCounts.get(service),
        // The slug is declared per plugin (`plugin.yaml`), so every service a
        // plugin declares shares its plugin's mark. A service that names
        // itself takes its own slug when one exists.
        iconSlug: pluginIconSlugs[service] ?? pluginIconSlugs[plugin.name],
        health: health.get(service),
        actions: actionsByCredentialKey.get(service) ?? [],
      };
    }));

    const actionServices: PluginActionServiceSummary[] = actionPlugins.map((actionPlugin) => ({
      service: actionPlugin.service,
      ...(actionPlugin.resolveActions !== undefined ? { dynamic: true as const } : {}),
      actions: actionPlugin.actions.map((action) => toActionSummary(actionPlugin, action)),
    }));

    return {
      name: plugin.name,
      version: plugin.version,
      displayName: plugin.displayName,
      description: plugin.description,
      actionCount,
      dynamic: dynamicServices.size > 0 ? true : undefined,
      services,
      actionServices,
    };
  }));

  const resp: ListPluginsResponse = { plugins: summaries };
  return c.json(resp);
});
