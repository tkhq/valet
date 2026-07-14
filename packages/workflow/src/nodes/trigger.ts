/**
 * `trigger` node executor (Phase 5 plan decision 10). Checkpoints the
 * run's trigger payload (from `RunParams.input`) as the node's result —
 * every other node reads it back via `templateContext.trigger`.
 */

import type { TriggerNode } from '../dag/nodes.js';
import type { NodeExecuteResult, NodeExecutorArgs } from './index.js';

export async function executeTrigger(args: NodeExecutorArgs<TriggerNode>): Promise<NodeExecuteResult> {
  const { run, node, attempt, iteration, store, clock } = args;
  const result = run.params.input ?? {};

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
    status: 'completed',
    result,
    attempt,
    createdAt: clock(),
  });

  return { status: 'completed', result };
}
