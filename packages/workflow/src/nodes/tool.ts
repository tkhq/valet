/**
 * `tool` node executor (node-completion plan decision 6). Dispatches a
 * single external action invocation via `engine.invokeAction` and maps its
 * result onto the node's checkpoint. Supports a policy-gate lifecycle: when
 * `invokeAction` returns `{ ok: false, requiresApproval: true }`, the
 * executor parks behind a `signal` wait and resumes when a resolution signal
 * lands or the `approvalTimeout` elapses.
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
 * Gate lifecycle (when a policy gate is raised):
 *   1. `invokeAction` returns `requiresApproval: true` on first entry.
 *   2. Executor writes gate effects into the intent checkpoint (`putIntent`
 *      replaces an existing intent row — `memory-store.ts:196`), fires
 *      `onApprovalPending` exactly once (keyed off `effects.gate !== true`),
 *      and parks on `approval:{nodeId}[:{iteration}]`.
 *   3. On resume: if an unconsumed signal of that type is found, the
 *      executor resolves it (invoke with approval field, then
 *      `consumeSignalAndCheckpoint`). If the timeout has elapsed and no
 *      signal arrived, the node is denied. Otherwise re-parks.
 *   4. Spec §2: invoke-first-THEN-consume is the pinned order so the
 *      invoker's dedup covers the crash window between invoke and consume.
 *   5. Spec §1: if `invokeAction` STILL returns `requiresApproval` after
 *      the approval field was provided, the executor fails loudly rather
 *      than re-parking (livelock guard).
 */

import { parseDurationMs } from '../dag/duration.js';
import {
  collectUnresolvedTemplatePaths,
  renderJsonTemplates,
  type TemplateContext,
} from '../dag/expression.js';
import type { ToolNode } from '../dag/nodes.js';
import type { NodeCheckpoint, RunSignal } from '../store.js';
import { iterationSuffix, resolveTemplateContext, type NodeExecuteResult, type NodeExecutorArgs } from './index.js';

// ─── Effects shape ────────────────────────────────────────────────────────────

interface ToolEffects {
  invocationId?: string;
  gate?: boolean;
  gateParams?: unknown;
  gateParamsTruncated?: boolean;
  gateItem?: unknown;
  riskLevel?: string;
  provenance?: string;
  timeoutAt?: number;
}

function readToolEffects(cp: NodeCheckpoint | undefined): ToolEffects {
  if (cp === undefined || cp.effects === undefined) return {};
  const e = cp.effects;
  return {
    invocationId: typeof e.invocationId === 'string' ? e.invocationId : undefined,
    gate: e.gate === true ? true : undefined,
    gateParams: e.gateParams,
    gateParamsTruncated: e.gateParamsTruncated === true ? true : undefined,
    gateItem: e.gateItem,
    riskLevel: typeof e.riskLevel === 'string' ? e.riskLevel : undefined,
    provenance: typeof e.provenance === 'string' ? e.provenance : undefined,
    timeoutAt: typeof e.timeoutAt === 'number' ? e.timeoutAt : undefined,
  };
}

// ─── 8KB cap helper (local — this package cannot import packages/api) ─────────

interface CapResult {
  value: unknown;
  truncated: boolean;
}

function capJson(value: unknown): CapResult {
  const json = JSON.stringify(value);
  if (json.length <= 8192) {
    return { value, truncated: false };
  }
  return { value: { truncated: true, preview: json.slice(0, 8192) }, truncated: true };
}

// ─── Gate payload parsing ─────────────────────────────────────────────────────

interface GatePayload {
  approved: boolean;
  resolvedBy: string;
  note?: string;
}

function parseGatePayload(payload: unknown): GatePayload {
  if (!payload || typeof payload !== 'object') {
    throw new Error('gate resolution signal payload is not an object');
  }
  const p = payload as Record<string, unknown>;
  if (typeof p.approved !== 'boolean') {
    throw new Error('gate resolution signal payload missing boolean "approved"');
  }
  if (typeof p.resolvedBy !== 'string') {
    throw new Error('gate resolution signal payload missing string "resolvedBy"');
  }
  return {
    approved: p.approved,
    resolvedBy: p.resolvedBy,
    note: typeof p.note === 'string' ? p.note : undefined,
  };
}

// ─── Main executor ────────────────────────────────────────────────────────────

