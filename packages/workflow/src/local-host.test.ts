import { describe, expect, it } from 'vitest';

import { describeRunHostContract, makeRunHostFixtureEngine, type RunHostFixture, type RunHostFixtureOptions } from './conformance/run-host.js';
import type { RunSettledInfo } from './interpreter.js';
import { LocalRunHost } from './local-host.js';
import { InMemoryWorkflowStore } from './memory-store.js';
import { createDefaultNodeExecutors, executeStop, type NodeExecutorRegistry } from './nodes/index.js';
import type { RunParams } from './store.js';
import type { SessionNode } from './dag/nodes.js';
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

function sessionDefinition(): WorkflowDefinition {
  const node: SessionNode = { id: 's', type: 'session', mode: 'start', prompt: 'do the thing' };
  return {
    version: 'dag/v1',
    nodes: [{ id: 't', type: 'trigger' }, node, { id: 'e', type: 'stop' }],
    edges: [
      { from: 't', to: 's' },
      { from: 's', to: 'e' },
    ],
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

// ─── Restart case: a run parked on a submission wait before the process ─────
// ─── crashed, re-armed by a fresh process's sweep with zero prior knowledge ─

describe('LocalRunHost sweep survives a process restart', () => {
  it('fails a preview run already parked on the same account after consumed consent', async () => {
    const store = new InMemoryWorkflowStore();
    const engine = makeRunHostFixtureEngine();
    await store.createRun('legacy-account-loop', runParams(), { version: 'dag/v1', nodes: [
      { id: 'step', type: 'tool', service: 'demo', action: 'ping', params: {} },
    ], edges: [] }, 'v1');
    const claim = await store.claimRun('legacy-account-loop', 'old-host', 30_000);
    if (!claim) throw new Error('Missing claim');
    await store.putIntent({ runId: 'legacy-account-loop', nodeId: 'step', iteration: 0, status: 'intent', attempt: claim.attempt,
      createdAt: 1, effects: { gate: true, accountConsentResolved: true, provenance: 'shared_account',
        approver: { userId: 'lender', shareGeneration: 'share-1', allowTeamConsent: true } } });
    await store.insertSignal({ runId: 'legacy-account-loop', signalId: 'approval:step:account:share-1:resolution', signalType: 'approval:step',
      payload: { approved: true, resolvedBy: 'lender', scope: 'team_account' }, createdAt: 1, consumedAt: 1,
      consumedBy: { nodeId: 'step', iteration: 0, attempt: claim.attempt } });
    await store.parkRun('legacy-account-loop', claim.attempt, [{ kind: 'signal', signalType: 'approval:step', nodeId: 'step' }]);
    const host = new LocalRunHost({ store, engine, pollMs: 100_000, sweepMs: 20 });
    host.startHost();
    try {
      await waitFor(async () => (await store.getRun('legacy-account-loop'))?.status === 'settled');
      expect((await store.getRun('legacy-account-loop'))?.outcome).toBe('failed');
      expect((await store.getCheckpoints('legacy-account-loop'))[0]?.error).toContain('account still requires approval');
      expect((await store.listSignals('legacy-account-loop'))[0]?.consumedAt).toBe(1);
    } finally { await host.stopHost(); }
  });

  it.each([false, true])('keeps a preview-format action gate open after legacy consent (consumed=%s)', async consumed => {
    const store = new InMemoryWorkflowStore();
    const engine = makeRunHostFixtureEngine();
    let calls = 0;
    engine.invokeAction = async req => {
      calls++;
      return req.approval ? { ok: true, result: {} } : { ok: false, requiresApproval: true, provenance: 'org_policy' };
    };
    await store.createRun('legacy-action', runParams(), { version: 'dag/v1', nodes: [
      { id: 'step', type: 'tool', service: 'demo', action: 'ping', params: {} },
    ], edges: [] }, 'v1');
    const claim = await store.claimRun('legacy-action', 'old-host', 30_000);
    if (!claim) throw new Error('Missing claim');
    await store.putIntent({ runId: 'legacy-action', nodeId: 'step', iteration: 0, status: 'intent', attempt: claim.attempt,
      createdAt: 1, effects: { gate: true, accountConsentResolved: true, provenance: 'org_policy' } });
    await store.insertSignal({ runId: 'legacy-action', signalId: 'legacy-account-answer', signalType: 'approval:step',
      payload: { approved: true, resolvedBy: 'lender', scope: 'team_account' }, createdAt: 1,
      ...(consumed ? { consumedAt: 1, consumedBy: { nodeId: 'step', iteration: 0, attempt: claim.attempt } } : {}) });
    await store.parkRun('legacy-action', claim.attempt, [{ kind: 'signal', signalType: 'approval:step', nodeId: 'step' }]);
    let sweeps = 0;
    const listParked = store.listParked.bind(store);
    store.listParked = async limit => { sweeps++; return listParked(limit); };
    const host = new LocalRunHost({ store, engine, pollMs: 100_000, sweepMs: 20 });
    host.startHost();
    try {
      await waitFor(() => sweeps >= 3);
      expect(calls).toBe(0);
      expect((await store.getRun('legacy-action'))?.status).toBe('parked');
      expect((await store.listSignals('legacy-action'))[0]?.consumedAt !== undefined).toBe(consumed);
      await store.insertSignal({ runId: 'legacy-action', signalId: 'legacy-action-answer', signalType: 'approval:step',
        payload: { approved: true, resolvedBy: 'requester' }, createdAt: 2 });
      await waitFor(async () => (await store.getRun('legacy-action'))?.status === 'settled');
      expect((await store.getRun('legacy-action'))?.outcome).toBe('completed');
      expect(calls).toBe(1);
    } finally { await host.stopHost(); }
  });

  it.each([false, true])('keeps multiple account answers consumed across later gates (legacy=%s)', async legacy => {
    const store = new InMemoryWorkflowStore();
    const engine = makeRunHostFixtureEngine();
    let calls = 0;
    engine.invokeAction = async req => {
      calls++;
      if (req.approval) return { ok: true, result: { done: true } };
      return calls < 3
        ? { ok: false, requiresApproval: true, provenance: 'shared_account', approver: { userId: 'lender', shareGeneration: `share-${calls}`, allowTeamConsent: true } }
        : { ok: false, requiresApproval: true, provenance: 'org_policy' };
    };
    const definition: WorkflowDefinition = { version: 'dag/v1', nodes: [
      { id: 't', type: 'trigger' }, { id: 'step', type: 'tool', service: 'demo', action: 'ping', params: {} },
    ], edges: [{ from: 't', to: 'step' }] };
    let sweeps = 0;
    const listParked = store.listParked.bind(store);
    store.listParked = async limit => { sweeps++; return listParked(limit); };
    const host = new LocalRunHost({ store, engine, pollMs: 100_000, sweepMs: 20 });
    host.startHost();
    try {
      await host.start('run-consent-sweep', runParams(), definition);
      await waitFor(async () => (await store.getRun('run-consent-sweep'))?.status === 'parked');
      if (legacy) {
        const cp = (await store.getCheckpoints('run-consent-sweep')).find(c => c.nodeId === 'step');
        if (!cp) throw new Error('Missing checkpoint');
        await store.putIntent({ ...cp, effects: { ...cp.effects, gateId: undefined, gateSequence: undefined } });
      }
      for (const signalId of ['consent:first', 'consent:second']) {
        const cp = (await store.getCheckpoints('run-consent-sweep')).find(c => c.nodeId === 'step');
        await store.insertSignal({ runId: 'run-consent-sweep', signalId, signalType: 'approval:step',
          payload: { approved: true, resolvedBy: 'lender', scope: 'team_account', gateId: cp?.effects?.gateId }, createdAt: Date.now() });
        await host.wake('run-consent-sweep');
        const expectedCalls = signalId === 'consent:first' ? 2 : 3;
        await waitFor(async () => calls >= expectedCalls && (await store.getRun('run-consent-sweep'))?.status === 'parked');
      }
      const beforeSweeps = sweeps;
      await waitFor(() => sweeps >= beforeSweeps + 3);
      const checkpoint = (await store.getCheckpoints('run-consent-sweep')).find(c => c.nodeId === 'step');
      const gateId = legacy ? 'approval:step:gate:2' : 'approval:step:gate:3';
      expect(checkpoint?.effects?.gateId).toBe(gateId);
      expect(calls).toBe(3);
      expect(await store.listSignals('run-consent-sweep', { unconsumed: true })).toEqual([]);
      await store.insertSignal({ runId: 'run-consent-sweep', signalId: 'action:answer', signalType: 'approval:step',
        payload: { approved: true, resolvedBy: 'requester', gateId }, createdAt: Date.now() });
      await waitFor(async () => (await store.getRun('run-consent-sweep'))?.status === 'settled');
      expect((await store.getRun('run-consent-sweep'))?.outcome).toBe('completed');
      expect(calls).toBe(4);
    } finally { await host.stopHost(); }
  });

  it('wakes a run parked on a submission wait that a fresh host never start()ed or wake()d', async () => {
    // This is the finding-1 regression verbatim: the sweep used to
    // enumerate a host-local `knownRunIds` set, populated only by
    // start/wake/scheduleWake/terminate — empty for a brand-new process.
    // A run parked on a submission wait before a crash was therefore never
    // re-armed after restart (no wakeAt, no wakeRequested, no lease — it's
    // invisible to `listRunnable`, and the old sweep never even looked at
    // it). The fix drives the sweep off `store.listParked(...)` instead,
    // which has no notion of "process instance" at all.
    const clock = makeClock();
    const store = new InMemoryWorkflowStore(clock.now);
    const runId = 'run-restart';

    // Host A: drive the run to a parked submission wait, then shut down —
    // simulating the process that started the run crashing (or just
    // stopping) before the submission ever settled.
    const engineA = makeRunHostFixtureEngine();
    engineA.setSettled(false);
    const hostA = new LocalRunHost({
      store,
      engine: engineA,
      clock: clock.now,
      pollMs: 10,
      sweepMs: 100_000, // sweep disabled on host A — irrelevant to this test
      leaseMs: 2_000,
      heartbeatMs: 300,
    });
    hostA.startHost();
    try {
      await hostA.start(runId, runParams(), sessionDefinition());
      await waitFor(async () => (await store.getRun(runId))?.status === 'parked');
      const parked = await store.getRun(runId);
      expect(parked?.waitingOn.some((w) => w.kind === 'submission')).toBe(true);
    } finally {
      await hostA.stopHost();
    }

    // A fresh host, fresh engine, sharing only the durable store — no
    // in-memory knowledge of `run-restart` whatsoever. The engine now
    // reports the submission settled (the crash didn't take the real
    // engine-side work with it). Crucially: no `start()`/`wake()` call is
    // ever made for this run — only `startHost()`'s sweep loop can be what
    // notices and re-arms it.
    const engineB = makeRunHostFixtureEngine();
    engineB.setSettled(true);
    const hostB = new LocalRunHost({
      store,
      engine: engineB,
      clock: clock.now,
      pollMs: 100_000, // poll disabled — only the sweep may act
      sweepMs: 20,
      leaseMs: 2_000,
      heartbeatMs: 300,
    });
    hostB.startHost();
    try {
      await waitFor(async () => (await store.getRun(runId))?.status === 'settled', 3_000);
      const run = await store.getRun(runId);
      expect(run?.outcome).toBe('completed');
    } finally {
      await hostB.stopHost();
    }
  });
});

// ─── Settle reporting: the host hands `onRunSettled` to every drive ─────────

describe('LocalRunHost settle reporting', () => {
  it('reports a run it drove to settlement, with the run owner and workflow id', async () => {
    const clock = makeClock();
    const store = new InMemoryWorkflowStore(clock.now);
    const engine = makeRunHostFixtureEngine();
    const reports: RunSettledInfo[] = [];

    const host = new LocalRunHost({
      store,
      engine,
      clock: clock.now,
      pollMs: 10,
      sweepMs: 20,
      leaseMs: 2_000,
      heartbeatMs: 300,
      onRunSettled: (info) => {
        reports.push(info);
      },
    });

    host.startHost();
    try {
      await host.start('run-report', runParams(), simpleDefinition(), { ownerType: 'user', ownerId: 'u-9' });
      await waitFor(async () => reports.length > 0);
    } finally {
      await host.stopHost();
    }

    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      runId: 'run-report',
      workflowId: 'wf-1',
      outcome: 'completed',
      owner: { ownerType: 'user', ownerId: 'u-9' },
    });
  });
});

