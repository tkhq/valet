/**
 * `foreach` node executor (node-completion plan decision 8 — the hardest
 * executor in the plan). Iterates over a bounded, template-resolved array,
 * running one inline body node per item, with bounded concurrency and
 * three `onItemError` policies. Unlike every other executor, `foreach`
 * OWNS a second tier of checkpoints: one per `(runId, body.id, i)` — the
 * body node's id never appears in `definition.nodes`, so the interpreter's
 * wave loop never sees these rows; only this executor reads/writes them.
 *
 * ─── Items resolution + truncation ──────────────────────────────────────
 * `node.items` is template-rendered against `{ trigger, nodes }` (+ any
 * inherited aliases — irrelevant in practice since a foreach can never be
 * a foreach body, but threaded for uniformity). A non-array result fails
 * the node immediately (no iterations attempted). The array is truncated
 * to `maxItems` (default 100); `truncatedCount = inputCount - count`.
 *
 * Items re-resolve deterministically on every entry (upstream checkpoints
 * are immutable, so the same render always yields the same array) — this
 * executor does NOT cache the resolved items themselves in `effects`.
 * `{ itemCount, truncatedCount, inputCount }` IS persisted into the first
 * intent's effects purely as a defensive consistency check: if a resumed
 * entry's fresh render disagrees with the persisted counts, that indicates
 * upstream determinism was violated (a checkpoint mutated, or the
 * definition changed under a live run) and this executor throws rather
 * than silently iterating a different array than the one it started.
 *
 * ─── Per-iteration execution ────────────────────────────────────────────
 * For each index `i` (processed in order):
 *   - a terminal body checkpoint (completed/failed) → its outcome is
 *     recorded and the iteration is never re-entered.
 *   - an `intent` body checkpoint (parked in an earlier pass) → always
 *     re-entered (re-invoking the body executor lets it re-check
 *     `isSettled`/`awaitResult` on its own submission; this does not
 *     consume a fresh concurrency slot — the slot was already spent when
 *     it first parked).
 *   - no checkpoint (never started) → started only if fewer than
 *     `concurrency` iterations are currently in flight (a "dispatched and
 *     still parked as of this pass" count, per decision 8); otherwise
 *     deferred (left absent) for a later pass.
 *
 * `inFlight` is tracked incrementally as the loop proceeds: it only
 * increments when an iteration's outcome THIS pass is `parked` — an
 * iteration that resolves to terminal (whether newly dispatched or
 * re-entered) frees its slot immediately, so a later absent item in the
 * SAME pass can take it. This is why a concurrency=1 run of purely
 * synchronous bodies (e.g. `set`) finishes the entire array in one call:
 * nothing ever parks, so the gate never triggers.
 *
 * ─── onItemError ─────────────────────────────────────────────────────────
 *   - 'skip': a failed body iteration is recorded as `{status:'skipped',
 *     error}` (no `data`); the pass continues.
 *   - 'collect': a failed body iteration is recorded as `{status:'failed',
 *     error}`; the pass continues; the foreach node itself still
 *     completes once every item is terminal.
 *   - 'fail' (default): the FIRST failed iteration encountered while
 *     walking the array in index order this pass immediately halts
 *     further processing — no iteration at a higher index is started (or
 *     even consulted, including ones that may already be terminal from an
 *     earlier pass — an accepted trade-off of the single-pass, index-order
 *     design; see the report). The aggregate is written with whatever is
 *     known: already-terminal iterations keep their real status, and every
 *     other iteration (still `intent`/in-flight, or never reached) is
 *     recorded as `{status:'skipped'}`. The foreach node itself is marked
 *     `failed`. Body iterations left in-flight (this pass's `waitingOn`,
 *     or an earlier pass's still-`intent` checkpoint the break never
 *     revisited) are aborted best-effort by this executor itself
 *     (`session`/`orchestrator` bodies persist a `{sessionId,
 *     receipt:{threadId, queueItemId}}` effects shape this reads back for
 *     `engine.abort`) before returning failed — the interpreter's
 *     cancel/terminate paths never see these sub-run-level submissions, so
 *     nothing else would ever abort them.
 *
 * ─── Aggregate result ────────────────────────────────────────────────────
 * Once every item (0..count-1) has a terminal outcome for this pass (i.e.
 * `waitingOn` came back empty and no fail-mode short-circuit fired), the
 * foreach's OWN checkpoint (at `args.iteration`, top-level so always 0 —
 * a foreach can never be a foreach body) is completed with the
 * `ForeachResult` aggregate. Downstream nodes read
 * `nodes.<foreachId>.output.items[i].data`.
 */

