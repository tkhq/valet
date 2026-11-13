/**
 * The fully-qualified action id convention, alone in a leaf module so pure
 * consumers (`assistants/behavior.ts`) can share it without importing
 * `action-invoker.ts`'s db/policy graph.
 */
import type { ActionPlugin, PluginAction } from "@valet/engine";
import { buildActionIdResolver, qualifiedActionId as qualifiedId, type ActionIdResolver } from "@valet/shared";

/** The canonical policy-facing action id: the fully-qualified fqid
 * (`service.action`), mirroring the plugin-catalog's list_tools convention.
 * Both invocation paths resolve to this form, so one org policy / override /
 * grant targets both (spec Deviations T6 #3). One rule builds it for every
 * caller: `@valet/shared` `qualifiedActionId`. */
export function qualifiedActionId(service: string, action: Pick<PluginAction, "id">): string {
  return qualifiedId(service, action.id);
}

/** What a policy surface reads off a listed tool: its identity and risk,
 * never its `execute`. A `PluginAction` is one; so is a fact set the engine
 * resolved for a live call. */
export type ListedAction = Pick<PluginAction, "id" | "name" | "description" | "riskLevel">;

/**
 * The tools a dynamic (`resolveActions`) service listed for one owner: the
 * cached tool schema `ServiceProbes` (`plugins/service-probe.ts`) holds. A
 * policy surface reads it to offer, verify, and resolve an action the static
 * catalog cannot name. Answers `[]` when nothing is cached and the listing
 * fails or times out, so a caller treats an empty answer as "unknown", not
 * as "the service has no tools".
 */
export type DynamicActionSource = (service: string, actionPlugin: ActionPlugin) => Promise<readonly ListedAction[]>;

/** Where one canonical tool id resolves: the service and the plugin's own action id. */
export interface ToolIndexEntry {
  service: string;
  actionId: string;
}

/**
 * Maps each static action's canonical id (`qualifiedActionId`) to its
 * service, so a tool id resolves without parsing. A plugin can declare ids
 * with its own prefix (google_workspace ships `drive.search_files`), so the
 * id does not always start with the service.
 *
 * Throws when an id could name two services: two actions share an id, or an
 * id starts with another registered service's name. Tools that a service
 * discovers at run time are not in the index. Callers resolve those by the
 * service prefix, which this rule keeps unambiguous for static ids.
 */
export function buildToolIndex(
  actionPluginByService: ReadonlyMap<string, { plugin: { name: string }; actionPlugin: ActionPlugin }>,
): Map<string, ToolIndexEntry> {
  const index = new Map<string, ToolIndexEntry>();
  const services = [...actionPluginByService.keys()];
  for (const [service, { plugin, actionPlugin }] of actionPluginByService) {
    for (const action of actionPlugin.actions) {
      const id = qualifiedActionId(service, action);
      const existing = index.get(id);
      if (existing) {
        const other = actionPluginByService.get(existing.service)?.plugin.name ?? existing.service;
        throw new Error(
          `tool id collision: "${id}" is declared by both "${other}" and "${plugin.name}". Rename one of the actions.`,
        );
      }
      const shadow = services.find((s) => s !== service && id.startsWith(`${s}.`));
      if (shadow) {
        const other = actionPluginByService.get(shadow)?.plugin.name ?? shadow;
        throw new Error(
          `tool id collision: "${id}" from "${plugin.name}" starts with the service name "${shadow}" of "${other}". ` +
            `Rename the action or the service so each tool id names one service.`,
        );
      }
      index.set(id, { service, actionId: action.id });
    }
  }
  return index;
}

type ActionPluginMap = ReadonlyMap<string, { plugin: { name: string }; actionPlugin: ActionPlugin }>;

const resolvers = new WeakMap<ActionPluginMap, ActionIdResolver>();

/**
 * The registry-backed `ActionIdResolver` for one plugin map: the shared
 * `buildActionIdResolver` over the map's static actions. `buildToolIndex`
 * runs first, so a map whose ids could name two services fails here, not in
 * a later lookup.
 */
export function actionIdResolver(actionPluginByService: ActionPluginMap): ActionIdResolver {
  const cached = resolvers.get(actionPluginByService);
  if (cached) return cached;
  buildToolIndex(actionPluginByService);
  const resolver = buildActionIdResolver([...actionPluginByService].map(([service, { actionPlugin }]) => ({
    service,
    declaredIds: actionPlugin.actions.map((action) => action.id),
    dynamic: actionPlugin.resolveActions !== undefined,
  })));
  resolvers.set(actionPluginByService, resolver);
  return resolver;
}

/**
 * The canonical id for a `(service, action)` pair that a caller sends, such
 * as a workflow tool node or a sandbox action call. The pair is resolved
 * through the registry, so `("google_workspace", "sheets.write_spreadsheet")`
 * and `("google_workspace", "google_workspace.sheets.write_spreadsheet")`
 * both give `sheets.write_spreadsheet`. Without a registry hit, the shared
 * `qualifiedActionId` rule applies.
 */
export function canonicalActionIdFor(resolver: ActionIdResolver | undefined, service: string, action: string): string {
  const resolved = resolver?.resolve(action) ?? resolver?.resolve(`${service}.${action}`);
  return resolved && resolved.service === service ? resolved.canonical : qualifiedId(service, action);
}
