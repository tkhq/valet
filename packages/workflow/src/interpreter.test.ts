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
    llmComplete: vi.fn(async () => {
      throw new Error('llmComplete not exercised by this fixture');
    }),
    promptOrchestrator: vi.fn(async () => {
      throw new Error('promptOrchestrator not exercised by this fixture');
    }),
    invokeAction: vi.fn(async () => {
      throw new Error('invokeAction not exercised by this fixture');
    }),
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

// ─── 2a. Tool-node fromOutput edges (policy gate pass / deny) ────────────────

describe('driveUntilPark: tool-node fromOutput edges', () => {
  function toolBranchDefinition(): WorkflowDefinition {
    return {
      version: 'dag/v1',
      nodes: [
        { id: 't', type: 'trigger' },
        { id: 'tool1', type: 'tool', service: 'svc', action: 'act', params: {} },
        { id: 'a', type: 'set', values: { branch: 'approved' } },
        { id: 'b', type: 'set', values: { branch: 'denied' } },
      ],
      edges: [
        { from: 't', to: 'tool1' },
        { from: 'tool1', to: 'a', fromOutput: 'true' },
        { from: 'tool1', to: 'b', fromOutput: 'false' },
      ],
    };
  }

  it('activates the true branch when tool completes with an ordinary result', async () => {
    const store = new InMemoryWorkflowStore();
    const clock = makeClock();
    const engine = makeFakeEngineDeps();
    (engine.invokeAction as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, result: { id: 1 } });
    const params = runParams();
    await store.createRun('run-tool-true', params, toolBranchDefinition(), 'v1');
    const attempt = await claimAttempt(store, 'run-tool-true');

    const park = await driveUntilPark('run-tool-true', attempt, { store, engine, clock: clock.now });

    expect(park.status).toBe('settled');
    expect(park.outcome).toBe('completed');

    const byNode = new Map((await store.getCheckpoints('run-tool-true')).map((cp) => [cp.nodeId, cp]));
    expect(byNode.get('tool1')?.status).toBe('completed');
    expect(byNode.get('a')?.status).toBe('completed');
    expect(byNode.get('b')?.status).toBe('skipped');
  });

  it('activates the false branch when tool is deny-skipped (policyDenied: true)', async () => {
    const store = new InMemoryWorkflowStore();
    const clock = makeClock();
    const engine = makeFakeEngineDeps();
    const params = runParams();
    await store.createRun('run-tool-deny', params, toolBranchDefinition(), 'v1');
    const attempt = await claimAttempt(store, 'run-tool-deny');

    // Seed a completed tool checkpoint with the deny-skip marker directly.
    await store.putIntent({
      runId: 'run-tool-deny',
      nodeId: 'tool1',
      iteration: 0,
      status: 'intent',
      attempt,
      createdAt: clock.now(),
    });
    await store.completeCheckpoint('run-tool-deny', 'tool1', 0, attempt, {
      runId: 'run-tool-deny',
      nodeId: 'tool1',
      iteration: 0,
      status: 'completed',
      result: { approved: false, policyDenied: true, resolvedBy: 'admin' },
      attempt,
      createdAt: clock.now(),
    });

    const park = await driveUntilPark('run-tool-deny', attempt, { store, engine, clock: clock.now });

    expect(park.status).toBe('settled');
    expect(park.outcome).toBe('completed');

    const byNode = new Map((await store.getCheckpoints('run-tool-deny')).map((cp) => [cp.nodeId, cp]));
    expect(byNode.get('tool1')?.status).toBe('completed');
    expect(byNode.get('a')?.status).toBe('skipped');
    expect(byNode.get('b')?.status).toBe('completed');
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

// ─── 9. Terminalizing-reclaim guard ──────────────────────────────────────────

describe('driveUntilPark: terminalizing-reclaim guard', () => {
  it('resumes settlement with the reserved outcome and never re-enters the wave loop', async () => {
    const clock = makeClock();
    // Lease-expiry reclaim below requires the store's own clock to track
    // the same fake clock the test advances (the store defaults to real
    // `Date.now()`, which `clock.advance` doesn't affect).
    const store = new InMemoryWorkflowStore(clock.now);
    const engine = makeFakeEngineDeps();

    let sideCalls = 0;
    const countingSideExecutor: NodeExecutor<WaitNode> = {
      async execute(): Promise<NodeExecuteResult> {
        sideCalls += 1;
        return { status: 'completed', result: {} };
      },
    };
    const executors: NodeExecutorRegistry = { ...createDefaultNodeExecutors(), wait: countingSideExecutor };

    const definition: WorkflowDefinition = {
      version: 'dag/v1',
      nodes: [
        { id: 't', type: 'trigger' },
        { id: 'stop', type: 'stop', outcome: 'success' },
        { id: 'side', type: 'wait', mode: 'duration', duration: '1h' } satisfies WaitNode,
      ],
      edges: [
        { from: 't', to: 'stop' },
        { from: 't', to: 'side' },
      ],
    };
    await store.createRun('run-9', runParams(), definition, 'v1');
    const firstAttempt = await claimAttempt(store, 'run-9', 'owner-a');

    // Model a crash between `beginTerminalize` (outcome reserved) and
    // `settleRun` (never reached) directly through the store — the durable
    // truth a real crash-mid-drive would leave behind, per the task brief.
    await store.beginTerminalize('run-9', firstAttempt, 'completed');

    // Lease expires; a new owner reclaims. Per the store contract, a
    // reclaimed `terminalizing` run stays `terminalizing`.
    clock.advance(60_000);
    const secondAttempt = await claimAttempt(store, 'run-9', 'owner-b');
    const runAfterReclaim = await store.getRun('run-9');
    expect(runAfterReclaim?.status).toBe('terminalizing');

    const park = await driveUntilPark('run-9', secondAttempt, { store, engine, clock: clock.now, executors });

    expect(park.status).toBe('settled');
    expect(park.outcome).toBe('completed');
    // The runnable set was never recomputed for this reclaimed run: the
    // side branch's executor must not have been invoked.
    expect(sideCalls).toBe(0);
  });
});

// ─── 10. Failure dominance on terminate ──────────────────────────────────────

describe('driveUntilPark: failure dominance on terminate', () => {
  it('settles failed when an earlier-wave node failed, even though the stop node completed', async () => {
    const store = new InMemoryWorkflowStore();
    const clock = makeClock();
    const engine = makeFakeEngineDeps();

    const failingExecutor: NodeExecutor<WaitNode> = {
      async execute(args): Promise<NodeExecuteResult> {
        const error = 'boom';
        await args.store.putIntent({
          runId: args.run.runId,
          nodeId: args.node.id,
          iteration: args.iteration,
          status: 'intent',
          attempt: args.attempt,
          createdAt: args.clock(),
        });
        await args.store.completeCheckpoint(args.run.runId, args.node.id, args.iteration, args.attempt, {
          runId: args.run.runId,
          nodeId: args.node.id,
          iteration: args.iteration,
          status: 'failed',
          error,
          attempt: args.attempt,
          createdAt: args.clock(),
        });
        return { status: 'failed', error }; // no `terminate` — this node alone doesn't end the run
      },
    };
    const executors: NodeExecutorRegistry = { ...createDefaultNodeExecutors(), wait: failingExecutor };

    const definition: WorkflowDefinition = {
      version: 'dag/v1',
      nodes: [
        { id: 't', type: 'trigger' },
        { id: 'fail', type: 'wait', mode: 'duration', duration: '1h' } satisfies WaitNode,
        { id: 's', type: 'set', values: { ok: true } },
        { id: 'stop', type: 'stop', outcome: 'success' },
      ],
      edges: [
        { from: 't', to: 'fail' },
        { from: 't', to: 's' },
        { from: 's', to: 'stop' }, // `stop` only becomes runnable in a later wave than `fail`
      ],
    };
    await store.createRun('run-10', runParams(), definition, 'v1');
    const attempt = await claimAttempt(store, 'run-10');

    const park = await driveUntilPark('run-10', attempt, { store, engine, clock: clock.now, executors });

    expect(park.status).toBe('settled');
    expect(park.outcome).toBe('failed'); // dominated by `fail`'s failure, not `stop`'s own success outcome

    const byNode = new Map((await store.getCheckpoints('run-10')).map((cp) => [cp.nodeId, cp]));
    expect(byNode.get('fail')?.status).toBe('failed');
    expect(byNode.get('stop')?.status).toBe('completed'); // the node's own checkpoint is unaffected
  });
});

// ─── 11. Livelock guard ──────────────────────────────────────────────────────

describe('driveUntilPark: livelock guard', () => {
  it('throws a descriptive error when a wave makes no progress, without settling or parking the run', async () => {
    const store = new InMemoryWorkflowStore();
    const clock = makeClock();
    const engine = makeFakeEngineDeps();

    const misbehavingExecutor: NodeExecutor<WaitNode> = {
      async execute(): Promise<NodeExecuteResult> {
        // Contract violation: reports `completed` without writing any
        // checkpoint (no `putIntent`/`completeCheckpoint`).
        return { status: 'completed', result: {} };
      },
    };
    const executors: NodeExecutorRegistry = { ...createDefaultNodeExecutors(), wait: misbehavingExecutor };

    const definition: WorkflowDefinition = {
      version: 'dag/v1',
      nodes: [
        { id: 't', type: 'trigger' },
        { id: 'bad', type: 'wait', mode: 'duration', duration: '1h' } satisfies WaitNode,
      ],
      edges: [{ from: 't', to: 'bad' }],
    };
    await store.createRun('run-11', runParams(), definition, 'v1');
    const attempt = await claimAttempt(store, 'run-11');

    await expect(driveUntilPark('run-11', attempt, { store, engine, clock: clock.now, executors })).rejects.toThrow(
      /livelock/i,
    );

    const run = await store.getRun('run-11');
    expect(run?.status).toBe('running'); // never settled or parked
  });

  it('throws a descriptive error when an executor parks with an empty waitingOn', async () => {
    const store = new InMemoryWorkflowStore();
    const clock = makeClock();
    const engine = makeFakeEngineDeps();

    const emptyParkExecutor: NodeExecutor<WaitNode> = {
      async execute(): Promise<NodeExecuteResult> {
        return { status: 'parked', waitingOn: [] };
      },
    };
    const executors: NodeExecutorRegistry = { ...createDefaultNodeExecutors(), wait: emptyParkExecutor };

    const definition: WorkflowDefinition = {
      version: 'dag/v1',
      nodes: [
        { id: 't', type: 'trigger' },
        { id: 'w', type: 'wait', mode: 'duration', duration: '1h' } satisfies WaitNode,
      ],
      edges: [{ from: 't', to: 'w' }],
    };
    await store.createRun('run-12', runParams(), definition, 'v1');
    const attempt = await claimAttempt(store, 'run-12');

    await expect(driveUntilPark('run-12', attempt, { store, engine, clock: clock.now, executors })).rejects.toThrow(
      /parked.*empty waitingOn|contract violation/i,
    );
  });
});

// ─── 12. Terminate path aborts in-flight submissions ─────────────────────────

describe('driveUntilPark: terminate does not leak in-flight submissions', () => {
  it('aborts a sibling submission wait parked in the same wave as a terminating stop', async () => {
    const store = new InMemoryWorkflowStore();
    const clock = makeClock();
    const engine = makeFakeEngineDeps();

    const parkingSessionExecutor: NodeExecutor<WaitNode> = {
      async execute(args): Promise<NodeExecuteResult> {
        await args.store.putIntent({
          runId: args.run.runId,
          nodeId: args.node.id,
          iteration: args.iteration,
          status: 'intent',
          attempt: args.attempt,
          createdAt: args.clock(),
        });
        return {
          status: 'parked',
          waitingOn: [
            {
              kind: 'submission',
              nodeId: args.node.id,
              sessionId: 'session-leaked',
              threadId: 'thread-leaked',
              queueItemId: 'queue-leaked',
            },
          ],
        };
      },
    };
    const executors: NodeExecutorRegistry = { ...createDefaultNodeExecutors(), wait: parkingSessionExecutor };

    const definition: WorkflowDefinition = {
      version: 'dag/v1',
      nodes: [
        { id: 't', type: 'trigger' },
        // Definition order matters: `side` parks (accumulating the
        // submission wait) before `stop` runs and sets `terminate` in the
        // same wave.
        { id: 'side', type: 'wait', mode: 'duration', duration: '1h' } satisfies WaitNode,
        { id: 'stop', type: 'stop', outcome: 'success' },
      ],
      edges: [
        { from: 't', to: 'side' },
        { from: 't', to: 'stop' },
      ],
    };
    await store.createRun('run-13', runParams(), definition, 'v1');
    const attempt = await claimAttempt(store, 'run-13');

    const park = await driveUntilPark('run-13', attempt, { store, engine, clock: clock.now, executors });

    expect(park.status).toBe('settled');
    expect(park.outcome).toBe('completed');
    expect(engine.abortCalls).toEqual([{ sessionId: 'session-leaked', threadId: 'thread-leaked' }]);
  });
});

// ─── 13. Diamond join + all-incoming-inactive skip propagation ──────────────

describe('driveUntilPark: diamond join and skip propagation', () => {
  it('runs a join node with one active and one skipped incoming edge, and skip-propagates a node fed only by the skipped branch', async () => {
    const store = new InMemoryWorkflowStore();
    const clock = makeClock();
    const engine = makeFakeEngineDeps();
    const definition: WorkflowDefinition = {
      version: 'dag/v1',
      nodes: [
        { id: 't', type: 'trigger' },
        { id: 'i', type: 'if', conditions: [{ left: 'trigger.data.flag', dataType: 'boolean', operation: 'isTrue' }] },
        { id: 'a', type: 'set', values: { branch: 'true-side' } },
        { id: 'b', type: 'set', values: { branch: 'false-side' } },
        // Join: one incoming from the taken branch, one from the skipped branch.
        { id: 'd', type: 'set', values: { joined: true } },
        { id: 'after-d', type: 'set', values: { after: 'd' } },
        // Fed only by the skipped branch — must itself skip, and propagate.
        { id: 'dead-end', type: 'set', values: { unreachable: true } },
        { id: 'after-dead-end', type: 'set', values: { after: 'dead-end' } },
      ],
      edges: [
        { from: 't', to: 'i' },
        { from: 'i', to: 'a', fromOutput: 'true' },
        { from: 'i', to: 'b', fromOutput: 'false' },
        { from: 'a', to: 'd' },
        { from: 'b', to: 'd' },
        { from: 'd', to: 'after-d' },
        { from: 'b', to: 'dead-end' },
        { from: 'dead-end', to: 'after-dead-end' },
      ],
    };
    const params = runParams({
      input: { type: 'manual', timestamp: '2026-01-01T00:00:00Z', data: { flag: true }, metadata: {} },
    });
    await store.createRun('run-14', params, definition, 'v1');
    const attempt = await claimAttempt(store, 'run-14');

    const park = await driveUntilPark('run-14', attempt, { store, engine, clock: clock.now });

    expect(park.status).toBe('settled');
    expect(park.outcome).toBe('completed');

    const byNode = new Map((await store.getCheckpoints('run-14')).map((cp) => [cp.nodeId, cp]));
    expect(byNode.get('a')?.status).toBe('completed');
    expect(byNode.get('b')?.status).toBe('skipped');
    // The join ran because at least one incoming edge (from `a`) was active.
    expect(byNode.get('d')?.status).toBe('completed');
    expect(byNode.get('after-d')?.status).toBe('completed');
    // Fed only by the skipped branch: all incoming inactive → skipped, and propagates.
    expect(byNode.get('dead-end')?.status).toBe('skipped');
    expect(byNode.get('after-dead-end')?.status).toBe('skipped');
  });
});