export async function executeTool(args: NodeExecutorArgs<ToolNode>): Promise<NodeExecuteResult> {
  const { run, node, attempt, iteration, store, clock, engine, existingCheckpoint,
          onApprovalPending, onGateResolved } = args;
  const templateContext = resolveTemplateContext(args);
  const suffix = iterationSuffix(iteration);
  const signalType = `approval:${node.id}${suffix}`;

  let effects = readToolEffects(existingCheckpoint);
  let invocationId = effects.invocationId ?? mintInvocationId(run.runId, node.id, iteration);

  if (existingCheckpoint === undefined) {
    await store.putIntent({
      runId: run.runId,
      nodeId: node.id,
      iteration,
      status: 'intent',
      attempt,
      createdAt: clock(),
      effects: { invocationId },
    });
  }

  const renderedParams = renderJsonTemplates<unknown>(node.params, templateContext);
  if (!isPlainRecord(renderedParams)) {
    return await writeTerminal(
      args, invocationId, undefined,
      { status: 'failed', error: `tool node "${node.id}" params template-rendered to a non-object value` },
    );
  }

  // ─── Gate already open? Resolve/timeout/re-park BEFORE any invoke. ────────
  let approval: { resolvedBy: string; note?: string } | undefined;
  let heldSignal: RunSignal | undefined;

  if (effects.gate === true) {
    const signals = await store.listSignals(run.runId, { unconsumed: true });
    heldSignal = signals.find((s) => s.signalType === signalType);
    if (heldSignal) {
      const payload = parseGatePayload(heldSignal.payload);
      if (!payload.approved) {
        return await denyOutcome(args, invocationId, payload.resolvedBy, payload.note, heldSignal);
      }
      approval = {
        resolvedBy: payload.resolvedBy,
        ...(payload.note !== undefined ? { note: payload.note } : {}),
      };
    } else if (effects.timeoutAt !== undefined && clock() >= effects.timeoutAt) {
      await callGateResolved(onGateResolved, { run, node, iteration, invocationId, outcome: 'timeout', resolvedBy: 'timeout' });
      return await denyOutcome(args, invocationId, 'timeout', undefined, undefined);
    } else {
      return park(node, signalType, effects.timeoutAt);
    }
  }

  // ─── Invoke ───────────────────────────────────────────────────────────────
  let response;
  try {
    response = await engine.invokeAction({
      service: node.service,
      action: node.action,
      params: renderedParams,
      invocationId,
      ...(node.credential !== undefined ? { credential: node.credential } : {}),
      ...(approval !== undefined ? { approval } : {}),
    });
  } catch (err) {
    return await writeTerminal(args, invocationId, heldSignal, { status: 'failed', error: errorMessage(err) });
  }

  // ─── Gate raised ─────────────────────────────────────────────────────────
  if (!response.ok && 'requiresApproval' in response && response.requiresApproval) {
    if (approval !== undefined) {
      // Spec §1: approval was provided but enforcement still requires it —
      // the grant write may have failed. Fail loudly; never livelock.
      // The signal must still be consumed so it can't re-deliver.
      return await writeTerminal(args, invocationId, heldSignal, {
        status: 'failed',
        error: `approval was recorded but policy enforcement still requires approval for ${node.service}.${node.action} — the grant write may have failed; resolve the gate again or check org policies`,
      });
    }
    return await openGate(args, invocationId, renderedParams, response.riskLevel, response.provenance);
  }

  if (!response.ok) {
    const base = 'error' in response ? response.error : 'invokeAction returned ok:false';
    return await writeTerminal(args, invocationId, heldSignal, {
      status: 'failed',
      error: base + unresolvedParamsNote(node.params, templateContext),
    });
  }

  return await writeTerminal(args, invocationId, heldSignal, { status: 'completed', result: response.result });
}

// ─── Gate open (first park) ───────────────────────────────────────────────────

async function openGate(
  args: NodeExecutorArgs<ToolNode>,
  invocationId: string,
  renderedParams: Record<string, unknown>,
  riskLevel: string | undefined,
  provenance: string | undefined,
): Promise<NodeExecuteResult> {
  const { run, node, attempt, iteration, store, clock, onApprovalPending } = args;
  const suffix = iterationSuffix(iteration);
  const signalType = `approval:${node.id}${suffix}`;

  let timeoutAt: number | undefined;
  if (node.approvalTimeout !== undefined) {
    const ms = parseDurationMs(node.approvalTimeout);
    if (ms === null) {
      const error = `tool node "${node.id}" has an unparseable approvalTimeout: ${JSON.stringify(node.approvalTimeout)}`;
      await store.completeCheckpoint(run.runId, node.id, iteration, attempt, {
        runId: run.runId,
        nodeId: node.id,
        iteration,
        status: 'failed',
        error,
        effects: { invocationId },
        attempt,
        createdAt: clock(),
      });
      return { status: 'failed', error };
    }
    timeoutAt = clock() + ms;
  }

  const gp = capJson(renderedParams);
  const gateItem = args.aliases !== undefined ? capJson(args.aliases).value : undefined;

  const gateEffects: Record<string, unknown> = {
    invocationId,
    gate: true,
    gateParams: gp.value,
    ...(gp.truncated ? { gateParamsTruncated: true } : {}),
    ...(gateItem !== undefined ? { gateItem } : {}),
    ...(riskLevel !== undefined ? { riskLevel } : {}),
    ...(provenance !== undefined ? { provenance } : {}),
    ...(timeoutAt !== undefined ? { timeoutAt } : {}),
  };

  // putIntent replaces an existing intent row (memory-store.ts:196) — this
  // is the documented way to grow effects on a re-entered intent.
  await store.putIntent({
    runId: run.runId,
    nodeId: node.id,
    iteration,
    status: 'intent',
    attempt,
    createdAt: clock(),
    effects: gateEffects,
  });

  // Fire onApprovalPending only on first gate open (effects.gate !== true
  // before this call — the check is done in the caller before entering
  // openGate, which is only called when effects.gate is falsy).
  await onApprovalPending?.({
    runId: run.runId,
    nodeId: node.id,
    kind: 'policy_gate',
    service: node.service,
    action: node.action,
    params: gp.value,
    ...(iteration > 0 ? { iteration } : {}),
  });

  return park(node, signalType, timeoutAt);
}

