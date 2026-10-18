/**
 * Retry from the failed step. A new run gets copies of the old run's finished
 * checkpoints for the steps it does not need to run again. The interpreter
 * never runs a step that already has a terminal checkpoint, so the new run
 * starts at the first step without one.
 *
 * A step runs again when it failed, when it never finished (in flight or
 * not started), when its definition or incoming edges changed since the old
 * run, or when it is downstream of any of those. A foreach that failed keeps
 * its finished items, so only the failed and unstarted items run again,
 * unless the foreach itself changed.
 */
import type { WorkflowNode } from './dag/nodes.js';
import type { WorkflowDefinition, WorkflowEdge } from './dag/shape.js';
import type { NodeCheckpoint } from './store.js';

/** JSON with object keys sorted, so a definition read back from a jsonb column compares equal. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().filter((key) => record[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** A node and the edges into it. Two equal signatures run the same step on the same inputs. */
function signatures(definition: WorkflowDefinition): Map<string, string> {
  const incoming = new Map<string, WorkflowEdge[]>();
  for (const edge of definition.edges) incoming.set(edge.to, [...(incoming.get(edge.to) ?? []), edge]);
  const out = new Map<string, string>();
  for (const node of definition.nodes) {
    const edges = (incoming.get(node.id) ?? []).map(canonical).sort();
    out.set(node.id, canonical({ node, edges }));
  }
  return out;
}

function descendants(definition: WorkflowDefinition, roots: Iterable<string>): Set<string> {
  const next = new Map<string, string[]>();
  for (const edge of definition.edges) next.set(edge.from, [...(next.get(edge.from) ?? []), edge.to]);
  const seen = new Set<string>();
  const stack = [...roots];
  while (stack.length > 0) {
    const id = stack.pop() as string;
    for (const to of next.get(id) ?? []) {
      if (!seen.has(to)) { seen.add(to); stack.push(to); }
    }
  }
  return seen;
}

function bodyOwners(definition: WorkflowDefinition): Map<string, string> {
  const owners = new Map<string, string>();
  for (const node of definition.nodes) if (node.type === 'foreach') owners.set(node.body.id, node.id);
  return owners;
}

/**
 * The old run's checkpoints that the retry reuses. `previous` is the
 * definition the old run used. `current` is the definition the retry runs.
 * The result keeps the old rows' run id and attempt; the caller rewrites both.
 */
export function retrySeedCheckpoints(
  previous: WorkflowDefinition,
  current: WorkflowDefinition,
  checkpoints: readonly NodeCheckpoint[],
): NodeCheckpoint[] {
  const before = signatures(previous);
  const after = signatures(current);
  const owners = bodyOwners(current);
  // A stop step ends the run when it executes. A copied one never executes,
  // so it always runs again; it has no side effects.
  const topLevel = new Set(current.nodes.filter((node: WorkflowNode) => node.type !== 'stop').map((node) => node.id));

  const changed = new Set([...after].filter(([id, sig]) => before.get(id) !== sig).map(([id]) => id));
  // Top-level steps only. A foreach that stops on a failed item fails its
  // own checkpoint too; one that skips or collects failed items completed.
  const failed = new Set(checkpoints.filter((cp) => cp.status === 'failed' && topLevel.has(cp.nodeId)).map((cp) => cp.nodeId));
  const roots = new Set([...changed, ...failed]);
  const downstream = descendants(current, roots);
  const rerun = new Set([...roots, ...downstream]);

  return checkpoints.filter((cp) => {
    if (cp.status !== 'completed' && cp.status !== 'skipped') return false;
    const owner = owners.get(cp.nodeId);
    if (owner === undefined) return topLevel.has(cp.nodeId) && !rerun.has(cp.nodeId);
    if (!rerun.has(owner)) return true;
    // The failed foreach itself, unchanged, and not downstream of another
    // step that runs again: its items are the same list, so a finished item
    // keeps its result.
    return cp.status === 'completed' && failed.has(owner) && !changed.has(owner) && !downstream.has(owner);
  });
}
