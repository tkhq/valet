/**
 * The integration limit a workspace carried over from its assistant's stored
 * `behavior` allow-list. A workspace now has one assistant and no per-assistant
 * editor, but dropping the allow-list on upgrade would hand that workspace
 * every entitled integration. So the limit keeps shaping the workspace's
 * assistant, the one session it shaped before, until an admin clears it.
 * Coding, child, and workflow sessions ignore it, as they did. Nothing
 * writes a new one.
 *
 * Like the editor it came from, this shapes capability; action policies and
 * approval gates stay the enforcement layer. A value that does not parse
 * applies no limit and is logged, so a bad row cannot stop the workspace.
 */
import { sql } from "drizzle-orm";
import type { ActionPlugin, PluginAction, Principal, ValetPlugin } from "@valet/engine";
import type { AppDb } from "../lib/drizzle.js";
import { qualifiedActionId } from "../plugins/action-id.js";

/** Allowed service → the action ids excluded within it. */
export type IntegrationLimit = ReadonlyMap<string, ReadonlySet<string>>;

export function parseIntegrationLimit(raw: string | null): IntegrationLimit | null {
  if (raw === null) return null;
  try {
    const integrations: unknown = (JSON.parse(raw) as { integrations?: unknown } | null)?.integrations;
    if (typeof integrations !== "object" || integrations === null || !("mode" in integrations) || integrations.mode !== "allowlist") return null;
    const entries = "entries" in integrations && Array.isArray(integrations.entries) ? integrations.entries : [];
    const limit = new Map<string, ReadonlySet<string>>();
    for (const entry of entries) {
      if (typeof entry !== "object" || entry === null || !("service" in entry) || typeof entry.service !== "string") continue;
      const excluded: unknown[] = "excludeActions" in entry && Array.isArray(entry.excludeActions) ? entry.excludeActions : [];
      limit.set(entry.service, new Set(excluded.filter((id): id is string => typeof id === "string")));
    }
    return limit;
  } catch (err) {
    console.warn(`[integration-limit] stored allow-list does not parse (${String(err)}); applying no limit`);
    return null;
  }
}

export async function loadIntegrationLimit(db: AppDb, orgId: string, owner: Principal): Promise<IntegrationLimit | null> {
  // `behavior` stays in the table for a rollback but left the Drizzle schema.
  const result = await db.execute(sql`SELECT behavior FROM assistants WHERE org_id = ${orgId}
    AND owner_type = ${owner.type} AND owner_id = ${owner.id} AND archived_at IS NULL LIMIT 1`) as { rows: Array<{ behavior: string | null }> };
  return parseIntegrationLimit(result.rows[0]?.behavior ?? null);
}

/** Clears the limit. The caller evicts the workspace's cached sessions. */
export async function clearIntegrationLimit(db: AppDb, orgId: string, owner: Principal): Promise<void> {
  await db.execute(sql`UPDATE assistants SET behavior = NULL
    WHERE org_id = ${orgId} AND owner_type = ${owner.type} AND owner_id = ${owner.id}`);
}

/**
 * The plugins with only the limit's services and actions. A pinned action is
 * host substrate (the workflow editor saves through one), so it is kept even
 * when its service is outside the limit. A plugin keeps its skills either way.
 */
export function limitPlugins(plugins: ValetPlugin[], limit: IntegrationLimit, pinned: ReadonlySet<string>): ValetPlugin[] {
  return plugins.map((plugin) => ({
    ...plugin,
    actions: (plugin.actions ?? []).flatMap((actionPlugin): ActionPlugin[] => {
      const excluded = limit.get(actionPlugin.service);
      const keep = (action: PluginAction) => {
        const id = qualifiedActionId(actionPlugin.service, action);
        return pinned.has(id) || (excluded !== undefined && !excluded.has(id));
      };
      const kept: ActionPlugin = {
        ...actionPlugin,
        actions: actionPlugin.actions.filter(keep),
        ...(actionPlugin.resolveActions ? { resolveActions: async (ctx) => (await actionPlugin.resolveActions!(ctx)).filter(keep) } : {}),
      };
      return excluded === undefined && kept.actions.length === 0 ? [] : [kept];
    }),
  }));
}
