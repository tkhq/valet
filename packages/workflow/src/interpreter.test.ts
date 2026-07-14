import { describe, expect, it, vi } from 'vitest';

import type { TriggerNode, WaitNode } from './dag/nodes.js';
import type { WorkflowDefinition } from './dag/shape.js';
import type { WorkflowEngineDeps } from './engine-deps.js';
import { driveUntilPark, type InterpreterDeps } from './interpreter.js';
import { InMemoryWorkflowStore } from './memory-store.js';
import { createDefaultNodeExecutors, executeTrigger, type NodeExecuteResult, type NodeExecutor, type NodeExecutorRegistry } from './nodes/index.js';
import type { RunParams } from './store.js';

// ─── Test helpers ────────────────────────────────────────────────────────────

function makeClock(start = 1_000): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

function makeFakeEngineDeps(): WorkflowEngineDeps & {
  abortCalls: Array<{ sessionId: string; threadId: string }>;
} {
  const abortCalls: Array<{ sessionId: string; threadId: string }> = [];
  return {
    abortCalls,
    createSession: vi.fn(async (opts) => ({ id: opts.id })),
    prompt: vi.fn(async () => ({ threadId: 'thread', queueItemId: 'queue' })),
    awaitResult: vi.fn(async () => ({ queueItemId: 'queue', outcome: 'completed' as const })),
    abort: vi.fn(async (sessionId: string, threadId: string) => {
      abortCalls.push({ sessionId, threadId });
    }),
    isSettled: vi.fn(async () => true),
  };
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

// ─── 1. Linear trigger → set → stop ─────────────────────────────────────────

describe('driveUntilPark: linear trigger → set → stop', () => {
  it('completes with expected checkpoints and template resolution', async () => {
    const store = new InMemoryWorkflowStore();
    const clock = makeClock();
    const engine = makeFakeEngineDeps();
    const definition: WorkflowDefinition = {
      version: 'dag/v1',
      nodes: [
        { id: 't', type: 'trigger' },
        { id: 's', type: 'set', values: { greeting: 'hello {{trigger.data.name}}' } },
        { id: 'e', type: 'stop', outcome: 'success', output: { echoed: '{{nodes.s.output.greeting}}' } },
      ],
      edges: [
        { from: 't', to: 's' },
        { from: 's', to: 'e' },
      ],
    };
    const params = runParams({
      input: { type: 'manual', timestamp: '2026-01-01T00:00:00Z', data: { name: 'world' }, metadata: {} },
    });
    await store.createRun('run-1', params, definition, 'v1');
    const attempt = await claimAttempt(store, 'run-1');

    const deps: InterpreterDeps = { store, engine, clock: clock.now };
    const park = await driveUntilPark('run-1', attempt, deps);

    expect(park.status).toBe('settled');
    expect(park.outcome).toBe('completed');

    const checkpoints = await store.getCheckpoints('run-1');
    const byNode = new Map(checkpoints.map((cp) => [cp.nodeId, cp]));
    expect(byNode.get('t')?.status).toBe('completed');
    expect(byNode.get('t')?.result).toEqual(params.input);
    expect(byNode.get('s')?.status).toBe('completed');
    expect(byNode.get('s')?.result).toEqual({ greeting: 'hello world' });
    expect(byNode.get('e')?.status).toBe('completed');
    expect(byNode.get('e')?.result).toMatchObject({ outcome: 'success', output: { echoed: 'hello world' } });
  });
});

// ─── 2. If-node branch activation + skip propagation ────────────────────────

describe('driveUntilPark: if-node branches and skip propagation', () => {
  function branchDefinition(): WorkflowDefinition {
    return {
      version: 'dag/v1',
      nodes: [
        { id: 't', type: 'trigger' },
        {
          id: 'i',
          type: 'if',
          conditions: [{ left: 'trigger.data.flag', dataType: 'boolean', operation: 'isTrue' }],
        },
        { id: 'a', type: 'set', values: { branch: 'true-side' } },
        { id: 'b', type: 'set', values: { branch: 'false-side' } },
        { id: 'after-b', type: 'set', values: { branch: 'downstream-of-b' } },
      ],
      edges: [
        { from: 't', to: 'i' },
        { from: 'i', to: 'a', fromOutput: 'true' },
        { from: 'i', to: 'b', fromOutput: 'false' },
        { from: 'b', to: 'after-b' },
      ],
    };
  }

  it('activates the true branch and skip-propagates the false branch and its descendants', async () => {
    const store = new InMemoryWorkflowStore();
    const clock = makeClock();
    const engine = makeFakeEngineDeps();
    const params = runParams({
      input: { type: 'manual', timestamp: '2026-01-01T00:00:00Z', data: { flag: true }, metadata: {} },
    });
    await store.createRun('run-2', params, branchDefinition(), 'v1');
    const attempt = await claimAttempt(store, 'run-2');

    const park = await driveUntilPark('run-2', attempt, { store, engine, clock: clock.now });

    expect(park.status).toBe('settled');
    expect(park.outcome).toBe('completed');

    const byNode = new Map((await store.getCheckpoints('run-2')).map((cp) => [cp.nodeId, cp]));
    expect(byNode.get('i')?.result).toMatchObject({ result: true });
    expect(byNode.get('a')?.status).toBe('completed');
    expect(byNode.get('b')?.status).toBe('skipped');
    expect(byNode.get('after-b')?.status).toBe('skipped');
  });

  it('activates the false branch when the condition is false', async () => {
    const store = new InMemoryWorkflowStore();
    const clock = makeClock();
    const engine = makeFakeEngineDeps();
    const params = runParams({
      input: { type: 'manual', timestamp: '2026-01-01T00:00:00Z', data: { flag: false }, metadata: {} },
    });
    await store.createRun('run-3', params, branchDefinition(), 'v1');
    const attempt = await claimAttempt(store, 'run-3');

    const park = await driveUntilPark('run-3', attempt, { store, engine, clock: clock.now });

    expect(park.status).toBe('settled');
    expect(park.outcome).toBe('completed');

    const byNode = new Map((await store.getCheckpoints('run-3')).map((cp) => [cp.nodeId, cp]));
    expect(byNode.get('a')?.status).toBe('skipped');
    expect(byNode.get('b')?.status).toBe('completed');
    expect(byNode.get('after-b')?.status).toBe('completed');
    expect(byNode.get('after-b')?.result).toEqual({ branch: 'downstream-of-b' });
  });
});

// ─── 3. `when` edge conditions ───────────────────────────────────────────────

describe('driveUntilPark: `when` edge conditions', () => {
  it('activates only the edge whose `when` expression is truthy', async () => {
    const store = new InMemoryWorkflowStore();
    const clock = makeClock();
    const engine = makeFakeEngineDeps();
    const definition: WorkflowDefinition = {
      version: 'dag/v1',
      nodes: [
        { id: 't', type: 'trigger' },
        { id: 'a', type: 'set', values: { n: 5 } },
        { id: 'big', type: 'set', values: { seen: 'big' } },
        { id: 'small', type: 'set', values: { seen: 'small' } },
      ],
      edges: [
        { from: 't', to: 'a' },
        { from: 'a', to: 'big', when: 'nodes.a.output.n > 3' },
        { from: 'a', to: 'small', when: 'nodes.a.output.n <= 3' },
      ],
    };
    await store.createRun('run-4', runParams(), definition, 'v1');
    const attempt = await claimAttempt(store, 'run-4');

    const park = await driveUntilPark('run-4', attempt, { store, engine, clock: clock.now });

    expect(park.status).toBe('settled');
    const byNode = new Map((await store.getCheckpoints('run-4')).map((cp) => [cp.nodeId, cp]));
    expect(byNode.get('big')?.status).toBe('completed');
    expect(byNode.get('small')?.status).toBe('skipped');
  });
});

// ─── 5. Failed node → run failed via terminalizing ──────────────────────────

describe('driveUntilPark: failed node terminalizes the run as failed', () => {
  it('a stop node with outcome "failure" settles the run failed', async () => {
    const store = new InMemoryWorkflowStore();
    const clock = makeClock();
    const engine = makeFakeEngineDeps();
    const definition: WorkflowDefinition = {
      version: 'dag/v1',
      nodes: [
        { id: 't', type: 'trigger' },
        { id: 'fail', type: 'stop', outcome: 'failure', message: 'boom' },
      ],
      edges: [{ from: 't', to: 'fail' }],
    };
    await store.createRun('run-5', runParams(), definition, 'v1');
    const attempt = await claimAttempt(store, 'run-5');

    const park = await driveUntilPark('run-5', attempt, { store, engine, clock: clock.now });

    expect(park.status).toBe('settled');
    expect(park.outcome).toBe('failed');
    const byNode = new Map((await store.getCheckpoints('run-5')).map((cp) => [cp.nodeId, cp]));
    expect(byNode.get('fail')?.status).toBe('failed');
    expect(byNode.get('fail')?.error).toBe('boom');
  });
});

// ─── 6. Cancel signal at wave boundary ──────────────────────────────────────

describe('driveUntilPark: cancel signal', () => {
  it('aborts in-flight submission waits and settles the run cancelled', async () => {
    const store = new InMemoryWorkflowStore();
    const clock = makeClock();
    const engine = makeFakeEngineDeps();
    const definition: WorkflowDefinition = {
      version: 'dag/v1',
      nodes: [{ id: 't', type: 'trigger' }],
      edges: [],
    };
    await store.createRun('run-6', runParams(), definition, 'v1');
    const firstAttempt = await claimAttempt(store, 'run-6', 'owner-a');

    // Fabricate a parked run with an in-flight submission wait, bypassing
    // the (unimplemented-this-task) session executor, per the task brief.
    await store.parkRun('run-6', firstAttempt, [
      { kind: 'submission', nodeId: 'sess-node', sessionId: 'session-1', threadId: 'thread-1', queueItemId: 'queue-1' },
    ]);
    await store.insertSignal({ runId: 'run-6', signalId: 'cancel', signalType: 'cancel', createdAt: clock.now() });

    const secondAttempt = await claimAttempt(store, 'run-6', 'owner-b');
    const park = await driveUntilPark('run-6', secondAttempt, { store, engine, clock: clock.now });

    expect(park.status).toBe('settled');
    expect(park.outcome).toBe('cancelled');
    expect(engine.abortCalls).toEqual([{ sessionId: 'session-1', threadId: 'thread-1' }]);
  });
});

// ─── 7 & 8. Spurious wake + resumption after claim-loss ─────────────────────

/**
 * A stand-in for the not-yet-implemented `wait` executor (Task 5): the
 * first invocation parks on a far-future timer; every invocation after
 * `resolveOnCall` completes the node. Lets these tests drive
 * `driveUntilPark` twice across a simulated claim-loss without depending
 * on session/approval machinery that lands in later tasks.
 */
function makeStubWaitExecutor(resolveOnCall: number): {
  executor: NodeExecutor<WaitNode>;
  callCount: () => number;
} {
  let calls = 0;
  const executor: NodeExecutor<WaitNode> = {
    async execute(args): Promise<NodeExecuteResult> {
      calls += 1;
      await args.store.putIntent({
        runId: args.run.runId,
        nodeId: args.node.id,
        iteration: args.iteration,
        status: 'intent',
        attempt: args.attempt,
        createdAt: args.clock(),
      });
      if (calls < resolveOnCall) {
        return { status: 'parked', waitingOn: [{ kind: 'timer', nodeId: args.node.id, wakeAt: args.clock() + 999_999 }] };
      }
      const result = { resumed: true };
      await args.store.completeCheckpoint(args.run.runId, args.node.id, args.iteration, args.attempt, {
        runId: args.run.runId,
        nodeId: args.node.id,
        iteration: args.iteration,
        status: 'completed',
        result,
        attempt: args.attempt,
        createdAt: args.clock(),
      });
      return { status: 'completed', result };
    },
  };
  return { executor, callCount: () => calls };
}

function waitDefinition(): WorkflowDefinition {
  return {
    version: 'dag/v1',
    nodes: [
      { id: 't', type: 'trigger' } satisfies TriggerNode,
      { id: 'w', type: 'wait', mode: 'duration', duration: '1h' } satisfies WaitNode,
      { id: 'e', type: 'stop', outcome: 'success', output: { got: '{{nodes.w.output.resumed}}' } },
    ],
    edges: [
      { from: 't', to: 'w' },
      { from: 'w', to: 'e' },
    ],
  };
}

describe('driveUntilPark: spurious wake', () => {
  it('re-parks without writing duplicate checkpoints', async () => {
    const store = new InMemoryWorkflowStore();
    const clock = makeClock();
    const engine = makeFakeEngineDeps();
    const stub = makeStubWaitExecutor(Number.POSITIVE_INFINITY); // never resolves
    const executors: NodeExecutorRegistry = { ...createDefaultNodeExecutors(), wait: stub.executor };

    await store.createRun('run-7', runParams(), waitDefinition(), 'v1');
    const attempt1 = await claimAttempt(store, 'run-7');
    const park1 = await driveUntilPark('run-7', attempt1, { store, engine, clock: clock.now, executors });
    expect(park1.status).toBe('parked');
    const checkpointsAfterFirst = await store.getCheckpoints('run-7');
    expect(checkpointsAfterFirst).toHaveLength(2); // t completed, w intent

    // Spurious wake: reclaim (host's wake path) and drive again with the
    // wait condition still unsatisfied.
    const attempt2 = await claimAttempt(store, 'run-7');
    const park2 = await driveUntilPark('run-7', attempt2, { store, engine, clock: clock.now, executors });
    expect(park2.status).toBe('parked');

    const checkpointsAfterSecond = await store.getCheckpoints('run-7');
    expect(checkpointsAfterSecond).toHaveLength(2); // still exactly one row per node
    expect(stub.callCount()).toBe(2);
  });
});

describe('driveUntilPark: resumption after claim-loss', () => {
  it('re-drives from checkpoints without re-executing already-completed nodes', async () => {
    const store = new InMemoryWorkflowStore();
    const clock = makeClock();
    const engine = makeFakeEngineDeps();
    const stub = makeStubWaitExecutor(2); // parks once, completes on the second call

    let triggerCalls = 0;
    const countingTrigger: NodeExecutor<TriggerNode> = {
      async execute(args) {
        triggerCalls += 1;
        return executeTrigger(args);
      },
    };
    const executors: NodeExecutorRegistry = {
      ...createDefaultNodeExecutors(),
      trigger: countingTrigger,
      wait: stub.executor,
    };

    await store.createRun('run-8', runParams(), waitDefinition(), 'v1');
    const attempt1 = await claimAttempt(store, 'run-8');
    const park1 = await driveUntilPark('run-8', attempt1, { store, engine, clock: clock.now, executors });
    expect(park1.status).toBe('parked');
    expect(triggerCalls).toBe(1);
    expect(stub.callCount()).toBe(1);

    // Simulate claim-loss: lease expires, a new owner reclaims (attempt
    // bumps) and re-drives.
    const attempt2 = await claimAttempt(store, 'run-8', 'owner-2');
    expect(attempt2).toBeGreaterThan(attempt1);
    const park2 = await driveUntilPark('run-8', attempt2, { store, engine, clock: clock.now, executors });

    expect(park2.status).toBe('settled');
    expect(park2.outcome).toBe('completed');
    expect(triggerCalls).toBe(1); // not re-executed — resumed from its terminal checkpoint
    expect(stub.callCount()).toBe(2);

    const byNode = new Map((await store.getCheckpoints('run-8')).map((cp) => [cp.nodeId, cp]));
    expect(byNode.get('e')?.result).toMatchObject({ outcome: 'success', output: { got: true } });
  });
});
