/**
 * Settle reporting (batch-fanout design decision 4): every path that
 * settles a run must report exactly once through `onRunSettled`, and the
 * report must arrive after the store has committed the settle and after a
 * sub-workflow run's parent has been woken.
 *
 * The four settle paths are covered here: the natural all-terminal settle,
 * a `stop` node's terminate, a `cancel` signal, and the `terminalizing`
 * reclaim. Ordering is asserted from inside the handler, which reads the
 * store while the interpreter is suspended on it.
 */
import { describe, expect, it, vi } from 'vitest';

import type { WorkflowDefinition } from './dag/shape.js';
import type { WorkflowEngineDeps } from './engine-deps.js';
import { driveUntilPark, type InterpreterDeps, type RunSettledInfo } from './interpreter.js';
import { InMemoryWorkflowStore } from './memory-store.js';
import type { RunParams } from './store.js';

// ─── Test helpers ────────────────────────────────────────────────────────────

function makeClock(start = 1_000): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

function makeFakeEngineDeps(): WorkflowEngineDeps {
  return {
    createSession: vi.fn(async (opts) => ({ id: opts.id })),
    prompt: vi.fn(async () => ({ threadId: 'thread', queueItemId: 'queue' })),
    awaitResult: vi.fn(async () => ({ queueItemId: 'queue', outcome: 'completed' as const })),
    abort: vi.fn(async () => {}),
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

function stopDefinition(outcome: 'success' | 'failure'): WorkflowDefinition {
  return {
    version: 'dag/v1',
    nodes: [
      { id: 't', type: 'trigger' },
      { id: 'e', type: 'stop', outcome, ...(outcome === 'failure' ? { message: 'boom' } : {}) },
    ],
    edges: [{ from: 't', to: 'e' }],
  };
}

/** Collects every report, plus what the store looked like at report time. */
function makeReporter(store: InMemoryWorkflowStore): {
  onRunSettled: NonNullable<InterpreterDeps['onRunSettled']>;
  reports: RunSettledInfo[];
  statusAtReport: Array<string | undefined>;
} {
  const reports: RunSettledInfo[] = [];
  const statusAtReport: Array<string | undefined> = [];
  return {
    reports,
    statusAtReport,
    onRunSettled: async (info) => {
      reports.push(info);
      statusAtReport.push((await store.getRun(info.runId))?.status);
    },
  };
}

// ─── 1. The natural all-terminal settle ─────────────────────────────────────

describe('driveUntilPark: settle reporting', () => {
  it('reports a completed run once, after the store has committed the settle', async () => {
    const clock = makeClock();
    // The store shares the test clock so the reported `settledAt` is exact.
    const store = new InMemoryWorkflowStore(clock.now);
    const engine = makeFakeEngineDeps();
    const reporter = makeReporter(store);

    const definition: WorkflowDefinition = {
      version: 'dag/v1',
      nodes: [{ id: 't', type: 'trigger' }],
      edges: [],
    };
    await store.createRun('run-settle-1', runParams(), definition, 'v1', { ownerType: 'user', ownerId: 'u-1' });
    const attempt = await claimAttempt(store, 'run-settle-1');

    const deps: InterpreterDeps = { store, engine, clock: clock.now, onRunSettled: reporter.onRunSettled };
    const park = await driveUntilPark('run-settle-1', attempt, deps);

    expect(park.outcome).toBe('completed');
    expect(reporter.reports).toEqual([
      {
        runId: 'run-settle-1',
        workflowId: 'wf-1',
        outcome: 'completed',
        owner: { ownerType: 'user', ownerId: 'u-1' },
        parentRunId: undefined,
        parentNodeId: undefined,
        parentIteration: undefined,
        settledAt: clock.now(),
      },
    ]);
    // The report follows `settleRun`, never precedes it.
    expect(reporter.statusAtReport).toEqual(['settled']);
  });

  it('reports a failed run when a stop node terminates the run failed', async () => {
    const store = new InMemoryWorkflowStore();
    const clock = makeClock();
    const engine = makeFakeEngineDeps();
    const reporter = makeReporter(store);

    await store.createRun('run-settle-2', runParams(), stopDefinition('failure'), 'v1');
    const attempt = await claimAttempt(store, 'run-settle-2');

    const park = await driveUntilPark('run-settle-2', attempt, {
      store,
      engine,
      clock: clock.now,
      onRunSettled: reporter.onRunSettled,
    });

    expect(park.outcome).toBe('failed');
    expect(reporter.reports).toHaveLength(1);
    expect(reporter.reports[0].outcome).toBe('failed');
    expect(reporter.reports[0].runId).toBe('run-settle-2');
    // No owner was recorded at `createRun`, so none is reported.
    expect(reporter.reports[0].owner).toBeUndefined();
  });

  it('reports a cancelled run', async () => {
    const store = new InMemoryWorkflowStore();
    const clock = makeClock();
    const engine = makeFakeEngineDeps();
    const reporter = makeReporter(store);

    await store.createRun('run-settle-3', runParams(), stopDefinition('success'), 'v1');
    const firstAttempt = await claimAttempt(store, 'run-settle-3', 'owner-a');
    await store.parkRun('run-settle-3', firstAttempt, [{ kind: 'timer', nodeId: 'e', wakeAt: clock.now() + 999_999 }]);
    await store.insertSignal({
      runId: 'run-settle-3',
      signalId: 'cancel',
      signalType: 'cancel',
      createdAt: clock.now(),
    });

    const secondAttempt = await claimAttempt(store, 'run-settle-3', 'owner-b');
    const park = await driveUntilPark('run-settle-3', secondAttempt, {
      store,
      engine,
      clock: clock.now,
      onRunSettled: reporter.onRunSettled,
    });

    expect(park.outcome).toBe('cancelled');
    expect(reporter.reports).toHaveLength(1);
    expect(reporter.reports[0].outcome).toBe('cancelled');
  });

  it('reports on the terminalizing-reclaim path, where the outcome was reserved by a crashed attempt', async () => {
    const clock = makeClock();
    const store = new InMemoryWorkflowStore(clock.now);
    const engine = makeFakeEngineDeps();
    const reporter = makeReporter(store);

    await store.createRun('run-settle-4', runParams(), stopDefinition('success'), 'v1');
    const firstAttempt = await claimAttempt(store, 'run-settle-4', 'owner-a');
    // The durable trace a crash between `beginTerminalize` and `settleRun`
    // leaves behind.
    await store.beginTerminalize('run-settle-4', firstAttempt, 'completed');

    clock.advance(60_000);
    const secondAttempt = await claimAttempt(store, 'run-settle-4', 'owner-b');
    const park = await driveUntilPark('run-settle-4', secondAttempt, {
      store,
      engine,
      clock: clock.now,
      onRunSettled: reporter.onRunSettled,
    });

    expect(park.outcome).toBe('completed');
    expect(reporter.reports).toHaveLength(1);
    expect(reporter.reports[0].outcome).toBe('completed');
  });

  it('settles the run unchanged when no handler is wired', async () => {
    const store = new InMemoryWorkflowStore();
    const clock = makeClock();
    const engine = makeFakeEngineDeps();

    await store.createRun('run-settle-5', runParams(), stopDefinition('success'), 'v1');
    const attempt = await claimAttempt(store, 'run-settle-5');

    const park = await driveUntilPark('run-settle-5', attempt, { store, engine, clock: clock.now });

    expect(park.status).toBe('settled');
    expect(park.outcome).toBe('completed');
  });
});

// ─── 2. Sub-workflow runs: parent linkage and wake ordering ─────────────────

describe('driveUntilPark: settle reporting for a sub-workflow run', () => {
  it('carries the parent linkage and reports only after the parent has been woken', async () => {
    const clock = makeClock();
    const store = new InMemoryWorkflowStore(clock.now);
    const engine = makeFakeEngineDeps();

    await store.createRun('parent-run', runParams(), stopDefinition('success'), 'v1');
    // A parked parent is what a `workflow` node leaves behind. `parkRun`
    // clears the wake flag, which makes the settle-time wake observable.
    const parentAttempt = await claimAttempt(store, 'parent-run');
    await store.parkRun('parent-run', parentAttempt, [{ kind: 'run', nodeId: 'call', runId: 'child-run' }]);

    const reports: RunSettledInfo[] = [];
    let parentWakeAtReport: boolean | undefined;
    const onRunSettled: NonNullable<InterpreterDeps['onRunSettled']> = async (info) => {
      reports.push(info);
      parentWakeAtReport = (await store.getRun('parent-run'))?.wakeRequested;
    };

    await store.createRun(
      'child-run',
      runParams({
        workflowId: 'wf-child',
        parentRunId: 'parent-run',
        parentNodeId: 'call',
        parentIteration: 3,
      }),
      stopDefinition('success'),
      'v1',
      { ownerType: 'team', ownerId: 'team-7' },
    );
    const childAttempt = await claimAttempt(store, 'child-run', 'owner-child');

    await driveUntilPark('child-run', childAttempt, { store, engine, clock: clock.now, onRunSettled });

    expect(reports).toEqual([
      {
        runId: 'child-run',
        workflowId: 'wf-child',
        outcome: 'completed',
        owner: { ownerType: 'team', ownerId: 'team-7' },
        parentRunId: 'parent-run',
        parentNodeId: 'call',
        parentIteration: 3,
        settledAt: clock.now(),
      },
    ]);
    // The wake precedes the report, so a handler that hangs cannot strand
    // the parked parent.
    expect(parentWakeAtReport).toBe(true);
  });
});
