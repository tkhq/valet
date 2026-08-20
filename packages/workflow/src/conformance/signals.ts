/**
 * Signal contract conformance suite — mirrors `checkpoints.ts`'s pattern (a
 * `describe*` factory taking a store constructor, registering vitest
 * blocks). Run against the in-memory store here; the sqlite store (Task 9)
 * must pass this suite unchanged.
 *
 * Coverage (spec "Signals", "Conformance → Signal contract"):
 *  - idempotent insertSignal (duplicate signalId returns the existing row, no error)
 *  - at-most-once consumption with consumedBy recording (nodeId/iteration/attempt)
 *  - atomic consumeSignalAndCheckpoint: both-or-neither on success
 *  - atomic consumeSignalAndCheckpoint: neither exists after a fenced call
 *  - signal-before-wait delivery
 *  - voidConsumption re-delivery
 */

import { describe, expect, it } from 'vitest';
import { WorkflowFenceError, type NodeCheckpoint, type RunParams, type RunSignal, type WorkflowStore } from '../store.js';

const RUN_ID = 'run-1';

function runParams(overrides: Partial<RunParams> = {}): RunParams {
  return {
    workflowId: 'wf-1',
    definitionVersionId: 'v1',
    input: { hello: 'world' },
    ...overrides,
  };
}

function signal(overrides: Partial<RunSignal> = {}): RunSignal {
  return {
    runId: RUN_ID,
    signalId: 'sig-1',
    signalType: 'approval:node-a',
    payload: { approved: true },
    createdAt: 1,
    ...overrides,
  };
}

function terminal(overrides: Partial<NodeCheckpoint> = {}): NodeCheckpoint {
  return {
    runId: RUN_ID,
    nodeId: 'node-a',
    iteration: 0,
    status: 'completed',
    result: { approved: true },
    attempt: 1,
    createdAt: 2,
    ...overrides,
  };
}

