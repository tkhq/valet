/**
 * `loop` node executor.
 *
 * Runs its body steps in order, once per iteration, until the `until`
 * condition holds or `maxIterations` is reached. Where foreach fans out
 * over a list that already exists, a loop iterates toward a state — the
 * canonical shape is a drafter step and a reviewer step cycling until
 * the reviewer approves.
 *
 * Template context inside the body and `until`:
 *   - `steps.<bodyId>`  — the current iteration's outputs so far
 *   - `prev.<bodyId>`   — the previous iteration's outputs (undefined on
 *                         the first pass)
 *   - `iteration`       — 0-based iteration number
 *
 * Each body step runs in its own `step.do` named
 * `node:<loopId>:i:<iteration>:<bodyId>` so steps are individually
 * cached and observable. Every body-step execution draws from the same
 * cumulative per-execution iteration budget as foreach.
 */

import type { LoopNode, LoopBodyNode } from '@valet/shared';
import { buildTemplateContext } from '../context.js';
import type { NodeExecutorArgs } from '../types.js';
// Lazy-bound at call time like foreach: runtime.ts → executor → dispatchNode.
import { dispatchNode, isStepDrivenNode } from '../runtime.js';
import { CancelledError, NO_RETRY, type CorrelationIds } from '../types.js';
import { evaluateIfConditions } from './if.js';

export interface LoopResult {
  /** Iterations fully or partially executed. */
  iterations: number;
  /** True when `until` fired before the cap (or when no `until` was set and the loop ran to count). */
  satisfied: boolean;
  /** The final iteration's body outputs, keyed by body node id. */
  steps: Record<string, unknown>;
  /** Set when onIterationError='break' cut the loop short; carries the failing step's error. */
  stoppedEarly?: string;
}

// Loop iterations share the foreach cumulative budget (see foreach.ts);
// the constant lives there conceptually but is re-declared to avoid
// exporting an internal. Kept equal by the shared-budget test.
const CUMULATIVE_ITERATION_CAP = 5000;

export async function executeLoop(args: NodeExecutorArgs<LoopNode>): Promise<LoopResult> {
  const node = args.node;
  const onIterationError = node.onIterationError ?? 'fail';

  const priorCount = args.state.foreachIterationCount ?? 0;
  if (priorCount >= CUMULATIVE_ITERATION_CAP) {
    throw new Error(
      `loop "${node.id}": prior foreach/loop nodes already consumed the per-execution cap of ${CUMULATIVE_ITERATION_CAP} iterations`,
    );
  }

  const bumpAndCheck = (): void => {
    const next = (args.state.foreachIterationCount ?? 0) + 1;
    args.state.foreachIterationCount = next;
    if (next > CUMULATIVE_ITERATION_CAP) {
      throw new Error(
        `loop "${node.id}": cumulative iteration ${next} exceeds the per-execution cap of ${CUMULATIVE_ITERATION_CAP}`,
      );
    }
  };

  // `steps`/`prev` context wrappers hold RAW step data (like the foreach
  // item alias), not { data } envelopes — `steps.review.approved`, not
  // `steps.review.data.approved`.
  let prevSteps: Record<string, unknown> | undefined;
  let satisfied = false;
  let iterations = 0;

  for (let iter = 0; iter < node.maxIterations; iter++) {
    const steps: Record<string, unknown> = {};
    iterations = iter + 1;

    for (const bodyNode of node.body) {
      bumpAndCheck();
      try {
        steps[bodyNode.id] = await runBodyStep(args, bodyNode, iter, steps, prevSteps);
      } catch (err) {
        // CancelledError is a workflow-control signal, not a step
        // failure — re-throw so the runtime writes 'skipped:cancelled'.
        if (err instanceof CancelledError) throw err;
        const message = err instanceof Error ? err.message : String(err);
        if (onIterationError === 'break') {
          return {
            iterations,
            satisfied: false,
            steps: prevSteps ?? {},
            stoppedEarly: `iteration ${iter} step "${bodyNode.id}" failed: ${message}`,
          };
        }
        throw new Error(`loop "${node.id}": iteration ${iter} step "${bodyNode.id}" failed: ${message}`);
      }
    }

    if (node.until) {
      const ctx = buildTemplateContext(args.state, {
        ...(args.aliases ?? {}),
        steps,
        prev: prevSteps,
        iteration: iter,
      });
      let untilResult: boolean;
      try {
        untilResult = evaluateIfConditions(node.until.conditions, node.until.combinator, ctx).result;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`loop "${node.id}": until condition failed to evaluate on iteration ${iter}: ${message}`);
      }
      prevSteps = steps;
      if (untilResult) {
        satisfied = true;
        break;
      }
    } else {
      prevSteps = steps;
    }
  }

  // No `until` means "repeat maxIterations times" — running to count IS
  // the contract, so the loop is satisfied. With an `until`, hitting the
  // cap without the condition firing reports satisfied=false and lets
  // the author branch on it downstream.
  if (!node.until) satisfied = true;

  return { iterations, satisfied, steps: prevSteps ?? {} };
}

/**
 * Run one body step inside its own step.do (mirroring foreach's
 * runIteration): step-driven types own their internal step primitives,
 * everything else is wrapped under NO_RETRY.
 */
async function runBodyStep(
  args: NodeExecutorArgs<LoopNode>,
  bodyNode: LoopBodyNode,
  iteration: number,
  steps: Record<string, unknown>,
  prevSteps: Record<string, unknown> | undefined,
): Promise<unknown> {
  const aliases = {
    ...(args.aliases ?? {}),
    steps,
    prev: prevSteps,
    iteration,
    // Reserved key consumed by executors that need the raw iteration
    // index (e.g. tool.ts builds per-iteration action_invocations ids
    // from it). Body ids are globally unique, so id+iteration is
    // collision-free.
    __iterationIndex: iteration,
  };

  const stepName = `node:${args.node.id}:i:${iteration}:${bodyNode.id}`;

  // Fresh correlations per step so one step's invocationId/approvalId
  // cannot leak into a sibling's trace row.
  const stepCorrelations: CorrelationIds = {};
  const recordWaiting: NodeExecutorArgs['recordWaiting'] = args.recordWaiting
    ? async (transition) => {
        await args.recordWaiting!({
          ...transition,
          iterationIndex: iteration,
          ...(stepCorrelations.invocationId ? { invocationId: stepCorrelations.invocationId } : {}),
          ...(stepCorrelations.approvalId ? { approvalId: stepCorrelations.approvalId } : {}),
        });
      }
    : undefined;

  const executorArgs = {
    node: bodyNode,
    state: args.state,
    params: args.params,
    env: args.env,
    step: args.step,
    aliases,
    correlations: stepCorrelations,
    ...(recordWaiting ? { recordWaiting } : {}),
  };

  if (isStepDrivenNode(bodyNode)) {
    return dispatchNode(bodyNode, executorArgs);
  }
  // NO_RETRY for non-step-driven bodies — same reasoning as runtime.ts
  // and foreach.ts: pure executors throw deterministically, and llm
  // shouldn't fire duplicated billed calls on transient errors.
  const json = await args.step.do(stepName, { retries: { ...NO_RETRY } }, async () => {
    const out = await dispatchNode(bodyNode, executorArgs);
    return JSON.stringify(out ?? null);
  });
  return JSON.parse(json) as unknown;
}
