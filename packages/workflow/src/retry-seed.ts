/**
 * Retry from the failed step. A new run gets copies of the old run's finished
 * checkpoints for the steps it does not need to run again. The interpreter
 * never runs a step that already has a terminal checkpoint, so the new run
 * starts at the first step without one.
 *
 * A step runs again when it failed, when it never finished (in flight or
 * not started), when its definition or incoming edges changed since the old
 * run, or when it is downstream of any of those. An approval step runs again
 * when any step after it changed, because the person approved the old steps. A foreach that failed keeps
 * its finished items, so only the failed and unstarted items run again,
 * unless the foreach itself changed.
 *
 * A re-run of a completed run's changed steps (`completed: true`) reuses
 * every step that did not change and is not after a changed step. That
 * includes a failed step the run tolerated (`onError: "continue"`), which is
 * part of the result, and a stop step that ran: a copied stop never
 * executes, so it cannot end the re-run before the changed steps finish.
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

/** How the old run ended. */
export interface RetrySeedOptions {
  /** The old run completed. Every checkpoint it finished is a result to keep,
   * so only the changed steps and the steps after them run again. */
  completed?: boolean;
}

function finished(status: NodeCheckpoint['status'], opts: RetrySeedOptions): boolean {
  return status === 'completed' || status === 'skipped' || (opts.completed === true && status === 'failed');
}

/** Which steps a retry runs again, and why. */
function retryScope(
  previous: WorkflowDefinition,
  current: WorkflowDefinition,
  checkpoints: readonly Pick<NodeCheckpoint, 'nodeId' | 'status'>[],
  opts: RetrySeedOptions,
) {
  const before = signatures(previous);
  const after = signatures(current);
  // A stop step ends the run when it executes. After a failure, a copied
  // stop never executes, so it always runs again; it has no side effects.
  // A completed run keeps its stops, so an unchanged one cannot end the
  // re-run early.
  const reusable = new Set(current.nodes.filter((node: WorkflowNode) => opts.completed || node.type !== 'stop').map((node) => node.id));

  const changed = new Set([...after].filter(([id, sig]) => before.get(id) !== sig).map(([id]) => id));
  // Top-level steps only. A foreach that stops on a failed item fails its
  // own checkpoint too; one that skips or collects failed items completed.
  // A completed run only has failures it tolerated.
  const failed = new Set(opts.completed ? [] : checkpoints
    .filter((cp) => cp.status === 'failed' && reusable.has(cp.nodeId)).map((cp) => cp.nodeId));
  // An approval step answered for the old steps after it. When any of those
  // changed, a person approves again, so the approval runs again too.
  const reapprove = current.nodes.filter((node: WorkflowNode) => node.type === 'approval'
    && [...descendants(current, [node.id])].some((id) => changed.has(id))).map((node) => node.id);
  const roots = new Set([...changed, ...failed, ...reapprove]);
  const downstream = descendants(current, roots);
  const rerun = new Set([...roots, ...downstream]);
  return { reusable, changed, failed, downstream, rerun };
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
  opts: RetrySeedOptions = {},
): NodeCheckpoint[] {
  const { reusable, changed, failed, downstream, rerun } = retryScope(previous, current, checkpoints, opts);
  const owners = bodyOwners(current);
  return checkpoints.filter((cp) => {
    if (!finished(cp.status, opts)) return false;
    const owner = owners.get(cp.nodeId);
    if (owner === undefined) return reusable.has(cp.nodeId) && !rerun.has(cp.nodeId);
    if (!rerun.has(owner)) return true;
    // The failed foreach itself, unchanged, and not downstream of another
    // step that runs again: its items are the same list, so a finished item
    // keeps its result.
    return cp.status === 'completed' && failed.has(owner) && !changed.has(owner) && !downstream.has(owner);
  });
}

/**
 * The top-level steps a retry runs again, in definition order: each failed
 * step, each step edited or added since the old run, each approval asked
 * again, and every step after one of these. After a failure, a step that the
 * old run never reached also runs, but this list does not name it.
 *
 * For a completed run, an empty list means that no step changed. Otherwise
 * the list also names each step that the old run never reached, because a
 * stop step ended it first: with the stop copied, that step runs now.
 */
export function retryRerunSteps(
  previous: WorkflowDefinition,
  current: WorkflowDefinition,
  checkpoints: readonly Pick<NodeCheckpoint, 'nodeId' | 'status'>[],
  opts: RetrySeedOptions = {},
): string[] {
  const { rerun } = retryScope(previous, current, checkpoints, opts);
  if (rerun.size === 0) return [];
  const reached = new Set(checkpoints.filter((cp) => finished(cp.status, opts)).map((cp) => cp.nodeId));
  return current.nodes
    .filter((node) => rerun.has(node.id) || (opts.completed === true && !reached.has(node.id)))
    .map((node) => node.id);
}