import { renderTemplate } from '../dag/expression.js';
import type { ForeachBodyNode, ForeachNode } from '../dag/nodes.js';
import type { NodeCheckpoint, RunWaitCondition } from '../store.js';
import { executeLlm } from './llm.js';
import { executeOrchestrator } from './orchestrator.js';
import { executeSession } from './session.js';
import { executeSet } from './set.js';
import { executeTool } from './tool.js';
import { resolveTemplateContext, type NodeExecuteResult, type NodeExecutorArgs } from './index.js';

const DEFAULT_MAX_ITEMS = 100;
const DEFAULT_CONCURRENCY = 1;

export interface ForeachItemResult {
  status: 'completed' | 'skipped' | 'failed';
  data?: unknown;
  error?: string;
}

export interface ForeachResult {
  items: ForeachItemResult[];
  count: number;
  inputCount: number;
  truncatedCount: number;
  completedCount: number;
  skippedCount: number;
  failedCount: number;
}

interface ForeachEffects {
  itemCount: number;
  truncatedCount: number;
  inputCount: number;
}

export async function executeForeach(args: NodeExecutorArgs<ForeachNode>): Promise<NodeExecuteResult> {
  const { run, node, attempt, iteration, store, clock, existingCheckpoint } = args;
  const templateContext = resolveTemplateContext(args);

  const rendered = renderTemplate(node.items, templateContext);
  if (!Array.isArray(rendered)) {
    const error = `foreach "${node.id}": items expression did not resolve to an array (got ${typeof rendered})`;
    if (existingCheckpoint === undefined) {
      await store.putIntent({ runId: run.runId, nodeId: node.id, iteration, status: 'intent', attempt, createdAt: clock() });
    }
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

  const inputItems: unknown[] = rendered;
  const maxItems = node.maxItems ?? DEFAULT_MAX_ITEMS;
  const items = inputItems.slice(0, maxItems);
  const effects: ForeachEffects = {
    itemCount: items.length,
    truncatedCount: Math.max(0, inputItems.length - items.length),
    inputCount: inputItems.length,
  };

  if (existingCheckpoint === undefined) {
    await store.putIntent({
      runId: run.runId,
      nodeId: node.id,
      iteration,
      status: 'intent',
      attempt,
      createdAt: clock(),
      effects: effectsToRecord(effects),
    });
  } else {
    const persisted = readEffects(existingCheckpoint);
    if (persisted !== undefined && !effectsEqual(persisted, effects)) {
      // Upstream checkpoints are immutable, so a resumed drive must
      // re-derive the exact same array every time. Disagreement here means
      // a determinism invariant was violated elsewhere — not a per-item
      // failure, a structural bug — so this throws rather than silently
      // iterating a different array than the one the run started with.
      throw new Error(
        `foreach "${node.id}": items re-resolved to a different shape on resume ` +
          `(persisted ${JSON.stringify(persisted)}, now ${JSON.stringify(effects)}) — contract violation`,
      );
    }
  }

  const itemAlias = node.itemAlias ?? 'item';
  const indexAlias = node.indexAlias ?? 'index';
  const concurrency = node.concurrency ?? DEFAULT_CONCURRENCY;
  const onItemError = node.onItemError ?? 'fail';

  const bodyCheckpoints = await loadBodyCheckpoints(store, run.runId, node.body.id);

  const results: (ForeachItemResult | undefined)[] = new Array(items.length);
  const waitingOn: RunWaitCondition[] = [];
  let inFlight = 0;
  let failure: { error: string } | undefined;

  for (let i = 0; i < items.length; i++) {
    const existingBodyCp = bodyCheckpoints.get(i);

    if (existingBodyCp !== undefined && existingBodyCp.status !== 'intent') {
      results[i] = itemResultFromTerminalCheckpoint(existingBodyCp, onItemError);
      if (results[i]?.status === 'failed' && onItemError === 'fail') {
        failure = { error: results[i]?.error ?? 'unknown error' };
        break;
      }
      continue;
    }

    const isReentry = existingBodyCp !== undefined; // status === 'intent'
    if (!isReentry && inFlight >= concurrency) {
      continue; // deferred: absent, not started this pass
    }

    const bodyArgs: Omit<NodeExecutorArgs, 'node'> = {
      run,
      attempt,
      iteration: i,
      aliases: { ...(args.aliases ?? {}), [itemAlias]: items[i], [indexAlias]: i },
      templateContext: args.templateContext,
      existingCheckpoint: existingBodyCp,
      store,
      clock,
      engine: args.engine,
      onApprovalPending: args.onApprovalPending,
    };

    const outcome = await invokeBody(node.body, bodyArgs);

    if (outcome.status === 'parked') {
      inFlight++;
      waitingOn.push(...outcome.waitingOn);
      continue;
    }
    if (outcome.status === 'completed') {
      results[i] = { status: 'completed', data: outcome.result };
      continue;
    }
    if (outcome.status === 'failed') {
      results[i] = onItemError === 'skip' ? { status: 'skipped', error: outcome.error } : { status: 'failed', error: outcome.error };
      if (onItemError === 'fail') {
        failure = { error: outcome.error };
        break;
      }
      continue;
    }
    // No allowed body type (llm/tool/set/session/orchestrator) ever
    // returns 'skipped' from its own executor — that status is reserved
    // for the interpreter's definition-level skip propagation, which
    // never touches foreach body checkpoints.
    throw new Error(
      `foreach "${node.id}": body node "${node.body.id}" returned status "skipped", which is not a valid body outcome`,
    );
  }

  if (failure !== undefined) {
    // Best-effort: abort every body submission left in-flight because of
    // this failure — both ones this pass just parked (`waitingOn`) and
    // ones that were already parked from an earlier pass and never got
    // revisited this pass because the fail-mode break happened at a lower
    // index (see module doc's "Any body iterations left parked" note,
    // updated by this fix). Must run BEFORE the placeholder-fill loop
    // below, which would otherwise erase the "never resolved this pass"
    // signal `results[i] === undefined` relies on. Deduped by
    // sessionId+threadId; a throw from any single abort must not mask the
    // failure this executor is about to return.
    const abortTargets = new Map<string, { sessionId: string; threadId: string }>();
    for (const wait of waitingOn) {
      if (wait.kind !== 'submission') continue;
      abortTargets.set(`${wait.sessionId}:${wait.threadId}`, { sessionId: wait.sessionId, threadId: wait.threadId });
    }
    for (let i = 0; i < items.length; i++) {
      if (results[i] !== undefined) continue; // resolved this pass, or already terminal from an earlier pass
      const cp = bodyCheckpoints.get(i);
      if (cp === undefined || cp.status !== 'intent') continue;
      const target = extractSubmissionTarget(cp);
      if (target === undefined) continue; // no receipt persisted yet (or a non-submission body type)
      abortTargets.set(`${target.sessionId}:${target.threadId}`, target);
    }
    for (const target of abortTargets.values()) {
      try {
        await args.engine.abort(target.sessionId, target.threadId);
      } catch {
        // Best-effort: the failure outcome below is authoritative regardless.
      }
    }

    for (let i = 0; i < results.length; i++) {
      if (results[i] === undefined) results[i] = { status: 'skipped' };
    }
    const aggregate = buildAggregate(results as ForeachItemResult[], effects);
    await store.completeCheckpoint(run.runId, node.id, iteration, attempt, {
      runId: run.runId,
      nodeId: node.id,
      iteration,
      status: 'failed',
      error: `foreach "${node.id}": ${failure.error}`,
      result: aggregate,
      effects: effectsToRecord(effects),
      attempt,
      createdAt: clock(),
    });
    return { status: 'failed', error: `foreach "${node.id}": ${failure.error}` };
  }

  if (waitingOn.length > 0) {
    return { status: 'parked', waitingOn };
  }

  // Every item resolved to a terminal outcome this pass (concurrency >= 1
  // guarantees an item is never left absent without something parked to
  // account for it — see the module doc).
  const aggregate = buildAggregate(results as ForeachItemResult[], effects);
  await store.completeCheckpoint(run.runId, node.id, iteration, attempt, {
    runId: run.runId,
    nodeId: node.id,
    iteration,
    status: 'completed',
    result: aggregate,
    effects: effectsToRecord(effects),
    attempt,
    createdAt: clock(),
  });
  return { status: 'completed', result: aggregate };
}

async function invokeBody(body: ForeachBodyNode, argsBase: Omit<NodeExecutorArgs, 'node'>): Promise<NodeExecuteResult> {
  switch (body.type) {
    case 'set':
      return executeSet({ ...argsBase, node: body });
    case 'llm':
      return executeLlm({ ...argsBase, node: body });
    case 'tool':
      return executeTool({ ...argsBase, node: body });
    case 'session':
      return executeSession({ ...argsBase, node: body });
    case 'orchestrator':
      return executeOrchestrator({ ...argsBase, node: body });
  }
}

async function loadBodyCheckpoints(
  store: NodeExecutorArgs['store'],
  runId: string,
  bodyId: string,
): Promise<Map<number, NodeCheckpoint>> {
  const all = await store.getCheckpoints(runId);
  const byIteration = new Map<number, NodeCheckpoint>();
  for (const cp of all) {
    if (cp.nodeId === bodyId) byIteration.set(cp.iteration, cp);
  }
  return byIteration;
}

/**
 * Reads a `session`/`orchestrator` body checkpoint's persisted submission
 * receipt (`submission-node.ts`'s `{ sessionId, receipt: { threadId,
 * queueItemId } }` effects shape) — the coordinates `engine.abort` needs.
 * Returns `undefined` for a body checkpoint that hasn't dispatched yet (no
 * receipt persisted this attempt) or belongs to a non-submission body type
 * (`set`/`llm`/`tool`), neither of which has anything to abort.
 */
function extractSubmissionTarget(cp: NodeCheckpoint): { sessionId: string; threadId: string } | undefined {
  const effects = cp.effects;
  if (!effects || typeof effects.sessionId !== 'string') return undefined;
  const receipt = effects.receipt;
  if (!receipt || typeof receipt !== 'object') return undefined;
  const threadId = (receipt as Record<string, unknown>).threadId;
  if (typeof threadId !== 'string') return undefined;
  return { sessionId: effects.sessionId, threadId };
}

function itemResultFromTerminalCheckpoint(cp: NodeCheckpoint, onItemError: 'fail' | 'skip' | 'collect'): ForeachItemResult {
  if (cp.status === 'completed') return { status: 'completed', data: cp.result };
  if (cp.status === 'failed') {
    return onItemError === 'skip' ? { status: 'skipped', error: cp.error } : { status: 'failed', error: cp.error };
  }
  throw new Error(`foreach body checkpoint "${cp.nodeId}" has unexpected terminal status "${cp.status}"`);
}

function buildAggregate(items: ForeachItemResult[], effects: ForeachEffects): ForeachResult {
  const completedCount = items.filter((r) => r.status === 'completed').length;
  const skippedCount = items.filter((r) => r.status === 'skipped').length;
  const failedCount = items.filter((r) => r.status === 'failed').length;
  return {
    items,
    count: items.length,
    inputCount: effects.inputCount,
    truncatedCount: effects.truncatedCount,
    completedCount,
    skippedCount,
    failedCount,
  };
}

function effectsToRecord(effects: ForeachEffects): Record<string, unknown> {
  return { itemCount: effects.itemCount, truncatedCount: effects.truncatedCount, inputCount: effects.inputCount };
}

function readEffects(cp: NodeCheckpoint | undefined): ForeachEffects | undefined {
  const raw = cp?.effects;
  if (!raw) return undefined;
  if (typeof raw.itemCount !== 'number' || typeof raw.truncatedCount !== 'number' || typeof raw.inputCount !== 'number') {
    return undefined;
  }
  return { itemCount: raw.itemCount, truncatedCount: raw.truncatedCount, inputCount: raw.inputCount };
}

function effectsEqual(a: ForeachEffects, b: ForeachEffects): boolean {
  return a.itemCount === b.itemCount && a.truncatedCount === b.truncatedCount && a.inputCount === b.inputCount;
}
