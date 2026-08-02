/**
 * `RunHost` contract conformance suite (Phase 5 plan Task 8, spec
 * "RunHost Port" + "Conformance → RunHost contract"). Mirrors the other
 * `describe*Contract` suites' shape but needs a richer fixture than a bare
 * store: assertions need to inspect the underlying `WorkflowStore` and a
 * call-recording `WorkflowEngineDeps`, and several tests need to tune
 * timing knobs (`pollMs`/`sweepMs`/`leaseMs`/`heartbeatMs`) or inject a
 * slow executor to isolate one wake source from the others. `makeFixture`
 * therefore returns `{ host, store, engine, clock }` and accepts an
 * options bag; `local-host.test.ts` wires this to `LocalRunHost` +
 * `InMemoryWorkflowStore`.
 *
 * `crashAt`/injectable `exit` (decision 20) are `LocalRunHost`-specific
 * constructor options, not part of the abstract `RunHost` port — that test
 * lives directly in `local-host.test.ts`, not here.
 *
 * Coverage: start idempotency, spurious-wake safety, `scheduleWake`
 * move-forward, terminate → cancellation reconciliation, the lost-wake
 * sweep's four wake sources, the pinned signal-timeout requirement (a
 * `{kind:'signal', timeoutAt}` wait settling via the host's own timer
 * machinery with no signal ever arriving), the background submission
 * waiter, heartbeat lease-holding across a long drive, and expired-lease
 * reclaim without duplicate dispatch.
 */

import { describe, expect, it } from 'vitest';

import type { SubmissionResult } from '@valet/engine';

import type { ApprovalNode, SessionNode } from '../dag/nodes.js';
import type { WorkflowDefinition } from '../dag/shape.js';
import type { WorkflowEngineDeps, WorkflowPromptReceipt } from '../engine-deps.js';
import type { RunHost } from '../local-host.js';
import { createDefaultNodeExecutors } from '../nodes/index.js';
import { executeStop } from '../nodes/stop.js';
import type { NodeExecutorRegistry } from '../nodes/index.js';
import type { RunParams, WorkflowStore } from '../store.js';

// ─── Fixture contract ────────────────────────────────────────────────────────

export interface RunHostFixtureOptions {
  concurrency?: number;
  pollMs?: number;
  leaseMs?: number;
  heartbeatMs?: number;
  sweepMs?: number;
  executors?: NodeExecutorRegistry;
}

export interface RunHostRecordedCall {
  kind: 'createSession' | 'prompt' | 'awaitResult' | 'abort' | 'isSettled';
  [key: string]: unknown;
}

export interface RunHostFixtureEngine extends WorkflowEngineDeps {
  calls: RunHostRecordedCall[];
  /**
   * Controls both `isSettled`'s return value and whether `awaitResult`
   * resolves. Defaults to `true`. Deliberately kept consistent between the
   * two methods — a real engine would never have `awaitResult` report
   * `completed` while `isSettled` still says `false` for the same
   * submission, and a fake that allowed that mismatch was found to
   * starve the event loop: a background waiter that resolves instantly on
   * an unsettled submission triggers a wake, the resumed node re-parks on
   * the same wait (since its own `isSettled` check says not-yet), a fresh
   * waiter spawns and resolves instantly again, forever, with no real
   * timer ever in the loop to yield to.
   */
  setSettled(v: boolean): void;
}

export interface RunHostFixtureClock {
  now: () => number;
  advance: (ms: number) => void;
}

export interface RunHostFixture {
  host: RunHost;
  store: WorkflowStore;
  engine: RunHostFixtureEngine;
  clock: RunHostFixtureClock;
}

export type MakeRunHostFixture = (opts?: RunHostFixtureOptions) => Promise<RunHostFixture> | RunHostFixture;

// ─── Test helpers ────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(
  predicate: () => Promise<boolean> | boolean,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 2_000;
  const intervalMs = opts.intervalMs ?? 5;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() >= deadline) throw new Error(`waitFor: condition not met within ${timeoutMs}ms`);
    await sleep(intervalMs);
  }
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

function waitDefinition(duration: string): WorkflowDefinition {
  return {
    version: 'dag/v1',
    nodes: [
      { id: 't', type: 'trigger' },
      { id: 'w', type: 'wait', mode: 'duration', duration },
      { id: 'e', type: 'stop' },
    ],
    edges: [
      { from: 't', to: 'w' },
      { from: 'w', to: 'e' },
    ],
  };
}

