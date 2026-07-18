/**
 * The checkpointed interpreter core (Phase 5 plan decision 8) —
 * `driveUntilPark(runId, attempt, deps)`.
 *
 * The HOST owns claim/lease/heartbeat (Task 8's `LocalRunHost`); this
 * function receives the already-claimed `attempt` and drives the run's
 * wave loop until it reaches a terminal state (two-phase settle) or has
 * nothing left runnable (park). It never claims, heartbeats, or releases
 * — a caller handing it a stale attempt will see every store write it
 * attempts fail with `WorkflowFenceError` (propagated as a throw; the
 * host's next claim re-drives from checkpoints, so no correctness is
 * lost).
 *
 * Loop body, each pass reloading from the store (so signals/settlements
 * that land mid-drive are picked up without a stale in-memory copy):
 *   1. load run + definition snapshot + checkpoints + unconsumed signals
 *   2. a `cancel` signal present → abort in-flight submission waits,
 *      two-phase settle `cancelled`
 *   3. else propagate skips to a fixed point, then compute the runnable
 *      set (decision 9's edge/skip semantics)
 *   4. nothing runnable, everything terminal → two-phase settle
 *      (`completed`/`failed`, dominated by any node's `failed` status)
 *   5. nothing runnable, not everything terminal → `parkRun`, return
 *   6. else execute the runnable nodes (deterministic definition order);
 *      a `stop` node's `terminate` signal short-circuits to two-phase
 *      settle once the current wave finishes; parked nodes' wait
 *      conditions accumulate and `parkRun` once the wave has no more
 *      newly-runnable work; otherwise loop again
 */

import {
  evaluateExpression,
  parseExpression,
  TemplateEvalError,
  TemplateParseError,
  type TemplateContext,
} from './dag/expression.js';
import type { WorkflowNode } from './dag/nodes.js';
import type { WorkflowDefinition, WorkflowEdge } from './dag/shape.js';
import type { WorkflowEngineDeps } from './engine-deps.js';
import {
  createDefaultNodeExecutors,
  type NodeExecuteResult,
  type NodeExecutorArgs,
  type NodeExecutorRegistry,
  type OnApprovalGrant,
  type OnApprovalPending,
} from './nodes/index.js';
import type { NodeCheckpoint, RunParkState, RunWaitCondition, WorkflowRun, WorkflowStore } from './store.js';

export interface InterpreterDeps {
  store: WorkflowStore;
  engine: WorkflowEngineDeps;
  clock: () => number;
  executors?: NodeExecutorRegistry;
  onApprovalPending?: OnApprovalPending;
  onApprovalGrant?: OnApprovalGrant;
  /**
   * Host-only extension point (Phase 5 plan decision 20): invoked
   * synchronously right after `store.beginTerminalize` succeeds, before
   * terminal cleanup and `store.settleRun`. The interpreter itself never
   * sets this — it exists so `LocalRunHost`'s `crashAt: 'terminalizing'`
   * test hook can simulate a process crash at exactly this seam (reserving
   * the outcome, then dying before finalizing) without the interpreter
   * knowing anything about process lifecycle. Not invoked on the
   * `resumeTerminalize` path (a reclaimed `terminalizing` run's outcome was
   * already reserved by the crashed attempt — re-firing the hook here would
   * simulate a crash that never actually happens twice).
   */
  onBeginTerminalize?: () => void | Promise<void>;
}

/**
 * The interpreter always drives the definition's own nodes at iteration 0
 * — a `foreach` body's checkpoints are ALSO written at iteration 0 (item 0
 * lands there), keyed by the body's own node id, which never appears in
 * `definition.nodes`. `loadCheckpoints` filters to definition-node ids so
 * this wave loop, the failure-dominance scans, and `buildTemplateContext`
 * never see body rows; the `foreach` executor reads its own body
 * checkpoints directly via `store.getCheckpoints` and is unaffected by
 * this filter.
 */
const ITERATION = 0;

