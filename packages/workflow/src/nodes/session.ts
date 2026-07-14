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
 * Lifecycle:
 *   1. No receipt in `effects` yet (first entry, or resumed after a crash
 *      before the receipt was persisted): write the intent (first entry
 *      only — a resumed entry already has one), (re-)dispatch
 *      `createSession` + `prompt`, persist the receipt into `effects`. If
 *      `wait.mode === 'none'`, complete now with `{ sessionId, receipt }`
 *      (fire-and-forget — never awaits settlement). Otherwise park on the
 *      submission without checking settlement (a submission dispatched this
 *      same call cannot already be settled).
 *   2. A receipt is already on record (a prior drive got this far): check
 *      `engine.isSettled` first — a non-blocking probe — and re-park on the
 *      same submission if it hasn't settled yet. This keeps a spurious wake
 *      (or the host's lost-wake sweep) from blocking the drive on
 *      `awaitResult`.
 *   3. Settled: `awaitResult` (resolves immediately) and map the outcome:
 *      - `completed` with a valid result (no `outputSchema`, or `output`
 *        present) → node `completed` with `{ sessionId, response, output }`.
 *      - `completed` with `outputSchema` set but `output` missing
 *        (validation failed) and no prior repair attempt → prompt the same
 *        session with the schema + validation error
 *        (`dispatchId + ':repair'`, `queueMode: 'followup'`), overwrite
 *        `effects.receipt` with the repair receipt, set
 *        `effects.repairAttempted`, park again. A second validation failure
 *        (`repairAttempted` already true) → node `failed`.
 *      - `failed`/`aborted`/`superseded`/`merged` → node `failed` with
 *        `result.error` (or a message naming the outcome).
 */

import type { SubmissionResult } from '@valet/engine';

import { renderTemplate, type TemplateContext } from '../dag/expression.js';
import type { SessionNode } from '../dag/nodes.js';
import type { WorkflowPromptReceipt } from '../engine-deps.js';
import type { NodeCheckpoint } from '../store.js';
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

interface SessionEffects {
  sessionId: string;
  receipt?: WorkflowPromptReceipt;
  repairAttempted: boolean;
}

export async function executeSession(args: NodeExecutorArgs<SessionNode>): Promise<NodeExecuteResult> {
  const { run, node, attempt, iteration, store, clock, engine, existingCheckpoint } = args;
  const templateContext = resolveTemplateContext(args);

  const suffix = iterationSuffix(iteration);
  const sessionId = `wf:${run.runId}:${node.id}${suffix}`;
  const dispatchId = `workflow:${run.runId}:${node.id}${suffix}`;
  const effects = readEffects(existingCheckpoint, sessionId);

  if (effects.receipt === undefined) {
    // First entry, or resumed after a crash before the receipt was
    // persisted. Write the intent before any externally-visible call (only
    // needed once — a resumed entry already has an intent row).
    if (existingCheckpoint === undefined) {
      await store.putIntent({
        runId: run.runId,
        nodeId: node.id,
        iteration,
        status: 'intent',
        attempt,
        createdAt: clock(),
        effects: { sessionId },
      });
    }

    await engine.createSession({ id: sessionId, title: node.title, purpose: 'workflow' });
    const promptText = renderText(node.prompt, templateContext);
    const receipt = await engine.prompt(sessionId, promptText, { dispatchId, model: node.model });

    await store.putIntent({
      runId: run.runId,
      nodeId: node.id,
      iteration,
      status: 'intent',
      attempt,
      createdAt: clock(),
      effects: { sessionId, receipt, repairAttempted: false },
    });

    if (node.wait?.mode === 'none') {
      const result: SessionDispatchedResult = { sessionId, receipt };
      await store.completeCheckpoint(run.runId, node.id, iteration, attempt, {
        runId: run.runId,
        nodeId: node.id,
        iteration,
        status: 'completed',
        result,
        effects: { sessionId, receipt, repairAttempted: false },
        attempt,
        createdAt: clock(),
      });
      return { status: 'completed', result };
    }

    return {
      status: 'parked',
      waitingOn: [{ kind: 'submission', nodeId: node.id, sessionId, threadId: receipt.threadId, queueItemId: receipt.queueItemId }],
    };
  }

  const receipt = effects.receipt;
  const settled = await engine.isSettled(sessionId, receipt.queueItemId);
  if (!settled) {
    return {
      status: 'parked',
      waitingOn: [{ kind: 'submission', nodeId: node.id, sessionId, threadId: receipt.threadId, queueItemId: receipt.queueItemId }],
    };
  }

  // `node.outputSchema` (a JSON Schema object) is passed straight through as
  // a `TSchema`: `typebox`'s `TSchema` is declared as an empty interface
  // (`export interface TSchema {}`), so any JSON-Schema-shaped object is
  // already structurally assignable to it — no `as` bridge is needed here.
  const result = await engine.awaitResult(
    sessionId,
    receipt.threadId,
    receipt.queueItemId,
    node.outputSchema !== undefined ? { resultSchema: node.outputSchema } : undefined,
  );

  return await handleOutcome(args, sessionId, dispatchId, receipt, effects.repairAttempted, result);
}

async function handleOutcome(
  args: NodeExecutorArgs<SessionNode>,
  sessionId: string,
  dispatchId: string,
  receipt: WorkflowPromptReceipt,
  repairAttempted: boolean,
  result: SubmissionResult,
): Promise<NodeExecuteResult> {
  const { run, node, attempt, iteration, store, clock, engine } = args;

  if (result.outcome !== 'completed') {
    const error = result.error ?? `session node "${node.id}" submission outcome: ${result.outcome}`;
    await store.completeCheckpoint(run.runId, node.id, iteration, attempt, {
      runId: run.runId,
      nodeId: node.id,
      iteration,
      status: 'failed',
      error,
      effects: { sessionId, receipt, repairAttempted },
      attempt,
      createdAt: clock(),
    });
    return { status: 'failed', error };
  }

  if (node.outputSchema === undefined || result.output !== undefined) {
    const settledResult: SessionSettledResult = { sessionId, response: result.text, output: result.output };
    await store.completeCheckpoint(run.runId, node.id, iteration, attempt, {
      runId: run.runId,
      nodeId: node.id,
      iteration,
      status: 'completed',
      result: settledResult,
      effects: { sessionId, receipt, repairAttempted },
      attempt,
      createdAt: clock(),
    });
    return { status: 'completed', result: settledResult };
  }

  // completed, but outputSchema set and output missing: schema validation failed.
  if (repairAttempted) {
    const error = result.error ?? `session node "${node.id}" result did not match outputSchema after repair`;
    await store.completeCheckpoint(run.runId, node.id, iteration, attempt, {
      runId: run.runId,
      nodeId: node.id,
      iteration,
      status: 'failed',
      error,
      effects: { sessionId, receipt, repairAttempted },
      attempt,
      createdAt: clock(),
    });
    return { status: 'failed', error };
  }

  // Exactly one repair attempt: re-prompt the same session/thread with the
  // schema + validation error, tracked via `repairAttempted` so a second
  // validation failure fails the node instead of repairing forever.
  const repairText = buildRepairPrompt(node.outputSchema, result.error);
  const repairReceipt = await engine.prompt(sessionId, repairText, {
    dispatchId: `${dispatchId}:repair`,
    model: node.model,
    queueMode: 'followup',
  });
  await store.putIntent({
    runId: run.runId,
    nodeId: node.id,
    iteration,
    status: 'intent',
    attempt,
    createdAt: clock(),
    effects: { sessionId, receipt: repairReceipt, repairAttempted: true },
  });
  return {
    status: 'parked',
    waitingOn: [
      { kind: 'submission', nodeId: node.id, sessionId, threadId: repairReceipt.threadId, queueItemId: repairReceipt.queueItemId },
    ],
  };
}

function buildRepairPrompt(schema: Record<string, unknown>, validationError: string | undefined): string {
  const errorText = validationError ?? 'result did not match the schema';
  return [
    'Your previous response did not match the required JSON schema.',
    '',
    'Schema:',
    JSON.stringify(schema),
    '',
    `Validation error: ${errorText}`,
    '',
    'Respond with ONLY the corrected JSON, matching the schema exactly.',
  ].join('\n');
}

function readEffects(existingCheckpoint: NodeCheckpoint | undefined, fallbackSessionId: string): SessionEffects {
  const raw = existingCheckpoint?.effects;
  if (!raw) return { sessionId: fallbackSessionId, repairAttempted: false };
  return {
    sessionId: typeof raw.sessionId === 'string' ? raw.sessionId : fallbackSessionId,
    receipt: parseReceipt(raw.receipt),
    repairAttempted: raw.repairAttempted === true,
  };
}

function parseReceipt(value: unknown): WorkflowPromptReceipt | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const v = value as Record<string, unknown>;
  if (typeof v.threadId !== 'string' || typeof v.queueItemId !== 'string') return undefined;
  return { threadId: v.threadId, queueItemId: v.queueItemId };
}

function renderText(source: string, ctx: TemplateContext): string {
  const v = renderTemplate(source, ctx);
  if (typeof v === 'string') return v;
  if (v === undefined || v === null) return '';
  return JSON.stringify(v);
}
