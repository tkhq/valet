/**
 * `stop` node executor (Phase 5 plan decision 10). Terminal checkpoint;
 * signals the interpreter to terminalize the run with its configured
 * outcome (default `'completed'`, i.e. `node.outcome !== 'failure'`).
 *
 * Unlike main's `stop` executor (which threw `StopFailure` to short-
 * circuit the wave loop via exception), this executor returns its intent
 * declaratively via `NodeExecuteResult.terminate` — the interpreter reads
 * it and settles the run after finishing the current wave.
 */

import { renderJsonTemplates, renderTemplate } from '../dag/expression.js';
import type { StopNode } from '../dag/nodes.js';
import { resolveTemplateContext, type NodeExecuteResult, type NodeExecutorArgs } from './index.js';

export interface StopResult {
  outcome: 'success' | 'failure';
  output?: unknown;
  message?: string;
}

export async function executeStop(args: NodeExecutorArgs<StopNode>): Promise<NodeExecuteResult> {
  const { run, node, attempt, iteration, store, clock } = args;
  const ctx = resolveTemplateContext(args);
  const outcome = node.outcome ?? 'success';
  const output = node.output !== undefined ? renderJsonTemplates(node.output, ctx) : undefined;
  const message =
    node.message !== undefined ? asString(renderTemplate(node.message, ctx)) : undefined;
  const result: StopResult = { outcome, output, message };

  await store.putIntent({
    runId: run.runId,
    nodeId: node.id,
    iteration,
    status: 'intent',
    attempt,
    createdAt: clock(),
  });

  if (outcome === 'failure') {
    const error = message ?? 'workflow stopped with failure outcome';
    await store.completeCheckpoint(run.runId, node.id, iteration, attempt, {
      runId: run.runId,
      nodeId: node.id,
      iteration,
      status: 'failed',
      error,
      result,
      attempt,
      createdAt: clock(),
    });
    return { status: 'failed', error, terminate: 'failed' };
  }

  await store.completeCheckpoint(run.runId, node.id, iteration, attempt, {
    runId: run.runId,
    nodeId: node.id,
    iteration,
    status: 'completed',
    result,
    attempt,
    createdAt: clock(),
  });
  return { status: 'completed', result, terminate: 'completed' };
}

function asString(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v === undefined || v === null) return '';
  return JSON.stringify(v);
}