export async function driveUntilPark(runId: string, attempt: number, deps: InterpreterDeps): Promise<RunParkState> {
  const { store, engine, clock, onApprovalPending, onApprovalGrant, onBeginTerminalize } = deps;
  const executors = deps.executors ?? createDefaultNodeExecutors();

  while (true) {
    const run = await store.getRun(runId);
    if (!run) throw new Error(`workflow run not found: ${runId}`);

    // A reclaimed `terminalizing` run (crash between `beginTerminalize` and
    // `settleRun`) MUST resume settlement directly, never re-enter the wave
    // loop: the outcome is already reserved, and recomputing the runnable
    // set here would re-execute nodes the terminalization preempted (e.g. a
    // sibling branch that hadn't run yet when the `stop` node terminated
    // the run). The store contract (`store.ts` `claimRun` doc) guarantees
    // the status stays `terminalizing` across reclaim precisely so this
    // branch is reachable.
    if (run.status === 'terminalizing') {
      return await resumeTerminalize(store, run);
    }

    // The store snapshots exactly what was passed to `createRun` at run
    // start (Task 2's contract); narrowing the JSON-value column back to
    // the type the workflow layer itself wrote is not a "bridging a
    // third-party lib" case, but it's the one place the store's `unknown`
    // boundary meets a type this package owns end-to-end.
    const definition = run.definition as WorkflowDefinition;
    const cpAll = await loadCheckpoints(store, runId, definition);
    const signals = await store.listSignals(runId, { unconsumed: true });

    const cancelSignal = signals.find((s) => s.signalType === 'cancel');
    if (cancelSignal) {
      return await cancelRun(run, attempt, deps);
    }

    const graph = compile(definition);
    const templateContext = buildTemplateContext(definition, cpAll);

    const skippedAny = await propagateSkips(store, run, definition, graph, cpAll, attempt, clock);
    if (skippedAny) continue; // re-derive the runnable set with the new skips visible

    const runnable = computeRunnable(definition, graph, cpAll, templateContext);

    if (runnable.length === 0) {
      const allTerminal = definition.nodes.every((n) => isSettled(cpAll, n.id));
      if (allTerminal) {
        const anyFailed = [...cpAll.values()].some((cp) => cp.status === 'failed');
        return await twoPhaseSettle(store, run.runId, attempt, anyFailed ? 'failed' : 'completed', onBeginTerminalize);
      }
      return await parkAndReturn(store, run, attempt, run.waitingOn, run.wakeAt);
    }

    const waitingOn: RunWaitCondition[] = [];
    let terminate: 'completed' | 'failed' | undefined;
    // Failure dominance (mirrors main's runtime.ts): if any node in this
    // run — this wave or an earlier one — has a `failed` checkpoint, a
    // terminate settles `failed` regardless of the terminating stop node's
    // own outcome.
    let sawFailure = [...cpAll.values()].some((cp) => cp.status === 'failed');

    for (const node of runnable) {
      const existingCheckpoint = cpAll.get(node.id);
      const argsBase: Omit<NodeExecutorArgs, 'node'> = {
        run,
        attempt,
        iteration: ITERATION,
        templateContext,
        existingCheckpoint,
        store,
        clock,
        engine,
        onApprovalPending,
        onApprovalGrant,
      };
      const outcome = await invokeExecutor(node, executors, argsBase);

      if (outcome.status === 'failed') sawFailure = true;

      if (outcome.status === 'parked') {
        if (outcome.waitingOn.length === 0) {
          // A contract violation: `parked` must always carry at least one
          // wait condition, or the wave loop would spin forever with no
          // way to know what it's waiting on.
          throw new Error(
            `node "${node.id}" (type "${node.type}") returned status "parked" with an empty waitingOn — contract violation`,
          );
        }
        waitingOn.push(...outcome.waitingOn);
        continue;
      }
      if ((outcome.status === 'completed' || outcome.status === 'failed') && outcome.terminate) {
        terminate = outcome.terminate;
      }
    }

    if (terminate) {
      const finalOutcome = sawFailure ? 'failed' : terminate;
      return await terminateSettle(store, engine, run.runId, attempt, waitingOn, finalOutcome, onBeginTerminalize);
    }
    if (waitingOn.length > 0) {
      const wakeAt = earliestTimerWake(waitingOn);
      return await parkAndReturn(store, run, attempt, waitingOn, wakeAt);
    }

    // Otherwise loop again: this wave's completions may unblock more nodes.
    // Livelock guard: a well-behaved wave that ran ≥1 node either produces
    // a new terminal checkpoint (progress the next pass's runnable/skip
    // computation can build on) or reports a wait condition above. A
    // future executor that returns `completed` without writing its
    // checkpoint (or otherwise fails to move a node off `intent`/absent)
    // would otherwise spin this loop forever.
    const cpAfterWave = await loadCheckpoints(store, runId, definition);
    const madeProgress = runnable.some((node) => {
      const cp = cpAfterWave.get(node.id);
      return cp !== undefined && cp.status !== 'intent';
    });
    if (!madeProgress) {
      throw new Error(
        `workflow livelock: wave executed ${runnable.length} runnable node(s) (${runnable
          .map((n) => n.id)
          .join(', ')}) but produced no new terminal checkpoint and no waitingOn`,
      );
    }
  }
}