describe('LocalRunHost approval park reporting', () => {
  it('reports once per drive that opens a gate, after the park lists every waiting step', async () => {
    const clock = makeClock();
    const store = new InMemoryWorkflowStore(clock.now);
    const reports: { attempt: number; waiting: string[] }[] = [];
    const host = new LocalRunHost({
      store,
      engine: makeRunHostFixtureEngine(),
      clock: clock.now,
      pollMs: 10,
      sweepMs: 20,
      leaseMs: 2_000,
      heartbeatMs: 300,
      onApprovalParked: async ({ runId, attempt }) => {
        const run = await store.getRun(runId);
        const waiting = (run?.waitingOn ?? []).map((wait) => (wait.kind === 'signal' ? wait.signalType : wait.kind));
        reports.push({ attempt, waiting: waiting.sort() });
      },
    });
    const definition: WorkflowDefinition = {
      version: 'dag/v1',
      nodes: [
        { id: 't', type: 'trigger' },
        { id: 'a', type: 'approval', prompt: 'A?', timeout: '1s', onDeny: 'skip' },
        { id: 'b', type: 'approval', prompt: 'B?' },
        { id: 'c', type: 'approval', prompt: 'C?' },
      ],
      edges: [
        { from: 't', to: 'a' },
        { from: 't', to: 'b' },
        { from: 'a', to: 'c', fromOutput: 'false' },
      ],
    };

    host.startHost();
    try {
      await host.start('run-gates', runParams(), definition);
      await waitFor(() => reports.length === 1);
      expect(reports[0].waiting).toEqual(['approval:a', 'approval:b']);

      // Approving b opens no gate: a still waits, and nothing is reported.
      await store.insertSignal({ runId: 'run-gates', signalId: 'approval:b:resolution', signalType: 'approval:b',
        payload: { approved: true, resolvedBy: 'member' }, createdAt: clock.now() });
      await host.wake('run-gates');
      await waitFor(async () => (await store.getCheckpoints('run-gates')).some((cp) => cp.nodeId === 'b' && cp.status === 'completed'));
      await waitFor(async () => (await store.getRun('run-gates'))?.status === 'parked');
      expect(reports).toHaveLength(1);

      // a times out without a resolution signal and c opens: a new report.
      clock.advance(5_000);
      await host.wake('run-gates');
      await waitFor(() => reports.length === 2);
      expect(reports[1].waiting).toEqual(['approval:c']);
      expect(reports[1].attempt).toBeGreaterThan(reports[0].attempt);
    } finally {
      await host.stopHost();
    }
  });
});