function approvalDefinition(overrides: Partial<ApprovalNode> = {}): WorkflowDefinition {
  const node: ApprovalNode = { id: 'a', type: 'approval', prompt: 'approve?', ...overrides };
  return {
    version: 'dag/v1',
    nodes: [{ id: 't', type: 'trigger' }, node, { id: 'e', type: 'stop' }],
    edges: [
      { from: 't', to: 'a' },
      { from: 'a', to: 'e' },
    ],
  };
}

function sessionDefinition(overrides: Partial<SessionNode> = {}): WorkflowDefinition {
  const node: SessionNode = { id: 's', type: 'session', mode: 'start', prompt: 'do the thing', ...overrides };
  return {
    version: 'dag/v1',
    nodes: [{ id: 't', type: 'trigger' }, node, { id: 'e', type: 'stop' }],
    edges: [
      { from: 't', to: 's' },
      { from: 's', to: 'e' },
    ],
  };
}

// ─── Fake WorkflowEngineDeps ─────────────────────────────────────────────────

export function makeRunHostFixtureEngine(): RunHostFixtureEngine {
  const calls: RunHostRecordedCall[] = [];
  let settled = true;
  let receiptCounter = 0;
  const receiptsByDispatch = new Map<string, WorkflowPromptReceipt>();

  const engine: RunHostFixtureEngine = {
    calls,
    setSettled: (v: boolean) => {
      settled = v;
    },
    createSession: async (opts) => {
      calls.push({ kind: 'createSession', id: opts.id });
      return { id: opts.id };
    },
    prompt: async (sessionId, _text, opts) => {
      calls.push({ kind: 'prompt', sessionId, dispatchId: opts.dispatchId });
      let receipt = receiptsByDispatch.get(opts.dispatchId);
      if (!receipt) {
        receiptCounter += 1;
        receipt = { threadId: `thread-${receiptCounter}`, queueItemId: `queue-${receiptCounter}` };
        receiptsByDispatch.set(opts.dispatchId, receipt);
      }
      return receipt;
    },
    awaitResult: async (sessionId, _threadId, queueItemId) => {
      calls.push({ kind: 'awaitResult', sessionId, queueItemId });
      if (!settled) {
        // Never resolves while unsettled — see the interface doc above for
        // why this must track `isSettled` exactly rather than resolving
        // unconditionally.
        return await new Promise<SubmissionResult>(() => {});
      }
      const result: SubmissionResult = { outcome: 'completed', text: 'ok', queueItemId };
      return result;
    },
    abort: async (sessionId, threadId) => {
      calls.push({ kind: 'abort', sessionId, threadId });
    },
    isSettled: async (sessionId, queueItemId) => {
      calls.push({ kind: 'isSettled', sessionId, queueItemId });
      return settled;
    },
    llmComplete: async () => {
      throw new Error('llmComplete not exercised by this fixture');
    },
    promptOrchestrator: async () => {
      throw new Error('promptOrchestrator not exercised by this fixture');
    },
    invokeAction: async () => {
      throw new Error('invokeAction not exercised by this fixture');
    },
  };

  return engine;
}

// ─── Suite ───────────────────────────────────────────────────────────────────