// ─── Cancel + settle ─────────────────────────────────────────────────────────

async function cancelRun(run: WorkflowRun, attempt: number, deps: InterpreterDeps): Promise<RunParkState> {
  const { store, engine, onBeginTerminalize } = deps;
  for (const wait of run.waitingOn) {
    if (wait.kind === 'submission') {
      await engine.abort(wait.sessionId, wait.threadId);
    }
  }
  return await twoPhaseSettle(store, run.runId, attempt, 'cancelled', onBeginTerminalize);
}

/**
 * Resume settlement for a run reclaimed while `terminalizing`: the outcome
 * was already reserved by the crashed attempt's `beginTerminalize` call, so
 * this only re-runs terminal cleanup (no-op this task) and finalizes via
 * `settleRun`, which is idempotent. Never touches checkpoints or recomputes
 * the runnable set.
 */
async function resumeTerminalize(store: WorkflowStore, run: WorkflowRun): Promise<RunParkState> {
  if (run.outcome === undefined) {
    throw new Error(`workflow run ${run.runId} is terminalizing with no reserved outcome`);
  }
  // Terminal cleanup hook: no-op this task. See `twoPhaseSettle`.
  await store.settleRun(run.runId, run.outcome);
  return await mustGetParkState(store, run.runId);
}

/**
 * Settle a run that terminated via a `stop` node's `terminate` signal.
 * Mirrors `cancelRun`: any submission wait accumulated by sibling
 * executors in the same wave (parked while the terminating node also ran)
 * must be aborted so the dispatched work doesn't keep running after the
 * workflow has settled.
 */
async function terminateSettle(
  store: WorkflowStore,
  engine: WorkflowEngineDeps,
  runId: string,
  attempt: number,
  waitingOn: RunWaitCondition[],
  outcome: 'completed' | 'failed',
  onBeginTerminalize: (() => void | Promise<void>) | undefined,
): Promise<RunParkState> {
  for (const wait of waitingOn) {
    if (wait.kind === 'submission') {
      await engine.abort(wait.sessionId, wait.threadId);
    }
  }
  return await twoPhaseSettle(store, runId, attempt, outcome, onBeginTerminalize);
}

async function twoPhaseSettle(
  store: WorkflowStore,
  runId: string,
  attempt: number,
  outcome: 'completed' | 'failed' | 'cancelled',
  onBeginTerminalize: (() => void | Promise<void>) | undefined,
): Promise<RunParkState> {
  await store.beginTerminalize(runId, attempt, outcome);
  // Decision 20's crash-point hook: `LocalRunHost` wires this to simulate a
  // process crash right after the outcome is reserved but before terminal
  // cleanup/finalization run. A throw here (the test-injected `exit`) must
  // propagate out of `driveUntilPark` uncaught by this function — the run
  // is left `terminalizing`, exactly like a real crash.
  await onBeginTerminalize?.();
  // Terminal cleanup hook: no-op this task. Later tasks (spawned-session
  // teardown, trace finalization) run here, between reserving the
  // outcome and finalizing it.
  await store.settleRun(runId, outcome);
  return await mustGetParkState(store, runId);
}

async function parkAndReturn(
  store: WorkflowStore,
  run: WorkflowRun,
  attempt: number,
  waitingOn: RunWaitCondition[],
  wakeAt: number | undefined,
): Promise<RunParkState> {
  await store.parkRun(run.runId, attempt, waitingOn, wakeAt);
  return await mustGetParkState(store, run.runId);
}

async function mustGetParkState(store: WorkflowStore, runId: string): Promise<RunParkState> {
  const run = await store.getRun(runId);
  if (!run) throw new Error(`workflow run vanished mid-drive: ${runId}`);
  return {
    runId: run.runId,
    status: run.status,
    outcome: run.outcome,
    waitingOn: run.waitingOn,
    ownerId: run.ownerId,
    leaseExpiresAt: run.leaseExpiresAt,
    updatedAt: run.updatedAt,
  };
}

function earliestTimerWake(waitingOn: RunWaitCondition[]): number | undefined {
  let min: number | undefined;
  for (const wait of waitingOn) {
    if (wait.kind !== 'timer') continue;
    min = min === undefined ? wait.wakeAt : Math.min(min, wait.wakeAt);
  }
  return min;
}

