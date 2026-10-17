import { intersectToolScopes, readToolScope, type ToolScope } from "@valet/shared";

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

/** Read only the run snapshot. Editing the current definition cannot expand an active run. */
export function workflowStepToolScope(params: { toolScope?: ToolScope }, definition: unknown, nodeId?: string): ToolScope | undefined {
  const node = nodeId ? findNode(definition, nodeId) : undefined;
  return intersectToolScopes(readToolScope(params.toolScope), node ? readToolScope(node.toolScope) : undefined);
}

/** The node types that run an agent: a session step and a Thread step. */
export function isAgentStep(node: Record<string, unknown>): boolean {
  return node.type === "session" || node.type === "orchestrator";
}

/** The `toolScope.actions` entries an agent step declares, or undefined when
 * `nodeId` is not an agent step. */
export function agentStepEntries(definition: unknown, nodeId: string): string[] | undefined {
  const node = findNode(definition, nodeId);
  if (!node || !isAgentStep(node)) return undefined;
  return readToolScope(node.toolScope)?.actions ?? [];
}

/** A `service.*` entry limits a step but names no action, so a saved grant never covers it. */
export function isExactAction(entry: string): boolean {
  return !entry.endsWith(".*");
}

/** The plugin service of a `service.action` or `service.*` entry. */
export function entryService(entry: string): string {
  return entry.slice(0, entry.indexOf("."));
}
