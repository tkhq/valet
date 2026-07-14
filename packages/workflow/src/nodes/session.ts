/**
 * `session` node executor (Phase 5 plan decision 13). Dispatches real engine
 * work — creates (or re-attaches to) a workflow-owned session and prompts it,
 * then either completes immediately (`wait.mode === 'none'`) or parks behind
 * the submission until it settles, with one bounded schema-repair round trip.
 *
 * Determinism / at-most-once dispatch:
 *   - `sessionId = wf:{runId}:{nodeId}[:{iteration}]`, `dispatchId =
 *     workflow:{runId}:{nodeId}[:{iteration}]` (repair turn: `dispatchId +
 *     ':repair'`; iteration suffix only when > 0, i.e. foreach bodies) —
 *     all derived from ids already durable in the checkpoint PK, so a
 *     crash-and-resume always recomputes the same ones.
 *   - `createSession` is idempotent by id, `prompt` idempotent by
 *     `dispatchId` (engine contract, `engine-deps.ts`), so re-issuing the
 *     dispatch after a crash between "prompt sent" and "receipt persisted"
 *     returns the *original* receipt rather than creating a duplicate
 *     submission.
 *   - The receipt (`{ threadId, queueItemId }`) is round-tripped through the
 *     intent checkpoint's `effects` — never re-derived — exactly like
 *     `wait`'s `wakeAt` and `approval`'s `timeoutAt`.
 *
 * Everything above the dispatch primitive (intent-before-dispatch ordering,
 * receipt persistence, `wait.mode: 'none'` short-circuit, park shape,
 * `isSettled` re-park guard, outcome mapping and the one-shot repair round)
 * is shared with the `orchestrator` executor via `submission-node.ts` — see
 * that module for the full lifecycle description. This file only supplies
 * the session-specific dispatch primitive (`createSession` + `prompt`) and
 * result shapes.
 */

import { renderTemplate, type TemplateContext } from '../dag/expression.js';
import type { SessionNode } from '../dag/nodes.js';
import type { WorkflowPromptReceipt } from '../engine-deps.js';
import { executeSubmissionNode, type SubmissionDispatch } from './submission-node.js';
import { iterationSuffix, resolveTemplateContext, type NodeExecuteResult, type NodeExecutorArgs } from './index.js';

export interface SessionDispatchedResult {
  sessionId: string;
  receipt: WorkflowPromptReceipt;
}

export interface SessionSettledResult {
  sessionId: string;
  response?: string;
  output?: unknown;
}

export async function executeSession(args: NodeExecutorArgs<SessionNode>): Promise<NodeExecuteResult> {
  const { run, node, attempt, iteration, store, clock, engine, existingCheckpoint } = args;
  const templateContext = resolveTemplateContext(args);

  const suffix = iterationSuffix(iteration);
  const sessionId = `wf:${run.runId}:${node.id}${suffix}`;
  const dispatchId = `workflow:${run.runId}:${node.id}${suffix}`;

  return await executeSubmissionNode<SessionDispatchedResult, SessionSettledResult>(
    { run, nodeId: node.id, attempt, iteration, store, clock, engine, existingCheckpoint },
    {
      nodeKind: 'session',
      dispatchId,
      initialEffects: { sessionId },
      waitMode: node.wait?.mode,
      outputSchema: node.outputSchema,
      dispatch: async (id): Promise<SubmissionDispatch> => {
        await engine.createSession({ id: sessionId, title: node.title, purpose: 'workflow' });
        const promptText = renderText(node.prompt, templateContext);
        const receipt = await engine.prompt(sessionId, promptText, { dispatchId: id, model: node.model });
        return { sessionId, receipt };
      },
      dispatchRepair: async (repairDispatchId, repairPrompt, id) =>
        await engine.prompt(id, repairPrompt, { dispatchId: repairDispatchId, model: node.model, queueMode: 'followup' }),
      buildDispatchedResult: (dispatch) => ({ sessionId: dispatch.sessionId, receipt: dispatch.receipt }),
      buildSettledResult: (id, result) => ({ sessionId: id, response: result.text, output: result.output }),
    },
  );
}

function renderText(source: string, ctx: TemplateContext): string {
  const v = renderTemplate(source, ctx);
  if (typeof v === 'string') return v;
  if (v === undefined || v === null) return '';
  return JSON.stringify(v);
}
