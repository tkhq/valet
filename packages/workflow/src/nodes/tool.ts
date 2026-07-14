/**
 * `tool` node executor (node-completion plan decision 6). Dispatches a
 * single external action invocation via `engine.invokeAction` and maps its
 * result straight onto the node's checkpoint — no parking, no repair.
 *
 * Idempotency:
 *   - `invocationId = workflow:{runId}:{nodeId}[:{iteration}]` (the same
 *     `iterationSuffix` convention every other id-bearing executor uses) is
 *     minted once, at first entry, and persisted into the intent
 *     checkpoint's `effects` before `invokeAction` is called. A resumed
 *     drive (crash after the intent write, before the terminal checkpoint)
 *     reads the id back from `effects` rather than re-minting it — the
 *     dedup contract `engine-deps.ts` documents for `invokeAction` depends
 *     on the id staying identical across re-entries so a dedup-capable
 *     receiver (Phase 6) can recognize the retry and return the original
 *     result instead of re-invoking the action.
 *
 * Lifecycle:
 *   1. No prior checkpoint: mint `invocationId`, write the intent with
 *      `effects: { invocationId }`.
 *   2. Prior (intent-only) checkpoint: read `invocationId` back from
 *      `effects` — never re-mint.
 *   3. Render `params` (structured — `renderJsonTemplates` walks
 *      objects/arrays, preserving a non-string value when a field is a
 *      single bare template) over `{trigger, nodes}` + aliases. If the
 *      rendered value isn't a plain object (contract violation — `params`
 *      is statically a `Record<string, unknown>`, so this only guards
 *      against a `renderJsonTemplates` bug), fail the node defensively
 *      without calling `invokeAction`.
 *   4. Call `engine.invokeAction`. A thrown error fails the node with the
 *      thrown message (not a drive-level throw). `{ ok: true, result }` →
 *      node `completed` with `result` stored verbatim as the checkpoint
 *      result (no wrapper). `{ ok: false, error }` → node `failed` with
 *      `error`.
 */

import { renderJsonTemplates } from '../dag/expression.js';
import type { ToolNode } from '../dag/nodes.js';
import type { NodeCheckpoint } from '../store.js';
import { iterationSuffix, resolveTemplateContext, type NodeExecuteResult, type NodeExecutorArgs } from './index.js';

interface ToolEffects {
  invocationId: string;
}

export async function executeTool(args: NodeExecutorArgs<ToolNode>): Promise<NodeExecuteResult> {
  const { run, node, attempt, iteration, store, clock, engine, existingCheckpoint } = args;
  const templateContext = resolveTemplateContext(args);

  let invocationId: string;
  if (existingCheckpoint === undefined) {
    invocationId = mintInvocationId(run.runId, node.id, iteration);
    await store.putIntent({
      runId: run.runId,
      nodeId: node.id,
      iteration,
      status: 'intent',
      attempt,
      createdAt: clock(),
      effects: effectsToRecord({ invocationId }),
    });
  } else {
    invocationId = readInvocationId(existingCheckpoint) ?? mintInvocationId(run.runId, node.id, iteration);
  }

  const renderedParams = renderJsonTemplates<unknown>(node.params, templateContext);
  if (!isPlainRecord(renderedParams)) {
    return await fail(args, invocationId, `tool node "${node.id}" params template-rendered to a non-object value`);
  }

  let response;
  try {
    response = await engine.invokeAction({
      service: node.service,
      action: node.action,
      params: renderedParams,
      invocationId,
    });
  } catch (err) {
    return await fail(args, invocationId, errorMessage(err));
  }

  if (!response.ok) {
    return await fail(args, invocationId, response.error);
  }

  return await complete(args, invocationId, response.result);
}

async function complete(args: NodeExecutorArgs<ToolNode>, invocationId: string, result: unknown): Promise<NodeExecuteResult> {
  const { run, node, attempt, iteration, store, clock } = args;
  await store.completeCheckpoint(run.runId, node.id, iteration, attempt, {
    runId: run.runId,
    nodeId: node.id,
    iteration,
    status: 'completed',
    result,
    effects: effectsToRecord({ invocationId }),
    attempt,
    createdAt: clock(),
  });
  return { status: 'completed', result };
}

async function fail(args: NodeExecutorArgs<ToolNode>, invocationId: string, error: string): Promise<NodeExecuteResult> {
  const { run, node, attempt, iteration, store, clock } = args;
  await store.completeCheckpoint(run.runId, node.id, iteration, attempt, {
    runId: run.runId,
    nodeId: node.id,
    iteration,
    status: 'failed',
    error,
    effects: effectsToRecord({ invocationId }),
    attempt,
    createdAt: clock(),
  });
  return { status: 'failed', error };
}

function mintInvocationId(runId: string, nodeId: string, iteration: number): string {
  return `workflow:${runId}:${nodeId}${iterationSuffix(iteration)}`;
}

function readInvocationId(checkpoint: NodeCheckpoint): string | undefined {
  const raw = checkpoint.effects?.invocationId;
  return typeof raw === 'string' ? raw : undefined;
}

function effectsToRecord(effects: ToolEffects): Record<string, unknown> {
  return { invocationId: effects.invocationId };
}

function isPlainRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
