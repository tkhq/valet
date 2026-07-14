import type { AppDb } from '../lib/drizzle.js';
import type { Env } from '../env.js';
import { integrationRegistry } from '../integrations/registry.js';
import { loadCustomMcpConnectorContext } from './custom-mcp-connectors.js';
import { listMcpToolCache } from '../lib/db/mcp-tool-cache.js';
import { zodToJsonSchema } from '../lib/zod-json-schema.js';

/**
 * Catalog entry describing a single integration action. Shape is stable
 * across the `GET /integrations/actions` endpoint and the workflow copilot's
 * `getActionSchema` tool — anything that changes must be reflected in both
 * the policy editor autocomplete and the copilot prompt guidance.
 */
export interface ActionCatalogEntry {
  service: string;
  serviceDisplayName: string;
  actionId: string;
  name: string;
  description: string;
  riskLevel: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
}

/**
 * Build the merged action catalog for a given (optional) service.
 *
 * Merges two sources with static (plugin-declared) winning over cache:
 *   1. Static plugin `listActions()` output from the integration registry.
 *   2. Cached MCP tool metadata in `mcp_tool_cache` (discovered at runtime
 *      by SessionAgentDO for MCP-backed services that require credentials
 *      to enumerate their tools).
 *
 * Passing `serviceFilter` restricts both sources to that service; without
 * a filter you get every action the worker knows about.
 */
export async function buildActionCatalog(
  env: Env,
  db: AppDb,
  serviceFilter?: string,
): Promise<ActionCatalogEntry[]> {
  const packages = integrationRegistry.listPackages();
  const customContext = await loadCustomMcpConnectorContext(env, db, 'default');

  // Build a lookup of provider display names by service for cache entries.
  const displayNameMap = new Map<string, string>();
  for (const pkg of packages) {
    displayNameMap.set(pkg.service, pkg.provider.displayName);
  }
  for (const connector of customContext.connectors.values()) {
    displayNameMap.set(connector.serviceSlug, connector.displayName);
  }

  const catalog: ActionCatalogEntry[] = [];

  // Track which service:actionId combos we've already added from static
  // sources so cache entries don't clobber them.
  const seen = new Set<string>();

  for (const pkg of packages) {
    if (serviceFilter && pkg.service !== serviceFilter) continue;
    // listActions may be async (e.g. MCP-backed sources). Without credentials
    // MCP sources return [] gracefully, which is fine for the catalog.
    const actions = await (pkg.actions?.listActions() ?? []);
    for (const a of actions) {
      const key = `${pkg.service}:${a.id}`;
      seen.add(key);
      // Fall back to converting the Zod `params` to JSON Schema when the
      // action doesn't ship an explicit inputSchema. Lets the workflow tool
      // node render typed parameters for every plugin action without each
      // one hand-authoring a duplicate schema.
      const inputSchema = a.inputSchema ?? zodToJsonSchema(a.params);
      catalog.push({
        service: pkg.service,
        serviceDisplayName: pkg.provider.displayName,
        actionId: a.id,
        name: a.name,
        description: a.description,
        riskLevel: a.riskLevel,
        ...(inputSchema && Object.keys(inputSchema).length > 0 ? { inputSchema } : {}),
        ...(a.outputSchema ? { outputSchema: a.outputSchema } : {}),
      });
    }
  }

  // Merge cached MCP tool metadata (discovered at runtime by SessionAgentDO).
  // This surfaces MCP-backed tools that can't be listed without credentials.
  try {
    const cached = await listMcpToolCache(db, serviceFilter ?? undefined);
    for (const entry of cached) {
      if (!integrationRegistry.isBuiltinService(entry.service) && !customContext.connectors.has(entry.service)) {
        continue;
      }
      const key = `${entry.service}:${entry.actionId}`;
      if (seen.has(key)) continue; // static source already provided this tool
      seen.add(key);
      catalog.push({
        service: entry.service,
        serviceDisplayName: displayNameMap.get(entry.service) ?? entry.service,
        actionId: entry.actionId,
        name: entry.name,
        description: entry.description,
        riskLevel: entry.riskLevel,
        ...(entry.inputSchema ? { inputSchema: entry.inputSchema } : {}),
        ...(entry.outputSchema ? { outputSchema: entry.outputSchema } : {}),
      });
    }
  } catch (err) {
    // Cache read failure is non-fatal — static catalog still works.
    console.warn('[action-catalog] mcp tool cache read failed:', err instanceof Error ? err.message : String(err));
  }

  return catalog;
}

/**
 * Build a service→actionId lookup for the workflow validator's
 * `knownToolActions` context field. Reuses `buildActionCatalog` so the
 * validator sees exactly the same tools the copilot and policy editor
 * do — no drift, no invisible mismatches.
 *
 * Returns a Map so lookups are O(1) inside the validator loop.
 */
export async function buildKnownToolActions(env: Env, db: AppDb): Promise<Map<string, Set<string>>> {
  const catalog = await buildActionCatalog(env, db);
  const known = new Map<string, Set<string>>();
  for (const entry of catalog) {
    let actions = known.get(entry.service);
    if (!actions) {
      actions = new Set<string>();
      known.set(entry.service, actions);
    }
    actions.add(entry.actionId);
  }
  return known;
}

/**
 * Look up a single action within a service, or `null` if it doesn't exist.
 * Thin wrapper on top of `buildActionCatalog` — the filter and lookup happen
 * in memory because both catalog sources are small enough that a full build
 * per lookup is fine, and reusing the same code path guarantees the copilot
 * sees exactly the entries the policy editor does.
 */
export async function getActionCatalogEntry(
  env: Env,
  db: AppDb,
  service: string,
  actionId: string,
): Promise<ActionCatalogEntry | null> {
  const catalog = await buildActionCatalog(env, db, service);
  return catalog.find((entry) => entry.actionId === actionId) ?? null;
}
