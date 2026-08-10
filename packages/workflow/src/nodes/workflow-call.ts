/**
 * `workflow` node executor (batch-fanout design decision 1) — starts a
 * child run of another workflow definition and parks until it settles.
 *
 * Determinism / at-most-once dispatch mirrors `submission-node.ts`: the
 * child run id derives from ids already durable in the checkpoint PK
 * (`runId`/`nodeId`/`iteration`), the intent checkpoint persists it in
 * `effects` before the child is created, and `store.createRun` is
 * insert-if-absent — a crash anywhere between intent and park re-enters
 * this executor, which re-derives the same id and converges.
 *
 * Starting the child needs no engine call: a run "starts" by existing in
 * the store with a requested wake (`LocalRunHost.start` does exactly
 * this), so the executor enqueues through the `WorkflowStore` directly.
 * Only the definition lookup is host-side (`engine.resolveWorkflow`).
 *
 * Wake-up: the interpreter's settle path requests a wake on
 * `params.parentRunId`, and the host's lost-wake sweep independently
 * wakes parents whose `run` wait names a settled child.
 */

import { renderJsonTemplates } from '../dag/expression.js';
import type { StopNode, WorkflowCallNode } from '../dag/nodes.js';
import type { WorkflowDefinition } from '../dag/shape.js';
import type { NodeCheckpoint, RunParams, WorkflowRun } from '../store.js';
import { resolveTemplateContext, type NodeExecuteResult, type NodeExecutorArgs } from './index.js';

/**
 * `wfrun_sub_<sha256(parentRunId:nodeId:iteration)[:20]>` — deterministic,
 * replay-safe. Web Crypto (`crypto.subtle`, a global since Node 19) keeps
 * this package free of `node:` imports — it declares no Node types.
 */
export async function deriveChildRunId(parentRunId: string, nodeId: string, iteration: number): Promise<string> {
  const bytes = new TextEncoder().encode(`${parentRunId}:${nodeId}:${iteration}`);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  let hex = '';
  for (const b of digest) hex += b.toString(16).padStart(2, '0');
  return `wfrun_sub_${hex.slice(0, 20)}`;
}

export async function executeWorkflowCall(args: NodeExecutorArgs<WorkflowCallNode>): Promise<NodeExecuteResult> {
  const { run, node, attempt, iteration, store, clock, engine, existingCheckpoint } = args;

  const fail = async (error: string): Promise<NodeExecuteResult> => {
    await store.putIntent({
      runId: run.runId,
      nodeId: node.id,
      iteration,
      status: 'intent',
      attempt,
      createdAt: clock(),
    });
    await store.completeCheckpoint(run.runId, node.id, iteration, attempt, {
      runId: run.runId,
      nodeId: node.id,
      iteration,
      status: 'failed',
      error,
      attempt,
      createdAt: clock(),
    });
    return { status: 'failed', error };
  };

  const persistedChildRunId =
    typeof existingCheckpoint?.effects?.childRunId === 'string' ? existingCheckpoint.effects.childRunId : undefined;

  if (persistedChildRunId !== undefined) {
    const child = await store.getRun(persistedChildRunId);
    if (child !== null) {
      if (child.status !== 'settled') {
        return { status: 'parked', waitingOn: [{ kind: 'run', nodeId: node.id, runId: persistedChildRunId }] };
      }
      return await settleFromChild(args, child);
    }
    // Crash between intent and createRun: fall through and re-dispatch with
    // the same derived id.
  }

  // Depth guard: a run started by a workflow node may not start another.
  if (run.params.parentRunId !== undefined) {
    return await fail(
      `workflow node "${node.id}": this run is itself a sub-workflow run — nesting depth is 1. ` +
        `Move the call into the parent workflow.`,
    );
  }
  if (engine.resolveWorkflow === undefined) {
    return await fail(
      `workflow node "${node.id}": this host does not support sub-workflow calls ` +
        `(engine.resolveWorkflow is not wired).`,
    );
  }

  const resolved = await engine.resolveWorkflow(node.workflowId, run.owner);
  if (resolved === null) {
    return await fail(
      `workflow node "${node.id}": workflow ${JSON.stringify(node.workflowId)} does not exist or ` +
        `belongs to another owner. Reference a workflow you own.`,
    );
  }
  const childDefinition = resolved.definition as WorkflowDefinition;
  if (childDefinition.nodes.some((n) => n.type === 'workflow')) {
    return await fail(
      `workflow node "${node.id}": workflow ${JSON.stringify(node.workflowId)} contains its own ` +
        `workflow node — nesting depth is 1. Flatten the called workflow.`,
    );
  }

  const childRunId = await deriveChildRunId(run.runId, node.id, iteration);
  await store.putIntent({
    runId: run.runId,
    nodeId: node.id,
    iteration,
    status: 'intent',
    attempt,
    createdAt: clock(),
    effects: { childRunId },
  });

  const rendered = node.input !== undefined ? renderJsonTemplates(node.input, resolveTemplateContext(args)) : undefined;
  const data = isPlainObject(rendered) ? rendered : rendered === undefined ? {} : { value: rendered };
  const params: RunParams = {
    workflowId: node.workflowId,
    definitionVersionId: resolved.definitionVersionId,
    input: { type: 'workflow', timestamp: clock(), data },
    parentRunId: run.runId,
    parentNodeId: node.id,
    parentIteration: iteration,
  };
  await store.createRun(childRunId, params, resolved.definition, resolved.definitionVersionId, run.owner);
  await store.requestWake(childRunId);

  return { status: 'parked', waitingOn: [{ kind: 'run', nodeId: node.id, runId: childRunId }] };
}

