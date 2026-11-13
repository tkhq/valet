/**
 * The fully-qualified action id convention, alone in a leaf module so pure
 * consumers (`assistants/behavior.ts`) can share it without importing
 * `action-invoker.ts`'s db/policy graph.
 */
import type { ActionPlugin, PluginAction } from "@valet/engine";
import { qualifiedActionId as qualifiedId, type ActionIdResolver, type ResolvedActionId } from "@valet/shared";

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

/** How `list_tools` and callers spell a service: case and `-`/`_` do not matter. */
function serviceKey(service: string): string {
  return service.toLowerCase().replaceAll("-", "_");
}

type ActionPluginMap = ReadonlyMap<string, { plugin: { name: string }; actionPlugin: ActionPlugin }>;

const resolvers = new WeakMap<ActionPluginMap, ActionIdResolver>();

/**
 * The registry-backed `ActionIdResolver` for one plugin map. It accepts every
 * spelling the platform takes for a static action: the canonical id
 * (`sheets.write_spreadsheet`), the service-prefixed id
 * (`google_workspace.sheets.write_spreadsheet`), and the service written as
 * `list_tools` reports it (`slack_user.x` for `slack-user`). A runtime
 * (`resolveActions`) service resolves any `service.tool` spelling, because its
 * tools are not known before discovery. Nothing here splits a string on a dot
 * to guess a service: each candidate service comes from the registry.
 */
export function actionIdResolver(actionPluginByService: ActionPluginMap): ActionIdResolver {
  const cached = resolvers.get(actionPluginByService);
  if (cached) return cached;
  const index = buildToolIndex(actionPluginByService);
  const services = [...actionPluginByService.keys()].sort((a, b) => b.length - a.length);
  const byKey = new Map(services.map((service) => [serviceKey(service), service]));
  const foreign = new Map<string, string[]>();
  for (const [canonical, { service }] of index) {
    if (canonical.startsWith(`${service}.`)) continue;
    foreign.set(service, [...(foreign.get(service) ?? []), canonical]);
  }
  const resolve = (spelling: string): ResolvedActionId | undefined => {
    const exact = index.get(spelling);
    if (exact) return { service: exact.service, canonical: spelling };
    const key = serviceKey(spelling);
    for (const service of services) {
      if (!key.startsWith(`${serviceKey(service)}.`)) continue;
      const rest = spelling.slice(service.length + 1);
      for (const candidate of [rest, `${service}.${rest}`, `${serviceKey(service)}.${rest}`]) {
        const hit = index.get(candidate);
        if (hit?.service === service) return { service, canonical: candidate };
      }
      if (actionPluginByService.get(service)?.actionPlugin.resolveActions) {
        return { service, canonical: qualifiedId(service, rest) };
      }
    }
    return undefined;
  };
  const resolver: ActionIdResolver = {
    resolve,
    service: (name) => byKey.get(serviceKey(name)),
    foreignPrefixedIds: (service) => foreign.get(service) ?? [],
  };
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