describe('LocalRunHost approval park reporting after a failed drive', () => {
  it('reports the gate on the retry when the drive that opened it failed to park', async () => {
    const clock = makeClock();
    const store = new InMemoryWorkflowStore(clock.now);
    const parkRun = store.parkRun.bind(store);
    let failPark = true;
    store.parkRun = async (...args) => {
      if (failPark) {
        failPark = false;
        throw new Error('transient park failure');
      }
      return parkRun(...args);
    };
    let opened = 0;
    const reports: number[] = [];
    const host = new LocalRunHost({
      store,
      engine: makeRunHostFixtureEngine(),
      clock: clock.now,
      pollMs: 10,
      sweepMs: 20,
      leaseMs: 50,
      heartbeatMs: 300,
      onApprovalPending: () => {
        opened++;
      },
      onApprovalParked: ({ attempt }) => {
        reports.push(attempt);
      },
    });
    const definition: WorkflowDefinition = {
      version: 'dag/v1',
      nodes: [{ id: 't', type: 'trigger' }, { id: 'a', type: 'approval', prompt: 'A?' }],
      edges: [{ from: 't', to: 'a' }],
    };

    host.startHost();
    try {
      await host.start('run-retry', runParams(), definition);
      await waitFor(async () => {
        clock.advance(100);
        return reports.length > 0;
      });
    } finally {
      await host.stopHost();
    }
    expect(opened).toBe(1);
    expect(reports).toHaveLength(1);
    expect((await store.getRun('run-retry'))?.waitingOn).toEqual([{ kind: 'signal', nodeId: 'a', signalType: 'approval:a', timeoutAt: undefined }]);
  });
});

