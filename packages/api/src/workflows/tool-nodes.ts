/**
 * The tool nodes a definition holds. One place, because three callers need
 * the same answer: the template install gate, the team readiness predicate,
 * and the repository sync's trigger gate. A copy that scanned only top-level
 * nodes let a tool node inside a `foreach` body slip past a gate.
 */
import type { ToolNode, WorkflowCallNode, WorkflowDefinition } from "@valet/workflow";

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

/** Sub-workflow calls anywhere in the definition, top level or foreach body. */
export function workflowCallsOf(definition: WorkflowDefinition): WorkflowCallNode[] {
  const out: WorkflowCallNode[] = [];
  for (const node of definition.nodes) {
    if (node.type === "workflow") out.push(node);
    else if (node.type === "foreach" && node.body.type === "workflow") out.push(node.body);
  }
  return out;
}

/**
 * A called workflow's definition, or null when the caller may not read it.
 * Null is what `engine.resolveWorkflow` answers for both a missing id and a
 * definition another owner holds, and the call node fails the run on either.
 */
export type CalledWorkflowResolver = (workflowId: string) => Promise<WorkflowDefinition | null>;

export interface ToolNodeClosure {
  /** Tool nodes of the definition and of every workflow it calls. */
  nodes: ToolNode[];
  /** Ids of called workflows the resolver could not read, in call order. */
  unresolved: string[];
}

/**
 * Every tool node a run of this definition can reach. A `workflow` node runs
 * the callee's nodes as the same owner, so a gate that judges the parent's
 * own nodes alone passes an install the child then fails.
 *
 * `toolNodesOf` stays pure and synchronous: its other callers shape a
 * template card and never need a database read. The walk is transitive
 * rather than one level deep so it stays correct if the depth-1 rule ever
 * loosens; `seen` bounds it, because a definition that calls itself would
 * otherwise resolve forever.
 */
export async function toolNodeClosure(
  definition: WorkflowDefinition,
  resolve: CalledWorkflowResolver,
): Promise<ToolNodeClosure> {
  const nodes = toolNodesOf(definition);
  const unresolved: string[] = [];
  const seen = new Set<string>();
  const pending = workflowCallsOf(definition).map((call) => call.workflowId);

  while (pending.length > 0) {
    const workflowId = pending.shift()!;
    if (seen.has(workflowId)) continue;
    seen.add(workflowId);
    const called = await resolve(workflowId);
    if (called === null) {
      unresolved.push(workflowId);
      continue;
    }
    nodes.push(...toolNodesOf(called));
    pending.push(...workflowCallsOf(called).map((call) => call.workflowId));
  }
  return { nodes, unresolved };
}
