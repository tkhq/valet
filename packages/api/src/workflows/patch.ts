/**
 * Node/edge-level workflow patching (agent tool `workflows.patch_workflow`).
 * Lets the agent rename a workflow or edit a single node without re-sending
 * the whole definition — regenerating an entire definition to change one
 * prompt risks corrupting the rest. Pure: callers validate the RESULT with
 * the full linter before persisting, so a bad patch surfaces as lint
 * errors, never a bad save.
 */
import type { WorkflowDefinition, WorkflowEdge, WorkflowNode } from "@valet/workflow";

export interface WorkflowEdgeRef {
  from: string;
  to: string;
  fromOutput?: "true" | "false";
}

export interface WorkflowPatch {
  /** Replace-by-id, or append when the id is new. */
  upsertNodes?: unknown[];
  /** Also drops every edge touching a removed node, and its ui position. */
  removeNodeIds?: string[];
  addEdges?: WorkflowEdge[];
  /** `fromOutput` omitted → removes matching edges regardless of branch. */
  removeEdges?: WorkflowEdgeRef[];
}

export type PatchResult =
  | { ok: true; definition: WorkflowDefinition }
  | { ok: false; errors: string[] };

export function applyWorkflowPatch(definition: WorkflowDefinition, patch: WorkflowPatch): PatchResult {
  const errors: string[] = [];
  const next: WorkflowDefinition = structuredClone(definition);

  for (const raw of patch.upsertNodes ?? []) {
    if (typeof raw !== "object" || raw === null || typeof (raw as { id?: unknown }).id !== "string") {
      errors.push(`upsert_nodes entries must be node objects with a string "id", got ${JSON.stringify(raw)}`);
      continue;
    }
    // Contents are validated by the full linter after the patch applies —
    // this narrowing is only about slotting the object into the array.
    const node = raw as WorkflowNode;
    const idx = next.nodes.findIndex((n) => n.id === node.id);
    if (idx >= 0) next.nodes[idx] = node;
    else next.nodes.push(node);
  }

  for (const id of patch.removeNodeIds ?? []) {
    const idx = next.nodes.findIndex((n) => n.id === id);
    if (idx < 0) {
      errors.push(`remove_node_ids: no node with id ${JSON.stringify(id)}`);
      continue;
    }
    next.nodes.splice(idx, 1);
    next.edges = next.edges.filter((e) => e.from !== id && e.to !== id);
    if (next.ui?.nodes && id in next.ui.nodes) {
      delete next.ui.nodes[id];
    }
  }

  for (const ref of patch.removeEdges ?? []) {
    const before = next.edges.length;
    next.edges = next.edges.filter(
      (e) =>
        !(
          e.from === ref.from &&
          e.to === ref.to &&
          (ref.fromOutput === undefined || e.fromOutput === ref.fromOutput)
        ),
    );
    if (next.edges.length === before) {
      errors.push(`remove_edges: no edge matches ${JSON.stringify(ref)}`);
    }
  }

  for (const edge of patch.addEdges ?? []) {
    const exists = next.edges.some(
      (e) => e.from === edge.from && e.to === edge.to && e.fromOutput === edge.fromOutput,
    );
    if (!exists) next.edges.push(edge);
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, definition: next };
}

/**
 * Causal hint for patch-induced unreachability. The post-patch lint says
 * "node X is unreachable" but never says WHY — and when the patch removed
 * edges, the removal is the likely cause. Append one line that links the
 * two, so the agent repairs the patch instead of re-deriving the graph.
 * Presence-based on purpose: computing exact edge-to-node causality is
 * not worth it when naming the removed edges already points at the fix.
 */
export function appendRemovedEdgeHint(lintErrors: string[], removedEdges: WorkflowEdgeRef[] | undefined): string[] {
  if (!removedEdges || removedEdges.length === 0) return lintErrors;
  if (!lintErrors.some((e) => e.includes("is unreachable"))) return lintErrors;
  const removed = removedEdges.map((e) => `${e.from}->${e.to}`).join(", ");
  return [
    ...lintErrors,
    `hint: this patch removed edge(s) ${removed}; if a removed edge was the only path to the unreachable nodes, add a replacement edge in the same patch`,
  ];
}
