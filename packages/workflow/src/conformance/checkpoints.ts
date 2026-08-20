/**
 * Checkpoint contract conformance suite — mirrors `@valet/engine`'s
 * `test-helpers/*-contract.ts` pattern (a `describe*` factory taking a
 * store constructor, registering vitest blocks). Run against the in-memory
 * store here; the sqlite store (Task 9) must pass this suite unchanged.
 *
 * Coverage (spec "Conformance → Checkpoint contract"):
 *  - skip-if-completed read-back
 *  - intent → terminal CAS
 *  - terminal immutability (first terminal write wins; late stale terminal rejected)
 *  - stale-attempt intent replacement by higher attempt
 *  - rejected late terminal write (WorkflowFenceError)
 *  - effects round-trip
 *  - createRun insert-if-absent idempotency
 */

import { describe, expect, it } from 'vitest';
import { WorkflowFenceError, type NodeCheckpoint, type RunParams, type WorkflowStore } from '../store.js';

const RUN_ID = 'run-1';

function runParams(overrides: Partial<RunParams> = {}): RunParams {
  return {
    workflowId: 'wf-1',
    definitionVersionId: 'v1',
    input: { hello: 'world' },
    ...overrides,
  };
}

function intent(overrides: Partial<NodeCheckpoint> = {}): NodeCheckpoint {
  return {
    runId: RUN_ID,
    nodeId: 'node-a',
    iteration: 0,
    status: 'intent',
    attempt: 1,
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
    result: { ok: true },
    attempt: 1,
    createdAt: 2,
    ...overrides,
  };
}