// ─── LocalRunHost-specific: poisoned-run cap ─────────────────────────────────
// A run whose drive throws deterministically on every reclaim must settle as
// `failed` after `maxConsecutiveDriveFailures` strikes instead of retrying
// forever — the infinite-reclaim loop pinned a live api (two runs with
// unparseable stored JSON re-driven every lease expiry, 36+ failures/10min).

describe('LocalRunHost poisoned-run cap', () => {
  function throwingStopExecutors(onThrow: () => void): NodeExecutorRegistry {
    return {
      ...createDefaultNodeExecutors(),
      stop: {
        execute: async () => {
          onThrow();
          throw new SyntaxError('poisoned: stored state is not valid JSON');
        },
      },
    };
  }

  function makePoisonHost(opts: {
    store: InMemoryWorkflowStore;
    clock: () => number;
    executors: NodeExecutorRegistry;
    onRunSettled?: (info: RunSettledInfo) => void;
  }): LocalRunHost {
    return new LocalRunHost({
      store: opts.store,
      engine: makeRunHostFixtureEngine(),
      clock: opts.clock,
      pollMs: 10,
      sweepMs: 20,
      leaseMs: 50,
      heartbeatMs: 300,
      maxConsecutiveDriveFailures: 3,
      executors: opts.executors,
      onRunSettled: opts.onRunSettled,
    });
  }

  it('settles the run as failed after the cap, through the normal settle door (onRunSettled fires)', async () => {
    const clock = makeClock();
    const store = new InMemoryWorkflowStore(clock.now);
    const settled: RunSettledInfo[] = [];
    let throws = 0;
    const host = makePoisonHost({
      store,
      clock: clock.now,
      executors: throwingStopExecutors(() => (throws += 1)),
      onRunSettled: (info) => {
        settled.push(info);
      },
    });

    host.startHost();
    try {
      await host.start('run-poisoned', runParams(), simpleDefinition());
      // Each failed drive abandons the lease. Advance the fake clock past
      // the lease repeatedly so every poll can reclaim, until the cap fires.
      const advancer = setInterval(() => clock.advance(60), 10);
      try {
        await waitFor(async () => (await store.getRun('run-poisoned'))?.status === 'settled');
      } finally {
        clearInterval(advancer);
      }
    } finally {
      await host.stopHost();
    }

    const run = await store.getRun('run-poisoned');
    expect(run?.status).toBe('settled');
    expect(run?.outcome).toBe('failed');
    // Exactly the budget: three strikes, no fourth drive after the settle.
    expect(throws).toBe(3);
    expect(settled).toHaveLength(1);
    expect(settled[0]).toMatchObject({ runId: 'run-poisoned', outcome: 'failed' });
  });

  it('a drive that recovers below the cap settles normally — transient failures keep retry-via-reclaim', async () => {
    const clock = makeClock();
    const store = new InMemoryWorkflowStore(clock.now);
    let throws = 0;
    const flaky: NodeExecutorRegistry = {
      ...createDefaultNodeExecutors(),
      stop: {
        execute: async (args) => {
          if (throws < 2) {
            throws += 1;
            throw new Error('transient: dependency hiccup');
          }
          return executeStop(args);
        },
      },
    };
    const host = makePoisonHost({ store, clock: clock.now, executors: flaky });

    host.startHost();
    try {
      await host.start('run-flaky', runParams(), simpleDefinition());
      const advancer = setInterval(() => clock.advance(60), 10);
      try {
        await waitFor(async () => (await store.getRun('run-flaky'))?.status === 'settled');
      } finally {
        clearInterval(advancer);
      }
    } finally {
      await host.stopHost();
    }

    const run = await store.getRun('run-flaky');
    // Two strikes (below the cap of three), then the third drive succeeded:
    // the run completes, proving the cap never fires on a recovered run.
    expect(throws).toBe(2);
    expect(run?.outcome).toBe('completed');
  });
});
