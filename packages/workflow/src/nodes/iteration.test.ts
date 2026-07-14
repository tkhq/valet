/**
 * `iteration`/`aliases` executor-contract tests for the node types that
 * don't already have a dedicated test file (`set`, `if`, `stop`, `trigger`).
 * These executors never park or mint ids, so their only iteration-related
 * contract is "thread `iteration` into checkpoint writes instead of a
 * hardcoded 0" (node-completion-plan decision 7) — and, for `set`/`if`,
 * that `aliases` reach template rendering/condition evaluation via
 * `resolveTemplateContext`.
 *
 * `driveUntilPark` always drives the definition's own nodes at iteration 0
 * (no `foreach` executor exists yet to invoke a body at iteration > 0 —
 * that lands in Task 6), so these call the executors directly with
 * constructed args, the way a future `foreach` executor will.
 */
import { describe, expect, it } from 'vitest';

import type { IfNode, SetNode, StopNode, TriggerNode } from '../dag/nodes.js';
import type { WorkflowDefinition } from '../dag/shape.js';
import { InMemoryWorkflowStore } from '../memory-store.js';
import type { RunParams } from '../store.js';
import { executeIf } from './if.js';
import { executeSet } from './set.js';
import { executeStop } from './stop.js';
import { executeTrigger } from './trigger.js';

function makeClock(start = 1_000): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

function runParams(overrides: Partial<RunParams> = {}): RunParams {
  return {
    workflowId: 'wf-1',
    definitionVersionId: 'v1',
    input: { type: 'manual', timestamp: '2026-01-01T00:00:00Z', data: {}, metadata: {} },
    ...overrides,
  };
}

async function claimAttempt(store: InMemoryWorkflowStore, runId: string, ownerId = 'owner'): Promise<number> {
  const claim = await store.claimRun(runId, ownerId, 30_000);
  if (!claim) throw new Error(`could not claim run ${runId}`);
  return claim.attempt;
}

const minimalDefinition: WorkflowDefinition = {
  version: 'dag/v1',
  nodes: [{ id: 't', type: 'trigger' }],
  edges: [],
};

describe('executeSet: iteration > 0 and aliases', () => {
  it('checkpoints at the given iteration and resolves aliases in rendered values', async () => {
    const store = new InMemoryWorkflowStore();
    const clock = makeClock();
    await store.createRun('run-1', runParams(), minimalDefinition, 'v1');
    const attempt = await claimAttempt(store, 'run-1');
    const run = await store.getRun('run-1');
    if (!run) throw new Error('run vanished');

    const node: SetNode = { id: 's', type: 'set', values: { seen: '{{item}} at {{index}}' } };
    const result = await executeSet({
      run,
      node,
      attempt,
      iteration: 3,
      aliases: { item: 'widget-9', index: 3 },
      templateContext: { trigger: undefined, nodes: {} },
      store,
      clock: clock.now,
      engine: unusedEngine(),
    });

    expect(result.status).toBe('completed');
    expect(result.status === 'completed' && result.result).toEqual({ seen: 'widget-9 at 3' });

    const checkpoints = await store.getCheckpoints('run-1');
    const cp = checkpoints.find((c) => c.nodeId === 's' && c.iteration === 3);
    expect(cp).toBeDefined();
    expect(cp?.status).toBe('completed');
    expect(checkpoints.some((c) => c.nodeId === 's' && c.iteration === 0)).toBe(false);
  });
});

describe('executeIf: iteration > 0 and aliases', () => {
  it('checkpoints at the given iteration and evaluates conditions against merged aliases', async () => {
    const store = new InMemoryWorkflowStore();
    const clock = makeClock();
    await store.createRun('run-2', runParams(), minimalDefinition, 'v1');
    const attempt = await claimAttempt(store, 'run-2');
    const run = await store.getRun('run-2');
    if (!run) throw new Error('run vanished');

    const node: IfNode = {
      id: 'i',
      type: 'if',
      conditions: [{ left: 'item', dataType: 'string', operation: 'equals', right: 'widget-9' }],
    };
    const result = await executeIf({
      run,
      node,
      attempt,
      iteration: 2,
      aliases: { item: 'widget-9' },
      templateContext: { trigger: undefined, nodes: {} },
      store,
      clock: clock.now,
      engine: unusedEngine(),
    });

    expect(result.status).toBe('completed');
    expect(result.status === 'completed' && result.result).toMatchObject({ result: true });

    const checkpoints = await store.getCheckpoints('run-2');
    const cp = checkpoints.find((c) => c.nodeId === 'i' && c.iteration === 2);
    expect(cp).toBeDefined();
    expect(checkpoints.some((c) => c.nodeId === 'i' && c.iteration === 0)).toBe(false);
  });
});

describe('executeStop: iteration > 0', () => {
  it('checkpoints at the given iteration', async () => {
    const store = new InMemoryWorkflowStore();
    const clock = makeClock();
    await store.createRun('run-3', runParams(), minimalDefinition, 'v1');
    const attempt = await claimAttempt(store, 'run-3');
    const run = await store.getRun('run-3');
    if (!run) throw new Error('run vanished');

    const node: StopNode = { id: 'e', type: 'stop', outcome: 'success' };
    const result = await executeStop({
      run,
      node,
      attempt,
      iteration: 1,
      templateContext: { trigger: undefined, nodes: {} },
      store,
      clock: clock.now,
      engine: unusedEngine(),
    });

    expect(result.status).toBe('completed');
    const checkpoints = await store.getCheckpoints('run-3');
    const cp = checkpoints.find((c) => c.nodeId === 'e' && c.iteration === 1);
    expect(cp).toBeDefined();
    expect(checkpoints.some((c) => c.nodeId === 'e' && c.iteration === 0)).toBe(false);
  });
});

describe('executeTrigger: iteration > 0', () => {
  it('checkpoints at the given iteration', async () => {
    const store = new InMemoryWorkflowStore();
    const clock = makeClock();
    await store.createRun('run-4', runParams(), minimalDefinition, 'v1');
    const attempt = await claimAttempt(store, 'run-4');
    const run = await store.getRun('run-4');
    if (!run) throw new Error('run vanished');

    const node: TriggerNode = { id: 't', type: 'trigger' };
    const result = await executeTrigger({
      run,
      node,
      attempt,
      iteration: 1,
      templateContext: { trigger: undefined, nodes: {} },
      store,
      clock: clock.now,
      engine: unusedEngine(),
    });

    expect(result.status).toBe('completed');
    const checkpoints = await store.getCheckpoints('run-4');
    const cp = checkpoints.find((c) => c.nodeId === 't' && c.iteration === 1);
    expect(cp).toBeDefined();
    expect(checkpoints.some((c) => c.nodeId === 't' && c.iteration === 0)).toBe(false);
  });
});

// These executors never call `engine` — a stub whose every method throws
// documents that at the type level without a full scriptable fake.
function unusedEngine() {
  const fail = async (): Promise<never> => {
    throw new Error('this executor must never call the engine');
  };
  return {
    createSession: fail,
    prompt: fail,
    awaitResult: fail,
    abort: fail,
    isSettled: fail,
    llmComplete: fail,
    promptOrchestrator: fail,
    invokeAction: fail,
  };
}
