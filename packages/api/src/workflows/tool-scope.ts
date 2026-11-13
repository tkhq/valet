import { canonicalizeToolScope, intersectToolScopes, isServiceWildcard, readToolScope, ValidationError, type ActionIdResolver, type ToolScope } from "@valet/shared";

/** The node with this id: a top-level node or a foreach body. */
function findNode(definition: unknown, nodeId: string): Record<string, unknown> | undefined {
  const find = (nodes: unknown): Record<string, unknown> | undefined => {
    if (!Array.isArray(nodes)) return undefined;
    for (const node of nodes) {
      if (!node || typeof node !== "object") continue;
      if ("id" in node && node.id === nodeId) return node as Record<string, unknown>;
      if ("body" in node) {
        const found = find([node.body]);
        if (found !== undefined) return found;
      }
    }
    return undefined;
  };
  return find(definition && typeof definition === "object" && "nodes" in definition ? definition.nodes : undefined);
}

/** Read only the run snapshot. Editing the current definition cannot expand an active run.
 *
 * Each layer is canonicalized before the intersection, so the run ceiling and
 * the step can spell one action differently (`sheets.write_spreadsheet`,
 * `google_workspace.sheets.write_spreadsheet`) and still agree. The result
 * holds canonical ids, which is the form every `actionInScope` caller checks.
 * Pass the registry's resolver; without one, entries stay as written. */
export function workflowStepToolScope(params: { toolScope?: ToolScope }, definition: unknown, nodeId?: string, resolver?: ActionIdResolver): ToolScope | undefined {
  const node = nodeId ? findNode(definition, nodeId) : undefined;
  return intersectToolScopes(canonicalizeToolScope(readToolScope(params.toolScope), resolver),
    node ? canonicalizeToolScope(readToolScope(node.toolScope), resolver) : undefined);
}

/** The node types that run an agent: a session step and a Thread step. */
export function isAgentStep(node: Record<string, unknown>): boolean {
  return node.type === "session" || node.type === "orchestrator";
}

/** The `toolScope.actions` entries an agent step declares, canonicalized when
 * a resolver is given, or undefined when `nodeId` is not an agent step. */
export function agentStepEntries(definition: unknown, nodeId: string, resolver?: ActionIdResolver): string[] | undefined {
  const node = findNode(definition, nodeId);
  if (!node || !isAgentStep(node)) return undefined;
  return canonicalizeToolScope(readToolScope(node.toolScope), resolver)?.actions ?? [];
}

/** A `service.*` entry limits a step but names no action, so a saved grant never covers it. */
export function isExactAction(entry: string): boolean {
  return !entry.endsWith(".*");
}

/** The plugin service of a `service.action` or `service.*` entry.
 *
 * Resolve through the registry: `sheets.write_spreadsheet` belongs to
 * `google_workspace`, not to a service named `sheets`. The text before the
 * first dot is only a fallback for an entry no registered service claims. */
export function entryService(entry: string, resolver?: ActionIdResolver): string {
  const prefix = entry.slice(0, entry.indexOf("."));
  if (!resolver) return prefix;
  if (isServiceWildcard(entry)) return resolver.service(entry.slice(0, -2)) ?? prefix;
  return resolver.resolve(entry)?.service ?? prefix;
}

/**
 * Canonicalizes the exact `toolScope.actions` entries of every agent step in a
 * definition, top-level or a foreach body, and returns the new definition.
 * `service.*` entries stay as written; readers expand them. Throws a
 * `ValidationError` for an exact entry that no registered service claims:
 * such an entry allows nothing, so the step would fail at run time instead.
 * Returns the input unchanged when no resolver is given.
 */
export function canonicalizeDefinitionScopes(definition: unknown, resolver: ActionIdResolver | undefined): unknown {
  if (!resolver || !definition || typeof definition !== "object" || !("nodes" in definition) || !Array.isArray(definition.nodes)) return definition;
  const fix = (node: unknown): unknown => {
    if (!node || typeof node !== "object") return node;
    const n = node as Record<string, unknown>;
    const next: Record<string, unknown> = { ...n };
    if (n.type === "foreach" && n.body && typeof n.body === "object") next.body = fix(n.body);
    if (!isAgentStep(n)) return next;
    const scope = readToolScope(n.toolScope);
    if (!scope?.actions) return next;
    const actions = scope.actions.map((entry) => {
      if (isServiceWildcard(entry)) return entry;
      const resolved = resolver.resolve(entry);
      if (!resolved) {
        const where = typeof n.id === "string" ? ` in step "${n.id}"` : "";
        throw new ValidationError(`Unknown action "${entry}"${where}. Use a tool id that list_tools shows, such as "slack.send_message".`);
      }
      return resolved.canonical;
    });
    next.toolScope = { ...scope, actions: [...new Set(actions)] };
    return next;
  };
  return { ...definition, nodes: definition.nodes.map(fix) };
}