// ─── Park ─────────────────────────────────────────────────────────────────────

function park(node: ToolNode, signalType: string, timeoutAt: number | undefined): NodeExecuteResult {
  return {
    status: 'parked',
    waitingOn: [
      {
        kind: 'signal',
        nodeId: node.id,
        signalType,
        ...(timeoutAt !== undefined ? { timeoutAt } : {}),
      },
    ],
  };
}

// ─── Deny outcome ─────────────────────────────────────────────────────────────

async function denyOutcome(
  args: NodeExecutorArgs<ToolNode>,
  invocationId: string,
  resolvedBy: string,
  note: string | undefined,
  signal: RunSignal | undefined,
): Promise<NodeExecuteResult> {
  const { node, onGateResolved } = args;
  const onDeny = node.onDeny ?? 'fail';

  if (signal !== undefined) {
    // Best-effort audit callback for signal-driven denials (host impl is idempotent).
    await callGateResolved(onGateResolved, {
      run: args.run,
      node,
      iteration: args.iteration,
      invocationId,
      outcome: 'denied',
      resolvedBy,
    });
  }

  if (onDeny === 'skip') {
    const result = { approved: false, policyDenied: true, resolvedBy, note };
    return await writeTerminal(args, invocationId, signal, { status: 'completed', result });
  }

  const error =
    resolvedBy === 'timeout'
      ? `${node.service}.${node.action} approval timed out`
      : `${node.service}.${node.action} was denied by ${resolvedBy}`;
  return await writeTerminal(args, invocationId, signal, { status: 'failed', error });
}

// ─── Terminal checkpoint write ────────────────────────────────────────────────

type TerminalOutcome =
  | { status: 'completed'; result: unknown }
  | { status: 'failed'; error: string };

async function writeTerminal(
  args: NodeExecutorArgs<ToolNode>,
  invocationId: string,
  heldSignal: RunSignal | undefined,
  outcome: TerminalOutcome,
): Promise<NodeExecuteResult> {
  const { run, node, attempt, iteration, store, clock } = args;
  const checkpoint: NodeCheckpoint = {
    runId: run.runId,
    nodeId: node.id,
    iteration,
    ...outcome,
    effects: { invocationId },
    attempt,
    createdAt: clock(),
  };
  const consumedBy = { nodeId: node.id, iteration, attempt };
  if (heldSignal !== undefined) {
    await store.consumeSignalAndCheckpoint(heldSignal.signalId, consumedBy, checkpoint);
  } else {
    await store.completeCheckpoint(run.runId, node.id, iteration, attempt, checkpoint);
  }
  if (outcome.status === 'completed') return { status: 'completed', result: outcome.result };
  return { status: 'failed', error: outcome.error };
}

// ─── onGateResolved trampoline ────────────────────────────────────────────────

async function callGateResolved(
  onGateResolved: NodeExecutorArgs<ToolNode>['onGateResolved'],
  info: {
    run: NodeExecutorArgs<ToolNode>['run'];
    node: ToolNode;
    iteration: number;
    invocationId: string;
    outcome: 'denied' | 'timeout';
    resolvedBy: string;
  },
): Promise<void> {
  if (onGateResolved === undefined) return;
  try {
    await onGateResolved({
      runId: info.run.runId,
      nodeId: info.node.id,
      iteration: info.iteration,
      invocationId: info.invocationId,
      outcome: info.outcome,
      resolvedBy: info.resolvedBy,
    });
  } catch {
    // Best-effort — a throw must not abort the node.
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function mintInvocationId(runId: string, nodeId: string, iteration: number): string {
  return `workflow:${runId}:${nodeId}${iterationSuffix(iteration)}`;
}

function isPlainRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * When a failed invocation's params contained template paths that resolved
 * to nothing (each rendered as null), name them — a receiver-side
 * "param must be a string" error is otherwise a dead end for the author.
 */
function unresolvedParamsNote(params: Record<string, unknown>, ctx: TemplateContext): string {
  const unresolved = new Set<string>();
  collectFromJson(params, ctx, unresolved);
  if (unresolved.size === 0) return '';
  return ` (unresolved template path(s), each rendered as null: ${[...unresolved].join(', ')})`;
}

function collectFromJson(value: unknown, ctx: TemplateContext, out: Set<string>): void {
  if (typeof value === 'string') {
    for (const path of collectUnresolvedTemplatePaths(value, ctx)) out.add(path);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectFromJson(entry, ctx, out);
    return;
  }
  if (isPlainRecord(value)) {
    for (const entry of Object.values(value)) collectFromJson(entry, ctx, out);
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