/** The parent-visible result of a completed sub-workflow call. */
export interface WorkflowCallResult {
  runId: string;
  output: unknown;
}

async function settleFromChild(
  args: NodeExecutorArgs<WorkflowCallNode>,
  child: WorkflowRun,
): Promise<NodeExecuteResult> {
  const { run, node, attempt, iteration, store, clock } = args;

  if (child.outcome !== 'completed') {
    const detail = await firstChildErrors(store, child);
    const error =
      `workflow node "${node.id}": sub-workflow run ${child.runId} settled ${child.outcome ?? 'unknown'}` +
      (detail ? ` — ${detail}` : '');
    await store.completeCheckpoint(run.runId, node.id, iteration, attempt, {
      runId: run.runId,
      nodeId: node.id,
      iteration,
      status: 'failed',
      error,
      effects: { childRunId: child.runId },
      attempt,
      createdAt: clock(),
    });
    return { status: 'failed', error };
  }

  const output = await computeChildOutput(store, child);
  const result: WorkflowCallResult = { runId: child.runId, output };
  await store.completeCheckpoint(run.runId, node.id, iteration, attempt, {
    runId: run.runId,
    nodeId: node.id,
    iteration,
    status: 'completed',
    result,
    effects: { childRunId: child.runId },
    attempt,
    createdAt: clock(),
  });
  return { status: 'completed', result };
}

/**
 * A run's output (batch-fanout design decision 1's output contract): the
 * completed stop node's rendered `output` when one declares it; otherwise
 * a map of the leaf nodes' results (nodes with no outgoing edges,
 * excluding the trigger), completed checkpoints only.
 */
async function computeChildOutput(
  store: NodeExecutorArgs['store'],
  child: WorkflowRun,
): Promise<unknown> {
  const definition = child.definition as WorkflowDefinition;
  const checkpoints = await store.getCheckpoints(child.runId);
  const byNode = new Map<string, NodeCheckpoint>();
  for (const cp of checkpoints) {
    if (cp.iteration === 0) byNode.set(cp.nodeId, cp);
  }

  for (const n of definition.nodes) {
    if (n.type !== 'stop') continue;
    const stop: StopNode = n;
    if (stop.output === undefined) continue;
    const cp = byNode.get(n.id);
    if (cp?.status !== 'completed') continue;
    const result = cp.result;
    if (result && typeof result === 'object' && 'output' in result) {
      return (result as { output?: unknown }).output;
    }
  }

  const withOutgoing = new Set(definition.edges.map((e) => e.from));
  const output: Record<string, unknown> = {};
  for (const n of definition.nodes) {
    if (n.type === 'trigger' || withOutgoing.has(n.id)) continue;
    const cp = byNode.get(n.id);
    if (cp?.status === 'completed') output[n.id] = cp.result;
  }
  return output;
}

/** First few failed-node errors from the child, for the parent's error message. */
async function firstChildErrors(store: NodeExecutorArgs['store'], child: WorkflowRun): Promise<string> {
  const checkpoints = await store.getCheckpoints(child.runId);
  const failures = checkpoints
    .filter((cp) => cp.status === 'failed' && cp.error !== undefined)
    .slice(0, 2)
    .map((cp) => `${cp.nodeId}: ${cp.error}`);
  return failures.join('; ');
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
