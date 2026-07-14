import { describe, expect, it } from 'vitest';

import { describeRunHostContract, makeRunHostFixtureEngine, type RunHostFixture, type RunHostFixtureOptions } from './conformance/run-host.js';
import { LocalRunHost } from './local-host.js';
import { InMemoryWorkflowStore } from './memory-store.js';
import type { RunParams } from './store.js';
import type { WorkflowDefinition } from './dag/shape.js';

// ─── Test helpers (crashAt test only — the shared suite covers everything else) ─

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

function simpleDefinition(): WorkflowDefinition {
  return {
    version: 'dag/v1',
    nodes: [
      { id: 't', type: 'trigger' },
      { id: 'e', type: 'stop' },
    ],
    edges: [{ from: 't', to: 'e' }],
  };
}

async function waitFor(predicate: () => Promise<boolean> | boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() >= deadline) throw new Error(`waitFor: condition not met within ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

// ─── Shared RunHost conformance suite ────────────────────────────────────────

describeRunHostContract(
  (opts: RunHostFixtureOptions = {}): RunHostFixture => {
    const clock = makeClock();
    const store = new InMemoryWorkflowStore(clock.now);
    const engine = makeRunHostFixtureEngine();
    const host = new LocalRunHost({
      store,
      engine,
      clock: clock.now,
      concurrency: opts.concurrency ?? 4,
      pollMs: opts.pollMs ?? 10,
      leaseMs: opts.leaseMs ?? 2_000,
      heartbeatMs: opts.heartbeatMs ?? 300,
      sweepMs: opts.sweepMs ?? 20,
      executors: opts.executors,
    });
    return { host, store, engine, clock };
  },
);

// ─── LocalRunHost-specific: crashAt 'terminalizing' (decision 20) ────────────

describe('LocalRunHost crashAt "terminalizing"', () => {
  it('invokes the injected exit hook right after beginTerminalize, leaving the run terminalizing; a fresh host then settles it', async () => {
    const clock = makeClock();
    const store = new InMemoryWorkflowStore(clock.now);
    const engine = makeRunHostFixtureEngine();
    const exitCalls: number[] = [];

    const crashingHost = new LocalRunHost({
      store,
      engine,
      clock: clock.now,
      pollMs: 10,
      sweepMs: 20,
      leaseMs: 2_000,
      heartbeatMs: 300,
      crashAt: 'terminalizing',
      exit: (code: number): never => {
        exitCalls.push(code);
        throw new Error(`simulated process exit ${code}`);
      },
    });

    crashingHost.startHost();
    try {
      await crashingHost.start('run-crash', runParams(), simpleDefinition());
      await waitFor(async () => (await store.getRun('run-crash'))?.status === 'terminalizing');
    } finally {
      await crashingHost.stopHost();
    }

    expect(exitCalls).toEqual([137]);
    const midCrashRun = await store.getRun('run-crash');
    expect(midCrashRun?.status).toBe('terminalizing');
    expect(midCrashRun?.outcome).toBe('completed');
    // No terminal checkpoint was overwritten and no second stop dispatch happened.
    expect((await store.getCheckpoints('run-crash')).filter((cp) => cp.nodeId === 'e')).toHaveLength(1);

    // The crashing host's heartbeat was cleared when its drive's error was
    // caught, so its lease no longer renews; advance the (fake) clock past
    // it so the fresh host's `listRunnable` sees it as reclaimable.
    clock.advance(2_001);

    // A fresh host (no crashAt) reclaims the expired lease and finalizes.
    const freshHost = new LocalRunHost({
      store,
      engine,
      clock: clock.now,
      pollMs: 10,
      sweepMs: 20,
      leaseMs: 2_000,
      heartbeatMs: 300,
    });
    freshHost.startHost();
    try {
      await waitFor(async () => (await store.getRun('run-crash'))?.status === 'settled');
      const run = await store.getRun('run-crash');
      expect(run?.outcome).toBe('completed');
    } finally {
      await freshHost.stopHost();
    }
  });
});
