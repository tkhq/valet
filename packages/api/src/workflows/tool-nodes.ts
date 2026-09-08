/**
 * The tool nodes a definition holds. One place, because three callers need
 * the same answer: the template install gate, the team readiness predicate,
 * and the repository sync's trigger gate. A copy that scanned only top-level
 * nodes let a tool node inside a `foreach` body slip past a gate.
 */
import type { ToolNode, WorkflowDefinition } from "@valet/workflow";

/** Tool nodes anywhere in the definition, including the one a foreach body
 * may hold. A foreach body is a single node, never a list (`nodes.ts`). */
export function toolNodesOf(definition: WorkflowDefinition): ToolNode[] {
  const out: ToolNode[] = [];
  for (const node of definition.nodes) {
    if (node.type === "tool") out.push(node);
    else if (node.type === "foreach" && node.body.type === "tool") out.push(node.body);
  }
  return out;
}
