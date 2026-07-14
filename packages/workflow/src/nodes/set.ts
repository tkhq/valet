/**
 * `set` node executor (Phase 5 plan decision 10). Pure template
 * transformation — no side effects, no network calls. Resolves the
 * node's `values` field as JSON templates over `{ trigger, nodes }`.
 */

import { renderJsonTemplates } from '../dag/expression.js';
import type { SetNode } from '../dag/nodes.js';
import { resolveTemplateContext, type NodeExecuteResult, type NodeExecutorArgs } from './index.js';

export async function executeSet(args: NodeExecutorArgs<SetNode>): Promise<NodeExecuteResult> {
  const { run, node, attempt, iteration, store, clock } = args;
  const result = renderJsonTemplates(node.values, resolveTemplateContext(args));

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