// ─── Executor dispatch ───────────────────────────────────────────────────────

/**
 * Switches on `node.type` so each branch narrows `node` via the
 * discriminated union and looks up the matching registry slot with a
 * matching-generic executor — no `as` cast bridges `WorkflowNode` back to
 * a specific node interface.
 */
async function invokeExecutor(
  node: WorkflowNode,
  executors: NodeExecutorRegistry,
  argsBase: Omit<NodeExecutorArgs, 'node'>,
): Promise<NodeExecuteResult> {
  switch (node.type) {
    case 'trigger':
      return requireExecutor(executors.trigger, node).execute({ ...argsBase, node });
    case 'set':
      return requireExecutor(executors.set, node).execute({ ...argsBase, node });
    case 'if':
      return requireExecutor(executors.if, node).execute({ ...argsBase, node });
    case 'wait':
      return requireExecutor(executors.wait, node).execute({ ...argsBase, node });
    case 'approval':
      return requireExecutor(executors.approval, node).execute({ ...argsBase, node });
    case 'session':
      return requireExecutor(executors.session, node).execute({ ...argsBase, node });
    case 'stop':
      return requireExecutor(executors.stop, node).execute({ ...argsBase, node });
    case 'foreach':
      return requireExecutor(executors.foreach, node).execute({ ...argsBase, node });
    case 'llm':
      return requireExecutor(executors.llm, node).execute({ ...argsBase, node });
    case 'orchestrator':
      return requireExecutor(executors.orchestrator, node).execute({ ...argsBase, node });
    case 'tool':
      return requireExecutor(executors.tool, node).execute({ ...argsBase, node });
  }
}

function requireExecutor<T>(executor: T | undefined, node: WorkflowNode): T {
  if (!executor) {
    throw new Error(`no executor registered for node type "${node.type}" (node "${node.id}")`);
  }
  return executor;
}

// ─── Checkpoint indexing ─────────────────────────────────────────────────────

/**
 * Loads the run's iteration-0 checkpoints, scoped to node ids that appear
 * in `definition.nodes`. A `foreach` body's checkpoints also land at
 * iteration 0 (item 0), keyed by the body's own node id — filtering to
 * definition-node ids here keeps that body state out of every downstream
 * consumer (failure-dominance scans, `buildTemplateContext`, the runnable
 * computation) in one place, rather than requiring each consumer to
 * re-derive the same filter.
 */
async function loadCheckpoints(
  store: WorkflowStore,
  runId: string,
  definition: WorkflowDefinition,
): Promise<Map<string, NodeCheckpoint>> {
  const definitionNodeIds = new Set(definition.nodes.map((n) => n.id));
  const checkpoints = await store.getCheckpoints(runId);
  const byNode = new Map<string, NodeCheckpoint>();
  for (const cp of checkpoints) {
    if (cp.iteration !== ITERATION) continue;
    if (!definitionNodeIds.has(cp.nodeId)) continue;
    byNode.set(cp.nodeId, cp);
  }
  return byNode;
}

/** Has a terminal (completed/failed/skipped) checkpoint — excluded from both skip-propagation and runnable candidacy. */
function isSettled(cpAll: Map<string, NodeCheckpoint>, nodeId: string): boolean {
  const cp = cpAll.get(nodeId);
  return cp !== undefined && cp.status !== 'intent';
}

// ─── Graph compilation + edge semantics (decision 9) ────────────────────────

interface CompiledGraph {
  incomingByNode: Map<string, WorkflowEdge[]>;
}

function compile(definition: WorkflowDefinition): CompiledGraph {
  const incomingByNode = new Map<string, WorkflowEdge[]>();
  for (const node of definition.nodes) incomingByNode.set(node.id, []);
  for (const edge of definition.edges) {
    incomingByNode.get(edge.to)?.push(edge);
  }
  return { incomingByNode };
}

/** An edge is resolved when its source has a terminal checkpoint (completed/failed/skipped). */
function edgeResolved(edge: WorkflowEdge, cpAll: Map<string, NodeCheckpoint>): boolean {
  return isSettled(cpAll, edge.from);
}

/**
 * An edge is active when its source `completed` AND (no `fromOutput` or it
 * matches the source's boolean output) AND (no `when` or it evaluates
 * truthy). A `failed`/`skipped` source never activates an outgoing edge.
 */
