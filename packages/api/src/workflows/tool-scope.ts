import { intersectToolScopes, readToolScope, type ToolScope } from "@valet/shared";

/** Read only the run snapshot. Editing the current definition cannot expand an active run. */
export function workflowStepToolScope(params: { toolScope?: ToolScope }, definition: unknown, nodeId?: string): ToolScope | undefined {
  const find = (nodes: unknown): ToolScope | undefined => {
    if (!Array.isArray(nodes)) return undefined;
    for (const node of nodes) {
      if (!node || typeof node !== "object") continue;
      if ("id" in node && node.id === nodeId) return readToolScope("toolScope" in node ? node.toolScope : undefined);
      if ("body" in node) {
        const found = find([node.body]);
        if (found !== undefined) return found;
      }
    }
    return undefined;
  };
  const nodes = definition && typeof definition === "object" && "nodes" in definition ? definition.nodes : undefined;
  return intersectToolScopes(readToolScope(params.toolScope), nodeId ? find(nodes) : undefined);
}