export function describeSignalContract(makeStore: () => Promise<WorkflowStore> | WorkflowStore): void {
  describe('WorkflowStore signal contract', () => {
    async function setup(): Promise<WorkflowStore> {
      const store = await makeStore();
      await store.createRun(RUN_ID, runParams(), { version: 'dag/v1' }, 'v1');
      return store;
    }

    it('insertSignal is idempotent: a duplicate signalId returns the existing row unchanged, no error', async () => {
      const store = await setup();
      const first = await store.insertSignal(signal({ payload: { approved: true } }));
      const second = await store.insertSignal(signal({ payload: { approved: false } }));

      expect(second).toEqual(first);
      expect(second.payload).toEqual({ approved: true });

      const [stored] = await store.listSignals(RUN_ID);
      expect(stored.payload).toEqual({ approved: true });
    });

    it('a top-level string payload round-trips verbatim (no read-time re-parse)', async () => {
      // Regression: a jsonb-backed store must not JSON.parse a string
      // payload's CONTENT on read — that throws on non-JSON text.
      const store = await setup();
      const text = 'records[50]:\n  - record_id: 04b39761 (not JSON)';
      await store.insertSignal(signal({ payload: text }));
      const [stored] = await store.listSignals(RUN_ID);
      expect(stored.payload).toBe(text);
    });

    it('a JSON-shaped string payload keeps its string type (no silent double-parse)', async () => {
      const store = await setup();
      await store.insertSignal(signal({ payload: '123' }));
      const [stored] = await store.listSignals(RUN_ID);
      expect(stored.payload).toBe('123');
    });

    it('signal-before-wait delivery: a signal inserted before any wait is registered is found by listSignals(unconsumed)', async () => {
      const store = await setup();
      await store.insertSignal(signal());

      const unconsumed = await store.listSignals(RUN_ID, { unconsumed: true });
      expect(unconsumed.map((s) => s.signalId)).toEqual(['sig-1']);
    });

    it('consumeSignalAndCheckpoint atomically writes both the consumption and the terminal checkpoint on success', async () => {
      const store = await setup();
      await store.insertSignal(signal());

      await store.consumeSignalAndCheckpoint(
        'sig-1',
        { nodeId: 'node-a', iteration: 0, attempt: 1 },
        terminal({ attempt: 1 }),
      );

      const [stored] = await store.listSignals(RUN_ID);
      expect(stored.consumedAt).toBeDefined();
      expect(stored.consumedBy).toEqual({ nodeId: 'node-a', iteration: 0, attempt: 1 });

      const checkpoints = await store.getCheckpoints(RUN_ID);
      expect(checkpoints).toHaveLength(1);
      expect(checkpoints[0].status).toBe('completed');
      expect(checkpoints[0].result).toEqual({ approved: true });
    });

    it('at-most-once consumption: a second consume attempt against an already-consumed signal is rejected, and the recorded consumedBy is stable', async () => {
      const store = await setup();
      await store.insertSignal(signal());
      await store.consumeSignalAndCheckpoint(
        'sig-1',
        { nodeId: 'node-a', iteration: 0, attempt: 1 },
        terminal({ attempt: 1 }),
      );

      // A different node/attempt trying to consume the same signal again must fail.
      await expect(
        store.consumeSignalAndCheckpoint(
          'sig-1',
          { nodeId: 'node-b', iteration: 0, attempt: 1 },
          terminal({ nodeId: 'node-b', attempt: 1 }),
        ),
      ).rejects.toThrow(WorkflowFenceError);

      const [stored] = await store.listSignals(RUN_ID);
      expect(stored.consumedBy).toEqual({ nodeId: 'node-a', iteration: 0, attempt: 1 });

      const unconsumed = await store.listSignals(RUN_ID, { unconsumed: true });
      expect(unconsumed).toHaveLength(0);
    });

    it('at-most-once consumption: the same attempt replaying its own consume+checkpoint write is idempotent', async () => {
      const store = await setup();
      await store.insertSignal(signal());
      await store.consumeSignalAndCheckpoint(
        'sig-1',
        { nodeId: 'node-a', iteration: 0, attempt: 1 },
        terminal({ attempt: 1 }),
      );

      await expect(
        store.consumeSignalAndCheckpoint(
          'sig-1',
          { nodeId: 'node-a', iteration: 0, attempt: 1 },
          terminal({ attempt: 1 }),
        ),
      ).resolves.toBeUndefined();

      const [stored] = await store.listSignals(RUN_ID);
      expect(stored.consumedBy).toEqual({ nodeId: 'node-a', iteration: 0, attempt: 1 });
    });

    it('consumeSignalAndCheckpoint atomicity: a fenced call (stale attempt) leaves NEITHER the signal consumed NOR a checkpoint written', async () => {
      const store = await setup();
      await store.insertSignal(signal());

      const firstClaim = await store.claimRun(RUN_ID, 'owner-1', 30_000);
      if (!firstClaim) throw new Error('expected first claim to succeed');
      await store.parkRun(RUN_ID, firstClaim.attempt, []);
      const secondClaim = await store.claimRun(RUN_ID, 'owner-2', 30_000);
      if (!secondClaim) throw new Error('expected second claim to succeed');
      expect(secondClaim.attempt).toBe(firstClaim.attempt + 1);

      // The zombie (stale attempt) tries to consume the signal after losing ownership.
      await expect(
        store.consumeSignalAndCheckpoint(
          'sig-1',
          { nodeId: 'node-a', iteration: 0, attempt: firstClaim.attempt },
          terminal({ attempt: firstClaim.attempt }),
        ),
      ).rejects.toThrow(WorkflowFenceError);

      const [stored] = await store.listSignals(RUN_ID);
      expect(stored.consumedAt).toBeUndefined();
      expect(stored.consumedBy).toBeUndefined();

      const checkpoints = await store.getCheckpoints(RUN_ID);
      expect(checkpoints).toHaveLength(0);
    });

    it('voidConsumption re-delivery: a consumed-but-uncheckpointed signal becomes unconsumed again and can be consumed by a later attempt', async () => {
      const store = await setup();
      await store.insertSignal(signal());
      // Simulate a non-transactional backend where the signal-consume write
      // landed but the paired checkpoint write for that attempt never did
      // (crash in between) — reconciliation detects the gap and voids the
      // consumption so the signal is treated as unconsumed again. On this
      // store `consumeSignalAndCheckpoint` always writes both together, so
      // we drive `voidConsumption` directly to model the reconciled state,
      // then re-deliver to a fresh node/attempt exactly as reconciliation
      // would after re-running the wait.
      await store.consumeSignalAndCheckpoint(
        'sig-1',
        { nodeId: 'node-a', iteration: 0, attempt: 1 },
        terminal({ attempt: 1 }),
      );
      await store.voidConsumption(RUN_ID, 'sig-1');

      const unconsumed = await store.listSignals(RUN_ID, { unconsumed: true });
      expect(unconsumed.map((s) => s.signalId)).toEqual(['sig-1']);

      // A later attempt (e.g. after reconciliation) re-consumes the re-delivered signal.
      await store.consumeSignalAndCheckpoint(
        'sig-1',
        { nodeId: 'node-b', iteration: 0, attempt: 2 },
        terminal({ nodeId: 'node-b', attempt: 2 }),
      );

      const [stored] = await store.listSignals(RUN_ID);
      expect(stored.consumedBy).toEqual({ nodeId: 'node-b', iteration: 0, attempt: 2 });
    });

    it('voidConsumption on an already-unconsumed or missing signal is a harmless no-op', async () => {
      const store = await setup();
      await store.insertSignal(signal());

      await expect(store.voidConsumption(RUN_ID, 'sig-1')).resolves.toBeUndefined();
      await expect(store.voidConsumption(RUN_ID, 'does-not-exist')).resolves.toBeUndefined();

      const [stored] = await store.listSignals(RUN_ID);
      expect(stored.consumedAt).toBeUndefined();
    });

    it('listSignals(unconsumed) excludes a consumed signal but listSignals() without the filter still returns it', async () => {
      const store = await setup();
      await store.insertSignal(signal());
      await store.consumeSignalAndCheckpoint(
        'sig-1',
        { nodeId: 'node-a', iteration: 0, attempt: 1 },
        terminal({ attempt: 1 }),
      );

      const unconsumed = await store.listSignals(RUN_ID, { unconsumed: true });
      expect(unconsumed).toHaveLength(0);

      const all = await store.listSignals(RUN_ID);
      expect(all).toHaveLength(1);
      expect(all[0].consumedAt).toBeDefined();
    });

    it('signals and voidConsumption are scoped per-run: two runs each holding a same-signalId signal do not interfere', async () => {
      const store = await setup();
      const RUN_B = 'run-2';
      await store.createRun(RUN_B, runParams(), { version: 'dag/v1' }, 'v1');

      const insertedA = await store.insertSignal(signal({ runId: RUN_ID, signalId: 'cancel', signalType: 'cancel' }));
      const insertedB = await store.insertSignal(signal({ runId: RUN_B, signalId: 'cancel', signalType: 'cancel' }));
      expect(insertedA.runId).toBe(RUN_ID);
      expect(insertedB.runId).toBe(RUN_B);

      // Both runs independently see their own 'cancel' signal — run B's
      // insert must not have collided with (or returned) run A's row.
      const signalsA = await store.listSignals(RUN_ID);
      const signalsB = await store.listSignals(RUN_B);
      expect(signalsA.map((s) => s.signalId)).toEqual(['cancel']);
      expect(signalsB.map((s) => s.signalId)).toEqual(['cancel']);

      await store.consumeSignalAndCheckpoint(
        'cancel',
        { nodeId: 'node-a', iteration: 0, attempt: 1 },
        terminal({ runId: RUN_ID, nodeId: 'node-a', attempt: 1 }),
      );

      const [consumedA] = await store.listSignals(RUN_ID);
      expect(consumedA.consumedAt).toBeDefined();
      const [unconsumedB] = await store.listSignals(RUN_B);
      expect(unconsumedB.consumedAt).toBeUndefined();

      // Voiding run B's consumption (it was never consumed) must not touch
      // run A's already-consumed signal.
      await store.voidConsumption(RUN_B, 'cancel');

      const [stillConsumedA] = await store.listSignals(RUN_ID);
      expect(stillConsumedA.consumedAt).toBeDefined();
      const [stillUnconsumedB] = await store.listSignals(RUN_B);
      expect(stillUnconsumedB.consumedAt).toBeUndefined();
    });

    it('mutating a returned signal does not affect the stored state', async () => {
      const store = await setup();
      await store.insertSignal(signal({ payload: { approved: true } }));

      const [stored] = await store.listSignals(RUN_ID);
      if (!isApprovalPayload(stored.payload)) throw new Error('expected an { approved } payload');
      stored.payload.approved = false;

      const [reread] = await store.listSignals(RUN_ID);
      expect(reread.payload).toEqual({ approved: true });
    });
  });
}

function isApprovalPayload(value: unknown): value is { approved: boolean } {
  return typeof value === 'object' && value !== null && 'approved' in value;
}
