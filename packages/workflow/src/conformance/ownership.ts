/**
 * Run-ownership contract conformance suite — mirrors `checkpoints.ts`'s
 * pattern (a `describe*` factory taking a store constructor, registering
 * vitest blocks). Run against the in-memory store here; the sqlite store
 * (Task 9) must pass this suite unchanged.
 *
 * Coverage (spec "Run ownership and reconciliation", "Conformance → Run
 * ownership contract"):
 *  - single-claim exclusivity
 *  - lease expiry + reclaim increments attempt
 *  - scheduleWake move-forward semantics
 *  - settleRun idempotency
 *  - two-phase beginTerminalize → settleRun
 */

import { describe, expect, it } from 'vitest';
import { WorkflowFenceError, type RunParams, type WorkflowStore } from '../store.js';

const RUN_ID = 'run-1';

function runParams(overrides: Partial<RunParams> = {}): RunParams {
  return {
    workflowId: 'wf-1',
    definitionVersionId: 'v1',
    input: { hello: 'world' },
    ...overrides,
  };
}

export function describeOwnershipContract(makeStore: () => Promise<WorkflowStore> | WorkflowStore): void {
  describe('WorkflowStore run-ownership contract', () => {
    async function setup(): Promise<WorkflowStore> {
      const store = await makeStore();
      await store.createRun(RUN_ID, runParams(), { version: 'dag/v1' }, 'v1');
      return store;
    }

    it('single-claim exclusivity: a second claimRun against a live-lease running run returns null', async () => {
      const store = await setup();
      const first = await store.claimRun(RUN_ID, 'owner-1', 30_000);
      expect(first).toEqual({ attempt: 1 });

      const second = await store.claimRun(RUN_ID, 'owner-2', 30_000);
      expect(second).toBeNull();

      const run = await store.getRun(RUN_ID);
      expect(run?.ownerId).toBe('owner-1');
      expect(run?.attempt).toBe(1);
    });

    it('claimRun returns null for a run that does not exist', async () => {
      const store = await makeStore();
      const claimed = await store.claimRun('no-such-run', 'owner-1', 30_000);
      expect(claimed).toBeNull();
    });

    it('claimRun succeeds on a pending run and transitions it to running with an owner and lease', async () => {
      const store = await setup();
      const claimed = await store.claimRun(RUN_ID, 'owner-1', 30_000);
      expect(claimed).toEqual({ attempt: 1 });

      const run = await store.getRun(RUN_ID);
      expect(run?.status).toBe('running');
      expect(run?.ownerId).toBe('owner-1');
      expect(run?.leaseExpiresAt).toBeGreaterThan(0);
    });

    it('lease expiry + reclaim: an expired-lease running run can be reclaimed by a new owner, incrementing attempt', async () => {
      const store = await setup();
      // Negative leaseMs backdates leaseExpiresAt into the past, simulating
      // a crashed owner without depending on real wall-clock time passing.
      const first = await store.claimRun(RUN_ID, 'owner-1', -1_000);
      expect(first).toEqual({ attempt: 1 });

      const second = await store.claimRun(RUN_ID, 'owner-2', 30_000);
      expect(second).toEqual({ attempt: 2 });

      const run = await store.getRun(RUN_ID);
      expect(run?.ownerId).toBe('owner-2');
      expect(run?.status).toBe('running');
    });

    it('lease expiry + reclaim: a live lease is not reclaimable and listRunnable excludes the run', async () => {
      const store = await setup();
      const claimed = await store.claimRun(RUN_ID, 'owner-1', 60_000);
      expect(claimed).toEqual({ attempt: 1 });

      const reclaimed = await store.claimRun(RUN_ID, 'owner-2', 30_000);
      expect(reclaimed).toBeNull();

      const runnable = await store.listRunnable(Date.now(), 10);
      expect(runnable.map((r) => r.runId)).not.toContain(RUN_ID);
    });

    it('heartbeat renews the lease for the current owner and no-ops for a non-owner', async () => {
      const store = await setup();
      const claimed = await store.claimRun(RUN_ID, 'owner-1', 1_000);
      if (!claimed) throw new Error('expected claim to succeed');

      const renewed = await store.heartbeat(RUN_ID, 'owner-1', 60_000);
      expect(renewed).toBe(true);

      const stolen = await store.heartbeat(RUN_ID, 'owner-2', 60_000);
      expect(stolen).toBe(false);

      // Still not reclaimable by another owner because the heartbeat renewed the lease.
      const reclaimed = await store.claimRun(RUN_ID, 'owner-2', 30_000);
      expect(reclaimed).toBeNull();
    });

    it('scheduleWake move-forward: an earlier wake wins, and a later call does not move an existing wake back', async () => {
      const store = await setup();
      await store.scheduleWake(RUN_ID, 50_000);
      let run = await store.getRun(RUN_ID);
      expect(run?.wakeAt).toBe(50_000);

      // A later time must not push the existing (earlier) wake back.
      await store.scheduleWake(RUN_ID, 80_000);
      run = await store.getRun(RUN_ID);
      expect(run?.wakeAt).toBe(50_000);

      // An earlier time moves the wake forward.
      await store.scheduleWake(RUN_ID, 20_000);
      run = await store.getRun(RUN_ID);
      expect(run?.wakeAt).toBe(20_000);
    });

    it('parkRun sets the run terminalStatus/waitingOn and clears ownership so the run is unowned', async () => {
      const store = await setup();
      const claimed = await store.claimRun(RUN_ID, 'owner-1', 30_000);
      if (!claimed) throw new Error('expected claim to succeed');

      const waitingOn = [{ kind: 'timer' as const, nodeId: 'node-a', wakeAt: 5_000 }];
      await store.parkRun(RUN_ID, claimed.attempt, waitingOn);

      const run = await store.getRun(RUN_ID);
      expect(run?.status).toBe('parked');
      expect(run?.waitingOn).toEqual(waitingOn);
      expect(run?.ownerId).toBeUndefined();
      expect(run?.leaseExpiresAt).toBeUndefined();
    });

    it('parkRun is fenced by attempt: a stale attempt cannot park over a run reclaimed by a newer attempt', async () => {
      const store = await setup();
      const first = await store.claimRun(RUN_ID, 'owner-1', -1_000);
      if (!first) throw new Error('expected first claim to succeed');
      const second = await store.claimRun(RUN_ID, 'owner-2', 30_000);
      if (!second) throw new Error('expected second claim to succeed');

      await expect(store.parkRun(RUN_ID, first.attempt, [])).rejects.toThrow(WorkflowFenceError);

      const run = await store.getRun(RUN_ID);
      expect(run?.status).toBe('running');
      expect(run?.ownerId).toBe('owner-2');
    });

    it('two-phase settlement: beginTerminalize records the pending outcome and moves the run to terminalizing', async () => {
      const store = await setup();
      const claimed = await store.claimRun(RUN_ID, 'owner-1', 30_000);
      if (!claimed) throw new Error('expected claim to succeed');

      await store.beginTerminalize(RUN_ID, claimed.attempt, 'failed');

      const run = await store.getRun(RUN_ID);
      expect(run?.status).toBe('terminalizing');
      expect(run?.outcome).toBe('failed');
    });

    it('two-phase settlement: settleRun finalizes a terminalizing run to settled', async () => {
      const store = await setup();
      const claimed = await store.claimRun(RUN_ID, 'owner-1', 30_000);
      if (!claimed) throw new Error('expected claim to succeed');
      await store.beginTerminalize(RUN_ID, claimed.attempt, 'completed');

      await store.settleRun(RUN_ID, 'completed');

      const run = await store.getRun(RUN_ID);
      expect(run?.status).toBe('settled');
      expect(run?.outcome).toBe('completed');
      expect(run?.waitingOn).toEqual([]);
    });

    it('beginTerminalize is fenced by attempt: a stale attempt cannot terminalize over a run reclaimed by a newer attempt', async () => {
      const store = await setup();
      const first = await store.claimRun(RUN_ID, 'owner-1', -1_000);
      if (!first) throw new Error('expected first claim to succeed');
      // Reclaim: the first owner's lease has already expired.
      const second = await store.claimRun(RUN_ID, 'owner-2', 30_000);
      if (!second) throw new Error('expected second claim (reclaim) to succeed');
      expect(second.attempt).toBe(first.attempt + 1);

      // The zombie (stale attempt) tries to begin terminalizing after losing ownership.
      await expect(store.beginTerminalize(RUN_ID, first.attempt, 'completed')).rejects.toThrow(WorkflowFenceError);

      const run = await store.getRun(RUN_ID);
      expect(run?.status).toBe('running'); // unaffected by the rejected stale write
      expect(run?.ownerId).toBe('owner-2');
      expect(run?.attempt).toBe(second.attempt);
    });

    it('settleRun is idempotent: a repeated call with the same outcome is harmless and the outcome stays stable', async () => {
      const store = await setup();
      const claimed = await store.claimRun(RUN_ID, 'owner-1', 30_000);
      if (!claimed) throw new Error('expected claim to succeed');
      await store.beginTerminalize(RUN_ID, claimed.attempt, 'cancelled');
      await store.settleRun(RUN_ID, 'cancelled');

      await expect(store.settleRun(RUN_ID, 'cancelled')).resolves.toBeUndefined();

      const run = await store.getRun(RUN_ID);
      expect(run?.status).toBe('settled');
      expect(run?.outcome).toBe('cancelled');
    });

    it('createRun with an owner round-trips via getRun; omitting owner leaves it unset', async () => {
      const store = await makeStore();
      await store.createRun('run-owned', runParams(), { version: 'dag/v1' }, 'v1', {
        ownerType: 'team',
        ownerId: 'team-42',
      });
      const owned = await store.getRun('run-owned');
      expect(owned?.owner).toEqual({ ownerType: 'team', ownerId: 'team-42' });

      // The suite's own `setup()`-created RUN_ID run never passed an owner.
      const store2 = await setup();
      const unowned = await store2.getRun(RUN_ID);
      expect(unowned?.owner).toBeUndefined();
    });

    it('listRunnable surfaces a wake-requested parked run and a due-timer parked run', async () => {
      const store = await setup();
      const claimed = await store.claimRun(RUN_ID, 'owner-1', 30_000);
      if (!claimed) throw new Error('expected claim to succeed');
      await store.parkRun(RUN_ID, claimed.attempt, [], 10_000);

      // Not yet due, no wake requested: excluded.
      let runnable = await store.listRunnable(1_000, 10);
      expect(runnable.map((r) => r.runId)).not.toContain(RUN_ID);

      // Due timer: included.
      runnable = await store.listRunnable(10_000, 10);
      expect(runnable.map((r) => r.runId)).toContain(RUN_ID);

      // requestWake surfaces the run regardless of the timer.
      await store.requestWake(RUN_ID);
      runnable = await store.listRunnable(0, 10);
      expect(runnable.map((r) => r.runId)).toContain(RUN_ID);
    });
  });
}
