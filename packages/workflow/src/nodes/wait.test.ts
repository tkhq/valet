import { describe, expect, it } from 'vitest';

import type { WaitNode } from '../dag/nodes.js';
import type { WorkflowDefinition } from '../dag/shape.js';
import type { WorkflowEngineDeps } from '../engine-deps.js';
import { driveUntilPark, type InterpreterDeps } from '../interpreter.js';
import { InMemoryWorkflowStore } from '../memory-store.js';
import type { RunParams } from '../store.js';

// ─── Test helpers ────────────────────────────────────────────────────────────

function makeClock(start = 1_000): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

function makeFakeEngineDeps(): WorkflowEngineDeps {
  return {
    createSession: async (opts) => ({ id: opts.id }),
    prompt: async () => ({ threadId: 'thread', queueItemId: 'queue' }),
    awaitResult: async () => ({ queueItemId: 'queue', outcome: 'completed' as const }),
    abort: async () => {},
    isSettled: async () => true,
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

function waitDefinition(duration = '10m'): WorkflowDefinition {
  return {
    version: 'dag/v1',
    nodes: [
      { id: 't', type: 'trigger' },
      { id: 'w', type: 'wait', mode: 'duration', duration } satisfies WaitNode,
      { id: 'e', type: 'stop', outcome: 'success', output: { wakeAt: '{{nodes.w.output.wakeAt}}' } },
    ],
    edges: [
      { from: 't', to: 'w' },
      { from: 'w', to: 'e' },
    ],
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('executeWait: parks with correct wakeAt', () => {
  it('parks with a timer wait condition at clock() + parseDurationMs(duration)', async () => {
    const store = new InMemoryWorkflowStore();
    const clock = makeClock(1_000);
    const engine = makeFakeEngineDeps();
    await store.createRun('run-1', runParams(), waitDefinition('10m'), 'v1');
    const attempt = await claimAttempt(store, 'run-1');

    const deps: InterpreterDeps = { store, engine, clock: clock.now };
    const park = await driveUntilPark('run-1', attempt, deps);

    expect(park.status).toBe('parked');
    expect(park.waitingOn).toEqual([{ kind: 'timer', nodeId: 'w', wakeAt: 1_000 + 10 * 60 * 1000 }]);

    const byNode = new Map((await store.getCheckpoints('run-1')).map((cp) => [cp.nodeId, cp]));
    const wCp = byNode.get('w');
    expect(wCp?.status).toBe('intent');
    expect(wCp?.effects).toEqual({ wakeAt: 1_000 + 10 * 60 * 1000 });
  });
});

describe('executeWait: effects.wakeAt read-back on resume', () => {
  it('honors the originally-computed wakeAt across a re-drive, never re-reading the clock for it', async () => {
    const store = new InMemoryWorkflowStore();
    const clock = makeClock(1_000);
    const engine = makeFakeEngineDeps();
    await store.createRun('run-2', runParams(), waitDefinition('10m'), 'v1');
    const attempt1 = await claimAttempt(store, 'run-2');

    const park1 = await driveUntilPark('run-2', attempt1, { store, engine, clock: clock.now });
    expect(park1.status).toBe('parked');
    const originalWakeAt = 1_000 + 10 * 60 * 1000;
    expect(park1.waitingOn).toEqual([{ kind: 'timer', nodeId: 'w', wakeAt: originalWakeAt }]);

    // Advance the clock by a different amount than the duration would
    // suggest, then re-drive (simulating a spurious wake or claim-loss
    // reclaim). If the executor re-read the clock instead of the stored
    // effects, it would compute a different wakeAt here.
    clock.advance(1);
    const attempt2 = await claimAttempt(store, 'run-2', 'owner-2');
    const park2 = await driveUntilPark('run-2', attempt2, { store, engine, clock: clock.now });

    expect(park2.status).toBe('parked');
    expect(park2.waitingOn).toEqual([{ kind: 'timer', nodeId: 'w', wakeAt: originalWakeAt }]);

    const byNode = new Map((await store.getCheckpoints('run-2')).map((cp) => [cp.nodeId, cp]));
    expect(byNode.get('w')?.effects).toEqual({ wakeAt: originalWakeAt });
  });
});

describe('executeWait: completes when due', () => {
  it('completes the node once clock() >= wakeAt and the run settles', async () => {
    const store = new InMemoryWorkflowStore();
    const clock = makeClock(1_000);
    const engine = makeFakeEngineDeps();
    await store.createRun('run-3', runParams(), waitDefinition('5s'), 'v1');
    const attempt1 = await claimAttempt(store, 'run-3');

    const park1 = await driveUntilPark('run-3', attempt1, { store, engine, clock: clock.now });
    expect(park1.status).toBe('parked');
    const wakeAt = 1_000 + 5_000;
    expect(park1.waitingOn).toEqual([{ kind: 'timer', nodeId: 'w', wakeAt }]);

    clock.advance(5_000); // now clock() === wakeAt
    const attempt2 = await claimAttempt(store, 'run-3', 'owner-2');
    const park2 = await driveUntilPark('run-3', attempt2, { store, engine, clock: clock.now });

    expect(park2.status).toBe('settled');
    expect(park2.outcome).toBe('completed');

    const byNode = new Map((await store.getCheckpoints('run-3')).map((cp) => [cp.nodeId, cp]));
    expect(byNode.get('w')?.status).toBe('completed');
    expect(byNode.get('w')?.result).toEqual({ wakeAt });
    expect(byNode.get('e')?.result).toMatchObject({ output: { wakeAt } });
  });

  it('completes immediately on first entry for a zero-length duration', async () => {
    const store = new InMemoryWorkflowStore();
    const clock = makeClock(1_000);
    const engine = makeFakeEngineDeps();
    await store.createRun('run-4', runParams(), waitDefinition('0ms'), 'v1');
    const attempt = await claimAttempt(store, 'run-4');

    const park = await driveUntilPark('run-4', attempt, { store, engine, clock: clock.now });

    expect(park.status).toBe('settled');
    expect(park.outcome).toBe('completed');
    const byNode = new Map((await store.getCheckpoints('run-4')).map((cp) => [cp.nodeId, cp]));
    expect(byNode.get('w')?.status).toBe('completed');
  });
});