function edgeActive(edge: WorkflowEdge, cpAll: Map<string, NodeCheckpoint>, templateContext: TemplateContext): boolean {
  const source = cpAll.get(edge.from);
  if (!source || source.status !== 'completed') return false;

  if (edge.fromOutput !== undefined) {
    const actual = booleanOutputOf(source.result);
    if (actual === undefined) return false;
    return actual === (edge.fromOutput === 'true');
  }

  if (edge.when !== undefined) {
    try {
      const ast = parseExpression(edge.when);
      return truthy(evaluateExpression(ast, templateContext));
    } catch (err) {
      if (err instanceof TemplateParseError || err instanceof TemplateEvalError) return false;
      throw err;
    }
  }

  return true;
}

/** `if` nodes carry `{ result: boolean }`; `approval` nodes (Task 5) carry `{ approved: boolean }`. */
function booleanOutputOf(result: unknown): boolean | undefined {
  if (result && typeof result === 'object') {
    const r = result as Record<string, unknown>;
    if (typeof r.result === 'boolean') return r.result;
    if (typeof r.approved === 'boolean') return r.approved;
  }
  return undefined;
}

function truthy(v: unknown): boolean {
  if (v === null || v === undefined || v === false || v === 0 || v === '') return false;
  return true;
}

/**
 * Skip nodes whose incoming edges are all resolved but none active.
 * Returns whether anything was skipped (the caller re-derives the
 * runnable set, since a skip can unblock further skip propagation or
 * runnable nodes downstream).
 */
async function propagateSkips(
  store: WorkflowStore,
  run: WorkflowRun,
  definition: WorkflowDefinition,
  graph: CompiledGraph,
  cpAll: Map<string, NodeCheckpoint>,
  attempt: number,
  clock: () => number,
): Promise<boolean> {
  let skippedAny = false;
  // Skipped nodes never add a `completed` entry, so the template context
  // is stable across this pass and can be computed once up front.
  const templateContext = buildTemplateContext(definition, cpAll);
  for (const node of definition.nodes) {
    if (cpAll.has(node.id)) continue; // started (intent or terminal) — never a skip candidate
    const incoming = graph.incomingByNode.get(node.id) ?? [];
    if (incoming.length === 0) continue; // runnable, not skippable
    if (!incoming.every((e) => edgeResolved(e, cpAll))) continue;
    if (incoming.some((e) => edgeActive(e, cpAll, templateContext))) continue;

    await store.putIntent({
      runId: run.runId,
      nodeId: node.id,
      iteration: ITERATION,
      status: 'intent',
      attempt,
      createdAt: clock(),
    });
    const skipped: NodeCheckpoint = {
      runId: run.runId,
      nodeId: node.id,
      iteration: ITERATION,
      status: 'skipped',
      attempt,
      createdAt: clock(),
    };
    await store.completeCheckpoint(run.runId, node.id, ITERATION, attempt, skipped);
    cpAll.set(node.id, skipped);
    skippedAny = true;
  }
  return skippedAny;
}

function computeRunnable(
  definition: WorkflowDefinition,
  graph: CompiledGraph,
  cpAll: Map<string, NodeCheckpoint>,
  templateContext: TemplateContext,
): WorkflowNode[] {
  const runnable: WorkflowNode[] = [];
  for (const node of definition.nodes) {
    if (isSettled(cpAll, node.id)) continue; // terminal — done, not runnable
    const incoming = graph.incomingByNode.get(node.id) ?? [];
    if (incoming.length === 0) {
      runnable.push(node);
      continue;
    }
    if (!incoming.every((e) => edgeResolved(e, cpAll))) continue;
    if (incoming.some((e) => edgeActive(e, cpAll, templateContext))) runnable.push(node);
  }
  return runnable;
}

// ─── Template context (decision 4: `{ trigger, nodes }`, `nodes.<id>.output`) ─

function buildTemplateContext(definition: WorkflowDefinition, cpAll: Map<string, NodeCheckpoint>): TemplateContext {
  const nodes: Record<string, { output: unknown }> = {};
  for (const [nodeId, cp] of cpAll) {
    if (cp.status !== 'completed') continue; // skipped/failed/intent nodes contribute no output
    nodes[nodeId] = { output: cp.result };
  }
  const triggerNode = definition.nodes.find((n) => n.type === 'trigger');
  const trigger = triggerNode ? nodes[triggerNode.id]?.output : undefined;
  return { trigger, nodes };
}