export function describeRunHostContract(makeFixture: MakeRunHostFixture): void {
  describe('RunHost contract', () => {
    it('start is idempotent: double-starting one run drives it exactly once to completion', async () => {
      const { host, store } = await makeFixture();
      host.startHost();
      try {
        await host.start('run-a', runParams(), simpleDefinition());
        await host.start('run-a', runParams(), simpleDefinition());

        await waitFor(async () => (await store.getRun('run-a'))?.status === 'settled');
        const run = await store.getRun('run-a');
        expect(run?.outcome).toBe('completed');

        const checkpoints = await store.getCheckpoints('run-a');
        expect(checkpoints).toHaveLength(2); // trigger + stop, no duplicates
      } finally {
        await host.stopHost();
      }
    });

    it('a spurious wake on a run parked behind a long timer re-parks harmlessly', async () => {
      const { host, store } = await makeFixture();
      host.startHost();
      try {
        await host.start('run-b', runParams(), waitDefinition('1h'));
        await waitFor(async () => (await store.getRun('run-b'))?.status === 'parked');

        const before = await store.getCheckpoints('run-b');
        await host.wake('run-b');
        await host.wake('run-b');
        await sleep(50); // let any triggered drives start
        // Deadline-based, not a fixed sleep: under load the re-park drive
        // can take longer than any constant, and sampling mid-drive read
        // 'running' (flaked real-Postgres runs).
        await waitFor(async () => (await store.getRun('run-b'))?.status === 'parked', {
          timeoutMs: 5_000,
        });

        const after = await store.getCheckpoints('run-b');
        expect(after).toHaveLength(before.length);
      } finally {
        await host.stopHost();
      }
    });

    it('scheduleWake move-forward: an earlier scheduled wake wins, a later one is a no-op, and the node still governs real completion', async () => {
      const { host, store, clock } = await makeFixture({ pollMs: 100_000, sweepMs: 100_000 });
      host.startHost();
      try {
        const t0 = clock.now();
        await host.start('run-mf', runParams(), waitDefinition('200ms'));
        await waitFor(async () => (await store.getRun('run-mf'))?.status === 'parked');

        const naturalWakeAt = t0 + 200;
        let run = await store.getRun('run-mf');
        expect(run?.wakeAt).toBe(naturalWakeAt);

        // Later call: must not push the wake back.
        await host.scheduleWake('run-mf', naturalWakeAt + 10_000);
        run = await store.getRun('run-mf');
        expect(run?.wakeAt).toBe(naturalWakeAt);

        // Earlier call: moves the store-level wake forward...
        await host.scheduleWake('run-mf', naturalWakeAt - 50);
        run = await store.getRun('run-mf');
        expect(run?.wakeAt).toBe(naturalWakeAt - 50);

        // ...but the wait node's own effects.wakeAt is untouched, so reaching
        // the moved-forward time only produces a harmless spurious re-park —
        // the run does not complete early.
        clock.advance(150); // now = t0 + 150 = naturalWakeAt - 50
        await host.wake('run-mf');
        // Deadline-based (see the spurious-wake test above). The recomputed
        // wakeAt proves the re-park came from the node's real timer wait,
        // not the moved-forward store value.
        await waitFor(
          async () => {
            const r = await store.getRun('run-mf');
            return r?.status === 'parked' && r?.wakeAt === naturalWakeAt;
          },
          { timeoutMs: 5_000 },
        );
        run = await store.getRun('run-mf');
        expect(run?.status).toBe('parked');
        expect(run?.wakeAt).toBe(naturalWakeAt);

        // Reaching the true wakeAt completes the run.
        clock.advance(50); // now = t0 + 200 = naturalWakeAt
        await host.wake('run-mf');
        await waitFor(async () => (await store.getRun('run-mf'))?.status === 'settled');
        run = await store.getRun('run-mf');
        expect(run?.outcome).toBe('completed');
      } finally {
        await host.stopHost();
      }
    });

    it('terminate writes a cancel signal, wakes the run, and reconciles to cancelled (aborting in-flight submission waits)', async () => {
      const { host, store, engine } = await makeFixture();
      // Keep the submission unsettled so the run stays parked long enough to
      // observe (and terminate) — otherwise the default-settled fake engine's
      // background waiter would race the run to normal completion first.
      engine.setSettled(false);
      host.startHost();
      try {
        await host.start('run-term', runParams(), sessionDefinition());
        await waitFor(async () => (await store.getRun('run-term'))?.status === 'parked');

        await host.terminate('run-term');
        await waitFor(async () => (await store.getRun('run-term'))?.status === 'settled');

        const run = await store.getRun('run-term');
        expect(run?.outcome).toBe('cancelled');
        expect(engine.calls.some((c) => c.kind === 'abort')).toBe(true);
      } finally {
        await host.stopHost();
      }
    });

    it('stopHost gates out late wakes: a wake() call after shutdown triggers no new drive', async () => {
      const { host, store, engine } = await makeFixture();
      // Keep the submission unsettled so the run parks and stays parked
      // (rather than racing to completion via the default-settled fake's
      // background waiter) — this leaves a background submission waiter
      // hanging, mirroring the case the gating in `spawnSubmissionWaiter`
      // exists for.
      engine.setSettled(false);
      host.startHost();
      try {
        await host.start('run-stop-gate', runParams(), sessionDefinition());
        await waitFor(async () => (await store.getRun('run-stop-gate'))?.status === 'parked');

        await host.stopHost();
        // Snapshot AFTER stop: between a pre-stop snapshot and stopHost
        // the poll loop could legitimately fire one more engine call,
        // which flaked the no-new-calls assertion under load. A short
        // drain lets any drive that raced stopHost finish writing.
        await sleep(50);
        const callsBefore = engine.calls.length;
        const checkpointsBefore = await store.getCheckpoints('run-stop-gate');

        // Both a direct `wake()` call and (implicitly) the now-hanging
        // background submission waiter must be no-ops post-stop: neither
        // `pollOnce` nor a new drive may run.
        await host.wake('run-stop-gate');
        await sleep(50);

        expect(engine.calls.length).toBe(callsBefore);
        const checkpointsAfter = await store.getCheckpoints('run-stop-gate');
        expect(checkpointsAfter).toEqual(checkpointsBefore);
        const run = await store.getRun('run-stop-gate');
        expect(run?.status).toBe('parked');
      } finally {
        await host.stopHost();
      }
    });

    it('pinned requirement: an approval timeout with no signal ever arriving settles via the host\'s own timer machinery', async () => {
      const { host, store, clock } = await makeFixture();
      host.startHost();
      try {
        await host.start('run-timeout', runParams(), approvalDefinition({ timeout: '50ms', onDeny: 'fail' }));
        await waitFor(async () => (await store.getRun('run-timeout'))?.status === 'parked');

        const parked = await store.getRun('run-timeout');
        const wait = parked?.waitingOn[0];
        expect(wait?.kind).toBe('signal');
        expect(wait && 'timeoutAt' in wait ? wait.timeoutAt : undefined).toBeDefined();

        clock.advance(60);

        await waitFor(async () => (await store.getRun('run-timeout'))?.status === 'settled', { timeoutMs: 3_000 });
        const run = await store.getRun('run-timeout');
        expect(run?.outcome).toBe('failed'); // onDeny: 'fail', resolvedBy 'timeout'
      } finally {
        await host.stopHost();
      }
    });

    it('a background submission waiter wakes the run when the awaited submission settles', async () => {
      const { host, store, engine } = await makeFixture({ sweepMs: 100_000 }); // sweep effectively disabled — only the waiter can progress this
      engine.setSettled(true);
      host.startHost();
      try {
        await host.start('run-waiter', runParams(), sessionDefinition());
        await waitFor(async () => (await store.getRun('run-waiter'))?.status === 'settled', { timeoutMs: 3_000 });
        const run = await store.getRun('run-waiter');
        expect(run?.outcome).toBe('completed');
      } finally {
        await host.stopHost();
      }
    });

    it('heartbeat holds the lease across a drive longer than the lease duration', async () => {
      const { host, store } = await makeFixture({
        leaseMs: 60,
        heartbeatMs: 15,
        executors: slowStopExecutors(200),
      });
      host.startHost();
      try {
        await host.start('run-hb', runParams(), simpleDefinition());

        let stolen = false;
        const intruder = setInterval(() => {
          void store.claimRun('run-hb', 'intruder', 10).then((claimed) => {
            if (claimed) stolen = true;
          });
        }, 10);

        try {
          await waitFor(async () => (await store.getRun('run-hb'))?.status === 'settled', { timeoutMs: 3_000 });
        } finally {
          clearInterval(intruder);
        }
        expect(stolen).toBe(false);
      } finally {
        await host.stopHost();
      }
    });

    it('expired-lease reclaim re-drives a mid-crash attempt without duplicate engine dispatch', async () => {
      // The dishonest version of this test claims a run through the store
      // before it was ever driven — the "dead worker" never dispatched
      // anything, so a single-dispatch assertion is trivially true no
      // matter what the reclaim path does. The real guarantee this test
      // must exercise: an attempt that got as far as dispatching to the
      // engine and persisting the intent checkpoint's receipt, then
      // crashed *before* parking (so the run is left `running` with a
      // lease that goes on to expire, not `parked` — `parkRun` clears
      // ownership, so a parked run is never lease-reclaimable in the first
      // place). A fresh claim redriving that node must read the persisted
      // receipt and skip straight to polling settlement, never re-issuing
      // `createSession`/`prompt`.
      const { host, store, engine } = await makeFixture();
      const runId = 'run-reclaim';
      const definition = sessionDefinition();
      await store.createRun(runId, runParams(), definition, 'v1');

      // Attempt 1: claim with an already-expired lease (simulating "claimed,
      // then the owner died before its first heartbeat"), then perform
      // exactly the dispatch + intent-persist a real `executeSession` would
      // do on its way to a `submission` park — but crash (stop, in this
      // fake) before calling `store.parkRun`.
      const deadClaim = await store.claimRun(runId, 'dead-worker', -1);
      expect(deadClaim).not.toBeNull();
      const attempt = deadClaim?.attempt as number;
      const sessionId = `wf:${runId}:s`;
      const dispatchId = `workflow:${runId}:s`;
      await engine.createSession({ id: sessionId, purpose: 'workflow' });
      const receipt = await engine.prompt(sessionId, 'do the thing', { dispatchId });
      await store.putIntent({
        runId,
        nodeId: 's',
        iteration: 0,
        status: 'intent',
        attempt,
        createdAt: Date.now(),
        effects: { sessionId, receipt, repairAttempted: false },
      });
      // The trigger node ('t') never got its checkpoint written either —
      // the real interpreter will pick it up fresh on the reclaim drive,
      // same as any restart. That's fine: it's not a dispatch source.

      host.startHost();
      try {
        // The expired lease (status `running`, no live owner) makes this
        // run visible to `listRunnable` on the very next poll — no
        // `wake()`/`start()` call needed, exactly like a real crash
        // recovery. Whether the reclaimed drive parks or races straight to
        // completion (the fake engine settles instantly by default) is
        // immaterial — what matters is that the *reclaim* dispatched to the
        // engine zero additional times.
        await waitFor(async () => (await store.getRun(runId))?.status !== 'running', { timeoutMs: 3_000 });
        await sleep(30); // let any (incorrect) duplicate dispatch land before asserting
        expect(engine.calls.filter((c) => c.kind === 'createSession')).toHaveLength(1);
        expect(engine.calls.filter((c) => c.kind === 'prompt')).toHaveLength(1);
      } finally {
        await host.stopHost();
      }
    });

    describe('lost-wake sweep', () => {
      it('wakes a parked run with a due timer', async () => {
        const { host, store, clock } = await makeFixture({ pollMs: 100_000, sweepMs: 20 });
        host.startHost();
        try {
          await host.start('run-sweep-timer', runParams(), waitDefinition('50ms'));
          await waitFor(async () => (await store.getRun('run-sweep-timer'))?.status === 'parked');

          clock.advance(60);

          await waitFor(async () => (await store.getRun('run-sweep-timer'))?.status === 'settled', { timeoutMs: 3_000 });
          const run = await store.getRun('run-sweep-timer');
          expect(run?.outcome).toBe('completed');
        } finally {
          await host.stopHost();
        }
      });

      it('wakes a parked run with an unconsumed matching signal, with no explicit wake', async () => {
        const { host, store, clock } = await makeFixture({ pollMs: 100_000, sweepMs: 20 });
        host.startHost();
        try {
          await host.start('run-sweep-signal', runParams(), approvalDefinition());
          await waitFor(async () => (await store.getRun('run-sweep-signal'))?.status === 'parked');

          await store.insertSignal({
            runId: 'run-sweep-signal',
            signalId: 'approval:a:resolution',
            signalType: 'approval:a',
            payload: { approved: true, resolvedBy: 'tester' },
            createdAt: clock.now(),
          });

          await waitFor(async () => (await store.getRun('run-sweep-signal'))?.status === 'settled', { timeoutMs: 3_000 });
          const run = await store.getRun('run-sweep-signal');
          expect(run?.outcome).toBe('completed');
        } finally {
          await host.stopHost();
        }
      });

      it('wakes a run parked purely on a submission wait (no signal wait) when an unconsumed cancel signal is lost', async () => {
        // Regression for finding M2: the sweep's unconsumed-signal check
        // used to bail out early whenever `waitingOn` contained no `signal`
        // wait at all, which meant a cancel written while a run is parked
        // only on a `submission` wait (the common case — `terminate()`
        // during an in-flight session prompt) was invisible to the sweep.
        // Here the signal is inserted directly via the store, bypassing
        // `host.terminate()`'s own explicit wake, to simulate exactly the
        // "wake was lost" case the sweep exists to cover; the submission is
        // left unsettled so only the sweep — not the settled-submission
        // wake source, not the background waiter — can be what notices.
        const { host, store, engine, clock } = await makeFixture({ pollMs: 100_000, sweepMs: 20 });
        engine.setSettled(false);
        host.startHost();
        try {
          await host.start('run-sweep-cancel', runParams(), sessionDefinition());
          await waitFor(async () => (await store.getRun('run-sweep-cancel'))?.status === 'parked');
          const parked = await store.getRun('run-sweep-cancel');
          expect(parked?.waitingOn.some((w) => w.kind === 'signal')).toBe(false);
          expect(parked?.waitingOn.some((w) => w.kind === 'submission')).toBe(true);

          await store.insertSignal({
            runId: 'run-sweep-cancel',
            signalId: 'cancel',
            signalType: 'cancel',
            createdAt: clock.now(),
          });

          await waitFor(async () => (await store.getRun('run-sweep-cancel'))?.status === 'settled', {
            timeoutMs: 3_000,
          });
          const run = await store.getRun('run-sweep-cancel');
          expect(run?.outcome).toBe('cancelled');
          expect(engine.calls.some((c) => c.kind === 'abort')).toBe(true);
        } finally {
          await host.stopHost();
        }
      });

      it('wakes a parked run on a settled submission, discovered only via isSettled — no explicit wake, waiter left hanging', async () => {
        const { host, store, engine } = await makeFixture({ pollMs: 100_000, sweepMs: 20 });
        engine.setSettled(false); // the background waiter's own awaitResult call hangs while unsettled
        host.startHost();
        try {
          await host.start('run-sweep-submission', runParams(), sessionDefinition());
          await waitFor(async () => (await store.getRun('run-sweep-submission'))?.status === 'parked');

          engine.setSettled(true);

          await waitFor(async () => (await store.getRun('run-sweep-submission'))?.status === 'settled', {
            timeoutMs: 3_000,
          });
          const run = await store.getRun('run-sweep-submission');
          expect(run?.outcome).toBe('completed');
          expect(engine.calls.filter((c) => c.kind === 'awaitResult').length).toBeGreaterThanOrEqual(2);
        } finally {
          await host.stopHost();
        }
      });

      it('re-delivers a consumed-but-uncheckpointed signal (voidConsumption then wake)', async () => {
        const { host, store, clock } = await makeFixture({ pollMs: 100_000, sweepMs: 20 });
        host.startHost();
        try {
          await host.start('run-sweep-void', runParams(), approvalDefinition());
          await waitFor(async () => (await store.getRun('run-sweep-void'))?.status === 'parked');

          // The store's own `consumeSignalAndCheckpoint` is atomic and can
          // never honestly produce a consumed-but-uncheckpointed signal (see
          // `store.ts`'s contract) — this fabricates what a
          // non-transactional backend's reconciliation gap looks like (spec
          // "Signals": a `consumedBy` referencing an attempt with no
          // matching checkpoint is re-delivered).
          await store.insertSignal({
            runId: 'run-sweep-void',
            signalId: 'approval:a:resolution',
            signalType: 'approval:a',
            payload: { approved: true, resolvedBy: 'tester' },
            createdAt: clock.now(),
            consumedAt: clock.now(),
            consumedBy: { nodeId: 'a', iteration: 0, attempt: 999 },
          });

          await waitFor(async () => (await store.getRun('run-sweep-void'))?.status === 'settled', { timeoutMs: 3_000 });
          const run = await store.getRun('run-sweep-void');
          expect(run?.outcome).toBe('completed');
        } finally {
          await host.stopHost();
        }
      });
    });
  });
}

/** The default registry with `stop` overridden to delay before completing — used to hold a drive open past the lease duration. */
function slowStopExecutors(delayMs: number): NodeExecutorRegistry {
  return {
    ...createDefaultNodeExecutors(),
    stop: {
      execute: async (args) => {
        await sleep(delayMs);
        return executeStop(args);
      },
    },
  };
}