export function describeCheckpointContract(makeStore: () => Promise<WorkflowStore> | WorkflowStore): void {
  describe('WorkflowStore checkpoint contract', () => {
    async function setup(): Promise<WorkflowStore> {
      const store = await makeStore();
      await store.createRun(RUN_ID, runParams(), { version: 'dag/v1' }, 'v1');
      return store;
    }

    it('createRun is insert-if-absent and idempotent', async () => {
      const store = await makeStore();
      const first = await store.createRun(RUN_ID, runParams({ input: { a: 1 } }), { n: 1 }, 'v1');
      const second = await store.createRun(RUN_ID, runParams({ input: { a: 2 } }), { n: 2 }, 'v2');
      // A serializing (e.g. sqlite-backed) store returns a freshly
      // deserialized object each call — assert value equality, not
      // reference identity.
      expect(second).toEqual(first);
      expect(second.params.input).toEqual({ a: 1 });
      expect(second.definitionVersionId).toBe('v1');

      const loaded = await store.getRun(RUN_ID);
      expect(loaded?.params.input).toEqual({ a: 1 });
    });

    it('putIntent then completeCheckpoint transitions intent → terminal, readable via getCheckpoints', async () => {
      const store = await setup();
      await store.putIntent(intent());
      let [cp] = await store.getCheckpoints(RUN_ID);
      expect(cp.status).toBe('intent');

      await store.completeCheckpoint(RUN_ID, 'node-a', 0, 1, terminal());
      [cp] = await store.getCheckpoints(RUN_ID);
      expect(cp.status).toBe('completed');
      expect(cp.result).toEqual({ ok: true });
    });

    it('skip-if-completed: a terminal checkpoint reads back its status and result for the interpreter to skip on', async () => {
      const store = await setup();
      await store.completeCheckpoint(RUN_ID, 'node-a', 0, 1, terminal({ result: { value: 42 } }));
      const checkpoints = await store.getCheckpoints(RUN_ID);
      const cp = checkpoints.find((c) => c.nodeId === 'node-a');
      expect(cp).toMatchObject({ status: 'completed', result: { value: 42 } });
    });

    it('a top-level string result round-trips verbatim (no read-time re-parse)', async () => {
      // Regression: action nodes can return a plain text blob. A jsonb-backed
      // store must not JSON.parse the string's CONTENT on read — that throws
      // on non-JSON text and poisons every subsequent read of the run.
      const store = await setup();
      const text = 'tasks[10]:\n  - task_id: 2701b936 (not JSON)';
      await store.completeCheckpoint(RUN_ID, 'node-a', 0, 1, terminal({ result: text }));
      const [cp] = await store.getCheckpoints(RUN_ID);
      expect(cp.result).toBe(text);
    });

    it('a JSON-shaped string result keeps its string type (no silent double-parse)', async () => {
      // The silent variant of the same bug: result "123" must read back as
      // the string "123", not the number 123.
      const store = await setup();
      await store.completeCheckpoint(RUN_ID, 'node-a', 0, 1, terminal({ result: '123' }));
      const [cp] = await store.getCheckpoints(RUN_ID);
      expect(cp.result).toBe('123');
    });

    it('effects round-trip through putIntent and completeCheckpoint', async () => {
      const store = await setup();
      const effects = { wakeAt: 12345, generatedId: 'abc-123', nested: { count: 3 } };
      await store.putIntent(intent({ effects }));
      let [cp] = await store.getCheckpoints(RUN_ID);
      expect(cp.effects).toEqual(effects);

      await store.completeCheckpoint(RUN_ID, 'node-a', 0, 1, terminal({ effects }));
      [cp] = await store.getCheckpoints(RUN_ID);
      expect(cp.effects).toEqual(effects);
    });

    it('a higher-attempt putIntent CAS-replaces a stale lower-attempt intent row', async () => {
      const store = await setup();
      await store.putIntent(intent({ attempt: 1, effects: { from: 'attempt-1' } }));
      await store.putIntent(intent({ attempt: 2, effects: { from: 'attempt-2' } }));

      const [cp] = await store.getCheckpoints(RUN_ID);
      expect(cp.attempt).toBe(2);
      expect(cp.effects).toEqual({ from: 'attempt-2' });
    });

    it('a lower-attempt putIntent against an existing higher-attempt intent is rejected with WorkflowFenceError', async () => {
      const store = await setup();
      await store.putIntent(intent({ attempt: 2 }));
      await expect(store.putIntent(intent({ attempt: 1 }))).rejects.toThrow(WorkflowFenceError);

      const [cp] = await store.getCheckpoints(RUN_ID);
      expect(cp.attempt).toBe(2); // unchanged
    });

    it('terminal rows are immutable: the first terminal write wins and a stale late terminal write is rejected', async () => {
      const store = await setup();
      await store.putIntent(intent({ attempt: 1 }));
      await store.completeCheckpoint(RUN_ID, 'node-a', 0, 1, terminal({ attempt: 1, result: { winner: true } }));

      // A stale attempt (e.g. reclaimed after lease expiry) tries to land its own terminal write late.
      await expect(
        store.completeCheckpoint(RUN_ID, 'node-a', 0, 1, terminal({ attempt: 1, result: { winner: false } })),
      ).resolves.toBeUndefined(); // same attempt replaying its own write is idempotent, not an error

      const [cpSameAttempt] = await store.getCheckpoints(RUN_ID);
      expect(cpSameAttempt.result).toEqual({ winner: true }); // first write's content still wins

      // A genuinely different (higher) attempt's late terminal write must be rejected.
      await expect(
        store.completeCheckpoint(RUN_ID, 'node-a', 0, 2, terminal({ attempt: 2, result: { winner: 'attempt-2' } })),
      ).rejects.toThrow(WorkflowFenceError);

      const [cp] = await store.getCheckpoints(RUN_ID);
      expect(cp.result).toEqual({ winner: true });
      expect(cp.attempt).toBe(1);
    });

    it('putIntent is rejected once a terminal row exists for the same key', async () => {
      const store = await setup();
      await store.completeCheckpoint(RUN_ID, 'node-a', 0, 1, terminal({ attempt: 1 }));
      await expect(store.putIntent(intent({ attempt: 2 }))).rejects.toThrow(WorkflowFenceError);
    });

    it('completeCheckpoint from a stale attempt against a live intent row is rejected', async () => {
      const store = await setup();
      await store.putIntent(intent({ attempt: 2 }));
      await expect(
        store.completeCheckpoint(RUN_ID, 'node-a', 0, 1, terminal({ attempt: 1 })),
      ).rejects.toThrow(WorkflowFenceError);

      const [cp] = await store.getCheckpoints(RUN_ID);
      expect(cp.status).toBe('intent');
      expect(cp.attempt).toBe(2);
    });

    it('checkpoints are keyed by (runId, nodeId, iteration): distinct iterations do not collide', async () => {
      const store = await setup();
      await store.completeCheckpoint(RUN_ID, 'node-a', 0, 1, terminal({ iteration: 0, result: { i: 0 } }));
      await store.completeCheckpoint(RUN_ID, 'node-a', 1, 1, terminal({ iteration: 1, result: { i: 1 } }));

      const checkpoints = await store.getCheckpoints(RUN_ID);
      expect(checkpoints).toHaveLength(2);
      expect(checkpoints.map((c) => c.result).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))).toEqual([
        { i: 0 },
        { i: 1 },
      ]);
    });

    it('a node can complete directly to terminal without a prior intent write (pure executors)', async () => {
      const store = await setup();
      await store.completeCheckpoint(RUN_ID, 'node-a', 0, 1, terminal({ status: 'skipped', result: undefined }));
      const [cp] = await store.getCheckpoints(RUN_ID);
      expect(cp.status).toBe('skipped');
    });

    it('a same-attempt putIntent overwrites the existing intent row (executor re-writing its own intent)', async () => {
      const store = await setup();
      await store.putIntent(intent({ attempt: 1, effects: { round: 1 } }));
      await store.putIntent(intent({ attempt: 1, effects: { round: 2 } }));

      const [cp] = await store.getCheckpoints(RUN_ID);
      expect(cp.attempt).toBe(1);
      expect(cp.effects).toEqual({ round: 2 });
    });

    it('mutating a returned checkpoint does not affect the stored state', async () => {
      const store = await setup();
      await store.completeCheckpoint(RUN_ID, 'node-a', 0, 1, terminal({ result: { count: 1 } }));

      const [cp] = await store.getCheckpoints(RUN_ID);
      expect(cp.result).toEqual({ count: 1 });
      if (!isCountResult(cp.result)) throw new Error('expected a { count } result');
      cp.result.count = 999;

      const [reread] = await store.getCheckpoints(RUN_ID);
      expect(reread.result).toEqual({ count: 1 });
    });

    it('a zombie putIntent for a fresh nodeId with attempt below the run\'s current attempt is rejected', async () => {
      const store = await setup();
      const firstClaim = await store.claimRun(RUN_ID, 'owner-1', 30_000);
      if (!firstClaim) throw new Error('expected first claim to succeed');
      await store.parkRun(RUN_ID, firstClaim.attempt, []);
      const secondClaim = await store.claimRun(RUN_ID, 'owner-2', 30_000);
      if (!secondClaim) throw new Error('expected second claim to succeed');
      expect(secondClaim.attempt).toBe(firstClaim.attempt + 1);

      // The zombie (attempt 1) tries to write a brand-new node's row after
      // losing ownership — there's no existing row for it to CAS against,
      // so only the run-level fence catches this.
      await expect(
        store.putIntent(intent({ nodeId: 'node-fresh', attempt: firstClaim.attempt })),
      ).rejects.toThrow(WorkflowFenceError);
    });

    it('a zombie completeCheckpoint for a fresh nodeId with attempt below the run\'s current attempt is rejected', async () => {
      const store = await setup();
      const firstClaim = await store.claimRun(RUN_ID, 'owner-1', 30_000);
      if (!firstClaim) throw new Error('expected first claim to succeed');
      await store.parkRun(RUN_ID, firstClaim.attempt, []);
      const secondClaim = await store.claimRun(RUN_ID, 'owner-2', 30_000);
      if (!secondClaim) throw new Error('expected second claim to succeed');
      expect(secondClaim.attempt).toBe(firstClaim.attempt + 1);

      await expect(
        store.completeCheckpoint(
          RUN_ID,
          'node-fresh',
          0,
          firstClaim.attempt,
          terminal({ nodeId: 'node-fresh', attempt: firstClaim.attempt }),
        ),
      ).rejects.toThrow(WorkflowFenceError);
    });

    it('claimRun reclaims a running run whose lease has expired, bumping attempt and keeping it running', async () => {
      const store = await setup();
      // Negative leaseMs backdates leaseExpiresAt into the past, simulating
      // a crashed owner without depending on real wall-clock time passing.
      const claimed = await store.claimRun(RUN_ID, 'owner-1', -1_000);
      expect(claimed).toEqual({ attempt: 1 });

      const runnable = await store.listRunnable(Date.now(), 10);
      expect(runnable.map((r) => r.runId)).toContain(RUN_ID);

      const reclaimed = await store.claimRun(RUN_ID, 'owner-2', 30_000);
      expect(reclaimed).toEqual({ attempt: 2 });
      const run = await store.getRun(RUN_ID);
      expect(run?.status).toBe('running');
      expect(run?.ownerId).toBe('owner-2');
    });

    it('claimRun does not reclaim a running run whose lease is still live, and listRunnable excludes it', async () => {
      const store = await setup();
      const claimed = await store.claimRun(RUN_ID, 'owner-1', 60_000);
      expect(claimed).toEqual({ attempt: 1 });

      const runnable = await store.listRunnable(Date.now(), 10);
      expect(runnable.map((r) => r.runId)).not.toContain(RUN_ID);

      const reclaimed = await store.claimRun(RUN_ID, 'owner-2', 30_000);
      expect(reclaimed).toBeNull();
    });

    it('claimRun reclaims an expired-lease terminalizing run and keeps it terminalizing', async () => {
      const store = await setup();
      const claimed = await store.claimRun(RUN_ID, 'owner-1', -1_000);
      if (!claimed) throw new Error('expected initial claim to succeed');
      await store.beginTerminalize(RUN_ID, claimed.attempt, 'completed');

      const runnable = await store.listRunnable(Date.now(), 10);
      expect(runnable.map((r) => r.runId)).toContain(RUN_ID);

      const reclaimed = await store.claimRun(RUN_ID, 'owner-2', 30_000);
      expect(reclaimed).toEqual({ attempt: 2 });
      const run = await store.getRun(RUN_ID);
      expect(run?.status).toBe('terminalizing');
      expect(run?.ownerId).toBe('owner-2');
    });

    it('parkRun clears the lease so a parked run is not later mistaken for an expired-lease running run', async () => {
      const store = await setup();
      const claimed = await store.claimRun(RUN_ID, 'owner-1', 1_000);
      if (!claimed) throw new Error('expected claim to succeed');
      await store.parkRun(RUN_ID, claimed.attempt, []);

      // Long after the original (now-cleared) lease would have expired.
      const runnable = await store.listRunnable(Date.now() + 60_000, 10);
      expect(runnable.map((r) => r.runId)).not.toContain(RUN_ID);
    });
  });
}

function isCountResult(value: unknown): value is { count: number } {
  return typeof value === 'object' && value !== null && 'count' in value;
}
