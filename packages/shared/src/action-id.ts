/**
 * Action identity: one canonical id per plugin action, and one way to reach it.
 *
 * A plugin declares each action with an id. Most ids start with the plugin's
 * service (`slack.send_message`), some carry no prefix (`send_message`), and
 * some start with a product name that is not the service: google_workspace
 * declares `sheets.write_spreadsheet`. Callers also write the same action as
 * `google_workspace.sheets.write_spreadsheet`. So one action has more than one
 * spelling, and a dot in a string does not tell where the service ends.
 *
 * Rules:
 * 1. `qualifiedActionId` is the only function that builds a canonical id.
 * 2. Code never splits an action id on a dot to find its service. It asks an
 *    `ActionIdResolver`, which the plugin registry builds.
 * 3. A tool scope is canonicalized (`canonicalizeToolScope`) before any
 *    `actionInScope` check reads it, so every spelling of an allowed action
 *    matches the canonical id that the invoker checks.
 *
 * See docs/specs/2026-11-12-canonical-action-ids-design.md.
 */
import type { ToolScope } from "./tool-scope.js";

/** The canonical id of a declared action. A declared id that has a dot is
 * already qualified and stays as declared; a bare id gets the service prefix.
 * Stored policies, grants, and audit rows use this form. */
export function qualifiedActionId(service: string, declaredId: string): string {
  return declaredId.includes(".") ? declaredId : `${service}.${declaredId}`;
}

/** Where one spelling of an action resolves. */
export interface ResolvedActionId {
  /** The plugin service that owns the action (and its credential lookup). */
  service: string;
  /** The canonical id (`qualifiedActionId`). */
  canonical: string;
}

/**
 * Resolves any accepted spelling of an action to its owner and canonical id,
 * from the plugin registry. Returns undefined when no registered service
 * claims the spelling. The resolver never guesses from dots alone.
 */
export interface ActionIdResolver {
  resolve(spelling: string): ResolvedActionId | undefined;
  /** The registered service a `service.*` pattern names, matched the way
   * `resolve` matches services. Undefined when no service has that name. */
  service(name: string): string | undefined;
  /** The canonical ids of a service's static actions whose canonical id does
   * not start with `service.`. For google_workspace that is every
   * `docs.*`, `drive.*`, `sheets.*`, and `slides.*` action. */
  foreignPrefixedIds(service: string): readonly string[];
}

/** True for a `service.*` scope pattern. */
export function isServiceWildcard(entry: string): boolean {
  return entry.endsWith(".*");
}

/**
 * Rewrites a scope's action entries to canonical ids. An exact entry maps to
 * the canonical id of the action it names. A `service.*` entry keeps
 * `service.*` (bare and runtime-discovered actions) and adds the exact
 * canonical ids of the service's actions that use another prefix, so
 * `google_workspace.*` covers `sheets.write_spreadsheet` and nothing that
 * another plugin declares. An entry the resolver does not know stays as
 * written: it can only narrow, never widen. `tools` entries are tool names,
 * not action ids, and stay unchanged.
 */
export function canonicalizeToolScope(scope: ToolScope | undefined, resolver: ActionIdResolver | undefined): ToolScope | undefined {
  if (!scope?.actions || !resolver) return scope;
  const actions = new Set<string>();
  for (const entry of scope.actions) {
    if (isServiceWildcard(entry)) {
      const service = resolver.service(entry.slice(0, -2));
      if (!service) {
        actions.add(entry);
        continue;
      }
      actions.add(`${service}.*`);
      for (const id of resolver.foreignPrefixedIds(service)) actions.add(id);
      continue;
    }
    actions.add(resolver.resolve(entry)?.canonical ?? entry);
  }
  return { ...scope, actions: [...actions] };
}

/** One registered service, as an `ActionIdResolver` sees it. */
export interface ActionIdService {
  service: string;
  /** The ids the plugin declares for its static actions. */
  declaredIds: readonly string[];
  /** True when the service discovers more tools at run time (`resolveActions`). */
  dynamic: boolean;
}

/** How `list_tools` and callers spell a service: case and `-`/`_` do not matter. */
function serviceKey(service: string): string {
  return service.toLowerCase().replaceAll("-", "_");
}

/**
 * The one `ActionIdResolver` implementation. The api builds it from its
 * plugin map and the engine from its catalog, so both accept the same
 * spellings of a static action:
 *
 * - the canonical id (`sheets.write_spreadsheet`);
 * - the service-prefixed id (`google_workspace.sheets.write_spreadsheet`);
 * - the service as `list_tools` reports it (`slack_user.x` for `slack-user`);
 * - the service with the action's last segment, when exactly one of the
 *   service's actions ends with it (`google_calendar.list_events` for
 *   `calendar.list_events`).
 *
 * A runtime service resolves any `service.tool` spelling, because its tools
 * are not known before discovery. Each candidate service comes from the
 * registry, never from splitting the spelling on a dot.
 */
export function buildActionIdResolver(services: readonly ActionIdService[]): ActionIdResolver {
  const index = new Map<string, string>();
  const byService = new Map<string, string[]>();
  for (const { service, declaredIds } of services) {
    const ids = declaredIds.map((id) => qualifiedActionId(service, id));
    byService.set(service, ids);
    for (const id of ids) if (!index.has(id)) index.set(id, service);
  }
  const ordered = [...services].sort((a, b) => b.service.length - a.service.length);
  const byKey = new Map(services.map(({ service }) => [serviceKey(service), service]));
  const resolve = (spelling: string): ResolvedActionId | undefined => {
    const exact = index.get(spelling);
    if (exact) return { service: exact, canonical: spelling };
    const key = serviceKey(spelling);
    for (const { service, dynamic } of ordered) {
      if (!key.startsWith(`${serviceKey(service)}.`)) continue;
      const rest = spelling.slice(service.length + 1);
      for (const candidate of [rest, `${service}.${rest}`, `${serviceKey(service)}.${rest}`]) {
        if (index.get(candidate) === service) return { service, canonical: candidate };
      }
      const named = (byService.get(service) ?? []).filter((id) => id.endsWith(`.${rest}`));
      if (named.length === 1) return { service, canonical: named[0]! };
      if (dynamic) return { service, canonical: qualifiedActionId(service, rest) };
    }
    return undefined;
  };
  return {
    resolve,
    service: (name) => byKey.get(serviceKey(name)),
    foreignPrefixedIds: (service) => (byService.get(service) ?? []).filter((id) => !id.startsWith(`${service}.`)),
  };
}
