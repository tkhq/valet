/**
 * `approval` node executor (Phase 5 plan decision 12). Parks the run behind
 * a `signal-wait` — a human (or another system) resolves it via a durable
 * `RunSignal` of type `approval:{nodeId}` carrying
 * `{ approved: boolean; resolvedBy: string; note?: string }`.
 *
 * Lifecycle:
 *   - First entry (no existing checkpoint): write the intent checkpoint
 *     (persisting `effects.timeoutAt` if `timeout` is set — same
 *     read-back-don't-re-read-the-clock rule as `wait`), then fire
 *     `onApprovalPending` exactly once, keyed off "intent did not already
 *     exist" so spurious re-drives never re-notify.
 *   - Every entry (first or resumed) then checks for an unconsumed signal
 *     matching `approval:{nodeId}`. If found, resolve it atomically with
 *     the terminal checkpoint via `consumeSignalAndCheckpoint` — this also
 *     covers "signal arrives before the node's first park", since the
 *     first-entry path falls through to this same check before parking.
 *   - No matching signal and a `timeoutAt` has passed: treat as denied
 *     (`resolvedBy: 'timeout'`), completed directly (no signal to
 *     consume).
 *   - Otherwise: park on `{ kind: 'signal', ... }`.
 *
 * Deny semantics (`onDeny`, default `'fail'`): `'fail'` → node `failed`.
 * `'skip'` → node `completed` with `{ approved: false, resolvedBy }` so
 * `fromOutput: 'false'` edges activate exactly like an `if` false branch
 * (the interpreter's `booleanOutputOf` already reads `result.approved`).
 */

import { renderJsonTemplates, renderTemplate, type TemplateContext } from '../dag/expression.js';
import { parseDurationMs } from '../dag/duration.js';
import type { ApprovalNode } from '../dag/nodes.js';
import type { NodeCheckpoint, RunSignal } from '../store.js';
import type { NodeExecuteResult, NodeExecutorArgs } from './index.js';

export interface ApprovalResult {
  approved: boolean;
  resolvedBy: string;
}

interface ApprovalPayload {
  approved: boolean;
  resolvedBy: string;
  note?: string;
}

export async function executeApproval(args: NodeExecutorArgs<ApprovalNode>): Promise<NodeExecuteResult> {
  const { run, node, attempt, iteration, store, clock, templateContext, existingCheckpoint, onApprovalPending } = args;
  const signalType = `approval:${node.id}`;

  let timeoutAt: number | undefined;

  if (existingCheckpoint === undefined) {
    if (node.timeout !== undefined) {
      const ms = parseDurationMs(node.timeout);
      if (ms === null) {
        // Defensive: `dag/validate.ts` rejects an unparseable
        // `approval.timeout` at definition time.
        const error = `approval node "${node.id}" has an unparseable timeout: ${JSON.stringify(node.timeout)}`;
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
      }
      timeoutAt = clock() + ms;
    }

    await store.putIntent({
      runId: run.runId,
      nodeId: node.id,
      iteration,
      status: 'intent',
      attempt,
      createdAt: clock(),
      ...(timeoutAt !== undefined ? { effects: { timeoutAt } } : {}),
    });

    await onApprovalPending?.({
      runId: run.runId,
      nodeId: node.id,
      prompt: renderText(node.prompt, templateContext),
      summary: node.summary !== undefined ? renderText(node.summary, templateContext) : undefined,
      details: node.details !== undefined ? renderJsonTemplates(node.details, templateContext) : undefined,
    });
  } else {
    const effTimeoutAt = existingCheckpoint.effects?.timeoutAt;
    timeoutAt = typeof effTimeoutAt === 'number' ? effTimeoutAt : undefined;
  }

  const signals = await store.listSignals(run.runId, { unconsumed: true });
  const match = signals.find((s) => s.signalType === signalType);

  if (match) {
    return await resolveViaSignal(args, match, timeoutAt);
  }

  if (timeoutAt !== undefined && clock() >= timeoutAt) {
    return await resolveViaTimeout(args);
  }

  return { status: 'parked', waitingOn: [{ kind: 'signal', nodeId: node.id, signalType, timeoutAt }] };
}

async function resolveViaSignal(
  args: NodeExecutorArgs<ApprovalNode>,
  signal: RunSignal,
  timeoutAt: number | undefined,
): Promise<NodeExecuteResult> {
  const { run, node, attempt, iteration, store, clock } = args;
  const payload = parseApprovalPayload(signal.payload);
  const consumedBy = { nodeId: node.id, iteration, attempt };

  if (payload.approved) {
    const result: ApprovalResult = { approved: true, resolvedBy: payload.resolvedBy };
    const checkpoint: NodeCheckpoint = {
      runId: run.runId,
      nodeId: node.id,
      iteration,
      status: 'completed',
      result,
      attempt,
      createdAt: clock(),
    };
    await store.consumeSignalAndCheckpoint(signal.signalId, consumedBy, checkpoint);
    return { status: 'completed', result };
  }

  return await denyOutcome(args, (checkpoint) =>
    store.consumeSignalAndCheckpoint(signal.signalId, consumedBy, checkpoint),
    payload.resolvedBy,
  );
}

async function resolveViaTimeout(args: NodeExecutorArgs<ApprovalNode>): Promise<NodeExecuteResult> {
  const { run, node, attempt, iteration, store } = args;
  return await denyOutcome(
    args,
    (checkpoint) => store.completeCheckpoint(run.runId, node.id, iteration, attempt, checkpoint),
    'timeout',
  );
}

/** Shared deny handling: writes the terminal checkpoint via `write`, honoring `onDeny` (default `'fail'`). */
async function denyOutcome(
  args: NodeExecutorArgs<ApprovalNode>,
  write: (checkpoint: NodeCheckpoint) => Promise<void>,
  resolvedBy: string,
): Promise<NodeExecuteResult> {
  const { run, node, attempt, iteration, clock } = args;
  const onDeny = node.onDeny ?? 'fail';

  if (onDeny === 'skip') {
    const result: ApprovalResult = { approved: false, resolvedBy };
    const checkpoint: NodeCheckpoint = {
      runId: run.runId,
      nodeId: node.id,
      iteration,
      status: 'completed',
      result,
      attempt,
      createdAt: clock(),
    };
    await write(checkpoint);
    return { status: 'completed', result };
  }

  const error = resolvedBy === 'timeout' ? `approval "${node.id}" timed out` : `approval "${node.id}" denied by ${resolvedBy}`;
  const checkpoint: NodeCheckpoint = {
    runId: run.runId,
    nodeId: node.id,
    iteration,
    status: 'failed',
    error,
    attempt,
    createdAt: clock(),
  };
  await write(checkpoint);
  return { status: 'failed', error };
}

function parseApprovalPayload(payload: unknown): ApprovalPayload {
  if (!payload || typeof payload !== 'object') {
    throw new Error('approval signal payload is not an object');
  }
  const p = payload as Record<string, unknown>;
  if (typeof p.approved !== 'boolean') {
    throw new Error('approval signal payload missing boolean "approved"');
  }
  if (typeof p.resolvedBy !== 'string') {
    throw new Error('approval signal payload missing string "resolvedBy"');
  }
  return {
    approved: p.approved,
    resolvedBy: p.resolvedBy,
    note: typeof p.note === 'string' ? p.note : undefined,
  };
}

function renderText(source: string, ctx: TemplateContext): string {
  const v = renderTemplate(source, ctx);
  if (typeof v === 'string') return v;
  if (v === undefined || v === null) return '';
  return JSON.stringify(v);
}
